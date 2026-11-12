export async function openPairedPage(page, url, token, options) {
  const origin = new URL(url).origin;
  const cdp = await page.createCDPSession();
  let identifier;
  try {
    await cdp.send("Page.enable");
    ({ identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        try {
          if (location.origin === ${JSON.stringify(origin)}) {
            localStorage.setItem("omp-remote-token", ${JSON.stringify(token)});
          }
        } catch {}
      })();`,
    }));
    return await page.goto(url, options);
  } finally {
    try {
      if (identifier !== undefined) {
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      }
    } finally {
      await cdp.detach();
    }
  }
}
