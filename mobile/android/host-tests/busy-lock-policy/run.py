#!/usr/bin/env python3
"""Compile exact bounded lease/cancellation policies; no Android SDK or sockets."""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app/runtime'


def main():
    with tempfile.TemporaryDirectory(prefix='busy-lock-policy-') as temporary:
        source = (SOURCE / 'DaemonClient.java').read_text()
        methods = source[source.index('    static final class Busy {'):source.index('    private JSONObject postJson(')]
        fixture = pathlib.Path(temporary) / 'DaemonClientFixture.java'
        fixture.write_text((HERE / 'DaemonClientFixture.java.template').read_text().replace('// EXACT_BUSY_CLIENT', methods))
        subprocess.run(['java', 'com.sun.tools.javac.Main', '-Xlint:all', '-Werror', '-d', temporary,
                        str(SOURCE / 'BusyLockPolicy.java'), str(SOURCE / 'BusyWatchControl.java'),
                        str(HERE / 'BusyLockPolicyTest.java'), str(fixture)], check=True, timeout=60)
        for test in ('BusyLockPolicyTest', 'DaemonClientFixture'):
            subprocess.run(['java', '-cp', temporary, 'com.omppulse.app.runtime.' + test],
                           check=True, timeout=30)


if __name__ == '__main__':
    main()
