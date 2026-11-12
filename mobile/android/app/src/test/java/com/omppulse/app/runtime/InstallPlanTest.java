package com.omppulse.app.runtime;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Set;
import org.junit.Test;

public class InstallPlanTest {
    /** Shape of /lib/apk/db/installed on Alpine 3.24, where openssh-client is only provided. */
    private static final String DB = "C:Q1abc=\nP:bash\nV:5.3\n\n"
            + "C:Q1def=\nP:openssh-client-default\nV:10.3_p1-r1\n"
            + "p:openssh-client=10.3_p1-r1 cmd:ssh=10.3_p1-r1\n\n";

    @Test
    public void providedNamesCountAsInstalled() {
        Set<String> names = InstallPlan.installedNames(DB);
        assertTrue(names.containsAll(Arrays.asList("bash", "openssh-client", "openssh-client-default")));
    }

    @Test
    public void absentPackageIsNotInstalled() {
        assertFalse(InstallPlan.installedNames(DB).contains("git"));
    }
}
