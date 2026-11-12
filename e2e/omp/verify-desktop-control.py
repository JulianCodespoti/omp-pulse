#!/usr/bin/env python3
"""Real OMP TUI + settings extension, isolated daemon/session, no model prompts."""
import json
import os
import pathlib
import pty
import select
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ['OMP_PULSE_TEST_BASE']
TOKEN = os.environ['OMP_PULSE_TEST_TOKEN']
ROOT = pathlib.Path(os.environ['OMP_PULSE_TEST_SESSIONS'])
TMP = pathlib.Path(os.environ['OMP_PULSE_TEST_TMP'])
STATE = pathlib.Path(os.environ['OMP_PULSE_TEST_STATE_DIR'])
assert BASE.startswith('http://127.0.0.1:') and ':7682' not in BASE
assert ROOT.is_relative_to(TMP) and STATE.is_relative_to(TMP)
REPO = pathlib.Path(__file__).resolve().parents[2]
MODEL = os.environ.get('OMP_PULSE_TEST_MODEL', 'opencode-go/muse-spark-1.3-contributor')
PROVIDER, MODEL_ID = MODEL.split('/', 1)
ID = str(uuid.uuid4())
folder = ROOT / '-tmp-desktop-control'
folder.mkdir(parents=True)
session = folder / f'2026-09-05T00-00-00-000Z_{ID}.jsonl'
entries = [
    {'type': 'session', 'version': 3, 'id': ID, 'cwd': str(TMP), 'title': 'Desktop settings verification'},
    {'type': 'title', 'title': 'Desktop settings verification'},
    {'type': 'message', 'id': 'fixture-user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'Isolated settings fixture; do not send a model prompt.'}]}},
    {'type': 'message', 'id': 'fixture-reply', 'parentId': 'fixture-user', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Desktop settings fixture ready.'}], 'stopReason': 'stop', 'provider': PROVIDER, 'model': MODEL_ID, 'api': 'openai-responses', 'timestamp': int(time.time() * 1000), 'usage': {'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}}},
]
session.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
install_env = dict(os.environ, PI_CODING_AGENT_DIR=str(TMP / 'agent'), OMP_PULSE_STATE_DIR=str(STATE))
unrelated = TMP / 'agent/extensions/omp-pulse-control.ts'
unrelated.parent.mkdir(parents=True)
unrelated_source = "const text = 'omp-pulse managed extension';\n"
unrelated.write_text(unrelated_source)
refused = subprocess.run([str(REPO / 'target/release/omp-pulse'), 'desktop-control', 'install'], env=install_env, capture_output=True, text=True)
assert refused.returncode != 0 and unrelated.read_text() == unrelated_source, 'Installer overwrote an unrelated extension'
unrelated.unlink()
print('ok installer preserves an unrelated extension', flush=True)
installed = subprocess.run([str(REPO / 'target/release/omp-pulse'), 'desktop-control', 'install'], env=install_env, check=True, capture_output=True, text=True)
print(installed.stdout.strip(), flush=True)
extension = TMP / 'agent/extensions/omp-pulse-control.ts'
assert extension.is_file(), f'Installer did not create {extension}'
env = dict(os.environ)
for key in list(env):
    if key.startswith(('HERDR_', 'KITTY_', 'TMUX')):
        env.pop(key)
