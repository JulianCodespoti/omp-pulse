// The session switcher drawer (`data-testid="session-switcher"`) is the sole
// session list, search, and project filter surface: the chat header's leading
// button (`session-back`) and home's leading button (`new-session-menu`) open it.

const OPEN_DRAWER = "[data-testid='session-switcher'][data-open]";
const DRAWER_ROWS = "[data-testid='session-switcher'][data-open] [data-testid='session-row']";

/** Open the session switcher drawer from an open chat or home (no-op if already open). */
export async function backToSessions(page) {
  if (await page.$(OPEN_DRAWER)) return true;
  const opened = await page.evaluate(() => {
    const btn =
      document.querySelector("[data-testid='session-back']") ??
      document.querySelector("[data-testid='new-session-menu']");
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    return true;
  });
  if (!opened) return false;
  await page.waitForSelector(OPEN_DRAWER, { timeout: 10000 });
  return true;
}

/**
 * Open the session switcher drawer from a cold start and wait until it shows
 * the drawer surface (`session-switcher[data-open]`).
 */
export async function showSessionsList(page) {
  await page.waitForSelector(
    `${OPEN_DRAWER}, [data-testid='session-back'], [data-testid='new-session-menu']`,
    { timeout: 30000 },
  );
  if (await page.$(OPEN_DRAWER)) return;
  await backToSessions(page);
  await page.waitForSelector(
    `${DRAWER_ROWS}, [data-testid='switcher-empty'], [data-testid='switcher-error'], [data-testid='switcher-slow']`,
    { timeout: 15000 },
  );
}
