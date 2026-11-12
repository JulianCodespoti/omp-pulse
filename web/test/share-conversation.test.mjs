import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

const code=await bundleDomFixture(`
import {conversationMarkdown} from ${JSON.stringify(resolve(root,'web/src/app/share-conversation.ts'))};
window.markdown=conversationMarkdown;
`,[{name:'stub-notices',resolveId(id,importer){return importer?.endsWith('/share-conversation.ts')&&id.endsWith('Notices')?'\0notices':null},load(id){return id==='\0notices'?'export const showToast=()=>{};':null}}]);
const dom=createDomFixture(code);
test.after(()=>{assert.deepEqual(dom.blocked,[]);dom.close()});

const tool=callId=>({kind:'tool',callId,name:'bash',args:{},state:'ok'});
const user=(id,text)=>({id,role:'user',text,parts:[{kind:'text',text}]});
const assistant=(id,text,parts=[])=>({id,role:'assistant',text,parts:[...(text?[{kind:'text',text}]:[]),...parts]});

test('conversation Markdown labels turns and summarises each run of tool calls on one line',()=>{
  const out=dom.window.markdown([
    user('u1','Fix the bug'),
    assistant('a1','',[tool('t1'),tool('t2')]),
    assistant('a2','Looking at it.',[tool('t3')]),
    assistant('a3','Done.'),
    user('u2','Thanks'),
    assistant('a4','',[tool('t4')]),
  ],'Bug hunt');
  assert.equal(out,[
    '# Bug hunt','',
    '**You**','','Fix the bug','',
    '_Used 2 tools_','',
    '**omp**','','Looking at it.','',
    '_Used 1 tool_','',
    '**omp**','','Done.','',
    '**You**','','Thanks','',
    '_Used 1 tool_','',
  ].join('\n'));
});

test('empty messages and a blank title are skipped or defaulted',()=>{
  const out=dom.window.markdown([user('u1','  '),assistant('a1','Hello')],' ');
  assert.equal(out,'# Conversation\n\n**omp**\n\nHello\n');
});
