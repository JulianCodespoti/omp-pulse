import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const content='# A clearer conversation\n\nReadable **emphasis** with `inline-token`.\n\n## What changed\n\n- First point\n- Second point\n\n### Detail\n\n#### Fine print\n\n> Keep the useful detail.\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n[Reference](https://example.invalid/reference)';
// Conversation text is styled by the one PROSE spec (parts/prose.ts), applied
// by MessageParts; Markdown itself stays neutral for every other consumer.
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {MessageParts} from ${JSON.stringify(resolve(root,'web/src/app/parts/MessageParts.tsx'))};
 import {Markdown} from ${JSON.stringify(resolve(root,'web/src/components/markdown.tsx'))};
 import {PROSE} from ${JSON.stringify(resolve(root,'web/src/app/parts/prose.ts'))};
 const text=${JSON.stringify(content)};
 const view=kind=>kind==='direct'?h(Markdown,{},text):h(MessageParts,{message:{id:kind,role:kind,text,parts:[{kind:'text',text}]},finalReply:true});
 window.fixture={act,PROSE,mount:kind=>{const r=createRoot(document.getElementById('root'));r.render(view(kind));return r}};
`);
async function fixture(t,kind='assistant'){
 const dom=createDomFixture(code),w=dom.window,{act}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(kind);await new Promise(r=>w.setTimeout(r,20))});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {d:w.document,prose:w.fixture.PROSE.split(/\s+/).filter(Boolean)};
}
// Every class on the element and its ancestors: Tailwind `[&_h1]:` variants
// style descendants, so the spec may sit on any wrapper above the heading.
const inherited=el=>{const out=new Set();for(let n=el;n&&n.classList;n=n.parentElement)for(const c of n.classList)out.add(c);return out};
// The heading scale sits ABOVE the 16px body (h3 = body, h4 = ui), all 600; bold is 500; tables are ui-sized.
// Element rules are scoped to rendered markdown (.md-body) so tool details and notices keep their own type.
const scale=['text-body','[&_.md-body_h1]:text-[1.25rem]','[&_.md-body_h1]:font-semibold','[&_.md-body_h2]:text-[1.125rem]','[&_.md-body_h2]:font-semibold','[&_.md-body_h3]:text-body','[&_.md-body_h3]:font-semibold','[&_.md-body_h4]:text-ui','[&_.md-body_h4]:font-semibold','[&_.md-body_strong]:font-medium','[&_[data-streamdown=strong]]:font-medium','[&_.md-body_table]:text-ui'];

test('PROSE spec declares the heading scale, body, bold and table sizes',async t=>{
 const {prose}=await fixture(t);
 for(const token of scale)assert.ok(prose.includes(token),token);
});
for(const kind of ['assistant','user']){
 test(`${kind} conversation text carries the PROSE scale and no legacy .chat-prose`,async t=>{
  const {d}=await fixture(t,kind);
  const h1=d.querySelector('h1');assert.equal(h1?.textContent,'A clearer conversation');
  const classes=inherited(h1);
  for(const token of scale)assert.ok(classes.has(token),token);
  assert.equal(d.querySelector('.chat-prose'),null);
  // MessageResponse keeps only the reading measure; the type scale is PROSE.
  assert.ok(classes.has('max-w-[68ch]'));
 });
}
// cn() runs PROSE through tailwind-merge; a token it treats as conflicting
// silently vanishes from the DOM, so the rendered reply must hold all of them.
test('every PROSE token survives class merging onto the rendered reply',async t=>{
 const {d,prose}=await fixture(t);
 const classes=inherited(d.querySelector('h1'));
 assert.deepEqual(prose.filter(token=>!classes.has(token)),[]);
});
test('actual renderer preserves heading/list/quote/table semantics and content',async t=>{
 const {d}=await fixture(t);
 assert.equal(d.querySelector('h2')?.textContent,'What changed');assert.equal(d.querySelector('h3')?.textContent,'Detail');assert.equal(d.querySelector('h4')?.textContent,'Fine print');
 assert.equal(d.querySelectorAll('li').length,2);assert.equal(d.querySelector('blockquote')?.textContent.trim(),'Keep the useful detail.');
 assert.equal(d.querySelector('[data-streamdown="strong"]')?.textContent,'emphasis');
 assert.deepEqual([...d.querySelectorAll('td')].map(c=>c.textContent),['A','B']);
});
test('inline code and links retain their actual renderer elements and the inline-code look',async t=>{
 const {d}=await fixture(t);
 const code=d.querySelector('code');assert.equal(code?.textContent,'inline-token');
 const classes=inherited(code);
 for(const token of ['[&_code]:!bg-surface-2','[&_code]:!rounded-sm','[&_code]:!text-code','[&_code]:!font-normal'])assert.ok(classes.has(token),token);
 assert.equal(d.querySelector('a')?.getAttribute('href'),'https://example.invalid/reference');
});
test('direct Markdown consumers acquire none of the conversation typography',async t=>{
 const {d}=await fixture(t,'direct');
 assert.equal(d.querySelector('h1')?.textContent,'A clearer conversation');
 assert.equal(d.querySelector('.chat-prose'),null);
 const all=new Set();for(const el of d.querySelectorAll('*'))for(const c of el.classList)all.add(c);
 for(const token of [...scale,'max-w-[68ch]'])assert.equal(all.has(token),false,token);
});
