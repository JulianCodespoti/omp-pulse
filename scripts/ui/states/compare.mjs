// Turning a lossless screenshot into what the gallery needs, and comparing a
// run against the saved baseline: pixels (what changed on screen) and the
// UI probe (which audit findings a change introduced or resolved).
//
// The pixel work runs IN THE BROWSER, on a canvas in the page that was just
// photographed: Chromium already decodes PNG and encodes WebP, so this needs
// no image library, and each worker compares its own shot in parallel.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A channel may differ by this much before the pixel counts as changed.
 * Rendering is deterministic on one machine, so this only absorbs
 * sub-pixel antialiasing; any real change moves channels by far more.
 */
const TOLERANCE = 8;

/**
 * Fewer changed device pixels than this is rendering noise, not a change.
 * Measured across unchanged reruns: the rounded corner of a bubble sitting
 * under the blurred header antialiased 8-16 pixels differently run to run.
 * A real change, even a 1px border on a small control, is far larger.
 */
const NOISE_PX = 32;

/**
 * Encode `current` (base64 PNG) as WebP for the gallery and, when a baseline
 * PNG exists, diff the two. The diff image is the baseline in dim grey with
 * every changed pixel in red, so a change reads at a glance even in a thumbnail.
 */
export async function processShot(page, current, baseline, quality) {
  return page.evaluate(
    async (current, baseline, quality, tolerance, noise) => {
      const load = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return { canvas, ctx, w: canvas.width, h: canvas.height };
      };
      const webp = (canvas) => canvas.toDataURL("image/webp", quality).slice("data:image/webp;base64,".length);
      const a = await load(current);
      const out = { webp: webp(a.canvas) };
      if (!baseline) return out;
      const b = await load(baseline);
      // The "before" image is only shown for changed states; encoding it for
      // every same-rated shot cost ~100ms each for nothing.
      if (a.w !== b.w || a.h !== b.h) {
        return { ...out, baseWebp: webp(b.canvas), changed: a.w * a.h, total: a.w * a.h, sizeChanged: true };
      }
      const pa = a.ctx.getImageData(0, 0, a.w, a.h).data;
      const pb = b.ctx.getImageData(0, 0, b.w, b.h).data;
      const diff = b.ctx.createImageData(b.w, b.h);
      const pd = diff.data;
      let changed = 0;
      let x0 = a.w, y0 = a.h, x1 = -1, y1 = -1;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
        if (d > tolerance) {
          changed++;
          pd[i] = 255; pd[i + 1] = 30; pd[i + 2] = 70; pd[i + 3] = 255;
          const p = i / 4, x = p % a.w, y = (p - x) / a.w;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        } else {
          const v = (pb[i] * 0.3 + pb[i + 1] * 0.59 + pb[i + 2] * 0.11) * 0.35;
          pd[i] = pd[i + 1] = pd[i + 2] = v; pd[i + 3] = 255;
        }
      }
      out.total = a.w * a.h;
      // Kept for transparency: a same-rated shot still says what it ignored.
      out.noise = changed <= noise ? changed : 0;
      out.changed = changed <= noise ? 0 : changed;
      if (out.changed) {
        out.baseWebp = webp(b.canvas);
        b.ctx.putImageData(diff, 0, 0);
        out.diffWebp = webp(b.canvas);
        out.bbox = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      }
      return out;
    },
    current,
    baseline,
    quality,
    TOLERANCE,
    NOISE_PX,
  );
}

/**
 * Flatten one UI probe result (e2e/lib/ui-probe.mjs) into stable finding
 * strings. Stable means independent of position, so the same defect keeps the
 * same key across runs and a delta against the baseline is meaningful.
 */
export function findingKeys(probe) {
  if (!probe) return [];
  const keys = [
    ...probe.contrast.map((f) => `contrast ${f.ratio}:1 (needs ${f.need}) "${f.text}"`),
    ...probe.small.map((f) => `target ${f.w}x${f.h} <${f.tag}> "${f.label}"`),
    ...probe.clipped.map((f) => `clipped ${f.ch}/${f.sh}px "${f.text}"`),
  ];
  if (probe.docOverflow) keys.push("document scrolls sideways");
  return [...new Set(keys)].sort();
}

/** The saved reference a run is compared with: `<id>.png` per state, plus probes and meta. */
export class Baseline {
  constructor(dir) {
    this.dir = resolve(dir);
    const metaPath = resolve(this.dir, "meta.json");
    this.meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
    const probePath = resolve(this.dir, "findings.json");
    this.findings = existsSync(probePath) ? JSON.parse(readFileSync(probePath, "utf8")) : {};
  }

  get exists() {
    return this.meta !== null;
  }

  png(id) {
    const p = resolve(this.dir, `${id}.png`);
    return existsSync(p) ? readFileSync(p).toString("base64") : null;
  }

  /** Findings present now that the baseline did not have, and the reverse. */
  delta(id, keys) {
    const before = this.findings[id];
    if (!before) return null;
    const was = new Set(before);
    const now = new Set(keys);
    return { introduced: keys.filter((k) => !was.has(k)), resolved: before.filter((k) => !now.has(k)) };
  }

  /**
   * Record `results` as the new reference. A partial run (`--only`) replaces
   * just those states, so one state can be re-baselined without a full run.
   * Failed captures are skipped: a broken shot is not a reference.
   */
  save(results, meta) {
    mkdirSync(this.dir, { recursive: true });
    let saved = 0;
    for (const r of results) {
      if (r.error || !r.png) continue;
      writeFileSync(resolve(this.dir, `${r.id}.png`), Buffer.from(r.png, "base64"));
      this.findings[r.id] = r.findings;
      saved++;
    }
    this.meta = { ...meta, savedAt: new Date().toISOString() };
    writeFileSync(resolve(this.dir, "findings.json"), JSON.stringify(this.findings, null, 1));
    writeFileSync(resolve(this.dir, "meta.json"), JSON.stringify(this.meta, null, 1));
    return saved;
  }
}
