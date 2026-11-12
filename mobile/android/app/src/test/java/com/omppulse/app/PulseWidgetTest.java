package com.omppulse.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PulseWidgetTest {
    @Test
    public void agoPicksTheCoarsestWholeUnit() {
        assertEquals("now", PulseWidget.ago(-5_000));
        assertEquals("now", PulseWidget.ago(59_999));
        assertEquals("1m", PulseWidget.ago(60_000));
        assertEquals("59m", PulseWidget.ago(59 * 60_000L + 59_999));
        assertEquals("1h", PulseWidget.ago(60 * 60_000L));
        assertEquals("23h", PulseWidget.ago(24 * 60 * 60_000L - 1));
        assertEquals("2d", PulseWidget.ago(2 * 24 * 60 * 60_000L));
    }

    @Test
    public void rowsFollowTheHeightButKeepOneAndStopAtThree() {
        assertEquals(3, PulseWidget.rowsFor(0)); // size not reported yet
        assertEquals(1, PulseWidget.rowsFor(60));
        assertEquals(3, PulseWidget.rowsFor(114)); // a stock 4x2
        assertEquals(3, PulseWidget.rowsFor(400));
    }
}
