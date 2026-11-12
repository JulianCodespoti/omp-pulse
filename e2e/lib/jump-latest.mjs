// The chat's jump control: tap steps to the next user message, a hold jumps to
// the newest turn. Suites that mean "go to latest" must hold, not tap, or a
// transcript with user turns below the reader lands mid-way.
//
// A page-evaluable expression (puppeteer `page.evaluate(JUMP_TO_LATEST)` or a
// raw CDP Runtime.evaluate with awaitPromise) that holds `jump-next` past the
// 500ms long-press delay with real pointer events, then releases.
export const JUMP_TO_LATEST = `(async () => {
  const b = document.querySelector("[data-testid='jump-next']");
  if (!(b instanceof HTMLElement)) return false;
  const r = b.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  b.dispatchEvent(new PointerEvent("pointerdown", o));
  await new Promise((resolve) => setTimeout(resolve, 650));
  b.dispatchEvent(new PointerEvent("pointerup", o));
  b.click();
  return true;
})()`;
