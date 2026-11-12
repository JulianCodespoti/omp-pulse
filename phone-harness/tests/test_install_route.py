import contextlib
import importlib.machinery
import importlib.util
import io
from pathlib import Path
import types
import unittest
from unittest import mock

ANDROID = Path(__file__).resolve().parents[1] / 'bin/android'


def load():
    loader = importlib.machinery.SourceFileLoader('android_cli_under_test', str(ANDROID))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


INSTALLER = ['android.widget.TextView text="Do you want to install this app?" [0,100][1080,200]',
             'android.widget.Button text="Install" id=com.android.packageinstaller:id/ok [600,2000][1000,2100] clickable']
WARNING = ['android.widget.TextView text="Blocked by Play Protect" [0,100][1080,200]',
           'android.widget.Button text="Install anyway" id=com.android.packageinstaller:id/ok [600,2000][1000,2100] clickable']


class InstallRouteTests(unittest.TestCase):
    def setUp(self):
        self.cli = load()
        self.calls = []
        mock.patch.object(self.cli.time, 'sleep').start()
        self.addCleanup(mock.patch.stopall)

    def phone(self, accessibility=True):
        def call(cmd, **body):
            self.calls.append((cmd, body))
            return {'ok': True, 'accessibility': accessibility} if cmd == 'status' else {'ok': True}
        mock.patch.object(self.cli, 'call', side_effect=call).start()

    def confirm(self, windows):
        mock.patch.object(self.cli, 'installer_window', side_effect=windows).start()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.cli.confirm_install('/tmp/app.apk', 30)
        return code, out.getvalue(), err.getvalue()

    def test_plain_install_only_opens_the_system_installer(self):
        args = types.SimpleNamespace(cmd='install', apk='app.apk', confirm=False, wait=5)
        cmd, body, _ = self.cli.run(args)
        self.assertEqual(cmd, 'install')
        self.assertTrue(Path(body['path']).is_absolute())

    def test_confirm_routes_to_the_accessibility_flow(self):
        args = types.SimpleNamespace(cmd='install', apk='app.apk', confirm=True, wait=5)
        with mock.patch.object(self.cli, 'confirm_install', return_value=0) as confirm, \
                self.assertRaises(SystemExit) as exited:
            self.cli.run(args)
        self.assertEqual(exited.exception.code, 0)
        confirm.assert_called_once_with(self.cli.absp('app.apk'), 5)

    def test_confirm_without_accessibility_never_opens_the_installer(self):
        self.phone(accessibility=False)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.cli.confirm_install('/tmp/app.apk', 30)
        self.assertEqual([c for c, _ in self.calls], ['status'])

    def test_confirm_taps_install_and_reports_success_when_the_installer_closes(self):
        self.phone()
        code, out, _ = self.confirm([(INSTALLER, False), (None, False)])
        self.assertEqual(code, 0)
        self.assertIn('installed', out)
        self.assertEqual(self.calls[1], ('install', {'path': '/tmp/app.apk'}))
        self.assertEqual(self.calls[2], ('tap', {'x': 800, 'y': 2050}))

    def test_security_warning_is_left_to_the_user(self):
        self.phone()
        code, _, err = self.confirm([(WARNING, False)])
        self.assertEqual(code, 3)
        self.assertNotIn('tap', [c for c, _ in self.calls])
        self.assertIn('security warning', err)


if __name__ == '__main__':
    unittest.main()
