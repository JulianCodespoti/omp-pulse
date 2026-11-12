// Bundler plugin for fixtures that mount the real App. The plugin host's catalogue
// request is network I/O these fixtures deliberately block or script, so every
// importer of runtime/plugin-host (App, use-plugin-host, PluginsSettings) gets this
// inert host instead. It matches by module path, not importer, so no consumer can
// pull the real module back in. Any OTHER network call still reaches the fixture's guard.
//
// Inert by default. A fixture that wants to observe or drive the host sets
// `window.pluginHostTest = { state?, ... }` before rendering; then:
//   retainKey(slot, key, context)   -> pushes [slot, key, context] into keyRetains
//   (its release)                   -> pushes [slot, key] into keyReleases
//   dispatchAction(...args)         -> pushes the full [pluginId, slot, action, item, key] into dispatches
//   setOpenSession(session)         -> pushes into openSessions
//   setOptions(pluginId, values)    -> pushes [pluginId, values] into options, then resolves
//   getState()                      -> `pluginHostTest.state`, with `keyed` filled in when absent
const ID = '\0plugin-host-stub';

const source = `
const KEYED = ['session.row', 'session.menu', 'transcript.tool', 'transcript.message'];
const emptyKeyed = () => Object.fromEntries(KEYED.map((slot) => [slot, {}]));
const state = {
  catalog: [],
  catalogError: null,
  views: { 'composer.status': [], 'composer.actions': [], drawer: [], page: [], 'session.row': [], 'session.menu': [], 'transcript.tool': [], 'transcript.message': [] },
  keyed: emptyKeyed(),
  runtimes: {},
  haltedAfterCrash: false,
};
const hook = () => (typeof window !== 'undefined' ? window.pluginHostTest : undefined);
// useSyncExternalStore needs the same snapshot until something changes.
const filled = new WeakMap();
const record = (name, value) => {
  const test = hook();
  if (!test) return;
  (test[name] ??= []).push(value);
};
export const pluginHost = {
  subscribe: () => () => {},
  getState: () => {
    const test = hook();
    if (!test || !test.state) return state;
    if (test.state.keyed) return test.state;
    if (!filled.has(test.state)) filled.set(test.state, { ...test.state, keyed: emptyKeyed() });
    return filled.get(test.state);
  },
  refresh: async () => {},
  retainSlot(slot, pluginId) {
    record('retains', [slot, pluginId]);
    return () => record('releases', [slot, pluginId]);
  },
  retainKey(slot, key, context) {
    record('keyRetains', [slot, key, context]);
    return () => record('keyReleases', [slot, key]);
  },
  setOpenSession(session) { record('openSessions', session); },
  dispatchAction(...args) { record('dispatches', args); },
  setEnabled: async () => {},
  async setOptions(pluginId, values) { record('options', [pluginId, values]); },
  resume() {},
  configure() {},
};
`;

export const pluginHostStub = {
  name: 'inert-plugin-host',
  resolveId: id => (/(^|\/)runtime\/plugin-host$/.test(id) ? ID : null),
  load: id => (id === ID ? source : null),
};
