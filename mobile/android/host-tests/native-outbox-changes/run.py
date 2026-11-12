#!/usr/bin/env python3
"""Exercise exact native coalescing and independently owned main/bubble subscriptions."""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app'


def signal_source():
    text = (SOURCE / 'NativeOutbox.java').read_text()
    start = text.index('    static final class ChangeSignal {')
    depth = 0
    for position in range(text.index('{', start), len(text)):
        if text[position] == '{':
            depth += 1
        elif text[position] == '}':
            depth -= 1
            if depth == 0:
                return text[start:position + 1]
    raise AssertionError('Unclosed ChangeSignal')


def main():
    with tempfile.TemporaryDirectory(prefix='native-outbox-changes-') as temporary:
        target = pathlib.Path(temporary) / 'ChangeSignalTest.java'
        target.write_text((HERE / 'ChangeSignalTest.java').read_text().replace('// EXACT_CHANGE_SIGNAL', signal_source()))
        subprocess.run(['java', 'com.sun.tools.javac.Main', '-Xlint:all', '-Werror', '-d', temporary,
                        str(target), str(SOURCE / 'OutboxPageRegistry.java')], check=True, timeout=60)
        subprocess.run(['java', '-cp', temporary, 'com.omppulse.app.ChangeSignalTest'], check=True, timeout=30)


if __name__ == '__main__':
    main()
