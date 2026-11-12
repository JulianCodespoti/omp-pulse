import test from "node:test";
import assert from "node:assert/strict";
import { TUI_ONLY_COMMANDS, classifyCommand } from "../src/app/commands/command-registry.ts";
import { compactFocus, pluginPromptRefusal, routeComposerText } from "../src/domain/composer-route.ts";
import { rankSlashMatches } from "../src/domain/slash-match.ts";

// The rows omp 18.8.6's RPC catalogue lacks: no RPC-mode handler, TUI only.
const wt = { name: "wt", aliases: ["worktree"], description: "Move this session into a new worktree", source: "builtin" };
const pin = { name: "pin", description: "Pin this session so you can resume it quickly", source: "builtin" };
const model = { name: "model", aliases: ["models"], description: "Choose the model", source: "builtin" };
const catalogue = [wt, pin, model, { name: "compact", source: "builtin" }, { name: "review", source: "skill" }];

test("each TUI-only command has a phone row that runs a phone surface", () => {
  const byName = Object.fromEntries(TUI_ONLY_COMMANDS.map((c) => [c.name, c]));
  assert.equal(byName.tree.picker, "timeline");
  assert.equal(byName.agents.picker, "agents");
  assert.equal(byName.settings.picker, "settings");
  assert.equal(byName.new.picker, "new-session");
  assert.equal(byName.resume.picker, "recent");
  assert.equal(byName.fork.shape, "rpc");
  assert.equal(byName.fork.rpc, "fork");
  for (const c of TUI_ONLY_COMMANDS) assert.equal(c.native, true, c.name);
});

test("/fork copies the whole session while /branch keeps rewinding", () => {
  // omp's /fork (handleForkCommand) forks with no entryId; /branch rewinds.
  const fork = classifyCommand({ name: "fork", source: "builtin" });
  assert.equal(fork.shape, "rpc");
  assert.equal(fork.rpc, "fork");
  const branch = classifyCommand({ name: "branch", aliases: ["rewind"], source: "builtin" });
  assert.equal(branch.shape, "rpc");
  assert.equal(branch.rpc, "branch");
  const row = TUI_ONLY_COMMANDS.find((c) => c.name === "fork");
  assert.doesNotMatch(row.description, /last message/);
});

test("a typed phone-native name ranks first and Enter may take it", () => {
  const withNative = [...catalogue, ...TUI_ONLY_COMMANDS];
  for (const name of ["tree", "new", "resume", "fork", "settings", "agents"]) {
    const ranked = rankSlashMatches(withNative, name);
    assert.equal(ranked.items[0].name, name, name);
    assert.equal(ranked.autoPick, true, name);
  }
});

test("Enter does not take a match that hit only an alias substring or the description", () => {
  // `/tree` reached `/wt` through "worktree"; `/new` through its description.
  const tree = rankSlashMatches(catalogue, "tree");
  assert.equal(tree.items[0].name, "wt");
  assert.equal(tree.autoPick, false);
  const fresh = rankSlashMatches(catalogue, "new");
  assert.equal(fresh.items[0].name, "wt");
  assert.equal(fresh.autoPick, false);
  const resume = rankSlashMatches(catalogue, "resume");
  assert.equal(resume.items[0].name, "pin");
  assert.equal(resume.autoPick, false);
});

test("a name or alias prefix still lets Enter pick", () => {
  assert.deepEqual(rankSlashMatches(catalogue, "mod"), { items: [model], autoPick: true });
  assert.equal(rankSlashMatches(catalogue, "work").autoPick, true);
  assert.equal(rankSlashMatches(catalogue, "work").items[0].name, "wt");
});

test("typed phone-native commands route to the phone, with or without arguments", () => {
  const withNative = [...catalogue, ...TUI_ONLY_COMMANDS];
  assert.deepEqual(routeComposerText("/tree", withNative), { kind: "native", name: "tree" });
  assert.deepEqual(routeComposerText("/resume abc123", withNative), { kind: "native", name: "resume" });
  assert.deepEqual(routeComposerText("/new", withNative), { kind: "native", name: "new" });
  // Advertised builtins and skills keep their routes.
  assert.deepEqual(routeComposerText("/compact", withNative), { kind: "command", name: "compact" });
  assert.deepEqual(routeComposerText("/review", withNative), { kind: "prompt" });
});

test("typed /compact focus goes to the RPC; a mode stays on omp's text handler", () => {
  const modes = ["llm", "snapcompact", "remote"];
  assert.equal(compactFocus("/compact", modes), "");
  assert.equal(compactFocus("/compact keep the API decisions", modes), "keep the API decisions");
  assert.equal(compactFocus("/compact snapcompact", modes), null);
  assert.equal(compactFocus("/compact Remote keep tests", modes), null);
  // A focus that merely starts like a mode is still focus.
  assert.equal(compactFocus("/compact llms and tools", modes), "llms and tools");
});

test("a plugin prompt sends messages only, by one rule on both send routes", () => {
  const withNative = [...catalogue, ...TUI_ONLY_COMMANDS, { name: "plan", native: true, source: "builtin" }];
  const open = { kind: "open", commands: withNative };
  const notOpen = { kind: "not-open" };
  for (const target of [open, notOpen]) {
    // Shell commands, however they are indented: that is session.bash.
    for (const text of ["!touch x", "   !touch x", "!!ls", "\n!ls"]) assert.match(pluginPromptRefusal(text, target), /session\.bash/, text);
    assert.equal(pluginPromptRefusal("hello", target), null);
    assert.equal(pluginPromptRefusal("see /tmp/x and !this", target), null, "a command only leads");
  }
  // The open conversation: sheets, app screens and builtins are refused whatever the spacing.
  for (const text of ["/btw why", " /btw why", "/goal ship it", "/plan on", "/plan", "/settings", "/tree", " /new"]) {
    assert.match(pluginPromptRefusal(text, open), /open app screens/, text);
  }
  assert.match(pluginPromptRefusal("/compact keep tests", open), /session\.rpc/);
  // Skills, templates and extension commands are messages omp expands.
  assert.equal(pluginPromptRefusal("/review the diff", open), null);
  // Not open: no catalogue, so every slash command, indented or not.
  for (const text of ["/btw why", " /btw why", "/review the diff"]) {
    assert.match(pluginPromptRefusal(text, notOpen), /Open the conversation/, text);
  }
});
