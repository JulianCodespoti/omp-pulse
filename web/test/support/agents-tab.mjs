import { resolve } from "node:path";

import { root } from "./react-dom.mjs";

// Bundle source that mounts the Agents tab the way the app does: the open chat
// publishes a workspace host, and the panel state decides `active`. Exposes
// `window.agentsTab`; prepend to a fixture's own source.
//
//   const tab = window.agentsTab.mount({ hosts: [agentsTab.host(controller)], strict });
//   tab.render(open = true, sessionPath = '/synthetic/a', hostIndex = 0);
//
// `open` drives the real panel store (openWorkspace('agents') / closePanels()),
// so a tab that closes itself (a jump, a drafted reply) is observable through
// `agentsTab.workspace()` and `agentsTab.jumps`. `agentsTab.Tab` ({ host,
// sessionPath }) is the same element for fixtures that compose their own app.
export function agentsTabHarness(require) {
  const src = (path) => JSON.stringify(resolve(root, path));
  return `
import { createElement as __agentsH, StrictMode as __AgentsStrict } from ${JSON.stringify(require.resolve("react"))};
import { createRoot as __agentsCreateRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
import { AgentsTab as __AgentsTab } from ${src("web/src/app/tools/AgentsTab.tsx")};
import { useProvideWorkspaceHost as __useProvideWorkspaceHost } from ${src("web/src/app/tools/workspace-host.ts")};
import { closePanels as __closePanels, openWorkspace as __openWorkspace, usePanels as __usePanels } from ${src("web/src/app/nav/panels.ts")};
const __agentsJumps = [], __agentsBranched = [], __agentsPanel = { workspace: null };
function __AgentsHost({ host, sessionPath }) {
  __useProvideWorkspaceHost(host);
  const panels = __usePanels();
  __agentsPanel.workspace = panels.workspace;
  const shown = panels.workspace === "agents";
  return __agentsH(__AgentsTab, { sessionPath, active: shown, focused: shown });
}
window.agentsTab = {
  jumps: __agentsJumps,
  branched: __agentsBranched,
  Tab: __AgentsHost,
  workspace: () => __agentsPanel.workspace,
  open: () => __openWorkspace("agents"),
  close: () => __closePanels(),
  // Hosts must be stable: create each once, outside render.
  host: (controller, extra = {}) => ({
    controller,
    jumpTo: (entryId) => __agentsJumps.push(entryId),
    onBranched: (path) => __agentsBranched.push(path),
    ...extra,
  }),
  mount({ hosts, strict = false, sessionPath: initialPath = "/synthetic/a" } = {}) {
    const r = __agentsCreateRoot(document.getElementById("root"));
    const render = (open = true, sessionPath = initialPath, hostIndex = 0) => {
      if (open) __openWorkspace("agents");
      else __closePanels();
      const tab = __agentsH(__AgentsHost, { host: hosts[Number(hostIndex)], sessionPath });
      r.render(strict ? __agentsH(__AgentsStrict, null, tab) : tab);
    };
    render();
    return { render, unmount: () => r.unmount() };
  },
};
`;
}
