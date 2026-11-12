#!/usr/bin/env python3
"""Host checks for exact shell ownership helpers and JobService lifecycle methods."""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app'


def main():
    job = (SOURCE / 'NativeOutboxJob.java').read_text()
    methods = job[job.index('    @Override public boolean onStartJob('):job.rfind('\n}')]
    methods = methods.replace('@Override ', '')
    with tempfile.TemporaryDirectory(prefix='native-lifecycle-') as temporary:
        fixture = pathlib.Path(temporary) / 'OutboxJobFixture.java'
        fixture.write_text((HERE / 'OutboxJobFixture.java.template').read_text().replace('// EXACT_JOB_METHODS', methods))
        subprocess.run(['java', 'com.sun.tools.javac.Main', '-Xlint:all', '-Werror', '-d', temporary,
                        str(SOURCE / 'ShellLifecycle.java'), str(HERE / 'ShellLifecycleTest.java'),
                        str(fixture)], check=True, timeout=60)
        for name in ('ShellLifecycleTest', 'OutboxJobFixture'):
            subprocess.run(['java', '-cp', temporary, 'com.omppulse.app.' + name], check=True, timeout=30)


if __name__ == '__main__':
    main()
