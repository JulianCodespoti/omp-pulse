import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const code=await bundleDomFixture(`
import {agentSummaryParts} from ${JSON.stringify(resolve(root,'web/src/app/tools/agent-status.tsx'))};
window.fixture={agentSummaryParts};
`);
const parts=(...states)=>{const dom=createDomFixture(code);try{return [...dom.window.fixture.agentSummaryParts(states)].map(p=>p.text)}finally{dom.close()}};
test('summary leads with problems, then running, then finished, omitting empty groups',()=>{
 assert.deepEqual(parts('working','working','done','stopped','done'),['2 running','3 finished']);
 assert.deepEqual(parts('needsYou','failed','working','done'),['1 needs you','1 failed','1 running','1 finished']);
 assert.deepEqual(parts('needsYou','needsYou'),['2 need you']);
 assert.deepEqual(parts(),[]);
});
