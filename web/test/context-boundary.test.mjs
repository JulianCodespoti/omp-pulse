import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const code = await bundleDomFixture(`
 import {newestCompactionBoundary} from ${JSON.stringify(resolve(root,'web/src/domain/messages.ts'))};
 import {createOmpStore,selectContextPercent,selectContextTokens} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {rowUsage} from ${JSON.stringify(resolve(root,'web/src/app/sessions/RowUsage.tsx'))};
 window.fixture={newestCompactionBoundary,createOmpStore,selectContextPercent,selectContextTokens,rowUsage};
`);
const at=Date.parse('2026-10-25T10:00:00Z');
const compact=(id,stamp,tokensAfter)=>({type:'compaction',id,timestamp:new Date(stamp).toISOString(),tokensBefore:99000,...(tokensAfter!==undefined?{tokensAfter}:{})});
function fixture(t){const dom=createDomFixture(code);t.after(()=>{assert.deepEqual(dom.blocked,[]);dom.close()});return dom.window.fixture;}

test('compaction boundary uses only reduced reported context and rejects older pages',t=>{
 const f=fixture(t),current=f.newestCompactionBoundary([compact('old',at-1000,500),compact('current',at,0)],0);
 assert.equal(current.entryId,'current');assert.equal(current.at,at);assert.equal(current.tokens,0);
 assert.equal(f.newestCompactionBoundary([compact('old',at-1000,500)],current.at),null);
 assert.equal(f.newestCompactionBoundary([compact('current',at,0)],current.at),null);
 for(const tokens of [undefined,-1,Infinity,'123'])assert.equal(f.newestCompactionBoundary([compact('unknown',at,tokens)],0).tokens,undefined);
 assert.equal(f.newestCompactionBoundary([{type:'compaction',id:'no-time',tokensAfter:1}],0),null);
 assert.equal(f.newestCompactionBoundary([compact('first',at,7),compact('last',at,11)],0).tokens,11);
});

for(const tokens of [undefined,0,1200])test(`open context selectors stop at compaction (${String(tokens)}) until a later measurement`,t=>{
 const f=fixture(t),store=f.createOmpStore();store.getState().beginSession('/synthetic/context');
 store.setState({sessionModel:{model:'synthetic/model',contextWindow:100000},contextBoundary:{entryId:'c',at,...(tokens!==undefined?{tokens}:{})},messages:[{id:'old',role:'assistant',text:'',parts:[],createdAt:new Date(at-1000),contextSnapshot:{promptTokens:99000}}]});
 assert.equal(f.selectContextPercent(store.getState()),tokens===undefined?undefined:tokens/1000);
 assert.equal(f.selectContextTokens(store.getState())?.used,tokens);
 store.setState({messages:[...store.getState().messages,{id:'new',role:'assistant',text:'',parts:[],createdAt:new Date(at+1000),contextSnapshot:{promptTokens:2200}}]});
 assert.equal(f.selectContextTokens(store.getState()).used,2200);
 store.setState({sessionModel:{model:'synthetic/model',contextWindow:100000,ctxPercent:17}});
 assert.equal(f.selectContextPercent(store.getState()),17);assert.equal(f.selectContextTokens(store.getState()).used,17000);
});

test('session rows lose old context warnings when the folded count is unknown while live figures win',t=>{
 const f=fixture(t),store=f.createOmpStore(),base={path:'/synthetic/context',title:'Synthetic',model:'synthetic/model',costTotal:2.5};
 store.getState().setSessions([{...base,ctxTokens:99000}]);
 store.getState().setSessions([{...base}]);
 assert.equal(f.rowUsage(store.getState().sessions[0]),null);
 const live=f.rowUsage({...base,ctxTokens:99000,ctxPercent:12});assert.equal(live.percent,12);assert.equal('cost' in live,false);
});

test('delayed compaction history clears only measurements predating that boundary',t=>{
 const f=fixture(t),store=f.createOmpStore();store.getState().beginSession('/synthetic/context');
 store.getState().setSessionModel({model:'synthetic/model',contextWindow:100000,ctxPercent:99,contextMeasuredAfter:at-1000});
 store.getState().setContextBoundary({entryId:'c1',at});
 assert.equal(f.selectContextPercent(store.getState()),undefined);
 store.getState().setSessionModel({ctxPercent:12,contextMeasuredAfter:at+3000});
 store.getState().setContextBoundary({entryId:'c2',at:at+2000});
 assert.equal(f.selectContextPercent(store.getState()),12);
 store.getState().setSessionModel({ctxPercent:null},'file');
 assert.equal(f.selectContextPercent(store.getState()),12);
 store.getState().setContextBoundary({entryId:'c3',at:at+4000,tokens:0});
 assert.equal(f.selectContextPercent(store.getState()),0);
 store.getState().setContextBoundary({entryId:'old',at:at-2000,tokens:99000});
 store.getState().setSessionModel({ctxPercent:99,contextMeasuredAfter:at-1000});
 assert.equal(f.selectContextTokens(store.getState()).used,0,'late retained settings cannot resurrect pre-compaction pressure');
 store.getState().beginSession('/synthetic/other');
 assert.equal(store.getState().contextBoundary,null);
});
