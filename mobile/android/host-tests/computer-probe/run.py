#!/usr/bin/env python3
"""Saved-computer availability checks: real loopback HTTP for the transport, deterministic sweep policy.

Needs only python3 and a JDK. ComputerProbe.java has no Android dependency, so the production
source is compiled unchanged; the test serves HTTP on 127.0.0.1 only.
"""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app/bridge/ComputerProbe.java'


def main():
    with tempfile.TemporaryDirectory(prefix='computer-probe-') as temporary:
        subprocess.run(['java', 'com.sun.tools.javac.Main', '-Xlint:all', '-Werror', '-d', temporary,
                        str(SOURCE), str(HERE / 'ComputerProbeTest.java')], check=True, timeout=90)
        subprocess.run(['java', '-cp', temporary, 'com.omppulse.app.bridge.ComputerProbeTest'],
                       check=True, timeout=120)


if __name__ == '__main__':
    main()
