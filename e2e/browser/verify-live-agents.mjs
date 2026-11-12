#!/usr/bin/env node
// The workspace Agents tab exposes actual desktop-agent messages and tool activity.
// This isolated browser acceptance fixture uses the app's real WebSocket/UI
// path plus intercepted passive roster/transcript responses. It never asks a
// real agent to run the synthetic tool shown in the transcript.
//
// Rows remain qualified as last received. Tapping a row must open a dedicated
// read-only conversation, and Back must restore its roster selection/focus.
// This script is a browser acceptance target, not evidence of an executed run.
//
// TWO TRAPS, both silent, both cost real time here:
//
//  * `page.evaluate` runs in an ISOLATED world and cannot see a global written
//    by an injected main-world script — `window.__sockets` reads as undefined
//    and looks exactly like "the app never opened a socket". The DOM is shared
//    across worlds, so the injected side listens for a CustomEvent and reports
//    back through sessionStorage.
//  * The app's CSP forbids `unsafe-eval`, so injection must go through
//    `Page.addScriptToEvaluateOnNewDocument`.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
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

const CWD = "/tmp/verify-live-agents";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-verify-live-agents`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-08-20T12-50-00-000Z_019ff400-0000-7000-0000-0000000000e1.jsonl`;
writeFileSync(
  file,
  [
    {
      type: "session",
      id: "019ff400-0000-7000-0000-0000000000e1",
      cwd: CWD,
      title: "Live agents fixture",
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "start the fan-out" }] },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(file, when, when);

