import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[1]
HEAVY = REPO / 'bin/heavy'
EXTENSION = REPO / 'agent/extensions/heavy-jobs.ts'
RULES = REPO / 'agent/heavy-jobs.json'


def load():
    loader = importlib.machinery.SourceFileLoader('heavy_under_test', str(HEAVY))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def job(jid, owner='a', mb=500, s=60, cpu=1, queued=0.0):
    return {'id': jid, 'owner': owner, 'pred_mb': mb, 'pred_s': s, 'cpu': cpu, 't_queued': queued}


def run(owner='a', mb=500, cur=0, cpu=1):
    return {'owner': owner, 'pred_mb': mb, 'cur_mb': cur, 'cpu': cpu}


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.h = load()

    def pick(self, queued, running=(), avail=4000, ncpu=4, reserve=1000, now=100.0):
        return self.h.pick(list(queued), list(running), avail, ncpu, reserve, now)

    def test_memory_admits_only_what_fits(self):
        self.assertEqual(self.pick([job(1, mb=1500), job(2, mb=1500)], avail=3600), [1])

    def test_idle_machine_always_runs_one_job_even_if_too_big(self):
        self.assertEqual(self.pick([job(1, mb=9000), job(2, mb=9000)], avail=2000), [1])

    def test_running_jobs_reserve_their_predicted_growth(self):
        # 2500 headroom, but the running build is predicted to grow by 1300 more.
        self.assertEqual(self.pick([job(1, mb=1500)], [run(mb=1500, cur=200)], avail=3500), [])
        self.assertEqual(self.pick([job(1, mb=1500)], [run(mb=1500, cur=1500)], avail=3500), [1])

    def test_cpu_slots_cap_parallel_jobs(self):
        self.assertEqual(self.pick([job(1, cpu=2), job(2, cpu=2), job(3, cpu=2)], avail=99999), [1, 2])

    def test_owner_without_running_jobs_goes_first(self):
        got = self.pick([job(1, owner='busy', s=10), job(2, owner='idle', s=500)], [run(owner='busy', mb=0)],
                        avail=1000 + 500, ncpu=2)
        self.assertEqual(got, [2])

    def test_short_jobs_first_and_waiting_ages_long_ones(self):
        self.assertEqual(self.pick([job(1, s=300), job(2, s=5)], [run(mb=0)], avail=1600, ncpu=2), [2])
        # Waited 200 s: 300 - 2*200 < 5, so the long one is now ahead.
        self.assertEqual(self.pick([job(1, s=300, queued=-100), job(2, s=5, queued=100)], [run(mb=0)],
                                   avail=1600, ncpu=2), [1])

    def test_starved_job_only_lets_short_jobs_overtake(self):
        starved = job(1, mb=3000, s=600, queued=-1000)
        long_small = job(2, mb=100, s=300, queued=90)
        short_small = job(3, mb=100, s=10, queued=90)
        self.assertEqual(self.pick([starved, long_small, short_small], [run(mb=0)], avail=2000), [3])

    def test_starved_job_holds_its_place_across_owners(self):
        # Another owner's fitting long job must not jump a job starved for an hour.
        starved = job(1, owner='A', mb=3000, s=600, queued=-3500)
        other = job(2, owner='B', mb=1000, s=900, queued=100)
        self.assertEqual(self.pick([starved, other], [run(owner='A', mb=0)], avail=3000, reserve=1200), [])


