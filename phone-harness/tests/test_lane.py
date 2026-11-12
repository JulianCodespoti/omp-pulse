import importlib.machinery
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[1]


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_') + '_under_test', str(REPO / 'bin' / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class LaneRoutingTests(unittest.TestCase):
    def setUp(self):
        self.h = load('heavy')

    def test_only_lines_where_every_match_is_output_only_go_to_the_lane(self):
        self.assertTrue(self.h.classify('cargo test -q')['lane'])
        self.assertTrue(self.h.classify('cd web && node --test x.test.mjs | tail -3')['lane'])
        # The build's artifacts are needed here, so the whole line stays local.
        self.assertFalse(self.h.classify('cargo test && cargo build --release')['lane'])
        self.assertFalse(self.h.classify('cargo build')['lane'])


class LaneSyncTests(unittest.TestCase):
    def setUp(self):
        self.lane = load('lane')
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, 'proj')
        os.makedirs(os.path.join(self.root, 'src'))
        os.makedirs(os.path.join(self.root, 'target', 'debug'))
        for rel in ('src/a.rs', 'src/b.rs', 'target/debug/big', '.git'):
            with open(os.path.join(self.root, rel), 'w') as f:
                f.write(rel)
        os.symlink('a.rs', os.path.join(self.root, 'src', 'link'))

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self):
        return self.lane.scan([self.root], skip_names=self.lane.PROJECT_SKIP_NAMES)

    def test_build_output_and_git_never_sync_and_edits_deletions_and_links_do(self):
        first = self.scan()
        self.assertFalse(any('/target' in p or p.endswith('.git') for p in first))
        self.assertEqual(first[os.path.join(self.root, 'src', 'link')][0], 'l')
        with open(os.path.join(self.root, 'src', 'a.rs'), 'w') as f:
            f.write('changed and longer')
        os.remove(os.path.join(self.root, 'src', 'b.rs'))
        changed, removed = self.lane.diff(first, self.scan())
        self.assertEqual(changed, [os.path.join(self.root, 'src', 'a.rs')])
        self.assertEqual(removed, [os.path.join(self.root, 'src', 'b.rs')])
        self.assertEqual(self.lane.diff(self.scan(), self.scan()), ([], []))


class LaneFallbackTests(unittest.TestCase):
    def setUp(self):
        self.lane = load('lane')

    def test_without_a_shell_the_command_still_runs_here_with_its_exit_code(self):
        with mock.patch.object(self.lane, 'is_set_up', return_value=True), \
                mock.patch.object(self.lane, 'shell_ok', return_value=False), mock.patch('sys.stderr'):
            self.assertEqual(self.lane.run('exit 5', str(REPO)), 5)

    def test_secrets_never_reach_the_lane_environment(self):
        env = {'CARGO_TERM_COLOR': 'always', 'CARGO_REGISTRY_TOKEN': 's3cret', 'NODE_AUTH_TOKEN': 'x',
               'RUSTC_WRAPPER': 'sccache', 'ANTHROPIC_API_KEY': 'k', 'NODE_OPTIONS': '--x'}
        with mock.patch.dict(os.environ, env, clear=True):
            got = self.lane.lane_env()
        self.assertEqual(got['CARGO_TERM_COLOR'], 'always')
        self.assertEqual(got['NODE_OPTIONS'], '--x')
        for k in ('CARGO_REGISTRY_TOKEN', 'NODE_AUTH_TOKEN', 'RUSTC_WRAPPER', 'ANTHROPIC_API_KEY'):
            self.assertNotIn(k, got)


if __name__ == '__main__':
    unittest.main()
