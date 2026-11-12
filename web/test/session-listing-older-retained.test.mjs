import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

// The first-page revalidation merges rows the owner already paged in with
// "Load more". It used to append them to the cached page object itself, so the
// NEXT changed first page treated them as previous-first-page rows and dropped
// them while keeping the deeper cursor: they vanished and Load more skipped them.
const code = await bundleDomFixture(`
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
window.fixture = () => {
 const store = createOmpStore(), controller = new OmpSessionController(store, 'synthetic-token');
 let payload = null;
 controller.fetchAuthed = async () => ({status:200, ok:true, headers:new Headers({ETag:'"fixture"'}), json:async()=>payload});
 controller.hydrateSessionListFromCache = async () => {};
 return {store,controller,payload(value){payload=JSON.parse(JSON.stringify(value));}};
};
`);

const row = path => ({path});
const paths = store => store.getState().sessions.map(session => session.path).join(',');

test('older paged-in rows survive repeated first-page changes', async t => {
 const dom=createDomFixture(code), w=dom.window;
 Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,SyntaxError,AbortController});
 const f=w.fixture();
 t.after(()=>{f.controller.dispose();assert.deepEqual(dom.blocked,[]);dom.close();});

 f.payload({sessions:[row('/a'),row('/b')],nextCursor:'c1'});
 await f.controller.loadSessions({query:'synthetic'});
 f.payload({sessions:[row('/c'),row('/d')],nextCursor:null});
 await f.controller.loadMoreSessions();
 assert.equal(paths(f.store),'/a,/b,/c,/d');

 f.payload({sessions:[row('/new'),row('/b')],nextCursor:'c1'});
 await f.controller.loadSessions();
 assert.equal(paths(f.store),'/new,/b,/c,/d');

 f.payload({sessions:[row('/newer'),row('/new')],nextCursor:'c1'});
 await f.controller.loadSessions();
 assert.equal(paths(f.store),'/newer,/new,/c,/d','a second first-page change must keep the paged-in archive');
 assert.equal(f.store.getState().sessionsNextCursor,null);
});