class ClassifyTests(unittest.TestCase):
    CASES = {
        'cargo test -j1 --release 2>&1 | tail -3': ('cargo-check', True),
        'cd x && cargo build --release && cp target/x /tmp': ('cargo-build', False),
        'cd web && npx tsc --noEmit -p .': ('tsc', True),
        "git commit -m 'fix cargo test'": (None, False),
        'grep -rn cargo src': (None, False),
        'npm run dev': ('watch', False),
        'npx vite': ('watch', False),
        'cd web && npx vite build && cargo test': ('cargo-check', False),
        'timeout 900 node --test x && node deploy.mjs': ('node-test', False),
        'flock /tmp/l nice -n 19 cargo clippy -j1 -- -D warnings': ('cargo-check', True),
        'e2e/with-test-daemon.sh node e2e/browser/verify-send.mjs': ('e2e', False),
        './gradlew assembleDebug': ('gradle', False),
        'gradle --stop': (None, False),
        '(cd web && tsc)': ('tsc', False),  # emits: a replay would not refresh the output
        'python3 -m unittest discover -s tests': ('py-test', True),
        'cargo test && git push': ('cargo-check', False),
        'cargo test > out.txt': ('cargo-check', False),
        '/usr/bin/cargo check --all-targets': ('cargo-check', True),
        'cd web && npx tsc -p .': ('tsc', False),
        'cargo clippy --fix --allow-dirty': ('cargo-check', False),
        'cargo test 2>&1 | sort -u': ('cargo-check', True),
        'cd /tmp/elsewhere && cargo test': ('cargo-check', False),  # another tree than the fingerprint
        'cargo test --manifest-path ../other/Cargo.toml': ('cargo-check', False),
        "git commit -qm \"$(cat <<'EOF'\nParser: speed up\n\nmake test fixtures smaller\nEOF\n)\"": (None, False),
        'cat > notes.md <<EOF\npytest is flaky\nEOF': (None, False),
        'gh pr create --body "cargo test passes; make it so"': (None, False),
    }

    def setUp(self):
        self.h = load()

    def test_python_rules(self):
        for cmd, (rule_id, cacheable) in self.CASES.items():
            rule = self.h.classify(cmd, '/')
            with self.subTest(cmd=cmd):
                self.assertEqual(rule and rule['id'], rule_id)
                self.assertEqual(bool(rule and rule['cache'] and self.h.pure(cmd)), cacheable)

    @unittest.skipUnless(shutil.which('node'), 'node not installed')
    def test_extension_matches_python(self):
        # The extension's default config is the DEPLOYED harness path; both sides
        # must read this checkout's rules, or a phone compares against its installed
        # copy and any other machine against none at all.
        script = ('const m = await import(%s); const cases = JSON.parse(process.argv[1]);'
                  'const rules = JSON.parse(await (await import("node:fs/promises")).readFile(%s, "utf8"));'
                  'console.log(JSON.stringify(cases.map(c => m.classify(c, "/", rules) ?? null)));') % (
                      json.dumps(str(EXTENSION)), json.dumps(str(RULES)))
        cases = list(self.CASES)
        out = subprocess.run([shutil.which('node'), '--no-warnings', '--input-type=module', '-e', script, json.dumps(cases)],
                             capture_output=True, text=True, check=True, timeout=60).stdout
        for cmd, ts_rule in zip(cases, json.loads(out)):
            py_rule = self.h.classify(cmd, '/')
            with self.subTest(cmd=cmd):
                self.assertEqual(ts_rule and (ts_rule['id'], ts_rule['cache']), py_rule and (py_rule['id'], py_rule['cache']))


