package com.omppulse.app.runtime;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Properties;

/**
 * Runs ordered, idempotent install steps and records each completed one in a state file.
 *
 * A step is done when the state file holds its current key AND its result is still present on
 * disk. Keys encode what the step installed (e.g. the omp version+sha), so a spec change re-runs
 * exactly the affected steps, an unchanged spec re-runs nothing, and a crash mid-install resumes
 * at the first unfinished step. Pure Java so the bookkeeping is unit-testable.
 */
final class Installer {
    /** One install step. */
    abstract static class Step {
        /** Stable identifier used as the state-file key. */
        abstract String name();

        /** What this step installs for the current spec; a different key means "re-run". */
        abstract String key();

        /** Cheap on-disk check that the step's result still exists. */
        abstract boolean present();

        /** Performs the step. Must be safe to re-run after a crash at any point. */
        abstract void run() throws Exception;
    }

    private final File stateFile;

    Installer(File stateFile) {
        this.stateFile = stateFile;
    }

    boolean done(Step step) {
        return recorded(step) && step.present();
    }

    /** True when the state file holds {@code step}'s current key, whatever is on disk. */
    boolean recorded(Step step) {
        return step.key().equals(load().getProperty(step.name()));
    }

    boolean allDone(List<? extends Step> steps) {
        Properties state = load();
        for (Step s : steps) {
            if (!s.key().equals(state.getProperty(s.name())) || !s.present()) return false;
        }
        return true;
    }

    /**
     * Runs every step that is not done, in order, recording each as it completes. Stops between
     * steps when the thread is interrupted (the service was stopped), so a cancelled install does
     * not keep going alongside the next supervisor.
     */
    void run(List<? extends Step> steps) throws Exception {
        for (Step s : steps) {
            if (Thread.interrupted()) throw new InterruptedException("install cancelled");
            if (done(s)) continue;
            s.run();
            record(s.name(), s.key());
        }
    }

    /** Records {@code name} as done with {@code key}. */
    void record(String name, String key) throws IOException {
        Properties state = load();
        state.setProperty(name, key);
        StringWriter w = new StringWriter();
        state.store(w, "omp-pulse runtime install steps");
        RuntimeIo.writeTextAtomic(stateFile, w.toString());
    }

    /**
     * Adopts an install made before step tracking existed: records every step whose result is
     * present as done with its current key. Without this, the first start after the upgrade would
     * re-run present steps (apk over the network, ~200 MB headroom) and fail offline.
     * No-op once a state file exists.
     */
    void adoptPresent(List<? extends Step> steps) throws IOException {
        if (hasState()) return;
        Properties state = new Properties();
        for (Step s : steps) {
            if (s.present()) state.setProperty(s.name(), s.key());
        }
        StringWriter w = new StringWriter();
        state.store(w, "omp-pulse runtime install steps");
        RuntimeIo.writeTextAtomic(stateFile, w.toString());
    }

    boolean hasState() {
        return stateFile.isFile();
    }

    private Properties load() {
        Properties p = new Properties();
        if (!stateFile.isFile()) return p;
        try (Reader in = new InputStreamReader(new FileInputStream(stateFile), StandardCharsets.UTF_8)) {
            p.load(in);
        } catch (IOException e) {
            // Unreadable state means "nothing recorded": steps re-run, which is safe by contract.
            return new Properties();
        }
        return p;
    }
}
