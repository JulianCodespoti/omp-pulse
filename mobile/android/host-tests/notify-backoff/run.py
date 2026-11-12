#!/usr/bin/env python3
"""Run bounded, network-free Java checks for native SSE retry behavior.

Uses the installed Java compiler module; no Android SDK, Gradle, dependencies,
actual sleeps, sockets or device are involved. The service methods are extracted
verbatim; platform boundaries and selected JSON parsing outcomes are fixtures.
"""
import hashlib
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
FIXTURES = pathlib.Path(__file__).resolve().parent
NATIVE = ROOT / "mobile/android/app/src/main/java/com/omppulse/app"


def blob(path):
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def run():
    service = NATIVE / "NotifyService.java"
    helper = NATIVE / "NotifyReconnectBackoff.java"
    source = service.read_text()

    def method(start, end):
        return source[source.index(start):source.index(end, source.index(start))]

    # sseLoop through the parser doc also carries stopWithoutToken, the
    # main-thread half of the unpaired exit.
    methods = method("    private void sseLoop()", "    /**\n     * Minimal SSE parser")
    methods += method("    private void parseSse(", "    /**\n     * Sleep for the backoff window")
    methods += method("    private void sleepWithJitter(", "    private void reconnectNow(")
    methods += method("    private void reconnectNow(", "    // ---- network / screen listeners")
    template = (FIXTURES / "LoopFixture.java.template").read_text()
    print("SOURCE_BLOB", blob(service), flush=True)
    print("HELPER_BLOB", blob(helper), flush=True)

    with tempfile.TemporaryDirectory(prefix="notify-backoff-") as directory:
        output = pathlib.Path(directory)
        fixture = output / "LoopFixture.java"
        fixture.write_text(template.replace("// EXACT_SOURCE_METHODS", methods))
        subprocess.run([
            "java", "com.sun.tools.javac.Main", "-Xlint:all", "-Werror", "-d", str(output),
            str(fixture), str(helper), str(FIXTURES / "NotifyReconnectBackoffTest.java"),
        ], check=True, timeout=30)
        for test, arguments in [("LoopFixture", ["candidate"]), ("NotifyReconnectBackoffTest", [])]:
            subprocess.run(["java", "-cp", str(output), "com.omppulse.app." + test, *arguments], check=True, timeout=30)


if __name__ == "__main__":
    run()
