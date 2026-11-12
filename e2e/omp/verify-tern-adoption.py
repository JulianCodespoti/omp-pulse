#!/usr/bin/env python3
"""Safe existing-host adoption against a real, isolated Tern window and real omp TUIs.

Scope: Pulse only ADOPTS a Collab host that omp itself already runs for the session
(started manually with /collab, or by omp's own autostart). It never types into a
terminal, never starts a share and installs/needs no Tern plugin or helper.

What runs (nothing here is mocked or scripted):

  * a private Tern window under Xvfb with its own config dir and session daemon
    (the TERN_CONFIG_DIR / TERN_DAEMON_SOCKET that e2e/with-test-daemon.sh
    exports); readiness is the GUI window attaching to that private daemon;
  * two real omp TUIs in two background Tern sessions with the same cwd: the
    TARGET, and a DECOY that proves exact identity (nothing may reach it);
  * the real omp-pulse test daemon, driven only through its production HTTP
    API.

The omp TUIs run WITHOUT the Pulse extension bridge and WITHOUT collab
autostart (`collab.relayUrl` points at the harness daemon, nothing else is
set), so a shared session exists only when this fixture runs /collab in the
TUI's own composer. A temporary read-only observer extension reports what the
omp process itself believes (editor text, session id, agent kind) into private
fixture files; it implements nothing of adoption.

Trigger: `POST /api/bash {sessionPath, command: "true"}`. The daemon resolves
the write path first. Collab has no bash channel, so the response is the stable
`{ok:false, code:"session_owned_by_terminal"}` refusal WITHOUT running the
command whether adoption succeeded or was refused. The response is therefore
never the evidence. The evidence is observable state:

  * the omp process's own editor text (observer file),
  * omp's native Collab registry (`omp collab list|link --json`, same HOME and
    PI_CONFIG_DIR as the TUI),
  * the daemon's authority record (`/api/history` sessionState), status and
    adoption counters,
  * /proc: the original owner is still the sole writer and no daemon child
    exists,
  * Tern's own layout (shown sessions, focused blocks), pane count, the
    transcripts and the native hosts before and after.

Cases:
  1. An UNSHARED target with a nonempty draft: the request is refused and
     nothing changes (no host, child, focus, transcript or decoy change).
  2. The fixture clears the draft, runs /collab and /collab stop (test-only
     input into its own composer); the old join hint stays in omp's capture.
     The request on the now UNSHARED, empty target is still refused: nothing
     starts automatically and the old hint is not reused.
  3. The fixture runs /collab again and waits for the real active host (a NEW
     room/token/generation). With the draft typed into the owner again, the
     request adopts that ACTIVE host exactly: same owner, session, control
     access and generation, original owner still the sole writer, daemon a
     connected writable guest, draft untouched.
  4. Repeating the request (also after the daemon detaches) reuses the one
     host: no duplicate host or share, draft unchanged.
  5. The GUI window is closed: the unshared decoy is refused with no GUI,
     owner, draft or transcript change, and the active host's original TUI
     stays alive.

No model calls and no user state: HOME, the omp agent dir, Tern config/cache/
state and the runtime dir are all under the harness' temporary directory. The
only things shared with the machine are the installed binaries (and
XDG_DATA_HOME, which omp's native addon needs).

Requires: Linux, `tern`, `xvfb-run` + `Xvfb`, `omp` on PATH, a release build of
omp-pulse (run via `e2e/run.sh e2e/omp/verify-tern-adoption.py`). Missing
optional prerequisites SKIP with a named reason and exit 0; set
OMP_PULSE_TEST_REQUIRE_TERN=1 to make a skip a failure. Standalone execution
(without the harness environment) fails with exit status 2.

Output contains only statuses, counters and booleans: never a token, share
URL, QR, draft or transcript text.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

NAME = 'tern-adoption'
HARNESS_ENV = (
    'OMP_PULSE_TEST_BASE', 'OMP_PULSE_TEST_WS', 'OMP_PULSE_TEST_TOKEN',
    'OMP_PULSE_TEST_STATE_DIR', 'OMP_PULSE_TEST_SESSIONS', 'OMP_PULSE_TEST_TMP',
    'OMP_PULSE_TEST_DAEMON_PID', 'TERN_CONFIG_DIR', 'TERN_DAEMON_SOCKET',
)
missing_env = [key for key in HARNESS_ENV if not os.environ.get(key)]
if missing_env:
    sys.exit(
        f'{NAME}: harness environment missing ({", ".join(missing_env)}). '
        'Run it through the isolated harness: '
        'e2e/run.sh e2e/omp/verify-tern-adoption.py '
        '(or e2e/with-test-daemon.sh python3 e2e/omp/verify-tern-adoption.py). '
        'It never falls back to a real daemon, token or Tern.'
    )

BASE = os.environ['OMP_PULSE_TEST_BASE']
WS = os.environ['OMP_PULSE_TEST_WS']
TOKEN = os.environ['OMP_PULSE_TEST_TOKEN']
TMP = pathlib.Path(os.environ['OMP_PULSE_TEST_TMP'])
STATE = pathlib.Path(os.environ['OMP_PULSE_TEST_STATE_DIR'])
SESSIONS = pathlib.Path(os.environ['OMP_PULSE_TEST_SESSIONS'])
DAEMON_PID = int(os.environ['OMP_PULSE_TEST_DAEMON_PID'])
TERN_CONFIG = pathlib.Path(os.environ['TERN_CONFIG_DIR'])
TERN_SOCKET = pathlib.Path(os.environ['TERN_DAEMON_SOCKET'])
MODEL = os.environ.get('OMP_PULSE_TEST_MODEL', 'opencode-go/muse-spark-1.3-contributor')
PROVIDER, MODEL_ID = MODEL.split('/', 1)
STRICT = os.environ.get('OMP_PULSE_TEST_REQUIRE_TERN') == '1'

# Isolation is asserted, never assumed: anything outside TMP could be real state.
assert BASE.startswith('http://127.0.0.1:') and ':7682' not in BASE, 'not an isolated daemon'
assert WS == BASE.replace('http://', 'ws://', 1), 'relay URL does not belong to the harness daemon'
assert SESSIONS.is_relative_to(TMP) and STATE.is_relative_to(TMP), 'state outside the harness tmp'
assert TERN_CONFIG.is_relative_to(TMP) and TERN_SOCKET.is_relative_to(TMP), 'Tern state outside the harness tmp'
leaked = [key for key in ('TERN_PANE', 'TERN_PANE_SOCKET', 'TERN_WINDOW_KEY', 'TERN_WINDOW_SOCKET', 'TERN_IDENTITY') if os.environ.get(key)]
assert not leaked, f'Tern identity leaked into the suite: {leaked}'

DRAFT = 'dummy draft that adoption must never touch'
URL_RE = re.compile(r'[A-Za-z][A-Za-z0-9+.-]*://\S+')
LAST_REFUSALS = {}


def scrub(text):
    return URL_RE.sub('<url>', text.replace(str(TMP), '<TMP>'))


def skip(reason):
    print(f'SKIP {NAME}: {reason}', flush=True)
    if STRICT:
        print(f'FAIL {NAME}: OMP_PULSE_TEST_REQUIRE_TERN=1 and a prerequisite is missing', flush=True)
        sys.exit(1)
    sys.exit(0)


def preflight():
    if not sys.platform.startswith('linux'):
        skip('platform is not Linux (isolated window needs Xvfb)')
    binaries = {}
    for name in ('tern', 'xvfb-run', 'Xvfb', 'omp'):
        found = shutil.which(name)
        if not found:
            skip(f'{name} is not installed')
        binaries[name] = found
    return binaries


BIN = preflight()
OMP = BIN['omp']
TERN = BIN['tern']

WORK = TMP / 'tern-adoption-work'
HOME = TMP / 'tern-adoption-home'
AGENT = TMP / 'tern-adoption-agent'
XDG = TMP / 'tern-adoption-xdg'
OBSERVER_DIR = TMP / 'tern-adoption-observer'
WINDOW_DIR = TMP / 'tern-adoption-window'
CTL = TMP / 'tern-adoption-ctl.sock'
WINDOW_LOG = TMP / 'tern-adoption-window.log'
for directory in (WORK, HOME, AGENT, OBSERVER_DIR, WINDOW_DIR, XDG / 'config', XDG / 'cache', XDG / 'state'):
    directory.mkdir(parents=True, exist_ok=True)

# Identity of whichever omp/Pulse is running THIS suite (an agent on the phone,
# a TUI in a pane): none of it may reach the omp under test.
IDENTITY_PREFIXES = ('HERDR_', 'KITTY_', 'TMUX', 'TERN_PANE', 'TERN_WINDOW', 'TERN_IDENTITY', 'TERN_ACP', 'TERN_COMPLETE', 'TERN_PROMPT', 'TERN_BLOB', 'TERN_LENSES', 'TERN_EXE')
IDENTITY_NAMES = {'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_TOOL_CALL_ID', 'OMPCODE', 'OMP_PULSE_CHILD', 'DISPLAY', 'WAYLAND_DISPLAY', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR'}


def clean_env():
    return {key: value for key, value in os.environ.items() if key not in IDENTITY_NAMES and not key.startswith(IDENTITY_PREFIXES)}


def native_env():
    """The environment omp's own CLI uses: EXACTLY what the TUI panes get."""
    env = clean_env()
    env.update(HOME=str(HOME), PI_CODING_AGENT_DIR=str(AGENT), PI_CONFIG_DIR='.omp-spike', TERM='xterm-256color')
    return env


