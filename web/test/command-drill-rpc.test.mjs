import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, resolveDrill } from '../src/app/commands/command-registry.ts';

// Shapes copied from omp's builtin registry (`/compact`, `/fast`, `/usage`).
const compact = classifyCommand({ name: 'compact', source: 'builtin', subcommands: [
  { name: 'soft', usage: '[focus]' }, { name: 'remote', usage: '[focus]' }, { name: 'snapcompact' },
] });
const fast = classifyCommand({ name: 'fast', source: 'builtin', subcommands: [
  { name: 'on' }, { name: 'ultra' }, { name: 'off' }, { name: 'status' },
] });
const usage = classifyCommand({ name: 'usage', source: 'builtin', subcommands: [
  { name: 'show' }, { name: 'reset', usage: '[provider/credential-id|provider/active]' },
] });
const shape = (cmd, sub) => { const r = resolveDrill(cmd, sub); return `${r.shape}:${r.rpc ?? ''}:${r.name}`; };

test('a subcommand the bare RPC cannot carry runs as the typed command', () => {
  // The bare `compact` RPC ran a default LLM compaction for snapcompact.
  assert.equal(shape(compact, 'snapcompact'), 'prompt::compact snapcompact');
  // set_fast_mode is a boolean: `ultra` used to fall through to a toggle.
  assert.equal(shape(fast, 'ultra'), 'prompt::fast ultra');
  // Native status preserves the ultrafast distinction lost by the boolean.
  assert.equal(shape(fast, 'status'), 'prompt::fast status');
});

test('subcommands the phone RPC path expresses keep their RPC', () => {
  assert.equal(shape(fast, 'on'), 'rpc:set_fast_mode:fast on');
  assert.equal(shape(fast, 'off'), 'rpc:set_fast_mode:fast off');
  assert.equal(shape(usage, 'show'), 'rpc:get_session_stats:usage show');
  assert.equal(shape(compact, 'soft'), 'prompt::compact soft');
  assert.equal(shape(usage, 'reset'), 'prompt::usage reset');
  assert.equal(compact.shape, 'rpc');
  assert.equal(fast.shape, 'rpc');
});
