package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class InstallerTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final List<String> ran = new ArrayList<>();

    private final class FakeStep extends Installer.Step {
        final String name;
        String key;
        boolean present = true;
        boolean crash;

        FakeStep(String name, String key) {
            this.name = name;
            this.key = key;
        }

        @Override String name() { return name; }

        @Override String key() { return key; }

        @Override boolean present() { return present; }

        @Override void run() throws Exception {
            ran.add(name);
            if (crash) throw new IllegalStateException("crash in " + name);
        }
    }

    private Installer installer() {
        return new Installer(new File(tmp.getRoot(), "state.properties"));
    }

    @Test
    public void runsStepsInOrderOnceAndRecordsThem() throws Exception {
        FakeStep a = new FakeStep("rootfs", "1");
        FakeStep b = new FakeStep("omp", "v1@aa");
        List<FakeStep> steps = Arrays.asList(a, b);
        assertFalse(installer().allDone(steps));
        installer().run(steps);
        assertEquals(Arrays.asList("rootfs", "omp"), ran);
        assertTrue(installer().allDone(steps));
        installer().run(steps);
        assertEquals("unchanged spec re-runs nothing", 2, ran.size());
    }

    @Test
    public void resumesAtTheFirstUnfinishedStepAfterACrash() throws Exception {
        FakeStep a = new FakeStep("rootfs", "1");
        FakeStep b = new FakeStep("packages", "repo|bash");
        FakeStep c = new FakeStep("omp", "v1@aa");
        b.crash = true;
        try {
            installer().run(Arrays.asList(a, b, c));
            fail("expected crash");
        } catch (IllegalStateException expected) {
            // the process would die here
        }
        b.crash = false;
        ran.clear();
        installer().run(Arrays.asList(a, b, c));
        assertEquals(Arrays.asList("packages", "omp"), ran);
    }

    @Test
    public void keyChangeRerunsOnlyThatStep() throws Exception {
        FakeStep a = new FakeStep("rootfs", "1");
        FakeStep omp = new FakeStep("omp", "v1@aa");
        installer().run(Arrays.asList(a, omp));
        ran.clear();
        omp.key = "v2@bb";
        assertFalse(installer().allDone(Arrays.asList(a, omp)));
        installer().run(Arrays.asList(a, omp));
        assertEquals(Arrays.asList("omp"), ran);
    }

    @Test
    public void missingResultRerunsStep() throws Exception {
        FakeStep a = new FakeStep("rootfs", "1");
        installer().run(Arrays.asList(a));
        a.present = false;
        ran.clear();
        assertFalse(installer().allDone(Arrays.asList(a)));
        installer().run(Arrays.asList(a));
        assertEquals(Arrays.asList("rootfs"), ran);
    }

    @Test
    public void recordedAdoptionSkipsStep() throws Exception {
        FakeStep omp = new FakeStep("omp", "v1@aa");
        Installer i = installer();
        assertFalse(i.hasState());
        i.record("omp", "v1@aa");
        assertTrue(i.hasState());
        i.run(Arrays.asList(omp));
        assertTrue(ran.isEmpty());
    }

    @Test
    public void legacyAdoptionRecordsEveryPresentStep() throws Exception {
        FakeStep rootfs = new FakeStep("rootfs", "1");
        FakeStep packages = new FakeStep("packages", "repo|bash");
        FakeStep omp = new FakeStep("omp", "v1@aa");
        FakeStep setup = new FakeStep("setup", "1");
        setup.present = false;
        List<FakeStep> steps = Arrays.asList(rootfs, packages, omp, setup);
        Installer i = installer();
        i.adoptPresent(steps);
        assertTrue(i.hasState());
        assertTrue(i.recorded(rootfs));
        assertTrue(i.recorded(packages));
        assertTrue(i.recorded(omp));
        assertFalse("a missing result is not adopted", i.recorded(setup));
        i.run(steps);
        assertEquals("only the absent step runs; nothing present is redone", Arrays.asList("setup"), ran);
    }

    @Test
    public void legacyAdoptionNeverOverridesExistingState() throws Exception {
        FakeStep omp = new FakeStep("omp", "v1@aa");
        Installer i = installer();
        i.record("omp", "v0@00");
        i.adoptPresent(Arrays.asList(omp));
        assertFalse(i.recorded(omp));
    }

    @Test
    public void interruptStopsBetweenSteps() throws Exception {
        FakeStep a = new FakeStep("rootfs", "1");
        Thread.currentThread().interrupt();
        try {
            installer().run(Arrays.asList(a));
            fail("expected interruption");
        } catch (InterruptedException expected) {
            // cancelled before running anything
        }
        assertTrue(ran.isEmpty());
    }
}
