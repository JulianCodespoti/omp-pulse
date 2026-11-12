import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const modules = ['domain/response-item-provenance', 'domain/message-provenance', 'domain/messages', 'domain/stream-visibility', 'runtime/omp-store', 'runtime/offline-cache'];
const source = modules.map(name => `export * from ${JSON.stringify(resolve(root, `web/src/${name}.ts`))};`).join('\n');
const build = await rolldown({input: 'provenance-fixture', platform: 'node', plugins: [{
  name: 'provenance-fixture', resolveId: id => id === 'provenance-fixture' ? '\0provenance-fixture' : null,
  load: id => id === '\0provenance-fixture' ? source : null,
}]});
let actual;
try {
  const generated = await build.generate({format: 'esm', codeSplitting: false});
  actual = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString('base64')}`);
} finally { await build.close(); }
const { rawAssistantText, getRawAssistantText: raw, withRawAssistantText: sourced,
  withoutRawAssistantText: unsourced, entryToUiMessage: normalize, mergeToolParts,
  applyToolResults, visibleStreamingMessage: visible, createOmpStore, saveTail, loadTail } = actual;
const prefix = 'The answer.';
const fence = '```text\nEXACT\n```';
const aggregate = prefix + fence;
const display = prefix + '\n' + fence;
const text = value => ({type: 'text', text: value});
const wire = (content = [text(prefix), text(fence)], extra = {}) => ({role: 'assistant', responseId: 'r1', content, ...extra});
const ui = (content, id = 'history', extra = {}) => normalize({type: 'message', id, message: wire(content, extra)}, 0);
const live = () => ui([text(aggregate)], 'live:r1');
const tool = {kind: 'tool', callId: 't1', name: 'bash', args: {}, state: 'running'};
const store = () => { const s = createOmpStore(); s.getState().beginSession('/synthetic'); return s; };

// Deliberately retain object/symbol identity at this fake storage seam. This
// proves BOTH public cache boundaries strip metadata themselves, independently
// of real IndexedDB's additional structured-clone removal of symbol keys.
const identityClone = value => value;
function memoryIndexedDb() {
  const stores = new Map();
  const calls = { open: 0, get: 0, put: 0, cursor: 0 };
  let opened = false;
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, records: new Map() }); },
    deleteObjectStore(name) { stores.delete(name); },
    close() {},
    transaction(name) {
      const table = stores.get(name);
      assert.ok(table, `unexpected object store ${name}`);
      let pending = 0;
      let ended = false;
      const tx = {
        objectStore(requested) {
          assert.equal(requested, name);
          const request = (operation) => {
            assert.equal(ended, false, "request issued after transaction completion");
            const result = {};
            pending++;
            queueMicrotask(() => {
              result.result = operation();
              result.onsuccess?.({ target: result });
              pending--;
              if (pending === 0) {
                ended = true;
                tx.oncomplete?.();
              }
            });
            return result;
          };
          return {
            keyPath: table.keyPath,
            get(key) {
              calls.get++;
              return request(() => identityClone(table.records.get(key)));
            },
            put(value) {
              calls.put++;
              const copied = identityClone(value);
              return request(() => table.records.set(copied[table.keyPath], copied));
            },
            delete(key) { return request(() => table.records.delete(key)); },
            openCursor() {
              calls.cursor++;
              const entries = [...table.records.entries()].sort(([a], [b]) => a.localeCompare(b));
              let index = 0;
              const cursorRequest = {};
              const next = () => {
                const tick = request(() => {
                  const pair = entries[index++];
                  return pair ? {
                    key: pair[0], value: identityClone(pair[1]),
                    continue: next,
                    delete: () => request(() => table.records.delete(pair[0])),
                  } : null;
                });
                tick.onsuccess = () => {
                  cursorRequest.result = tick.result;
                  cursorRequest.onsuccess?.({ target: cursorRequest });
                };
              };
              next();
              return cursorRequest;
            },
          };
        },
        abort() { ended = true; tx.onabort?.(); },
      };
      return tx;
    },
  };
  return {
    calls,
    indexedDB: {
      open(name, version) {
        assert.equal(name, "omp-pulse-offline");
        assert.equal(version, 3);
        calls.open++;
        const request = {};
        queueMicrotask(() => {
          request.result = database;
          if (!opened) { request.onupgradeneeded?.(); opened = true; }
          request.onsuccess?.();
        });
        return request;
      },
    },
    record: (namespace, sessionPath) => identityClone(stores.get("history")?.records.get(`${namespace}:${sessionPath}`)),
    inject(record) { stores.get("history").records.set(record.key, identityClone(record)); },
  };
}
const idb = memoryIndexedDb();
const previousIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: idb.indexedDB });
after(() => {
  if (previousIndexedDb) Object.defineProperty(globalThis, "indexedDB", previousIndexedDb);
  else delete globalThis.indexedDB;
});

test('normalizer retains exact source independently of fence repairs and omitted blocks', () => {
  for (const omitted of [null, {type:'thinking',thinking:''}, {type:'unknown'}, {type:'toolCall'}, {type:'text',text:7}]) {
    const row = ui([text(prefix), omitted, text(fence)]);
    assert.equal(raw(row), aggregate);
    assert.equal(row.text, display);
    assert.deepEqual(row.parts, [{kind:'text', text:display}]);
  }
  assert.equal(rawAssistantText(wire(' a\n\t ')), ' a\n\t ');
  assert.equal(rawAssistantText(wire([])), '');
  for (const content of [undefined, null, {}, 7]) assert.equal(rawAssistantText({...wire(), content}), null);
  assert.equal(rawAssistantText({role:'user',content:'same'}), null);
});

test('retained thinking tools and images add no raw separator', () => {
  for (const part of [{type:'thinking',thinking:'Inspecting'}, {type:'toolCall',id:'t1',name:'bash'}, {type:'image',data:'blob:sha256:synthetic',mimeType:'image/png'}]) {
    const row = ui([text(prefix),part,text(fence)]);
    assert.equal(raw(row), aggregate);
    assert.equal(row.text, aggregate);
    assert.equal(row.parts.length,3);
  }
});

test('ordinary provenance stores no second raw aggregate and has no JSON surface', () => {
  const row = live(), symbols = Object.getOwnPropertySymbols(row);
  assert.equal(symbols.length,1);
  assert.equal(row[symbols[0]].raw,null);
  assert.equal(raw({...row}), aggregate);
  assert.equal(raw(JSON.parse(JSON.stringify(row))),null);
  assert.equal(raw(structuredClone(row)),null);
  assert.equal(raw({...JSON.parse(JSON.stringify(row)),rawAssistantSource:aggregate,rawText:aggregate}),null);
  assert.equal(raw({...row,[Symbol('raw assistant source')]:row[symbols[0]],...{id:'other'}}),null);
  assert.equal(raw(row),aggregate);
});

test('copied metadata becomes invalid after any prose or identity replacement', () => {
  const row = ui();
  for (const changed of [
    {...row,text:'changed'}, {...row,parts:[{kind:'text',text:'changed'}]},
    {...row,parts:row.parts.map(p=>({...p}))}, {...row,parts:[]},
    {...row,id:'new'}, {...row,responseKey:'response:new'}, {...row,role:'user'},
  ]) assert.equal(raw(changed),null);
  const mutated = ui(); mutated.parts[0].text='in-place changed';
  assert.equal(raw(mutated),null);
  const replaced = sourced({...row,text:'new',parts:[{kind:'text',text:'new'}]},'new');
  assert.equal(raw(replaced),'new');
});

test('tool-only spreads and production tool merging keep valid source', () => {
  const row = ui(), extended = {...row,parts:[...row.parts,tool]};
  assert.equal(raw(extended),aggregate);
  const incoming = ui();
  assert.equal(raw(mergeToolParts(incoming,extended)),aggregate);
  const applied = applyToolResults([extended],[{callId:'t1',name:'bash',output:'done',isError:false,pruned:false}]).messages[0];
  assert.equal(raw(applied),aggregate);
  assert.equal(applied.parts.at(-1).state,'ok');
  // A sourceless full snapshot never inherits the previous revision's proof.
  assert.equal(raw(mergeToolParts(unsourced(incoming),extended)),null);
});

test('all store ingress paths preserve only the incoming source and tool-only state', () => {
  for (const method of ['setHistory','mergeMessages','prependMessages','appendMessage','setStreamingMessage']) {
    const s = store(), row = ui();
    s.getState()[method](method==='appendMessage'||method==='setStreamingMessage'?row:[row]);
    assert.equal(raw(method==='setStreamingMessage'?s.getState().streamingMessage:s.getState().messages[0]),aggregate,method);
  }
  const s=store();s.getState().setStreamingMessage(live());s.getState().mergeMessages([ui()]);s.getState().commitStreamingMessage();
  assert.equal(s.getState().messages.length,1);assert.equal(raw(s.getState().messages[0]),aggregate);
  const replacement={...ui(),text:'revised',parts:[{kind:'text',text:'revised'}]};
  s.getState().mergeMessages([replacement]);assert.equal(raw(s.getState().messages[0]),null);
});

test('raw prefix coverage requires two valid proofs behind the existing identity gate', () => {
  const history=ui(), streaming=live();
  assert.equal(visible([history],streaming),null);
  for (const pair of [[unsourced(history),streaming],[history,unsourced(streaming)],[unsourced(history),unsourced(streaming)]]) {
    assert.equal(visible([pair[0]],pair[1]),pair[1]);
  }
  for (const id of ['different','entry:0','']) {
    const other=ui([text(aggregate)],id,{responseId:'other'});
    assert.equal(visible([history],other),other);
  }
  const sameIdA=ui(undefined,'same',{responseId:undefined}),sameIdB=ui([text(aggregate)],'same',{responseId:undefined});
  assert.equal(visible([sameIdA],sameIdB),null);
  const noIdA=ui(undefined,'entry:0',{responseId:undefined}),noIdB=ui([text(aggregate)],'entry:0',{responseId:undefined});
  assert.equal(visible([noIdA],noIdB),noIdB);
});

test('same-display full store replacements own their new raw source or conservative absence', () => {
  const s=store(), original=ui(), withTool={...original,parts:[...original.parts,tool]};
  assert.equal(raw(withTool),aggregate);s.getState().mergeMessages([withTool]);
  const literal=ui([text(display)]);
  assert.equal(literal.text,original.text);assert.equal(raw(literal),display);
  s.getState().mergeMessages([literal]);
  assert.equal(raw(s.getState().messages[0]),display);
  assert.equal(s.getState().messages[0].parts.at(-1).callId,'t1');
  const cached=unsourced(ui([text(display)]));s.getState().mergeMessages([cached]);
  assert.equal(s.getState().messages[0].text,display);
  assert.equal(raw(s.getState().messages[0]),null);
  assert.equal(s.getState().messages[0].parts.at(-1).callId,'t1');
  const staleCopy={...original,parts:original.parts.map(part=>({...part}))};
  assert.equal(raw(staleCopy),null,'even equal-text replacement parts cannot borrow a copied proof');
});

test('history-first commit preserves the actual history winner source despite equal display', () => {
  const s=store(), history=ui(), streaming=ui([text(display)],'live:r1');
  assert.equal(history.text,streaming.text);assert.notEqual(raw(history),raw(streaming));
  s.getState().setStreamingMessage(streaming);s.getState().mergeMessages([history]);
  assert.equal(visible(s.getState().messages,s.getState().streamingMessage),s.getState().streamingMessage);
  s.getState().commitStreamingMessage();
  assert.equal(s.getState().messages.length,1);assert.equal(s.getState().messages[0].id,history.id);
  assert.equal(s.getState().messages[0].text,display);assert.equal(raw(s.getState().messages[0]),aggregate);
});

test('valid raw source vetoes display equality for genuine newline or revised/longer source', () => {
  const history=ui();
  for (const content of [display,aggregate+'\n',aggregate+' extra','Revised answer.']) {
    const streaming=ui([text(content)],'live:r1');
    assert.equal(visible([history],streaming),streaming);
  }
  const partial=ui([text(prefix)],'live:r1');assert.equal(visible([history],partial),null);
  const empty=ui([],'live:r1');assert.equal(visible([history],empty),null);
});

test('legacy comparison still suppresses exact display prefixes without granting provenance', () => {
  const history=unsourced(ui()),streaming=unsourced(ui([text(display)],'live:r1'));
  assert.equal(visible([history],streaming),null);
  assert.equal(raw(history),null);assert.equal(raw(streaming),null);
});

test('raw coverage projects fresh tool thinking image and error without repeated prose', () => {
  const history=ui(), initial=live(), messages=[history];
  const details=[tool,{kind:'thinking',text:'Fresh reasoning'},{kind:'image',src:null,mimeType:'image/png'}];
  const streaming={...initial,parts:[...initial.parts,...details],errorMessage:'Fresh failure'};
  const projected=visible(messages,streaming);
  assert.equal(projected.text,'');assert.deepEqual(projected.parts,details);assert.equal(projected.errorMessage,'Fresh failure');
  assert.equal(raw(projected),null);assert.equal(raw(streaming),aggregate);
  assert.equal(visible(messages,streaming),projected);
});

test('saveTail explicitly strips source metadata and preserves display text', async () => {
  const row=ui(), path='/synthetic-cache',namespace='provenance-save';
  await saveTail(path,[row],namespace);const record=idb.record(namespace,path);assert.ok(record);
  assert.equal(Object.getOwnPropertySymbols(record.messages[0]).length,0);
  assert.equal(record.messages[0].text,display);assert.deepEqual(record.messages[0].parts,row.parts);
  assert.equal(raw(row),aggregate);
  const cached=await loadTail(path,namespace);assert.ok(cached);assert.equal(raw(cached.messages[0]),null);
  assert.equal(visible(cached.messages,live()).text,aggregate);
});

test('loadTail independently drops a valid injected in-memory proof without rewriting', async () => {
  const path='/synthetic-cache',namespace='provenance-load';await saveTail(path,[ui()],namespace);
  const before=idb.record(namespace,path),row=ui();idb.inject({...before,messages:[row]});
  assert.equal(raw(idb.record(namespace,path).messages[0]),aggregate);
  const writes=idb.calls.put;const cached=await loadTail(path,namespace);
  assert.ok(cached);assert.equal(raw(cached.messages[0]),null);assert.equal(Object.getOwnPropertySymbols(cached.messages[0]).length,0);
  assert.equal(cached.messages[0].text,display);assert.equal(idb.calls.put,writes);assert.equal(raw(row),aggregate);
});


// Responses identity witnesses must cross neither side of the same real cache
// seam, even though this adapter deliberately preserves object/symbol identity.
function signedProvisional(s) {
  const message = {role:'assistant',api:'openai-responses',provider:'synthetic-provider',model:'synthetic-model',timestamp:1700000000000,
    content:[{type:'text',text:aggregate,textSignature:JSON.stringify({v:1,id:'cache-output-item'})}]};
  const row=normalize({type:'message',id:'live:cache-item',message},0);
  s.getState().beginResponseLifecycle();
  s.getState().setStreamingMessage(actual.withResponseItem(row,message,false));
  s.getState().commitStreamingMessage();
  return {live:s.getState().messages[0],canonical:normalize({type:'message',id:'canonical-cache-item',message:{...message,responseId:'cache-response'}},0)};
}
for(const liveId of ['live:cache-response','canonical-cache-item']) test(`recovered late provider-ID commit retains fresh details and canonical prose (${liveId})`,()=>{
  const s=store(), {canonical}=signedProvisional(s);
  s.getState().mergeMessages([canonical]);
  const message={role:'assistant',api:'openai-responses',provider:'synthetic-provider',model:'synthetic-model',responseId:'cache-response',
    content:[{type:'text',text:'Delayed provisional prose',textSignature:JSON.stringify({v:1,id:'cache-output-item'})}]};
  const fresh=[tool,{kind:'thinking',text:'Fresh thinking'},{kind:'image',src:null,mimeType:'image/png'}];
  const row=normalize({type:'message',id:liveId,message},0);
  s.getState().setStreamingMessage(actual.withResponseItem({...row,parts:[...row.parts,...fresh],errorMessage:'Fresh error'},message,false));
  const projected=visible(s.getState().messages,s.getState().streamingMessage);
  assert.equal(projected.text,'');
  assert.deepEqual(projected.parts,fresh);
  s.getState().commitStreamingMessage();
  assert.equal(s.getState().streamingMessage,null);
  assert.equal(s.getState().messages.length,1);
  const committed=s.getState().messages[0];
  assert.equal(committed.id,canonical.id);
  assert.equal(committed.text,canonical.text);
  assert.equal(raw(committed),raw(canonical));
  for(const part of fresh) assert.ok(committed.parts.includes(part));
  assert.equal(committed.errorMessage,'Fresh error');
});
for(const boundary of ['save','load']) test(`Responses alias proof is stripped at actual ${boundary}Tail boundary`,async()=>{
  const s=store(), {live,canonical}=signedProvisional(s),path='/synthetic-signed-cache',namespace=`signed-${boundary}`;
  await saveTail(path,[live],namespace);
  const record=idb.record(namespace,path);assert.ok(record);
  assert.equal(Object.getOwnPropertySymbols(record.messages[0]).length,0);
  if(boundary==='load') idb.inject({...record,messages:[live]});
  const writes=idb.calls.put,cached=await loadTail(path,namespace);assert.ok(cached);
  assert.equal(Object.getOwnPropertySymbols(cached.messages[0]).length,0);
  assert.equal(cached.messages[0].text,aggregate);assert.equal(idb.calls.put,writes);
  s.getState().beginSession('/synthetic');s.getState().setHistory(cached.messages);
  s.getState().mergeMessages([canonical]);
  assert.equal(s.getState().messages.length,2,'cache rehydration must not mint an observed lifecycle');
});
