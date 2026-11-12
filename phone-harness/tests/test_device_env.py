"""Runtime-detected phone facts: app endpoint, RAM-scaled limits, cores, app/OEM applicability.

Nothing here touches the phone: endpoint/device files are temporary, subprocesses are mocked."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

BIN = Path(__file__).resolve().parents[1] / 'bin'
REFERENCE_MEMTOTAL = 11113  # MemTotal (MB) of the phone the limits were tuned on


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_') + '_env_under_test', str(BIN / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def completed(code=0, stdout='', stderr=''):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class TempFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(mock.patch.stopall)

    def file(self, name, content):
        path = os.path.join(self.tmp.name, name)
        with open(path, 'w') as handle:
            handle.write(content if isinstance(content, str) else json.dumps(content))
        return path

    def missing(self, name='absent.json'):
        return os.path.join(self.tmp.name, name)


ENDPOINT = {'phoneApi': 'http://127.0.0.1:41234/v1/', 'daemon': 'http://127.0.0.1:45555/',
            'package': 'com.example.pulse', 'nativeLibraryDir': '/data/app/~~x/com.example.pulse-y/lib/arm64'}


class EndpointTests(TempFiles):
    def test_android_reads_the_phone_api_url_and_falls_back_to_the_old_port(self):
        cli = load('android')
        cases = ((self.file('e.json', ENDPOINT), 'http://127.0.0.1:41234/v1/'),
                 (self.file('noslash.json', {'phoneApi': 'http://127.0.0.1:5000/v1'}), 'http://127.0.0.1:5000/v1/'),
                 (self.missing(), 'http://127.0.0.1:7690/v1/'),
                 (self.file('bad.json', '{oops'), 'http://127.0.0.1:7690/v1/'),
                 (self.file('list.json', []), 'http://127.0.0.1:7690/v1/'),
                 (self.file('old.json', {'daemon': 'http://127.0.0.1:7681/'}), 'http://127.0.0.1:7690/v1/'))
        for path, url in cases:
            with self.subTest(path=os.path.basename(path)), mock.patch.object(cli, 'ENDPOINT_FILE', path):
                self.assertEqual(cli.api_url(), url)

    def test_android_calls_go_to_the_endpoint_url(self):
        cli = load('android')
        token = self.file('token', 'secret\n')
        seen = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def urlopen(request, timeout):
            seen.append(request.full_url)
            return Response(b'{"ok": true}')
        with mock.patch.object(cli, 'ENDPOINT_FILE', self.file('e.json', ENDPOINT)), \
                mock.patch.object(cli, 'TOKEN_FILE', token), mock.patch('urllib.request.urlopen', urlopen):
            self.assertEqual(cli.call('status'), {'ok': True})
        self.assertEqual(seen, ['http://127.0.0.1:41234/v1/status'])

    def test_phone_mcp_port_follows_endpoint_json_with_the_old_port_as_fallback(self):
        mcp = load('phone-mcp')
        for path, port in ((self.file('e.json', ENDPOINT), 41234), (self.missing(), 7690),
                           (self.file('bad.json', 'nope'), 7690), (self.file('none.json', {'phoneApi': None}), 7690),
                           (self.file('noport.json', {'phoneApi': 'http://127.0.0.1/v1/'}), 7690)):
            with self.subTest(path=os.path.basename(path)), mock.patch.object(mcp, 'ENDPOINT_FILE', path):
                self.assertEqual(mcp.phone_port(), port)

    def test_phone_mcp_rereads_the_port_after_the_app_went_away(self):
        mcp = load('phone-mcp')
        endpoint = self.file('e.json', ENDPOINT)
        token = self.file('token', 't')
        mock.patch.object(mcp, 'ENDPOINT_FILE', endpoint).start()
        service = mcp.Service('PhoneApi', mcp.phone_port, token)
        ports = []

        class Refused:
            def __init__(self, host, port, timeout):
                ports.append(port)

            def request(self, *args):
                raise ConnectionRefusedError('refused')

            def close(self):
                pass
        with mock.patch.object(mcp.http.client, 'HTTPConnection', Refused):
            with self.assertRaises(mcp.Failure):
                service.post('/v1/status', {})
            Path(endpoint).write_text(json.dumps({'phoneApi': 'http://127.0.0.1:42000/v1/'}))
            with self.assertRaises(mcp.Failure):
                service.post('/v1/status', {})
        self.assertEqual(ports, [41234, 42000])

    def test_phone_bench_uses_the_endpoint_port(self):
        bench = load('phone-bench')
        with mock.patch.object(bench, 'ENDPOINT_FILE', self.file('e.json', ENDPOINT)):
            self.assertEqual(bench.phone_port(), 41234)
        with mock.patch.object(bench, 'ENDPOINT_FILE', self.missing()):
            self.assertEqual(bench.phone_port(), 7690)

    def test_lane_prefers_the_endpoint_library_dir_then_pm_path_for_the_endpoint_package(self):
        lane = load('lane')
        with mock.patch.object(lane, 'ENDPOINT_FILE', self.file('e.json', ENDPOINT)), \
                mock.patch.object(lane, 'adb') as adb:
            self.assertEqual(lane.proot_dir(), ENDPOINT['nativeLibraryDir'])
            adb.assert_not_called()
        older = self.file('older.json', {'phoneApi': ENDPOINT['phoneApi'], 'package': 'com.example.pulse'})
        for path, package in ((older, 'com.example.pulse'), (self.missing(), 'com.omppulse.app')):
            with self.subTest(package=package), mock.patch.object(lane, 'ENDPOINT_FILE', path), \
                    mock.patch.object(lane, 'adb', return_value=completed(0, 'package:/data/app/~~a/p-b/base.apk\n')) as adb:
                self.assertEqual(lane.proot_dir(), '/data/app/~~a/p-b/lib/arm64')
                self.assertEqual(adb.call_args.args[0], 'pm path ' + package)

    def test_shell_tier_protects_the_endpoint_package(self):
        st = load('shell-tier')
        with mock.patch.object(st, 'ENDPOINT_FILE', self.file('e.json', ENDPOINT)):
            self.assertEqual(st.pulse_package(), 'com.example.pulse')
        with mock.patch.object(st, 'ENDPOINT_FILE', self.missing()):
            self.assertEqual(st.pulse_package(), 'com.omppulse.app')


class ShellTierGrantTests(unittest.TestCase):
    def test_grants_only_touch_omp_pulse_and_report_failures(self):
        st = load('shell-tier')
        ran = []

        def fake_adb(*args, timeout=30):
            ran.append(args[-1])
            return completed(1 if 'RUN_IN_BACKGROUND' in args[-1] else 0, 'ok')
        with mock.patch.object(st, 'adb', side_effect=fake_adb), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(st.grants(), 1)
        self.assertEqual(ran, st.GRANTS)
        self.assertTrue(all(st.PULSE in line for line in ran))
        self.assertIn('FAIL  appops set %s RUN_IN_BACKGROUND allow' % st.PULSE, out.getvalue())


class RamScalingTests(unittest.TestCase):
    def test_mem_guard_reference_phone_gets_the_tuned_thresholds(self):
        guard = load('mem-guard')
        self.assertEqual(guard.thresholds(REFERENCE_MEMTOTAL),
                         {'MIN_AVAIL_MB': 1000, 'MIN_VICTIM_MB': 400, 'RENICE_MB': 1000, 'MAX_JOB_MB': 3000})

    def test_mem_guard_smaller_phone_gets_smaller_thresholds_never_below_floors(self):
        guard = load('mem-guard')
        reference = guard.thresholds(REFERENCE_MEMTOTAL)
        six = guard.thresholds(6 * 1024)
        for key in reference:
            self.assertLess(six[key], reference[key], key)
        tiny = guard.thresholds(1024)
        self.assertEqual(tiny, {'MIN_AVAIL_MB': 500, 'MIN_VICTIM_MB': 200, 'RENICE_MB': 500, 'MAX_JOB_MB': 1500})
        self.assertGreater(guard.thresholds(16 * 1024)['MAX_JOB_MB'], 3000)

    def test_mem_guard_help_prints_the_live_values(self):
        guard = load('mem-guard')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(guard.main(['--help']), 0)
        self.assertIn('This phone: MemTotal %d MB' % guard.MEMTOTAL_MB, out.getvalue())
        self.assertIn('kill >= %d MB' % guard.MAX_JOB_MB, out.getvalue())

    def heavy_config(self):
        return json.loads((BIN.parent / 'agent/heavy-jobs.json').read_text())

    def test_heavy_reference_phone_gets_the_rules_values(self):
        heavy = load('heavy')
        cfg = self.heavy_config()
        scaled = heavy.scale_config(cfg, REFERENCE_MEMTOTAL)
        self.assertEqual(scaled['reserve_mb'], cfg['reserve_mb'])
        self.assertEqual({k: c['mem_mb'] for k, c in scaled['classes'].items()},
                         {k: c['mem_mb'] for k, c in cfg['classes'].items()})
        self.assertEqual(scaled['rules'], cfg['rules'])

    def test_heavy_smaller_phone_gets_smaller_values_never_below_floors(self):
        heavy = load('heavy')
        cfg = self.heavy_config()
        six = heavy.scale_config(cfg, 6 * 1024)
        self.assertLess(six['reserve_mb'], cfg['reserve_mb'])
        for name, c in cfg['classes'].items():
            self.assertLess(six['classes'][name]['mem_mb'], c['mem_mb'], name)
            self.assertEqual(six['classes'][name]['cpu'], c['cpu'])
        tiny = heavy.scale_config(cfg, 512)
        self.assertEqual(tiny['reserve_mb'], heavy.MIN_RESERVE_MB)
        self.assertTrue(all(c['mem_mb'] >= min(cfg['classes'][n]['mem_mb'], heavy.MIN_CLASS_MB)
                            for n, c in tiny['classes'].items()))
        # A configured value below the floor is never raised.
        self.assertEqual(heavy.scale_config({'reserve_mb': 100, 'classes': {'t': {'mem_mb': 50}}}, 512),
                         {'reserve_mb': 100, 'classes': {'t': {'mem_mb': 50}}})

    def test_heavy_config_and_help_use_the_scaled_values(self):
        heavy = load('heavy')
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle:
            json.dump({'reserve_mb': 1200, 'classes': {'rust': {'mem_mb': 1500, 'cpu': 2}}, 'rules': []}, handle)
        self.addCleanup(os.unlink, handle.name)
        with mock.patch.object(heavy, 'CONFIG', handle.name), mock.patch.object(heavy, 'MEMTOTAL_MB', 6 * 1024), \
                mock.patch.object(heavy, 'ncpus', return_value=3):
            self.assertEqual(heavy.config()['reserve_mb'], 650)
            self.assertEqual(heavy.config()['classes']['rust']['mem_mb'], 850)
            text = heavy.live_limits()
        self.assertIn('MemTotal 6144 MB', text)
        self.assertIn('3 CPU slots', text)
        self.assertIn('reserve 650 MB', text)
        self.assertIn('rust 850 MB/2 cpu', text)


class CoreTests(unittest.TestCase):
    def test_lane_counts_come_from_the_cpuset_and_the_shell(self):
        lane = load('lane')
        with mock.patch.object(lane.os, 'sched_getaffinity', return_value={0, 1, 4, 5}):
            self.assertEqual(lane.app_cores(), 4)
        with mock.patch.object(lane, 'adb', return_value=completed(0, '8\n')):
            self.assertEqual(lane.lane_cores(), 8)
        with mock.patch.object(lane, 'adb', return_value=completed(1, '', 'no device')):
            self.assertIsNone(lane.lane_cores())

    def test_lane_help_prints_live_counts_and_survives_a_missing_adb(self):
        lane = load('lane')
        out = io.StringIO()
        with mock.patch.object(lane.subprocess, 'run', side_effect=FileNotFoundError('adb')), \
                mock.patch.object(lane.os, 'sched_getaffinity', return_value={0, 1}), contextlib.redirect_stdout(out):
            self.assertEqual(lane.main(['--help']), 0)
        self.assertIn('the app may use 2 cores', out.getvalue())
        self.assertIn('the shell lane unknown', out.getvalue())

    def test_heavy_cpu_slots_follow_the_affinity(self):
        heavy = load('heavy')
        with mock.patch.object(heavy.os, 'sched_getaffinity', return_value={2, 3, 6}):
            self.assertEqual(heavy.ncpus(), 3)


if __name__ == '__main__':
    unittest.main()
