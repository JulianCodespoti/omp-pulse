// The objective per-screen audit: text contrast (resolved through a canvas),
// touch targets under 44px (measured as the EFFECTIVE target, ::after insets
// included), text clipped by a fixed height, and sideways document overflow.
//
// Shared by e2e/browser/verify-a11y.mjs (asserts it on the surfaces a phone
// touches) and scripts/ui/states/ (records it for every captured state and
// reports what a change introduced). It is a string, evaluated in the page as
// an expression, so it survives the app's CSP-free CDP evaluate path unchanged.
//
// Contrast is resolved through a canvas, NOT a regex over the computed colour:
// getComputedStyle hands back oklch()/color() here, which a regex over rgba()
// skips silently and then reports a clean sheet.

export const UI_PROBE = `(() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const toRgb = (css) => {
    if (cache.has(css)) return cache.get(css);
    let out = null;
    try {
      ctx.clearRect(0,0,1,1); ctx.fillStyle = "#000"; ctx.fillStyle = css; ctx.fillRect(0,0,1,1);
      const d = ctx.getImageData(0,0,1,1).data;
      out = [d[0], d[1], d[2], d[3]/255];
    } catch (e) { out = null; }
    cache.set(css, out); return out;
  };
  const lum = ([r,g,b]) => { const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const over = (fg,bg) => { const a=fg[3];
    return [fg[0]*a+bg[0]*(1-a), fg[1]*a+bg[1]*(1-a), fg[2]*a+bg[2]*(1-a), 1]; };
  const bgOf = (el) => { let cur=el, acc=null;
    while (cur) { const c=toRgb(getComputedStyle(cur).backgroundColor);
      if (c && c[3]>0) { acc = acc ? over(acc,c) : c; if (acc[3]>=0.999) return acc; }
      cur = cur.parentElement; }
    return acc && acc[3]>=0.999 ? acc : [10,10,12,1]; };

  // Visually-hidden content is exempt from VISUAL checks: sr-only text is
  // clipped to a 1px box on purpose, and the Base UI switch keeps a 1x1 input.
  // Counting them produces permanent false failures that train you to ignore
  // the report.
  const hidden = (el, r) => {
    if (el.closest(".sr-only")) return true;
    const cs = getComputedStyle(el);
    if (cs.clipPath && cs.clipPath !== "none") return true;
    if (cs.clip && cs.clip !== "auto") return true;
    return r.width < 4 || r.height < 4;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  };

  const contrast = [], small = [], clipped = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (hidden(el, r)) continue;
    const cs = getComputedStyle(el);
    const ownText = Array.from(el.childNodes).filter(n=>n.nodeType===3)
      .map(n=>n.textContent.trim()).join("").trim();

    if (ownText.length > 1) {
      const fg = toRgb(cs.color);
      if (fg) {
        const bg = bgOf(el);
        const eff = fg[3] < 0.999 ? over(fg,bg) : fg;
        const L1 = lum(eff), L2 = lum(bg);
        const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
        const px = parseFloat(cs.fontSize);
        const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight,10) >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) contrast.push({ ratio: Math.round(ratio*100)/100, need,
          text: ownText.slice(0,40), color: cs.color, cls: (el.className||"").toString().slice(0,44) });
      }
      if (cs.overflowY === "hidden" && el.scrollHeight > el.clientHeight + 3
          && !String(cs.webkitLineClamp).match(/^\\d+$/)) {
        clipped.push({ sh: el.scrollHeight, ch: el.clientHeight, text: ownText.slice(0,32),
          cls: (el.className||"").toString().slice(0,44) });
      }
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    // switch/checkbox/tab/link/radio are interactive too. Omitting them let the
    // settings toggle sit at a 34px effective target, unreported. NOTE: this
    // block lives inside a template literal, so no backticks in comments here.
    if (tag === "button" || tag === "a" ||
        ["button","menuitem","switch","checkbox","tab","link","radio"].includes(role || "")) {
      // Measure the EFFECTIVE target, not the painted box. A compact control
      // may legitimately reach 44px through a transparent absolutely-positioned
      // ::after with negative insets — PathChip and the Switch both do this
      // deliberately so a secondary affordance stays visually small without
      // becoming a chunky button. Counting the painted box would fail correct
      // code, and a suite that cries wolf gets ignored.
      const af = getComputedStyle(el, "::after");
      let w = r.width, h = r.height;
      if (af && af.content !== "none" && af.position === "absolute") {
        const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
        if (getComputedStyle(el).position === "static") {
          // A stretched control (the session row title): an unpositioned
          // element's ::after is laid out against the nearest positioned
          // ancestor, so that box, less the insets, is the target.
          let cb = el.parentElement;
          while (cb && getComputedStyle(cb).position === "static") cb = cb.parentElement;
          if (cb) {
            const cr = cb.getBoundingClientRect();
            w = Math.max(w, cr.width - px(af.left) - px(af.right));
            h = Math.max(h, cr.height - px(af.top) - px(af.bottom));
          }
        } else {
          // Negative insets grow the box; positive ones shrink it, so clamp at 0.
          w += Math.max(0, -px(af.left)) + Math.max(0, -px(af.right));
          h += Math.max(0, -px(af.top)) + Math.max(0, -px(af.bottom));
        }
      }
      if (h < 44 || w < 44) small.push({ tag, w: Math.round(w), h: Math.round(h),
        painted: Math.round(r.width) + "x" + Math.round(r.height),
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0,30),
        cls: (el.className||"").toString().slice(0,44) });
    }
  }
  return { contrast, small, clipped,
    docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
})()`;
