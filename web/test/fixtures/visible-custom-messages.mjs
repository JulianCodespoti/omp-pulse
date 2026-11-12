import { createRequire } from "node:module";
import { resolve } from "node:path";
import { root } from "../support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));

// Bundle with bundleDomFixture for a standalone, offline browser smoke page.
// window.fixture exposes canonical history, live normalization, and pagination.
export const visibleCustomMessagesSource = `
  import { createElement as h, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { MessageParts } from ${JSON.stringify(resolve(root, "web/src/app/parts/MessageParts.tsx"))};
  import { entriesToTranscript, customMessageToTranscript, provisionalTextFromPartial } from ${JSON.stringify(resolve(root, "web/src/domain/messages.ts"))};
  import { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import { buildTimeline } from ${JSON.stringify(resolve(root, "web/src/domain/timeline.ts"))};
  const store = createOmpStore();
  store.getState().beginSession('/synthetic/visible-custom');
  let mounted;
  function render() {
    mounted.render(h('main', {}, store.getState().messages.map(message =>
      h('section', {key: message.id, 'data-message-id': message.id},
        h(MessageParts, {message, finalReply: true})))));
  }
  window.fixture = {
    act, store, entriesToTranscript, customMessageToTranscript, provisionalTextFromPartial, buildTimeline,
    mount() { mounted = createRoot(document.getElementById('root')); render(); return mounted; },
    history(entries, method = 'setHistory') {
      const transcript = entriesToTranscript(entries);
      store.getState()[method](transcript.messages);
      store.getState().settleAgents(transcript.settledAgents);
      render();
    },
    anchoredLive(message) {
      const transcript = customMessageToTranscript(message);
      if (!transcript) return;
      store.getState().mergeMessages(transcript.messages);
      store.getState().settleAgents(transcript.settledAgents);
      render();
    },
    smoke() {
      this.history([
        {type: 'custom_message', id: 'notice', customType: 'extension-summary', display: true,
          timestamp: '2026-10-23T10:00:00Z', content: '## Extension result\\n\\nReadable **summary**, not a model reply.'},
        {type: 'custom_message', id: 'internal', customType: 'internal-context', display: false,
          content: 'INTERNAL INSTRUCTIONS MUST STAY HIDDEN'},
        {type: 'custom_message', id: 'task-result', customType: 'async-result', display: true,
          details: {jobs: [{type: 'task', jobId: 'Worker'}]},
          content: [{type: 'text', text: 'Worker finished.\\n'},
            {type: 'text', text: '<task-result id="Worker" status="completed">Done.</task-result>'}]}
      ]);
    }
  };
`;