# A desktop TUI is never one of the daemon's RPC children. When this suite is
# itself run from an omp that omp-pulse drives (an agent on the phone), the
# marker is inherited, and the extension then deliberately publishes no
# descriptor (extensions/omp-pulse-control.ts onSessionReady).
env.pop('OMP_PULSE_CHILD', None)
env['TERM'] = 'xterm-256color'
env['OMP_PULSE_STATE_DIR'] = str(STATE)
master, slave = pty.openpty()
child = subprocess.Popen(['omp', '--resume', str(session), '--session-dir', str(folder), '--cwd', str(TMP), '--no-title', '--no-tools', '--no-lsp', '--no-skills', '--no-rules', '--no-extensions', '-e', str(extension), '--model', MODEL], cwd=TMP, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
stop = threading.Event()
log = TMP / 'desktop-control-tui.log'
def drain():
    with log.open('wb') as output:
        while not stop.is_set():
            if select.select([master], [], [], 0.2)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return
                if not data:
                    return
                output.write(data)
                output.flush()
thread = threading.Thread(target=drain, daemon=True)
thread.start()

def request(url, body=None, token=TOKEN, extra=None):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    headers.update(extra or {})
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

def rpc(command, params=None):
    status, result = request(BASE + '/api/rpc', {'sessionPath': str(session), 'command': command, 'params': params or {}})
    assert status == 200 and result.get('ok') is not False, (status, result)
    return result.get('data', result)

def wait_for_descriptor():
    for _ in range(200):
        if child.poll() is not None:
            raise AssertionError(f'OMP exited {child.returncode}; {log.read_text(errors="replace")[-8000:]}')
        for path in (STATE / 'desktop-controls').glob('*.json'):
            descriptor = json.loads(path.read_text())
            if descriptor.get('sessionPath') == str(session):
                return path, descriptor
        time.sleep(0.1)
    tui_output = log.read_text(errors='replace')[-8000:]
    raise AssertionError(f'No descriptor; {tui_output}')

try:
    descriptor_path, descriptor = wait_for_descriptor()
    assert descriptor['pid'] == child.pid, descriptor['pid']
    if os.name != 'nt':
        assert descriptor_path.stat().st_mode & 0o777 == 0o600
    control_url = f'http://127.0.0.1:{descriptor["port"]}/control'
    envelope = {'sessionPath': str(session), 'method': 'get_state', 'params': {}}
    status, result = request(control_url, envelope, token='wrong')
    assert status == 401, (status, result)
    status, result = request(control_url, envelope, token=descriptor['token'], extra={'Origin': 'https://untrusted.example'})
    assert status in (400, 403), (status, result)
    status, result = request(control_url, dict(envelope, sessionPath=str(session) + '.different'), token=descriptor['token'])
    assert status >= 400 or result.get('ok') is False, (status, result)
    print('ok extension authenticates requests, rejects browser origins and binds the exact active session', flush=True)
    initial = rpc('get_state')
    assert initial['model']['id'] == MODEL_ID and initial['model']['provider'] == PROVIDER, initial
    catalogue = rpc('get_available_models')
    models = catalogue.get('models', []) if isinstance(catalogue, dict) else catalogue
    supported = [m for m in models if m.get('provider') == PROVIDER and len(m.get('thinking', {}).get('efforts', [])) >= 2]
    assert supported, 'No configured multi-effort model for the real settings scenario'
    target = next((m for m in supported if 'gpt-' in m['id']), supported[0])
    levels = target['thinking']['efforts']
    first, second = levels[0], levels[-1]
    rpc('set_model', {'provider': target['provider'], 'modelId': target['id'], 'thinkingLevel': first})
    current = rpc('get_state')
    assert current['model']['id'] == target['id'] and current['thinkingLevel'] == first, current
    rpc('set_model', {'provider': target['provider'], 'modelId': target['id'], 'thinkingLevel': second})
    current = rpc('get_state')
    assert current['model']['id'] == target['id'] and current['thinkingLevel'] == second, current
    status, rejected = request(BASE + '/api/rpc', {'sessionPath': str(session), 'command': 'set_model', 'params': {'provider': initial['model']['provider'], 'modelId': initial['model']['id'], 'thinkingLevel': 'not-a-real-level'}})
    assert status >= 400 or rejected.get('ok') is False, rejected
    unchanged = rpc('get_state')
    assert unchanged['model']['id'] == target['id'] and unchanged['thinkingLevel'] == second, unchanged
    persisted = [json.loads(line) for line in session.read_text().splitlines() if line.strip()]
    assert sum(entry.get('type') == 'message' for entry in persisted) == 2, 'Model settings became transcript prompts'
    assert any(entry.get('type') == 'model_change' for entry in persisted), 'No real model change persisted'
    assert any(entry.get('type') == 'thinking_level_change' for entry in persisted), 'No real thinking change persisted'
    print(f'ok real desktop model and reasoning changed to {target["provider"]}/{target["id"]}: {first} -> {second}; invalid level cannot change the model; no chat prompt added', flush=True)
    if os.environ.get('PULSE_INSPECT') == '1':
        inspection = pathlib.Path('/tmp/pulse-control-inspection.json')
        inspection.write_text(json.dumps({'base': BASE, 'token': TOKEN, 'session': str(session), 'root': str(ROOT), 'tmp': str(TMP), 'model': target, 'thinkingLevel': second}))
        inspection.chmod(0o600)
        print('desktop-control-inspection-ready', flush=True)
        while True:
            time.sleep(1)
finally:
    child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)
    stop.set()
    thread.join(timeout=2)
    os.close(master)