const fixtureNow = Date.now();
const fixtureConnectionId = "synthetic-agent-read-lease";
const fixtureAgents = [
  { id: "ag-1", displayName: "PaymentsRefactor", kind: "sub", parentId: "host", status: "running", createdAt: fixtureNow - 45000, lastActivity: fixtureNow - 1000, hasSessionFile: true },
  { id: "ag-2", displayName: "SchemaScout", kind: "sub", parentId: "host", status: "parked", createdAt: fixtureNow - 90000, lastActivity: fixtureNow - 2000, hasSessionFile: true },
  { id: "ag-3", displayName: "FlakyTestHunt", kind: "sub", parentId: "host", status: "aborted", createdAt: fixtureNow - 120000, lastActivity: fixtureNow - 3000, hasSessionFile: false },
  { id: "host", displayName: "main", kind: "main", status: "running", createdAt: fixtureNow, lastActivity: fixtureNow, hasSessionFile: true },
];
const fixtureTranscript = [
  { type: "message", id: "agent-user", message: { role: "user", content: [{ type: "text", text: "AGENT_REQUEST: review the synthetic payments handler" }] } },
  { type: "message", id: "agent-call", message: { role: "assistant", content: [
    { type: "text", text: "AGENT_PROGRESS: checking the synthetic handler" },
    { type: "toolCall", id: "fixture-tool", name: "inspect_fixture", arguments: { path: "/synthetic/payments.ts", purpose: "conversation acceptance fixture" } },
  ] } },
  { type: "message", id: "agent-result", message: { role: "toolResult", toolCallId: "fixture-tool", toolName: "inspect_fixture", content: [{ type: "text", text: "AGENT_TOOL_OUTPUT: verified the synthetic handler" }], isError: false } },
  { type: "message", id: "agent-final", message: { role: "assistant", content: [{ type: "text", text: "AGENT_FINAL_REPLY: the fixture is ready" }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const fixtureTranscriptBytes = Buffer.byteLength(fixtureTranscript, "utf8");
const fixtureAuthority = {
  daemonInstanceId: "synthetic-desktop-daemon", revision: 1000000, bindingEpoch: 3,
  owner: { kind: "collab", roomId: "synthetic-desktop-room", peerId: "1", canWrite: true },
  confidence: "confirmed", connection: "connected", turn: "idle", observedAt: fixtureNow,
  activity: null, capabilities: { read: true, stream: true, control: true, send: true, answer: true },
};

const webApp = await startWebApp({ base: BASE, port: 5216 });
let browser;

try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-live-agents-`)}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));

  const rosterReads = [], transcriptReads = [], forbiddenAgentRpc = [], fixtureErrors = [], directReplies = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void (async () => {
      const url = new URL(request.url());
      const reply = (status, body) => request.respond({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
      if (url.pathname === "/api/rpc") {
        let body;
        try { body = JSON.parse(request.postData() || "{}"); } catch { body = {}; }
        if (["get_desktop_agent_follow_up", "desktop_agent_follow_up"].includes(body.command)) {
          const params = body.params ?? {};
          if (body.sessionPath !== file || params.agentId !== "ag-1" || params.expectedCreatedAt !== fixtureAgents[0].createdAt
              || params.expectedConnectionId !== fixtureConnectionId || params.daemonInstanceId !== fixtureAuthority.daemonInstanceId
              || params.bindingEpoch !== fixtureAuthority.bindingEpoch || request.headers().authorization !== `Bearer ${TOKEN}`) {
            fixtureErrors.push("Direct follow-up lost its exact desktop target or authentication");
            await reply(409, { ok: false, error: "Synthetic agent identity changed" });
          } else if (body.command === "get_desktop_agent_follow_up") {
            await reply(200, { ok: true, data: { available: true } });
          } else {
            directReplies.push(params);
            await reply(200, { ok: true, data: { delivery: "handoff" } });
          }
          return;
        }
        if (["get_subagents", "get_subagent_messages", "steer_subagent", "cancel_subagent"].includes(body.command)) {
          forbiddenAgentRpc.push(body.command);
          await reply(403, { ok: false, code: "session_owned_by_terminal", error: "Synthetic desktop fixture must use the passive route" });
          return;
        }
      }
      if (!["/api/agents/roster", "/api/agents/transcript"].includes(url.pathname)) {
        await request.continue();
        return;
      }
      // Only the throwaway session created above can resolve fixture data.
      if (request.method() !== "GET" || url.searchParams.get("session") !== file || request.headers().authorization !== `Bearer ${TOKEN}`) {
        fixtureErrors.push("Unexpected passive route method, session or authentication");
        await reply(400, { ok: false, code: "invalid_request", error: "Unexpected isolated fixture target" });
        return;
      }
      if (url.pathname === "/api/agents/roster") {
        rosterReads.push(Object.fromEntries(url.searchParams));
        await reply(200, { ok: true, agents: fixtureAgents.filter((agent) => agent.kind === "sub"), connectionId: fixtureConnectionId });
        return;
      }
      const query = Object.fromEntries(url.searchParams);
      transcriptReads.push(query);
      if (query.agentId !== "ag-1" || query.expectedCreatedAt !== String(fixtureAgents[0].createdAt) || query.expectedConnectionId !== fixtureConnectionId) {
        fixtureErrors.push("Transcript read lost its exact agent/creation/connection identity");
        await reply(404, { ok: false, code: "transcript_unavailable", error: "Unknown synthetic agent identity" });
        return;
      }
      const fromByte = Number(query.fromByte);
      if (!Number.isSafeInteger(fromByte) || ![0, fixtureTranscriptBytes].includes(fromByte)) {
        fixtureErrors.push("Transcript read used an unexpected byte cursor");
        await reply(400, { ok: false, code: "invalid_request", error: "Invalid synthetic byte cursor" });
        return;
      }
      await reply(200, { ok: true, agentId: "ag-1", connectionId: fixtureConnectionId, fromByte, nextByte: fixtureTranscriptBytes, text: fromByte === 0 ? fixtureTranscript : "", reset: false });
    })().catch(async (error) => {
      fixtureErrors.push(String(error));
      if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
    });
  });

  const cdp = await page.createCDPSession();
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const Native = window.WebSocket;
      const sockets = [];
      function Patched(...a) {
        const s = new Native(...a); sockets.push(s);
        const send = s.send.bind(s);
        s.send = raw => {
          let frame; try { frame = JSON.parse(raw); } catch {}
          if (frame?.type === "collab-ui-response" && frame.pulseQuestionToken?.startsWith("fixture-browser:")) {
            const frames = JSON.parse(sessionStorage.getItem("test:answers") || "[]");
            frames.push(frame); sessionStorage.setItem("test:answers", JSON.stringify(frames)); return;
          }
          send(raw);
        };
        return s;
      }
      Patched.prototype = Native.prototype;
      Object.assign(Patched, Native);
      window.WebSocket = Patched;
      window.addEventListener("test:pushframe", (e) => {
        let n = 0;
        for (const s of sockets) {
          try { s.dispatchEvent(new MessageEvent("message", { data: e.detail })); n++; } catch {}
        }
        sessionStorage.setItem("test:delivered", String(n));
      });
      window.addEventListener("test:countsockets", () => {
        sessionStorage.setItem("test:sockets", String(sockets.length));
      });
    })();`,
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Live agents fixture")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await new Promise((r) => setTimeout(r, 3000));

  const nSockets = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("test:countsockets"));
    return sessionStorage.getItem("test:sockets");
  });
  check("the app opened a websocket", Number(nSockets) > 0, `sockets: ${nSockets}`);

  // The exact shape omp's host broadcasts: AgentRegistry entries, whose status
  // is one of running | idle | parked | aborted (agent-registry.ts:31).
  const delivered = await page.evaluate(({agents, sessionState}) => {
    const payload = JSON.stringify({ type: "event", sessionState, event: { type: "collab_agents", agents } });
    window.dispatchEvent(new CustomEvent("test:pushframe", { detail: payload }));
    return Number(sessionStorage.getItem("test:delivered") || 0);
  }, {agents: fixtureAgents, sessionState: fixtureAuthority});
  check("the collab_agents frame reached the client", delivered > 0, `sockets written: ${delivered}`);
  await new Promise((r) => setTimeout(r, 1500));

  // Agents are a page of the chat's tab row. While any agent works or waits
  // the Agents tab carries a count badge, and its accessible name says it.
  const badge = await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='agents']");
    return {
      text: (document.querySelector("[data-testid='tab-badge-agents']")?.textContent || "").trim(),
      tone: document.querySelector("[data-testid='tab-badge-agents']")?.getAttribute("data-tone") ?? null,
      label: tab?.getAttribute("aria-label") ?? null,
    };
  });
  // ag-1 running, ag-2 parked, ag-3 aborted (stopped); the host's main agent is
  // not a subagent. Exactly one is working and none needs the user.
  check("the Agents tab's badge counts the working desktop agent", badge.text === "1" && badge.tone === "running" && badge.label === "Agents, 1 working", JSON.stringify(badge));
  await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='agents']");
    if (tab instanceof HTMLElement) tab.click();
  });
  await page.waitForSelector("[data-testid='workspace-tab-agents'] [data-testid='agents-tab']", { timeout: 8000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 2500));
  check(
    "tapping the tab shows the Agents page",
    await page.evaluate(() => document.querySelector("[data-testid='workspace-tabs'] [data-value='agents']")?.getAttribute("aria-selected") === "true"),
  );

  const seen = await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tab-agents']");
    return tab ? tab.textContent || "" : "";
  });

  check(
    "the Agents tab lists the received desktop subagents",
    /PaymentsRefactor/.test(seen) && /SchemaScout/.test(seen) && /FlakyTestHunt/.test(seen),
    seen.slice(0, 160),
  );
  check(
    "the computer's roster is the list, without the transcript fallback group",
    !/From this chat/.test(seen),
    seen.slice(0, 160),
  );
  check("each agent carries its status word", /Running/.test(seen) && /Parked/.test(seen) && /Stopped/.test(seen));
  check(
    "the host's own main agent is not listed as a subagent",
    !/\bmain\b/.test(seen),
    seen.slice(0, 200),
  );
  const rosterScroll = await page.$eval('[data-testid="agent-roster"]', (roster) => roster.closest('[data-slot="scroll-area-viewport"]').scrollTop);
  await page.click('[data-desktop-agent="ag-1"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-transcript"]')?.textContent?.includes("AGENT_FINAL_REPLY"), { timeout: 10000 });
  const conversation = await page.$eval('[data-testid="agent-transcript"]', (node) => ({
    text: node.textContent || "", messages: node.querySelectorAll("[data-agent-message]").length,
    interactiveInputs: node.querySelectorAll('input, textarea, [contenteditable="true"]').length,
    forbiddenControls: Array.from(node.querySelectorAll("button")).some((button) => /^(Send|Redirect|Stop agent|Stop command|Approve|Answer)$/.test((button.getAttribute("aria-label") || button.textContent || "").trim())),
  }));
  check("row opens the agent's own request, progress and final reply", /AGENT_REQUEST/.test(conversation.text) && /AGENT_PROGRESS/.test(conversation.text) && /AGENT_FINAL_REPLY/.test(conversation.text) && conversation.messages === 3, conversation.text.slice(0, 240));
  check("the destination is conversation content rather than metadata or parent task", !/start the fan-out|Session file|Created|Agent ID|View task in conversation/.test(conversation.text));
  check("agent conversation contains no composer or parent controls", conversation.interactiveInputs === 0 && !conversation.forbiddenControls);
  // A call is a quiet row; a tap opens its whole detail in a sheet, the
  // arguments behind its Details disclosure.
  await page.click('[data-testid="agent-transcript"] [data-testid="tool-row"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="tool-sheet"]')?.textContent?.includes("AGENT_TOOL_OUTPUT"), { timeout: 10000 });
  // The sheet may still be sliding in; a pointer click finds no stable point.
  await page.$eval('[data-testid="tool-sheet"] [data-testid="tool-args"] button', (button) => button.click());
  const expandedTool = await page.$eval('[data-testid="tool-sheet"]', (node) => node.textContent || "");
  check("the tool's detail reveals actual arguments and result", expandedTool.includes("/synthetic/payments.ts") && expandedTool.includes("conversation acceptance fixture") && expandedTool.includes("AGENT_TOOL_OUTPUT"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="tool-sheet"]'), { timeout: 5000 });
  check("desktop transcript reads use the passive identity-fenced byte contract", transcriptReads.length > 0 && transcriptReads[0].fromByte === "0" && fixtureErrors.length === 0, fixtureErrors.join(" | "));
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="desktop-agent-reply"] textarea');
    return input && !input.disabled;
  }, {timeout: 10000});
  await page.type('[data-testid="desktop-agent-reply"] textarea', "Please double-check the second patch.");
  await page.evaluate(() => {
    const send = document.querySelector('[data-testid="desktop-agent-reply-send"]');
    send.click(); send.click();
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-agent-reply"]')?.textContent?.includes("Handed to the desktop connection"));
  check("direct follow-up is distinct from Discuss and same-turn duplicate taps dispatch once",
    directReplies.length === 1 && directReplies[0].text === "Please double-check the second patch."
    && await page.$('[data-testid="agent-prepare-response"]') !== null);
  await page.click('[data-testid="agents-tab"] button[aria-label="Back to agents"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-transcript"]') && document.querySelector('[data-testid="agent-roster"]')?.hidden === false);
  const returned = await page.evaluate(() => {
    const roster = document.querySelector('[data-testid="agent-roster"]');
    const row = document.querySelector('[data-desktop-agent="ag-1"]');
    return { header: Boolean(document.querySelector('[data-testid="agents-tab"] button[aria-label="Back to agents"]')), selected: row?.getAttribute("aria-current"), focused: document.activeElement === row, scrollTop: roster?.closest('[data-slot="scroll-area-viewport"]')?.scrollTop };
  });
  check("Back restores the roster, selected row, focus and reading position", !returned.header && returned.selected === "true" && returned.focused && returned.scrollTop === rosterScroll, JSON.stringify(returned));
  const readsAtBack = transcriptReads.length;
  // Authority/connection changes create a new roster visit; they are not polling.
  const rosterReadsAtBack = rosterReads.length;
  await new Promise((resolve) => setTimeout(resolve, 3200));
  check("leaving the conversation stops its tail reads", transcriptReads.length === readsAtBack);
  check("the passive roster is not polled", rosterReads.length === rosterReadsAtBack, `reads: ${rosterReadsAtBack} -> ${rosterReads.length}`);
  const pushQuestion = (event) => page.evaluate(event => {
    window.dispatchEvent(new CustomEvent("test:pushframe", {detail:JSON.stringify({type:"event",event})}));
  }, event);
  const stamp = revision => ({sessionPath:file,generation:"fixture-browser",revision});
  const question = (id, checked) => ({
    reqId:id, pulseQuestionToken:`fixture-browser:${id}`, kind:"select", title:"Which checks should run? (1/2)",
    options:["Unit checks","Browser checks",...(checked.length ? ["Done selecting"] : []),"Other"],
    selectionMarker:"checkbox", checkedIndices:checked, markableCount:2,
  });
  await page.evaluate(() => document.querySelector('[data-testid="workspace-close"]')?.click());
  await pushQuestion({type:"collab_ui_snapshot",complete:true,lifecycle:stamp(1),requests:[question(70,[])]});
  await page.waitForSelector('[data-testid="collab-dialog"] [role="checkbox"]', { visible: true });
  await page.locator('[data-testid="collab-dialog"] [role="checkbox"]').click();
  check("multi-select waits for desktop confirmation rather than optimistic selection",
    await page.$eval('[data-testid="collab-dialog"] [role="checkbox"]', node => node.getAttribute("aria-checked") === "false" && node.disabled));
  await pushQuestion({type:"collab_ui_request_end",reqId:70,pulseQuestionToken:"fixture-browser:70",lifecycle:stamp(2)});
  await pushQuestion({type:"collab_ui_request",request:question(71,[0]),lifecycle:stamp(3)});
  await page.waitForSelector('[data-testid="collab-dialog"] [role="checkbox"][aria-checked="true"]');
  check("desktop-selected answers and native Continue actions are visually and semantically distinct",
    await page.$$eval('[data-testid="collab-selection-actions"] button', nodes => nodes.length === 2 && nodes.every(node => node.getAttribute("role") !== "checkbox")));
  await page.locator('[data-testid="collab-selection-actions"] button')
    .filter(button => button.textContent?.trim() === "Done selecting").click();
  const answers = await page.evaluate(() => JSON.parse(sessionStorage.getItem("test:answers") || "[]"));
  check("toggle and Continue preserve native values with fresh question identities",
    answers.length === 2 && answers[0].reqId === 70 && answers[0].value === "Unit checks"
    && answers[1].reqId === 71 && answers[1].value === "Done selecting");
  await pushQuestion({type:"collab_ui_request_end",reqId:71,pulseQuestionToken:"fixture-browser:71",lifecycle:stamp(4)});
  check("desktop navigation never uses generic agent RPC", forbiddenAgentRpc.length === 0, forbiddenAgentRpc.join(" | "));
  check("fixture routes stayed isolated and correctly authenticated", fixtureErrors.length === 0, fixtureErrors.join(" | "));
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

} finally {
  await browser?.close();
  webApp.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures);
