import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

SERVER = Path(__file__).resolve().parents[1] / 'bin/phone-mcp'


def load():
    loader = importlib.machinery.SourceFileLoader('phone_mcp_under_test', str(SERVER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


SETTINGS = """# window 7 type=3
android.widget.FrameLayout id=com.android.systemui:id/status_bar [0,0][1080,96]
  android.widget.ImageView desc="Wi-Fi signal full" [900,10][940,80]
# window 9 type=1
android.widget.FrameLayout id=com.android.settings:id/root [0,0][1080,2400]
  androidx.recyclerview.widget.RecyclerView id=com.android.settings:id/list [0,200][1080,2300] scrollable
    android.widget.LinearLayout [0,200][1080,400] clickable
      android.widget.TextView text="Wi-Fi" [40,220][400,280]
      android.widget.TextView text="Off" [40,300][400,360]
    android.widget.LinearLayout [0,400][1080,600] clickable
      android.widget.TextView text="Bluetooth" [40,420][400,480]
  android.widget.TextView text="Total paid=5" [0,2300][1080,2400]
"""

# Same screen with a banner inserted above Wi-Fi: everything below moves down by 100 px.
SETTINGS_MOVED = SETTINGS.replace(
    "    android.widget.LinearLayout [0,200][1080,400] clickable\n",
    "    android.widget.Button text=\"Update available\" [0,200][1080,300] clickable\n"
    "    android.widget.LinearLayout [0,300][1080,500] clickable\n").replace(
    "[40,220][400,280]", "[40,320][400,380]").replace("[40,300][400,360]", "[40,400][400,460]").replace(
    "    android.widget.LinearLayout [0,400][1080,600] clickable\n",
    "    android.widget.LinearLayout [0,500][1080,700] clickable\n").replace(
    "[40,420][400,480]", "[40,520][400,580]")


class FakePhone:
    """Serves queued ui_dump trees (last one repeats) and records gestures."""

    def __init__(self, *trees):
        self.trees, self.calls = list(trees), []

    def __call__(self, cmd, timeout=None, **body):
        self.calls.append((cmd, body))
        if cmd == 'ui_dump':
            tree = self.trees.pop(0) if len(self.trees) > 1 else self.trees[0]
            return {'ok': True, 'tree': tree}
        return {'ok': True}

    def gestures(self):
        return [(cmd, body) for cmd, body in self.calls if cmd != 'ui_dump']


class PhoneMcpTests(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def use(self, fake):
        patcher = mock.patch.object(self.m, 'phone', fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.m.RUNTIME = self.m.Runtime()
        return fake

    def test_clickable_row_is_labelled_by_children_and_text_not_repeated(self):
        self.use(FakePhone(SETTINGS))
        text = self.m.tool_observe({})
        self.assertIn('c "Wi-Fi \u00b7 Off"', text)
        self.assertNotIn('- "Wi-Fi"', text)
        self.assertIn('- "Total paid=5"', text)  # text containing id= is parsed as text

    def test_refs_are_stable_when_nodes_move_and_diff_reports_only_new_node(self):
        self.use(FakePhone(SETTINGS, SETTINGS_MOVED))
        first = self.m.tool_observe({})
        wifi_ref = first.split(' c "Wi-Fi')[0].rsplit('\n', 1)[-1]
        second = self.m.tool_observe({'diff_only': True})
        self.assertIn('+ ', second)
        self.assertIn('Update available', second)
        self.assertNotIn('Wi-Fi', second)  # moved, not changed
        self.assertIn(wifi_ref + ' c "Wi-Fi', self.m.tool_observe({}))

    def test_ref_tap_uses_the_fresh_position_of_a_moved_node(self):
        fake = self.use(FakePhone(SETTINGS, SETTINGS, SETTINGS_MOVED))
        first = self.m.tool_observe({})
        wifi_ref = first.split(' c "Wi-Fi')[0].rsplit('\n', 1)[-1]
        self.m.tool_act({'steps': [{'tap': wifi_ref}], 'grace_ms': 0, 'settle_ms': 0})
        self.assertEqual(fake.gestures()[0], ('tap', {'x': 540, 'y': 400}))

    def test_vanished_ref_fails_without_tapping(self):
        gone = SETTINGS.replace('text="Bluetooth"', 'text="Hotspot"')
        fake = self.use(FakePhone(SETTINGS, SETTINGS, gone))
        first = self.m.tool_observe({})
        bt_ref = first.split(' c "Bluetooth"')[0].rsplit('\n', 1)[-1]
        out = self.m.call_tool('act', {'steps': [{'tap': bt_ref}], 'grace_ms': 0})
        self.assertTrue(out.get('isError'))
        self.assertIn('not on the current screen', out['content'][0]['text'])
        self.assertEqual(fake.gestures(), [])

    def test_tap_text_prefers_exact_app_match_and_taps_clickable_row(self):
        fake = self.use(FakePhone(SETTINGS))
        self.m.tool_act({'steps': [{'tap_text': 'wi-fi'}], 'grace_ms': 0, 'settle_ms': 0})
        # status bar "Wi-Fi signal full" is only a prefix match; the row centre is tapped
        self.assertEqual(fake.gestures()[0], ('tap', {'x': 540, 'y': 300}))

    def test_expect_package_blocks_gestures_in_another_app(self):
        fake = self.use(FakePhone(SETTINGS))
        out = self.m.call_tool('act', {'steps': [{'tap': [10, 10]}], 'expect_package': 'com.example.other'})
        self.assertTrue(out.get('isError'))
        self.assertIn('com.android.settings is in front', out['content'][0]['text'])
        self.assertEqual(fake.gestures(), [])

    def test_steps_after_a_failure_are_not_run(self):
        fake = self.use(FakePhone(SETTINGS))
        out = self.m.call_tool('act', {'steps': [{'tap_text': 'Nowhere'}, {'key': 'home'}], 'grace_ms': 0})
        self.assertTrue(out.get('isError'))
        self.assertEqual(fake.gestures(), [])

    def test_settle_waits_for_late_change_then_quiet(self):
        self.use(FakePhone(SETTINGS, SETTINGS, SETTINGS, SETTINGS_MOVED, SETTINGS_MOVED))
        rt = self.m.RUNTIME
        rt.fetch()
        changed, timed_out, _ = rt.settle(rt.screen.hash, settle_ms=0, max_wait_ms=2000, grace_ms=1000, poll_ms=0)
        self.assertTrue(changed)
        self.assertFalse(timed_out)
        self.assertIn('Update available', '\n'.join(rt.lines))

    def test_tool_bug_returns_error_instead_of_killing_server(self):
        def broken(cmd, timeout=None, **body):
            raise AttributeError('boom')
        self.use(broken)
        out = self.m.call_tool('screenshot', {})
        self.assertTrue(out.get('isError'))
        self.assertIn('internal error', out['content'][0]['text'])
        self.assertIsNone(self.m.handle({'jsonrpc': '2.0', 'method': 'notifications/initialized'}))


class ToolListTests(unittest.TestCase):
    def test_lists_only_phone_api_tools(self):
        reply = load().handle({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        self.assertEqual([tool['name'] for tool in reply['result']['tools']],
                         ['observe', 'act', 'status', 'apps', 'screenshot', 'clipboard'])


if __name__ == '__main__':
    unittest.main()
