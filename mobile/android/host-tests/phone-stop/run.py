#!/usr/bin/env python3
"""Stop/resume of phone mode: persisted OFF, no revived resources, real subprocess shutdown.

Needs only python3 and a JDK on a POSIX host (/bin/sh, kill, /proc). The production methods are
extracted verbatim (the harness fails when their anchors drift) and compiled against small fakes of
the Android classes. The shutdown tests run REAL processes that mimic proot 5.1.107.96 (ignore
SIGTERM, kill the guest on SIGQUIT), so they prove the signalling choice, not the proot binary.
"""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
APP = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app'
RUNTIME = APP / 'runtime'

PROCESS_FAKE = '''package android.os;

/** Signals go to a hook (selection tests) or, with no hook, are dropped. */
public final class Process {
    public static java.util.function.BiConsumer<Integer, Integer> hook;
    public static int myPid() { return (int) ProcessHandle.current().pid(); }
    public static void sendSignal(int pid, int signal) { if (hook != null) hook.accept(pid, signal); }
    public static void killProcess(int pid) { sendSignal(pid, 9); }
}
'''


def span(source, start, end):
    """Verbatim text from the start anchor up to (excluding) the end anchor."""
    a = source.index(start)
    return source[a:source.index(end, a + len(start))]


def main():
    runtime = (RUNTIME / 'LocalRuntime.java').read_text()
    service = (RUNTIME / 'LocalPulseService.java').read_text()
    token_store = (APP / 'TokenStore.java').read_text()
    native_config = (APP / 'NativeConfig.java').read_text()
    notify = (APP / 'NotifyService.java').read_text()

    runtime_fixture = (HERE / 'RuntimeStopFixture.java.template').read_text()
    for marker, text in {
        '// EXACT_CONSTANTS': span(runtime, '    private static final int SIGQUIT =', '    private static final String RUNTIME_PREFS'),
        '// EXACT_MODE_ENUM': span(runtime, '    public enum Mode {', '    private static final String TAG'),
        '// EXACT_MODE_METHODS': span(runtime, '    public Mode mode() {', '    public boolean isSupported()'),
        '// EXACT_SIGNAL_METHODS': span(runtime, "    /** Stops this app's omp-pulse daemons", '    /** Re-pairs with the running daemon'),
        '// EXACT_SHUTDOWN_CONSTANT': span(service, '    private static final long SHUTDOWN_WAIT_MS', '\n').rstrip('\n') + '\n',
        '// EXACT_SHUTDOWN_METHODS': span(service, '    /**\n     * Stops the daemon and its guest tree', '    private static String message('),
    }.items():
        runtime_fixture = runtime_fixture.replace(marker, text)

    scope_fixture = (HERE / 'ScopeFixture.java.template').read_text()
    for marker, text in {
        '// EXACT_SERVER_URL': span(native_config, '    public static String serverUrl(', '    /**\n     * The laptop\'s /app/ URL'),
        '// EXACT_TOKEN_STORE': span(token_store, '    public static void saveToken(', '    // INVARIANT: reflection path'),
        '// EXACT_NOTIFY_STARTS': span(notify, '    /**\n     * Whether the current run mode has a daemon', '    public static void stop(Context ctx)'),
    }.items():
        scope_fixture = scope_fixture.replace(marker, text)

    with tempfile.TemporaryDirectory(prefix='phone-stop-') as temporary:
        out = pathlib.Path(temporary)
        sources = out / 'src'
        (sources / 'android/os').mkdir(parents=True)
        (sources / 'android/os/Process.java').write_text(PROCESS_FAKE)
        (sources / 'RuntimeStopFixture.java').write_text(runtime_fixture)
        (sources / 'ScopeFixture.java').write_text(scope_fixture)
        subprocess.run(['java', 'com.sun.tools.javac.Main', '-Xlint:all', '-Werror', '-d', str(out),
                        str(sources / 'android/os/Process.java'),
                        str(sources / 'RuntimeStopFixture.java'), str(sources / 'ScopeFixture.java'),
                        str(RUNTIME / 'RuntimeIo.java'), str(RUNTIME / 'Posix.java')], check=True, timeout=90)
        for name in ('com.omppulse.app.runtime.RuntimeStopFixture', 'com.omppulse.app.ScopeFixture'):
            subprocess.run(['java', '-Djava.io.tmpdir=' + str(out), '-cp', str(out), name], check=True, timeout=60)


if __name__ == '__main__':
    main()