def window_env():
    env = clean_env()
    env.update(
        WGPU_BACKEND='gl', LIBGL_ALWAYS_SOFTWARE='1', STENCIL_LOG='warn',
        XDG_CONFIG_HOME=str(XDG / 'config'), XDG_CACHE_HOME=str(XDG / 'cache'), XDG_STATE_HOME=str(XDG / 'state'),
    )
    return env


def tern_env():
    return clean_env()


def until(description, probe, timeout=30.0, interval=0.1):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = probe()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f'timed out waiting for {description}')


def run(argv, env, timeout=60, cwd=None):
    return subprocess.run(argv, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def tern(*args, parse=True, timeout=30):
    result = run([TERN, *args], tern_env(), timeout=timeout)
    if result.returncode != 0:
        raise AssertionError(f'tern {args[0]} failed (exit {result.returncode})')
    return json.loads(result.stdout) if parse else result.stdout


def omp_json(*args):
    result = run([OMP, *args], native_env(), timeout=60, cwd=WORK)
    if result.returncode != 0:
        raise AssertionError(f'omp {args[0]} {args[1] if len(args) > 1 else ""} failed (exit {result.returncode})')
    return json.loads(result.stdout)


def request(path, body=None, method=None, timeout=90):
    headers = {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


# --- /proc -------------------------------------------------------------------

def all_pids():
    return [int(entry) for entry in os.listdir('/proc') if entry.isdigit()]


def stat_fields(pid):
    try:
        raw = pathlib.Path(f'/proc/{pid}/stat').read_text()
    except OSError:
        return None
    return raw.rsplit(')', 1)[1].split()


def start_time(pid):
    fields = stat_fields(pid)
    return int(fields[19]) if fields else None


def parent_of(pid):
    fields = stat_fields(pid)
    return int(fields[1]) if fields else None


def cmdline(pid):
    try:
        return pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode(errors='replace').replace('\0', ' ').strip()
    except OSError:
        return ''


def descendants(root):
    parents = {}
    for pid in all_pids():
        parent = parent_of(pid)
        if parent is not None:
            parents.setdefault(parent, []).append(pid)
    found, queue = [], [root]
    while queue:
        for child in parents.get(queue.pop(), []):
            found.append(child)
            queue.append(child)
    return found


def fd_holders(path):
    target = str(path)
    holders = set()
    for pid in all_pids():
        try:
            for fd in os.listdir(f'/proc/{pid}/fd'):
                try:
                    if os.readlink(f'/proc/{pid}/fd/{fd}') == target:
                        holders.add(pid)
                except OSError:
                    pass
        except OSError:
            pass
    return holders


def alive(pid, started):
    return start_time(pid) == started


# --- fixtures ----------------------------------------------------------------

# Read-only. Reports what the omp process itself says. It implements nothing of
# adoption and registers no commands; omp loads it only through `-e`.
OBSERVER_SOURCE = '''import { renameSync, writeFileSync } from "node:fs";
interface ObserverContext {
  sessionManager: { getSessionId(): string };
  agent?: { kind: string };
  hasUI: boolean;
  ui: { getEditorText(): string };
}
interface ObserverAPI {
  on(event: "session_start" | "session_switch", handler: (event: unknown, context: ObserverContext) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
}
const OUT = %s;
export default function observer(pi: ObserverAPI): void {
  let context: ObserverContext | undefined;
  let stop: (() => void) | undefined;
  let seq = 0;
  const publish = (): void => {
    const current = context;
    if (!current) return;
    const record = {
      seq: ++seq,
      at: Date.now(),
      pid: process.pid,
      sessionId: current.sessionManager.getSessionId(),
      agentKind: current.agent?.kind,
      hasUI: current.hasUI,
      editorText: current.ui.getEditorText(),
    };
    try {
      writeFileSync(OUT + ".tmp", JSON.stringify(record));
      renameSync(OUT + ".tmp", OUT);
    } catch { /* fixture directory gone */ }
  };
  const observe = (_event: unknown, ctx: ObserverContext): void => {
    context = ctx;
    if (!stop) {
      const timer = setInterval(publish, 100);
      stop = () => clearInterval(timer);
    }
    publish();
  };
  pi.on("session_start", observe);
  pi.on("session_switch", observe);
  pi.on("session_shutdown", () => { stop?.(); stop = undefined; });
}
'''


class Pane:
    def __init__(self, label):
        self.label = label
        self.session_id = str(uuid.uuid4())
        folder = SESSIONS / f'-tern-adoption-{label}'
        folder.mkdir(parents=True)
        self.folder = folder
        self.path = folder / f'2026-09-05T00-00-00-000Z_{self.session_id}.jsonl'
        title = f'Tern adoption {label}'
        entries = [
            {'type': 'session', 'version': 3, 'id': self.session_id, 'cwd': str(WORK), 'title': title},
            {'type': 'title', 'title': title},
            {'type': 'message', 'id': 'fixture-user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'Isolated Tern fixture; no model prompt.'}]}},
            {'type': 'message', 'id': 'fixture-reply', 'parentId': 'fixture-user', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Fixture ready.'}], 'stopReason': 'stop', 'provider': PROVIDER, 'model': MODEL_ID, 'api': 'openai-responses', 'timestamp': int(time.time() * 1000), 'usage': {'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}}},
        ]
        self.path.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
        self.observation_file = OBSERVER_DIR / f'{label}.json'
        self.extension = OBSERVER_DIR / f'{label}-observer.ts'
        self.extension.write_text(OBSERVER_SOURCE % json.dumps(str(self.observation_file)))
        self.block = None
        self.session = None
        self.pid = None
        self.started = None

    def launch(self):
        command = [
            'env', '-u', 'PI_SESSION_FILE', '-u', 'PI_SESSION_ID', '-u', 'PI_TOOL_CALL_ID', '-u', 'OMPCODE', '-u', 'OMP_PULSE_CHILD',
            f'HOME={HOME}', f'PI_CODING_AGENT_DIR={AGENT}', 'PI_CONFIG_DIR=.omp-spike', 'TERM=xterm-256color',
            OMP, '--resume', str(self.path), '--session-dir', str(self.folder), '--cwd', str(WORK),
            '--no-title', '--no-tools', '--no-lsp', '--no-skills', '--no-rules', '--no-context-files', '--no-extensions',
            '-e', str(self.extension), '--model', MODEL,
        ]
        created = tern('new', 'session', f'pulse-{self.label}', '--cwd', str(WORK), '--json', '--', *command)
        self.session, self.block = created['session'], created['block']

    def observed(self):
        try:
            return json.loads(self.observation_file.read_text())
        except (OSError, ValueError):
            return None

    def fresh(self, timeout=10):
        """An observation published after now: stable-state checks must not read a stale file."""
        floor = time.time() * 1000
        return until(f'a fresh {self.label} observation', lambda: (lambda o: o if o and o.get('at', 0) > floor else None)(self.observed()), timeout)

    def editor(self):
        text = self.fresh().get('editorText')
        assert isinstance(text, str), f'{self.label} editor text is not readable'
        return text

    def resolve_owner(self):
        info = tern('process', str(self.block), '--json')
        pid = info['child']['pid']
        until(f'{self.label} omp to own its session', lambda: str(self.path) in cmdline(pid), 20)
        self.pid, self.started = pid, start_time(pid)
        assert self.started is not None, f'{self.label} owner vanished'


# --- native/daemon views ---------------------------------------------------------

def native_hosts():
    listing = omp_json('collab', 'list', '--json')
    assert listing.get('version') == 1 and isinstance(listing.get('hosts'), list), 'unexpected `omp collab list --json` schema'
    return listing['hosts']


def native_link(selector):
    link = omp_json('collab', 'link', str(selector), '--json')
    assert link.get('version') == 1 and link.get('access') == 'control', 'native link is not a control link'
    url = link.get('url')
    assert isinstance(url, str) and f'127.0.0.1:{BASE.rsplit(":", 1)[1]}/r/' in url, 'native link does not use the harness relay'
    return link, hashlib.sha256(url.encode()).hexdigest()


def layout():
    """Tern's focus-relevant state: which sessions/tabs are shown and which block has focus."""
    inspected = tern('inspect', '--json')
    return [
        (s['id'], s['shown'], [(t['id'], t['shown'], [(b['id'], b['focused']) for b in t['blocks']]) for t in s['tabs']])
        for s in inspected['sessions']
    ]


def counters():
    status, body = request('/api/status')
    assert status == 200, f'status {status}'
    return body['metrics'].get('counters', {}), body


def authority(path):
    status, body = request('/api/history?session=' + urllib.parse.quote(str(path), safe=''))
    assert status == 200, f'history status {status}'
    return body['sessionState']


def transcript_counts(path):
    entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return sum(entry.get('type') == 'message' for entry in entries), any('bashExecution' in json.dumps(entry) for entry in entries)


def trigger(pane):
    """The production HTTP path into adoption. The body is not the evidence (see module docstring)."""
    status, body = request('/api/bash', {'sessionPath': str(pane.path), 'command': 'true'})
    assert status == 200, f'/api/bash status {status}'
    assert body.get('ok') is False and body.get('code') == 'session_owned_by_terminal', 'a command ran or the refusal shape changed'
    LAST_REFUSALS[pane.label] = scrub(body['error'])


def assert_sole_writer(owner):
    holders = fd_holders(owner.path) - {DAEMON_PID, os.getpid()}
    assert holders <= {owner.pid}, f'{len(holders - {owner.pid})} unexpected process(es) hold the session file'
    daemon_children = [pid for pid in descendants(DAEMON_PID) if owner.session_id in cmdline(pid) or '--mode rpc' in cmdline(pid)]
    assert not daemon_children, 'the daemon spawned an omp child for the session'
    assert counters()[1].get('children') == 0, 'the daemon reports a live child'
    assert alive(owner.pid, owner.started), 'the original owner exited or was replaced'
    assert str(owner.path) in cmdline(owner.pid), 'the original owner no longer owns the session'


# --- window lifecycle -------------------------------------------------------------

window = None
recorded = {'daemon': None, 'tree': {}}


def find_daemon():
    needle = str(TERN_SOCKET)
    for pid in all_pids():
        args = cmdline(pid).split(' ')
        if 'daemon' in args and '--socket' in args and args[args.index('--socket') + 1:][:1] == [needle]:
            return pid
    return None


def start_window():
    global window
    log = WINDOW_LOG.open('wb')
    window = subprocess.Popen(
        ['xvfb-run', '-a', '-s', '-screen 0 1400x900x24', TERN, '--control', str(CTL), '--dir', str(WINDOW_DIR)],
        env=window_env(), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    log.close()

    def ready():
        if window.poll() is not None:
            return 'exited'
        if not (CTL.exists() and TERN_SOCKET.exists()):
            return None
        try:
            clients = tern('inspect', '--json')['clients']
        except (AssertionError, ValueError, KeyError, subprocess.TimeoutExpired):
            return None
        return 'ready' if any(c.get('kind') == 'window' for c in clients) else None

    try:
        state = until('the Tern window to attach to its daemon', ready, 60, 0.3)
    except AssertionError:
        state = 'timeout'
    if state != 'ready':
        tail = WINDOW_LOG.read_text(errors='replace') if WINDOW_LOG.exists() else ''
        # Tern's benign "software rendering on llvmpipe" warning is printed on every
        # healthy start; only a real renderer/display failure may skip.
        failures = [line for line in tail.splitlines() if 'software rendering on llvmpipe' not in line]
        graphics = re.search(r'(?i)(cannot open display|unable to open display|no suitable (gpu )?adapter|failed to (create|request) (an? )?(wgpu |gl |egl |gpu )?(adapter|surface|device|context)|libGL error|xauth)', '\n'.join(failures))
        if state in ('exited', 'timeout') and graphics and not STRICT:
            skip('no usable GL/software renderer or X display for a Tern window under Xvfb (WGPU_BACKEND=gl, LIBGL_ALWAYS_SOFTWARE=1)')
        raise AssertionError(f'Tern window did not become ready ({state})')
    recorded['daemon'] = find_daemon()
    assert recorded['daemon'] is not None, 'the private Tern daemon is not running under the private socket'


def record_tree():
    daemon = recorded['daemon']
    if daemon is None:
        return
    for pid in [daemon, *descendants(daemon)]:
        started = start_time(pid)
        if started is not None:
            recorded['tree'][pid] = started


def terminate(pid_started, grace=8.0):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        pending = [pid for pid, started in pid_started.items() if alive(pid, started)]
        if not pending:
            return
        for pid in reversed(pending):
            try:
                os.kill(pid, sig)
            except OSError:
                pass
        deadline = time.monotonic() + (grace if sig == signal.SIGTERM else 2.0)
        while time.monotonic() < deadline and any(alive(pid, started) for pid, started in pid_started.items()):
            time.sleep(0.1)


def cleanup(panes):
    for pane in panes:
        try:
            if pane.pid and pane.started:
                recorded['tree'][pane.pid] = pane.started
        except Exception:
            pass
    try:
        record_tree()
    except Exception:
        pass
    if window is not None:
        if window.poll() is None and CTL.exists():
            try:
                run([TERN, 'ctl', '--control', str(CTL), 'quit'], tern_env(), timeout=10)
            except Exception:
                pass
        try:
            window.wait(timeout=10)
        except subprocess.TimeoutExpired:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(window.pid, sig)
                except OSError:
                    break
                try:
                    window.wait(timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    continue
    try:
        record_tree()
        terminate(recorded['tree'])
    except Exception:
        pass


def diagnostics(panes):
    """Redacted refusal reasons, counters and booleans; never editor or capture text."""
    print('--- diagnostics (no tokens, URLs or transcript text) ---', flush=True)
    print(f'window_alive={window is not None and window.poll() is None} daemon_alive={recorded["daemon"] is not None and start_time(recorded["daemon"]) is not None}', flush=True)
    for pane in panes:
        observation = pane.observed() or {}
        print(f'{pane.label}: observed={bool(observation)} session_ok={observation.get("sessionId") == pane.session_id} agent_kind={observation.get("agentKind")} editor_len={len(observation.get("editorText") or "")} owner_alive={bool(pane.pid and pane.started and alive(pane.pid, pane.started))}', flush=True)
        if pane.label in LAST_REFUSALS:
            print(f'{pane.label}: refusal={LAST_REFUSALS[pane.label]}', flush=True)
    try:
        print(f'native_hosts={len(native_hosts())} counters={ {k: v for k, v in counters()[0].items() if k.startswith("adopt")} }', flush=True)
    except Exception as error:
        print(f'native/daemon state unreadable: {type(error).__name__}', flush=True)


# --- scenario -----------------------------------------------------------------------

def gui_window_processes():
    """Tern GUI (non-daemon) processes of THIS suite's private daemon scope. Matching the private
    TERN_DAEMON_SOCKET in the environment keeps the developer's own Tern windows out of the answer."""
    needle = b'TERN_DAEMON_SOCKET=' + str(TERN_SOCKET).encode() + b'\0'
    found = []
    for pid in all_pids():
        args = cmdline(pid).split(' ')
        if not args or os.path.basename(args[0]) != 'tern' or 'daemon' in args:
            continue
        try:
            environ = pathlib.Path(f'/proc/{pid}/environ').read_bytes()
        except OSError:
            continue
        if needle in environ:
            found.append(pid)
    return found


def submit_composer(pane, text):
    """Test-only: type and submit one slash command into the fixture's own composer."""
    tern('send', str(pane.block), 'text', text, parse=False)
    until(f'{pane.label} composer to hold the command', lambda: pane.editor() == text, 10, 0.2)
    tern('send', str(pane.block), 'keys', 'enter', parse=False)
    until(f'{pane.label} composer to be submitted', lambda: pane.editor() == '', 10, 0.2)


def link_token(url):
    """The room.secret path segment of a share URL. Compared, never printed."""
    match = re.search(r'/r/([^/#?\s]+)', url)
    assert match, 'share URL has no room token'
    return match.group(1)


def counts():
    """(adopt_attempt, adopt_success) from the daemon's own metrics."""
    snapshot = counters()[0]
    return snapshot.get('adopt_attempt', 0), snapshot.get('adopt_success', 0)


def host_identities():
    return sorted((h['sessionId'], h['pid'], h['instanceId'], h['generation']) for h in native_hosts())


def world(panes):
    """Everything an adoption request must not disturb: Tern layout/focus, pane count, transcripts and native hosts."""
    return {
        'layout': layout(),
        'panes': len(tern('inspect', '--json')['panes']),
        'transcripts': {pane.label: transcript_counts(pane.path) for pane in panes},
        'hosts': host_identities(),
    }


def quiet(expected):
    """Two observations published after now per pane: the draft text is exactly the expected one."""
    for _ in range(2):
        for pane, text in expected.items():
            assert pane.editor() == text, f'the {pane.label} editor changed'


def assert_refused(pane, panes, expected, why):
    """The production request on an unshared session ends in exactly one refused adoption that changes nothing."""
    attempts0, successes0 = counts()
    world0 = world(panes)
    trigger(pane)
    quiet(expected)
    attempts1, successes1 = counts()
    assert attempts1 - attempts0 == 1 and successes1 == successes0, f'{why}: the request did not end in exactly one refused adoption'
    assert world(panes) == world0, f'{why}: the refusal moved Tern focus/visibility, a pane, a transcript or a native host'
    assert authority(pane.path)['owner']['kind'] != 'collab', f'{why}: the daemon attached to a share that must not exist'
    for other in panes:
        assert_sole_writer(other)


def scenario(decoy, target):
    panes = [decoy, target]
    # 0. Setup: the omp TUIs share only through the harness relay, and start with no host.
    assert run([OMP, 'config', 'set', 'collab.relayUrl', WS], native_env(), timeout=60, cwd=WORK).returncode == 0, 'could not point omp at the harness relay'
    assert native_hosts() == [], 'a Collab host existed before the first request (autostart leaked in)'
    start_window()
    print('ok isolated Tern window + private session daemon ready under Xvfb', flush=True)

    decoy.launch()
    target.launch()
    for pane in panes:
        observation = until(f'{pane.label} omp to report its session', lambda: (lambda o: o if o and o.get('sessionId') else None)(pane.observed()), 90, 0.25)
        assert observation['sessionId'] == pane.session_id, f'{pane.label} resumed the wrong session'
        assert observation.get('agentKind') == 'main' and observation.get('hasUI') is True, f'{pane.label} is not an interactive main agent'
        assert observation['editorText'] == '', f'{pane.label} editor is not empty at start'
        pane.resolve_owner()
    assert decoy.pid != target.pid
    time.sleep(1.0)  # the TUI accepts keys a moment after its first session event
    shown = [s for s in layout() if s[1]]
    assert len(shown) == 1, 'the background panes are not both in background sessions'
    print('ok two real omp TUIs (target + same-cwd decoy) run without Pulse bridge or autostart', flush=True)

    # 1. A nonempty draft on an UNSHARED target: refused, nothing changes, nothing starts.
    tern('send', str(target.block), 'text', DRAFT, parse=False)
    until('the draft in the target editor', lambda: target.editor() == DRAFT, 15, 0.2)
    assert_refused(target, panes, {target: DRAFT, decoy: ''}, 'nonempty draft, unshared target')
    assert native_hosts() == [], 'a host started sharing over a nonempty draft'
    print('ok unshared target with a draft: request refused, draft unchanged, no host/child/focus/transcript change', flush=True)

    # 2. Clear the draft (fixture's own input). Share manually, then stop: omp's native
    # capture keeps the dead join hint. An UNSHARED empty target must still be refused:
    # nothing starts sharing automatically and the old hint is never reused.
    for keys in (['ctrl+u'], ['ctrl+a', 'ctrl+k']):
        tern('send', str(target.block), 'keys', *keys, parse=False)
        try:
            until('the draft to clear', lambda: target.editor() == '', 5, 0.2)
            break
        except AssertionError:
            continue
    else:
        raise AssertionError('could not clear the dummy draft through Tern keys')
    assert native_hosts() == [], 'a host appeared while only clearing the draft'
    submit_composer(target, '/collab')
    old_hosts = until('the manual share to host', lambda: [h for h in native_hosts() if h.get('sessionId') == target.session_id] or None, 30, 0.25)
    assert len(old_hosts) == 1 and old_hosts[0].get('pid') == target.pid, 'the manual share is not hosted by the original owner'
    old_identity = (old_hosts[0]['instanceId'], old_hosts[0]['generation'])
    old_link, old_fingerprint = native_link(target.pid)
    old_token = link_token(old_link['url'])
    submit_composer(target, '/collab stop')
    until('the manual host to disappear', lambda: not native_hosts(), 20, 0.25)

    def stale_hint_in_capture():
        capture = tern('capture', str(target.block), '--surfaces', parse=False)
        return old_token in re.sub(r'\s+', '', capture)

    until('the stopped share\'s join hint to remain in the native capture', stale_hint_in_capture, 20, 0.5)
    assert target.editor() == '' and decoy.editor() == '', 'the manual share left text in an editor'
    assert_refused(target, panes, {target: '', decoy: ''}, 'empty editor, unshared target with a stale hint')
    assert native_hosts() == [], 'the request started a share automatically'
    assert stale_hint_in_capture(), 'the old hint left the native capture, so the refusal did not prove it is ignored'
    print('ok stopped share: dead hint remains, request on the unshared target refused, no host started', flush=True)

    # 3. Share manually again. With a draft in the owner, the production request adopts the
    # ACTIVE host exactly as found: same owner/session/control/generation, draft untouched.
    submit_composer(target, '/collab')
    host = until('the target to host a new Collab share', lambda: [h for h in native_hosts() if h.get('sessionId') == target.session_id] or None, 30, 0.25)
    assert len(host) == 1, 'more than one host for the target session'
    row = host[0]
    assert row.get('pid') == target.pid, 'the host is not the original owner process'
    assert row.get('access') == 'control' and isinstance(row.get('generation'), int) and row['generation'] > 0 and isinstance(row.get('instanceId'), str)
    link, link_fingerprint = native_link(target.pid)
    assert (row['instanceId'], row['generation']) != old_identity, 'the stopped host generation was reused'
    assert link_fingerprint != old_fingerprint and link_token(link['url']) != old_token, 'the new share reuses the stopped room/token'
    assert link['instanceId'] == row['instanceId'] and link['generation'] == row['generation'], 'native link names another host generation'
    assert [h['sessionId'] for h in native_hosts()] == [target.session_id], 'the decoy or another session is sharing'
    assert authority(target.path)['owner']['kind'] != 'collab', 'the daemon attached before any request'
    tern('send', str(target.block), 'text', DRAFT, parse=False)
    until('the draft in the shared target editor', lambda: target.editor() == DRAFT, 15, 0.2)
    world3 = world(panes)
    attempts3, successes3 = counts()
    trigger(target)
    quiet({target: DRAFT, decoy: ''})
    state = until('the daemon to attach as a writable guest', lambda: (lambda s: s if s['owner']['kind'] == 'collab' and s['capabilities']['send'] else None)(authority(target.path)), 20, 0.25)
    assert state['connection'] == 'connected', 'daemon link is not connected'
    assert counters()[1].get('desktopLink') == 'attached', 'daemon does not report an attached desktop link'
    attempts4, successes4 = counts()
    assert attempts4 - attempts3 == 1 and successes4 - successes3 == 1, 'exactly one adoption must have succeeded'
    assert world(panes) == world3, 'adoption changed the host, focus, layout or a transcript'
    adopted_row = [h for h in native_hosts() if h['sessionId'] == target.session_id]
    assert [(h['instanceId'], h['generation'], h['pid'], h['access']) for h in adopted_row] == [(row['instanceId'], row['generation'], target.pid, 'control')], 'adoption replaced or duplicated the host'
    assert native_link(target.pid)[1] == link_fingerprint, 'adoption changed the share'
    assert_sole_writer(target)
    assert_sole_writer(decoy)
    print('ok active host: adopted exactly (owner/session/control/generation), new room != stopped host, draft unchanged, original owner sole writer', flush=True)

    # 4. Repeating the request reuses the one host. 4a: daemon still attached.
    successes5 = counts()[1]
    trigger(target)
    quiet({target: DRAFT, decoy: ''})
    assert world(panes) == world3, 'repeat request changed a host, layout or transcript'
    assert native_link(target.pid)[1] == link_fingerprint, 'repeat request changed the share'
    assert counts()[1] == successes5, 'an attached session was adopted again'
    assert_sole_writer(target)
    # 4b: the daemon forgets its attachment; the next request re-attaches to the one host.
    status, _ = request('/api/collab/detach', {'sessionPath': str(target.path)})
    assert status == 200
    trigger(target)
    until('the daemon to be a writable guest again', lambda: (lambda s: s['owner']['kind'] == 'collab' and s['capabilities']['send'])(authority(target.path)), 30, 0.25)
    quiet({target: DRAFT, decoy: ''})
    assert world(panes) == world3, 'reattachment changed a host, layout or transcript'
    final = native_hosts()
    assert [(h['instanceId'], h['generation'], h['pid']) for h in final] == [(row['instanceId'], row['generation'], target.pid)], 'a second share started after reattachment'
    assert native_link(target.pid)[1] == link_fingerprint, 'reattachment changed the share'
    assert_sole_writer(target)
    readopted = counts()[1] > successes5
    print(f'ok repeated request: same host generation, one share, draft unchanged, original owner sole writer (daemon re-adoption ran: {readopted})', flush=True)

    # 5. No GUI: close ONLY the isolated GUI window through its private control endpoint,
    # leaving the daemon, both TUIs and the active host running. The still-unshared decoy
    # must be refused without creating a window, pane, tab or host. Only the shape of state
    # is asserted, never wording.
    closed = run([TERN, 'ctl', '--control', str(CTL), 'quit'], tern_env(), timeout=15)
    assert closed.returncode == 0, f'closing the isolated window failed (exit {closed.returncode})'
    until('the isolated GUI window to exit', lambda: window.poll() is not None, 30, 0.2)
    until('no window client attached to the private daemon', lambda: not [c for c in tern('inspect', '--json')['clients'] if c.get('kind') == 'window'], 20, 0.3)
    assert recorded['daemon'] is not None and find_daemon() == recorded['daemon'], 'closing the window stopped the private daemon'
    assert alive(target.pid, target.started) and alive(decoy.pid, decoy.started), 'closing the window killed an omp TUI'
    assert not gui_window_processes(), 'a Tern GUI process still runs after the window was closed'
    assert [(h['instanceId'], h['generation'], h['pid']) for h in native_hosts()] == [(row['instanceId'], row['generation'], target.pid)], 'unexpected hosts before the windowless request'
    assert_refused(decoy, panes, {decoy: '', target: DRAFT}, 'unshared decoy without a GUI')
    assert not [h for h in native_hosts() if h['sessionId'] == decoy.session_id or h['pid'] == decoy.pid], 'the decoy started sharing without a GUI'
    assert native_link(target.pid)[1] == link_fingerprint, 'the target share changed'
    assert not [c for c in tern('inspect', '--json')['clients'] if c.get('kind') == 'window'], 'a Tern window client appeared'
    assert not gui_window_processes(), 'a Tern GUI process was started by the request'
    assert alive(target.pid, target.started) and alive(decoy.pid, decoy.started), 'an omp owner exited or was replaced'
    assert not fd_holders(decoy.path) - {DAEMON_PID, os.getpid(), decoy.pid}, 'another process holds the decoy session'
    print('ok no GUI: unshared decoy refused with no GUI/owner/draft/transcript change, active host and its original TUI intact', flush=True)


def main():
    decoy, target = Pane('decoy'), Pane('target')
    panes = [decoy, target]
    try:
        scenario(decoy, target)
    except SystemExit:
        raise
    except BaseException as error:
        print(f'FAIL {NAME}: {type(error).__name__}: {scrub(str(error))}', flush=True)
        diagnostics(panes)
        raise SystemExit(1) from None
    finally:
        try:
            request('/api/collab/detach', {'sessionPath': str(target.path)}, timeout=10)
        except Exception:
            pass
        cleanup(panes)
    print(f'ok {NAME}', flush=True)


if __name__ == '__main__':
    main()
