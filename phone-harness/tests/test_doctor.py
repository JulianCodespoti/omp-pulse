import importlib.machinery
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ANDROID = Path(__file__).resolve().parents[1] / 'bin/android'


def load():
    loader = importlib.machinery.SourceFileLoader('android_doctor_under_test', str(ANDROID))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class SeedStatusTests(unittest.TestCase):
    """`android doctor` reports the app's last harness seed merge from harness-seed.json."""

    def setUp(self):
        self.cli = load()
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / 'phone-harness'
        self.repo.mkdir()
        self.status = self.tmp / 'harness-seed.json'
        mock.patch.object(self.cli, 'REPO', str(self.repo)).start()
        mock.patch.object(self.cli, 'SEED_STATUS', str(self.status)).start()
        self.addCleanup(mock.patch.stopall)

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=t', '-c', 'user.email=t@t',
                               '-c', 'commit.gpgsign=false', *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, rel, text, message):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        self.git('add', '-A')
        self.git('commit', '-qm', message)
        return self.git('rev-parse', 'HEAD')

    def seed(self, **fields):
        self.status.write_text(json.dumps(dict({'seed': 'ab' * 32, 'release': 'r42', 'upstream': 'u', 'merge': '',
                                                'conflicts': [], 'detail': ''}, **fields)))

    def checks(self):
        return list(self.cli.seed_checks())

    def test_missing_status_is_a_note_until_the_next_app_start(self):
        self.assertEqual(self.checks(), [('note', 'harness seed', 'no seed status yet (written on the next app start)')])

    def test_unreadable_status_is_a_note_not_a_crash(self):
        self.status.write_text('{not json')
        (status, check, _), = self.checks()
        self.assertEqual((status, check), ('note', 'harness seed'))

    def test_seeded_and_merged_are_ok_with_the_release(self):
        for state in ('seeded', 'merged'):
            with self.subTest(state=state):
                self.seed(state=state)
                self.assertEqual(self.checks(), [('ok', 'harness seed', '%s r42' % state)])

    def test_pending_is_a_fix_with_the_merge_command_and_the_reason(self):
        self.seed(state='pending', detail='uncommitted changes')
        (status, check, detail), = self.checks()
        self.assertEqual((status, check), ('fix', 'harness seed'))
        self.assertIn('commit your changes', detail)
        self.assertIn('`git -C %s merge upstream`' % self.repo, detail)
        self.assertIn('keep your version on conflicts', detail)
        self.assertIn('uncommitted changes', detail)

    def test_conflicts_flag_only_paths_unchanged_since_the_merge(self):
        self.git('init', '-q')
        self.commit('agent/AGENTS.md', 'mine\n', 'base')
        self.commit('bin/android', 'mine\n', 'tool')
        merge = self.commit('README.md', 'merged\n', 'merge upstream')
        self.commit('agent/AGENTS.md', 'merged by hand\n', 'resolve AGENTS.md')
        self.seed(state='conflicts', merge=merge, conflicts=['agent/AGENTS.md', 'bin/android'])
        checks = self.checks()
        self.assertEqual(checks[0][:2], ('ok', 'harness seed'))
        by_path = {check: (status, detail) for status, check, detail in checks[1:]}
        self.assertEqual(by_path['agent/AGENTS.md'][0], 'ok')
        status, detail = by_path['bin/android']
        self.assertEqual(status, 'fix')
        self.assertIn('kept your version over the new seed', detail)
        self.assertIn('`git -C %s diff HEAD upstream -- bin/android`' % self.repo, detail)

    def test_conflict_without_a_known_merge_commit_stays_a_fix(self):
        self.git('init', '-q')
        self.commit('bin/android', 'mine\n', 'base')
        self.seed(state='conflicts', merge='0' * 40, conflicts=['bin/android'])
        self.assertEqual([c[0] for c in self.checks()], ['ok', 'fix'])

    def test_doctor_includes_the_seed_check_and_no_shipped_mirror(self):
        self.seed(state='pending')
        (self.repo / 'bin').mkdir()
        (self.repo / 'bin/asr-setup').write_text('MODEL=m\nSTATE=%s/asr\nVENV=$STATE/venv\n' % self.tmp)
        checks = list(self.cli.doctor_checks())
        self.assertIn('harness seed', [c[1] for c in checks if c[0] == 'fix'])
        self.assertFalse(any('shipped' in c[1] for c in checks))


if __name__ == '__main__':
    unittest.main()
