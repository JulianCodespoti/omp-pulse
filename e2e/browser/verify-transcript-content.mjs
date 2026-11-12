#!/usr/bin/env node
// Proof that the transcript renders every kind of content omp can emit.
//
// `partsFromContent` is a switch with a `default: break`, and
// `entryToUiMessage` gates on `role !== "user" && role !== "assistant"`. Both
// drop anything they do not recognise SILENTLY — no placeholder, no gap, no
// console warning. Three shapes were being thrown away:
//
//   * `anthropicServerTool` — Anthropic's native server-side tools. A turn that
//     searched the web rendered as the answer alone, so it looked like the
//     model simply knew.
//   * image blocks inside a `tool_result` — reading a screenshot produced a
//     base64 JSON blob in the output pane and no picture.
//   * `bashExecution` / `pythonExecution` turns — dropped whole, so background
//     job output and broker-injected async results never appeared at all.
//
// Everything here is a fixture: no model calls, no cost.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";
const puppeteer = await loadPuppeteer();
const { OMP_PULSE_TEST_BASE:BASE, OMP_PULSE_TEST_TOKEN:TOKEN, OMP_PULSE_TEST_SESSIONS:S } = process.env;
const SESSIONS = S;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682");
  process.exit(2);
}
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CWD="/tmp/omp-ct-cwd"; mkdirSync(CWD,{recursive:true});
const dir=`${S}/-tmp-transcript-content`; mkdirSync(dir,{recursive:true});
const sp=`${dir}/2026-08-21T16-00-00-000Z_019ff400-0000-7000-0000-000000180cae.jsonl`;
const PNG="iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR42mNgYPhPIhrVMKph2GoAAJLb/wHQPqPSAAAAAElFTkSuQmCC";
const es=[
 {id:"e-s",type:"session",cwd:CWD,title:"Content types"},
 {id:"e-u-0",type:"message",timestamp:"2026-08-21T16:00:00.000Z",message:{id:"m0",role:"user",content:[{type:"text",text:"MARKER_USER_TURN"}]}},
 // F1: Anthropic native server tool (web search) blocks
 {id:"e-a-0",type:"message",timestamp:"2026-08-21T16:00:01.000Z",message:{id:"m1",role:"assistant",content:[
   {type:"anthropicServerTool",block:{type:"server_tool_use",id:"srv1",name:"web_search",input:{query:"MARKER_SEARCH_QUERY"}}},
   {type:"anthropicServerTool",block:{type:"web_search_tool_result",tool_use_id:"srv1",content:[{title:"MARKER_SEARCH_RESULT",url:"https://example.com"}]}},
   {type:"text",text:"MARKER_ANSWER_AFTER_SEARCH"}]}},
 // F3: tool call whose RESULT carries an image
 {id:"e-a-1",type:"message",timestamp:"2026-08-21T16:00:02.000Z",message:{id:"m2",role:"assistant",content:[
   {type:"toolCall",id:"call1",name:"read",arguments:{path:"/tmp/shot.png"}}]}},
 {id:"e-tr-1",type:"message",timestamp:"2026-08-21T16:00:03.000Z",message:{id:"m3",role:"toolResult",toolCallId:"call1",toolName:"read",content:[{type:"image",data:PNG,mimeType:"image/png"}]}},
 // F4: bashExecution role, as omp persists it (session/messages.ts
 // BashExecutionMessage): command, output, exitCode, cancelled, truncated and
 // no `content`. A `content` array here was a shape omp never writes.
 {id:"e-be-0",type:"message",timestamp:"2026-08-21T16:00:04.000Z",message:{id:"m4",role:"bashExecution",command:"echo MARKER_BASH_COMMAND",output:"MARKER_BASH_EXECUTION\n",exitCode:0,cancelled:false,truncated:false,timestamp:Date.parse("2026-08-21T16:00:04.000Z")}},
];
writeFileSync(sp,es.map(e=>JSON.stringify(e)).join("\n")+"\n");
const w=new Date(Date.now()-60000); utimesSync(sp,w,w);
const H={Authorization:`Bearer ${TOKEN}`,"content-type":"application/json"};
await fetch(`${BASE}/api/open`,{method:"POST",headers:H,body:JSON.stringify({sessionPath:sp})});
await new Promise(r=>setTimeout(r,13000));
const webApp=await startWebApp({base:BASE,port:5291});
const profile=mkdtempSync(`${tmpdir()}/ct-`);
try{
 const b=await puppeteer.launch({headless:true,executablePath:chromium(),protocolTimeout:20000,args:["--no-sandbox",`--user-data-dir=${profile}`]});
 const p=await b.newPage(); await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await openPairedPage(p, webApp.url, TOKEN, {waitUntil:"networkidle0"}); await p.reload({waitUntil:"networkidle0"});
 await showSessionsList(p);
 await p.waitForSelector("[data-testid='session-row']",{timeout:20000});
 await p.evaluate(()=>{const r=document.querySelector("[data-testid='session-row']"); if(r instanceof HTMLElement) r.click();});
 await new Promise(r=>setTimeout(r,5000));
 // Expand any collapsed tool output so the result is in the DOM.
 // Expand everything: click every button inside a chat message twice over.
 for (let pass=0; pass<2; pass++) {
   await p.evaluate(()=>{document.querySelectorAll("[data-testid='chat-message'] button").forEach(b=>{ try{ b.click(); }catch{} });});
   await new Promise(r=>setTimeout(r,1200));
 }

 const r=await p.evaluate(()=>{const t=document.body.textContent||"";
  return {
   msgs:document.querySelectorAll("[data-testid='chat-message']").length,
   imgs:document.querySelectorAll("img").length,
   user:t.includes("MARKER_USER_TURN"),
   searchQuery:t.includes("MARKER_SEARCH_QUERY"),
   searchResult:t.includes("MARKER_SEARCH_RESULT"),
   answer:t.includes("MARKER_ANSWER_AFTER_SEARCH"),
   bashExec:t.includes("MARKER_BASH_COMMAND")&&t.includes("MARKER_BASH_EXECUTION"),
   rawImageJson:/"type":\s*"image"/.test(t)||t.includes("iVBORw0KGgo"),
  };});

 check("the user turn renders", r.user);
 check("the assistant's answer renders", r.answer);
 check("a native server-tool call is shown, not silently dropped", r.searchQuery);
 check("an image returned by a tool is displayed", r.imgs >= 1, `img elements: ${r.imgs}`);
 check("a tool image is not dumped as base64 JSON", r.rawImageJson === false);
 check("a bashExecution turn appears in the transcript", r.bashExec);
 check("every turn in the fixture is present", r.msgs >= 4, `chat messages: ${r.msgs}`);
 await b.close();
} finally { webApp.stop(); rmSync(profile,{recursive:true,force:true,maxRetries:3}); }

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures);