class BrokerTests(unittest.TestCase):
    """Real daemon in a temporary state dir; config forces one job at a time."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='heavy-test-')
        self.state = os.path.join(self.tmp, 'state')
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(self.repo)
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        Path(self.repo, 't_slow.py').write_text(
            'import time, unittest\n'
            'class T(unittest.TestCase):\n'
            '    def test_slow(self):\n'
            '        print("slow test ran", flush=True)\n'
            '        time.sleep(1.5)\n')
        Path(self.repo, 't_big.py').write_text(
            'import unittest\n'
            'class T(unittest.TestCase):\n'
            '    def test_big(self):\n'
            '        print("x" * 1000000, flush=True)\n')
        subprocess.run(['git', '-C', self.repo, 'add', '.'], check=True)
        subprocess.run(['git', '-C', self.repo, '-c', 'user.name=t', '-c', 'user.email=t@t',
                        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'],
                       check=True)
        config = {'reserve_mb': 10 ** 7, 'cache_ttl_s': 3600, 'classes': {'t': {'mem_mb': 100, 'cpu': 1}},
                  'rules': [{'id': 'ut', 'class': 't', 'cache': True, 're': r'python3?\s+-m\s+unittest'},
                            {'id': 'sleep', 'class': 't', 're': r'sleep\s'}]}
        self.config = os.path.join(self.tmp, 'heavy-jobs.json')
        Path(self.config).write_text(json.dumps(config))
        self.env = dict(os.environ, HEAVY_STATE=self.state, HEAVY_CONFIG=self.config)
        for k in ('HEAVY_JOB_ID', 'HEAVY', 'HEAVY_NO_CACHE'):
            self.env.pop(k, None)

    def tearDown(self):
        try:
            os.kill(int(Path(self.state, 'heavy.pid').read_text()), signal.SIGTERM)
        except (OSError, ValueError):
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def start(self, *cmd, timeout=None, owner='t'):
        args = [sys.executable, str(HEAVY), 'run', '--owner', owner]
        if timeout:
            args += ['--timeout', str(timeout)]
        return subprocess.Popen(args + ['--', 'bash', '-c', ' '.join(cmd)], cwd=self.repo, env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def history(self):
        out = subprocess.run([sys.executable, str(HEAVY), 'history'], env=self.env, capture_output=True, text=True,
                             check=True).stdout
        return [line.split()[1] for line in out.splitlines()]

    def wait_running(self):
        for _ in range(100):
            out = subprocess.run([sys.executable, str(HEAVY), 'status', '--json'], env=self.env, capture_output=True,
                                 text=True).stdout
            if out and json.loads(out)['running']:
                return
            time.sleep(0.1)
        self.fail('first job never started')

    def test_timeout_counts_from_admission_not_queue(self):
        first = self.start('sleep 3')
        self.wait_running()  # it holds the only slot for ~3 s
        second = self.start('sleep 1', timeout=2)  # queues ~2 s, then needs 1 s of its 2 s
        out, err = second.communicate(timeout=30)
        self.assertEqual(second.returncode, 0, err)
        self.assertIn('queued', err)
        first.wait(timeout=30)

    def test_run_time_limit_stops_the_job(self):
        p = self.start('sleep 30', timeout=1)
        out, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 124)
        self.assertIn('run-time limit', err)

    def test_identical_checks_run_once_then_replay(self):
        a = self.start('python3 -m unittest t_slow', owner='a')
        self.wait_running()
        b = self.start('python3 -m unittest t_slow', owner='b')
        (_, err_a), (out_b, err_b) = a.communicate(timeout=60), b.communicate(timeout=60)
        self.assertEqual((a.returncode, b.returncode), (0, 0), err_a + err_b)
        self.assertIn('already running', err_b)
        self.assertIn('slow test ran', out_b)  # the leader's stdout, replayed to stdout
        self.assertIn('Ran 1 test', err_b)  # ... and its stderr to stderr
        self.assertNotIn('Ran 1 test', out_b)
        c = self.start('python3 -m unittest t_slow')
        _, err_c = c.communicate(timeout=60)
        self.assertEqual(c.returncode, 0)
        self.assertIn('replayed its output', err_c)
        Path(self.repo, 't_slow.py').write_text(Path(self.repo, 't_slow.py').read_text() + '\n# changed\n')
        d = self.start('python3 -m unittest t_slow')
        _, err_d = d.communicate(timeout=60)
        self.assertNotIn('replayed', err_d)  # a changed tree reruns
        self.assertEqual(self.history().count('cached'), 1)
        self.assertEqual(self.history().count('ok'), 2)

    def test_killed_client_takes_its_job_with_it(self):
        pidfile = os.path.join(self.tmp, 'job.pid')
        p = self.start(f'echo $$ > {pidfile}; exec sleep 60')
        for _ in range(100):
            if os.path.exists(pidfile) and Path(pidfile).read_text().strip():
                break
            time.sleep(0.1)
        job_pid = int(Path(pidfile).read_text())
        p.kill()
        p.wait()
        for _ in range(100):
            try:
                os.kill(job_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.kill(job_pid, signal.SIGKILL)
            self.fail('job outlived its client')

    def test_attached_caller_reruns_when_the_leader_is_aborted(self):
        a = self.start('python3 -m unittest t_slow', owner='a')
        self.wait_running()
        b = self.start('python3 -m unittest t_slow', owner='b')
        time.sleep(0.8)  # b attaches to a's run
        a.send_signal(signal.SIGTERM)  # the leader's agent aborts
        a.communicate(timeout=30)
        out_b, err_b = b.communicate(timeout=60)
        self.assertIn('already running', err_b)
        self.assertIn('running it here', err_b)
        self.assertEqual(b.returncode, 0, err_b)  # b's own run passed instead of inheriting the abort

    def test_closed_reader_does_not_hang_the_job(self):
        p = subprocess.Popen([sys.executable, str(HEAVY), 'run', '--', 'bash', '-c', 'python3 -m unittest t_big'],
                             cwd=self.repo, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        p.stdout.read(10)
        p.stdout.close()  # like `| head -c 10`
        self.assertEqual(p.wait(timeout=60), 0)

    def test_timeout_applies_outside_the_broker_too(self):
        out = subprocess.run([sys.executable, str(HEAVY), 'run', '--timeout', '1', '--', 'bash', '-c', 'sleep 30'],
                             cwd=self.repo, env=dict(self.env, HEAVY='off'), capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 124)

    def test_nested_and_bypass_run_directly(self):
        for extra in ({'HEAVY_JOB_ID': '1'}, {'HEAVY': 'off'}):
            out = subprocess.run([sys.executable, str(HEAVY), 'run', '--', 'bash', '-c', 'sleep 0.1; echo direct'],
                                 cwd=self.repo, env=dict(self.env, **extra), capture_output=True, text=True, timeout=30)
            self.assertEqual(out.stdout.strip(), 'direct')
        self.assertFalse(os.path.exists(os.path.join(self.state, 'heavy.sock')))

    def test_unusable_state_dir_fails_open(self):
        env = dict(self.env, HEAVY_STATE='/proc/no-such-dir/heavy')
        out = subprocess.run([sys.executable, str(HEAVY), 'run', '--', 'bash', '-c', 'sleep 0.1; echo ran'],
                             cwd=self.repo, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual((out.returncode, out.stdout.strip()), (0, 'ran'))
        self.assertIn('running directly', out.stderr)


if __name__ == '__main__':
    unittest.main()
