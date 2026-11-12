package com.omppulse.app.runtime;

import java.io.IOException;

/**
 * Runs one command inside the guest and reports its exit code.
 *
 * WHY an interface: production goes through proot ({@link GuestLauncher}); JVM unit tests run the
 * same argv (e.g. git) directly on the host against a temp directory.
 */
interface GuestExec {
    /** Exit code and merged stdout+stderr of one finished command. */
    final class Result {
        final int code;
        final String output;

        Result(int code, String output) {
            this.code = code;
            this.output = output;
        }

        boolean ok() {
            return code == 0;
        }
    }

    /** Runs {@code argv} to completion; a non-zero exit is a result, not an exception. */
    Result exec(String... argv) throws IOException, InterruptedException;
}
