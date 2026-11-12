// Synthetic IndexedDB boundary, adapted from stream-comparison-provenance's
// memory seam. Clones records, commits atomically, and exposes abort/read hooks.
// This exercises application transaction behavior, not a browser's IDB engine.
export function memoryIndexedDb({ initialStores = {}, initialVersion = 0 } = {}) {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const stores = new Map(), calls = [];
  for (const [name, keyPath] of Object.entries(initialStores))
    stores.set(name, { keyPath, rows: new Map() });
  let opened = false, sequence = 0;
  const control = { abortNextPut: false, beforeGet: null, beforeTransaction: null };
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, { keyPath }) {
      if (stores.has(name)) throw new Error('ConstraintError: synthetic store already exists: '+name);
      stores.set(name, { keyPath, rows: new Map() });
    },
    close() {},
    transaction(name, mode) {
      control.beforeTransaction?.(name, mode);
      const table = stores.get(name);
      if (!table) throw Error('Unknown synthetic store '+name);
      const id = ++sequence, rows = new Map(table.rows);
      let pending = 0, ended = false;
      const tx = {
        abort() { if (ended) return; ended = true; calls.push({id, type:'abort'}); queueMicrotask(()=>tx.onabort?.()); },
        objectStore(requested) {
          if(requested!==name) throw Error('Unexpected synthetic store');
          const request = (type, operation) => {
            if(ended) throw Error('Request after synthetic transaction ended');
            const result = {}; pending++; calls.push({id,type,mode,name});
            queueMicrotask(()=>{
              if(ended) return;
              if(type==='put'&&control.abortNextPut){control.abortNextPut=false;tx.abort();return}
              try { result.result=operation(); }
              catch(error) {
                result.error=error;
                result.onerror?.({target:result});
                tx.error=error;tx.abort();return;
              }
              result.onsuccess?.({target:result});pending--;
              if(!pending&&!ended){ended=true;if(mode==='readwrite')table.rows=rows;calls.push({id,type:'complete'});tx.oncomplete?.()}
            });
            return result;
          };
          return {
            transaction: tx,
            openCursor(range) {
              const keys=[...rows.keys()].filter(key=>!range||((range.lowerOpen?key>range.lower:key>=range.lower)&&(range.upperOpen?key<range.upper:key<=range.upper))).sort();
              const cursorRequest={};let position=0;
              const advance=()=>{
                const current=request('cursor',()=>{
                  const key=keys[position];
                  if(key===undefined)return null;
                  control.beforeGet?.(name,key,rows);
                  return {key,value:clone(rows.get(key)),continue(){position++;advance()}};
                });
                current.onsuccess=()=>{
                  cursorRequest.result=current.result;
                  cursorRequest.onsuccess?.({target:cursorRequest});
                };
                current.onerror=()=>{
                  cursorRequest.error=current.error;
                  cursorRequest.onerror?.({target:cursorRequest});
                };
              };
              advance();return cursorRequest;
            },
            openKeyCursor(range) { return this.openCursor(range); },
            get(key) { return request('get',()=>{control.beforeGet?.(name,key,rows);return clone(rows.get(key))}); },
            getAll() { return request('getAll',()=>[...rows.values()].map(clone)); },
            put(value) { const saved=clone(value);return request('put',()=>rows.set(saved[table.keyPath],saved)); },
            delete(key) { return request('delete',()=>rows.delete(key)); },
          };
        },
      };
      return tx;
    },
  };
  return { control,calls,
    rows(name='commands-v3') { return [...(stores.get(name)?.rows.values()??[])].map(clone); },
    inject(value,name='commands-v3') { const table=stores.get(name);table.rows.set(value[table.keyPath],clone(value)); },
    indexedDB:{open(name,version){const request={};calls.push({type:'open',name,oldVersion:initialVersion,version});queueMicrotask(()=>{request.result=db;if(!opened){opened=true;request.onupgradeneeded?.({oldVersion:initialVersion,newVersion:version})}request.onsuccess?.()});return request}},
  };
}
