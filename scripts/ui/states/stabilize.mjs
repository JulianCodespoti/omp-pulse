// The last thing that happens before a shot: remove what legitimately varies
// between two runs of an unchanged tree, so the baseline diff reports only
// real changes. Each rule here was found by running twice and diffing.
//
//   * Sub-pixel scroll. The transcript's stick-to-bottom animation settles a
//     fraction of a pixel differently each run, which moved every line of a
//     long reply by 1px (120k changed pixels, nothing actually different).
//     Scrollers at their end are snapped to it; others to a whole pixel.
//   * Elapsed seconds. The page clock is pinned to a fixed date but has to
//     run at real speed (page-shim.mjs), so a turn timer read "4m 58s" or
//     "4m 59s" and "Session list refreshed 0s ago" or "1s ago" depending on
//     how long the recipe took. Seconds-level durations and the seconds of
//     clock times are rewritten to a fixed value. Minute-level relative text
//     ("20m") is untouched: fixture ages are whole minutes, so it is stable.
//
// It runs before the UI probe as well as the screenshot, so audit findings
// quote the same text on every run too.

/**
 * Resolve once nothing has scrolled for 200ms (max 3s). The transcript
 * smooth-scrolls to its live edge after it loads, and sheets re-anchor as
 * content lands; a point, offset or shot taken mid-scroll is stale (measured:
 * a touch landed 170ms before the last scroll event, on text, and was ignored).
 */
export async function scrollQuiet(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let last = performance.now();
    const t0 = last;
    const onScroll = () => { last = performance.now(); };
    document.addEventListener("scroll", onScroll, true);
    const tick = () => {
      const now = performance.now();
      if (now - last > 200 || now - t0 > 3000) { document.removeEventListener("scroll", onScroll, true); resolve(); }
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/**
 * @param {import("puppeteer-core").Page} page
 * @param {string[]} [mask] selectors whose content is inherently random
 *   (e.g. a live microphone level): hidden with `visibility`, so layout holds.
 */
export async function stabilize(page, mask = []) {
  // Snapping a scroller that is still animating would freeze it wherever it
  // happened to be: the same state then shot mid-scroll on one run and at
  // the bottom on the next.
  await scrollQuiet(page);
  await page.evaluate((mask) => {
    window.dispatchEvent(new CustomEvent("capture:freeze"));

    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = max - el.scrollTop < 3 ? max : Math.round(el.scrollTop);
    }

    for (const selector of mask) {
      for (const el of document.querySelectorAll(selector)) el.style.setProperty("visibility", "hidden", "important");
    }

    // The spellchecker underlines words asynchronously: "tsc-alias" in a
    // draft was squiggled on one run and not the next.
    for (const el of document.querySelectorAll("textarea, input, [contenteditable]")) el.spellcheck = false;

    const normalize = () => {
      // React renders `{n}s` as TWO adjacent text nodes ("4", "s"), so text
      // is normalised per run of adjacent text siblings, not per node.
      const runs = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let run = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (run && run.at(-1).nextSibling === node) run.push(node);
        else runs.push((run = [node]));
      }
      for (const nodes of runs) {
        const before = nodes.map((n) => n.nodeValue).join("");
        if (!/\d/.test(before)) continue;
        let after = before
          // 9:00:03 AM, 11:37:08 → seconds only; hours and minutes are stable.
          .replace(/\b(\d{1,2}:\d{2}):\d{2}\b/g, "$1:00");
        if (after.length <= 80) {
          after = after
            // A trailing turn timer: "Running · 0:07", "1:34".
            .replace(/(^|[^\d:])\d{1,3}:\d{2}\s*$/, "$10:42")
            // A trailing seconds duration: "4m 59s", "12s", "0s ago".
            .replace(/(^|[^\d.])(\d+h )?(\d+m )?\d+s( ago)?\s*$/, (_, lead, _h, _m, ago) => `${lead}42s${ago ?? ""}`);
        }
        if (after === before) continue;
        nodes[0].nodeValue = after;
        for (const n of nodes.slice(1)) n.nodeValue = "";
      }
    };
    normalize();
    // A timer that ticks once more after the freeze (its last render predates
    // it) rewrites its node with the real value. Mutation observers run before
    // the next paint, so re-normalising there keeps every painted frame fixed.
    // Its own edits re-trigger it once and then find nothing to change.
    new MutationObserver(normalize).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, mask);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
