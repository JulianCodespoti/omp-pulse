// An annotated UI review: findings pinned to captured states, drawn as
// numbered callouts over the real screenshots, in one self-contained page.
//
//   node scripts/ui/states/capture.mjs --review audit/ui-review.json
//   node scripts/ui/states/capture.mjs --review audit/ui-review/   # every *.json in it, merged
//   → audit/ui-review.html (+ .json with every mark as resolved)
//
// A finding names the state it is about and marks elements in it by CSS
// selector and/or visible text, not by pixel. The capture run resolves each
// mark to a box inside the live page just before the shot, so a finding keeps
// pointing at the right thing after the layout moves, and a mark that no
// longer matches anything is reported rather than drawn in the wrong place.
//
// Review file:
//   { "title": "...", "findings": [ {
//       "id": "chat-3",                       stable, shown on the card
//       "severity": "high|medium|low|polish",
//       "category": "layout|contrast|copy|…", free-form, filterable
//       "title": "one line", "problem": "what and why", "fix": "what to change",
//       "shots": [ { "state": "<recipe id>", "marks": [ {
//           "selector"?: "css", "text"?: "visible text", "nth"?: 0,
//           "rect"?: [x, y, w, h],            CSS px fallback / free region
//           "note"?: "what this mark points at"
//       } ] } ]
//   } ] }
// `state` + `marks` on the finding itself is shorthand for a single shot.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SEVERITIES = ["high", "medium", "low", "polish"];
const COLOR = { high: "#ff5d5d", medium: "#ffb020", low: "#4da3ff", polish: "#a78bfa" };

/** Read and normalise a review file (or a folder of them, merged in name order); `states` is every recipe id it needs. */
export function loadReview(path) {
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => f.endsWith(".json")).sort().map((f) => join(path, f))
    : [path];
  if (!files.length) throw new Error(`no review files in ${path}`);
  const parts = files.map((f) => {
    try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  });
  const raw = { title: parts.find((p) => p.title)?.title, intro: parts.find((p) => p.intro)?.intro, findings: parts.flatMap((p) => p.findings ?? []) };
  const findings = raw.findings.map((f, i) => {
    const shots = f.shots ?? (f.state ? [{ state: f.state, marks: f.marks ?? [] }] : []);
    if (!shots.length) throw new Error(`finding ${f.id ?? i}: no state`);
    if (f.severity && !SEVERITIES.includes(f.severity)) throw new Error(`finding ${f.id ?? i}: severity "${f.severity}" is not one of ${SEVERITIES.join(", ")}`);
    return { id: f.id ?? `F${i + 1}`, severity: f.severity ?? "low", category: f.category ?? "general",
      title: f.title ?? "", problem: f.problem ?? "", fix: f.fix ?? "",
      shots: shots.map((s) => ({ state: s.state, marks: s.marks ?? [] })) };
  });
  const marks = {};
  for (const f of findings) for (const s of f.shots) (marks[s.state] ??= []).push(...s.marks);
  return { title: raw.title ?? "UI review", intro: raw.intro ?? "", findings, marks, states: Object.keys(marks) };
}

/**
 * Evaluated in the page after stabilisation: every mark of one state → a box
 * in CSS px clamped to the viewport, or `{ error }`. Text matches take the
 * innermost visible element containing the text. Matches on screen win over
 * scrolled-away ones (a chat title is also a transcript row above the fold),
 * and `nth` counts among them.
 */
export function resolveMarks(marks) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const innermost = (els) => els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
  return marks.map((m) => {
    let els = [];
    if (m.selector) {
      try { els = [...document.querySelectorAll(m.selector)].filter(vis); } catch { return { error: `bad selector ${m.selector}` }; }
    }
    if (m.text) {
      const pool = m.selector ? els : [...document.querySelectorAll("body *")].filter(vis);
      els = innermost(pool.filter((el) => el.textContent.includes(m.text)));
    }
    const onScreen = els.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; });
    const el = (onScreen.length ? onScreen : els)[m.nth ?? 0];
    let r = el ? el.getBoundingClientRect() : null;
    if (!r && m.rect) r = { left: m.rect[0], top: m.rect[1], right: m.rect[0] + m.rect[2], bottom: m.rect[1] + m.rect[3] };
    const what = `${m.selector ?? ""}${m.text ? ` "${m.text}"` : ""}`.trim();
    if (!r) return { error: `no visible match for ${what || "empty mark"}` };
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
    if (x1 <= x || y1 <= y) return { error: `${what} is off screen` };
    return { x: Math.round(x), y: Math.round(y), w: Math.round(x1 - x), h: Math.round(y1 - y), matches: els.length };
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Markup for one shot: the screenshot with its numbered boxes, in `viewBox`
 * space. `renderWidth` is the CSS width it is shown at, so strokes and badges
 * come out the same on-screen size in the full view and the zoom.
 */
function shotSvg(state, boxes, color, viewBox, cls, renderWidth) {
  const [vx, vy, vw, vh] = viewBox;
  const k = vw / renderWidth;
  const marks = boxes.map(({ n, box }) => {
    if (!box || box.error) return "";
    const p = 2 * k;
    const bx = box.x - p, by = box.y - p;
    const cy = by - vy < 12 * k ? by + box.h + 2 * p + 11 * k : by - 1 * k;
    return `<rect x="${bx}" y="${by}" width="${box.w + 2 * p}" height="${box.h + 2 * p}" rx="${6 * k}" fill="${color}14" stroke="${color}" stroke-width="${2 * k}"/>` +
      `<circle cx="${bx + 2 * k}" cy="${cy}" r="${10 * k}" fill="${color}" stroke="#0b0b0d" stroke-width="${1.5 * k}"/>` +
      `<text x="${bx + 2 * k}" y="${cy + 4 * k}" font-size="${12 * k}" font-weight="700" text-anchor="middle" fill="#0b0b0d">${n}</text>`;
  }).join("");
  const style = cls === "zoom" ? ` style="width:${Math.round(renderWidth)}px"` : "";
  return `<svg class="${cls}"${style} viewBox="${vx} ${vy} ${vw} ${vh}" data-state="${esc(state)}"><image data-img="${esc(state)}" x="0" y="0" width="390" height="844"/><g class="marks">${marks}</g></svg>`;
}

/** Padded union of a shot's boxes, at the screenshot's aspect-free size, or null if it is most of the screen. */
function zoomBox(boxes) {
  const ok = boxes.map((b) => b.box).filter((b) => b && !b.error);
  if (!ok.length) return null;
  let x0 = Math.min(...ok.map((b) => b.x)), y0 = Math.min(...ok.map((b) => b.y));
  let x1 = Math.max(...ok.map((b) => b.x + b.w)), y1 = Math.max(...ok.map((b) => b.y + b.h));
  const pad = 28;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(390, x1 + pad); y1 = Math.min(844, y1 + pad);
  // At least a readable strip: widen short regions to 3:1 and full width if narrow.
  if (x1 - x0 < 200) { const c = (x0 + x1) / 2; x0 = Math.max(0, c - 100); x1 = Math.min(390, x0 + 200); }
  if (y1 - y0 < 90) { const c = (y0 + y1) / 2; y0 = Math.max(0, c - 45); y1 = Math.min(844, y0 + 90); }
  if ((x1 - x0) * (y1 - y0) > 0.55 * 390 * 844) return null;
  return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
}

/**
 * @param review   loadReview() output
 * @param results  capture results for review.states (with `webp` and `marks`)
 * @param meta     capture run meta
 */
export function renderReview(review, results, meta) {
  const byState = new Map(results.map((r) => [r.id, r]));
  const images = {};
  const problems = [];
  const cursor = {}; // per state: how many of its resolved marks are consumed
  const cards = review.findings.map((f) => {
    const color = COLOR[f.severity];
    let n = 0;
    const legend = [];
    const shots = f.shots.map((s) => {
      const r = byState.get(s.state);
      if (!r || !r.webp) {
        problems.push(`${f.id}: state ${s.state} ${r?.error ? `failed: ${r.error}` : "was not captured"}`);
        return `<div class="missing">${esc(s.state)}: ${esc(r?.error ?? "not captured")}</div>`;
      }
      images[s.state] = r.webp;
      const start = cursor[s.state] ?? 0;
      cursor[s.state] = start + s.marks.length;
      const boxes = s.marks.map((m, i) => {
        const box = r.marks?.[start + i] ?? { error: "not resolved" };
        n += 1;
        if (box.error) problems.push(`${f.id} mark ${n}: ${box.error}`);
        legend.push(`<li class="${box.error ? "err" : ""}"><b style="background:${color}">${n}</b>${esc(m.note ?? m.text ?? m.selector ?? "region")}${box.error ? ` <em>(${esc(box.error)})</em>` : ""}</li>`);
        return { n, box };
      });
      const zoom = zoomBox(boxes);
      return `<div class="shot"><div class="cap">${esc(s.state)}<span>${esc(r.title)}</span></div>` +
        shotSvg(s.state, boxes, color, [0, 0, 390, 844], "full", 230) +
        // The zoom is at most 320 wide and 420 tall; whichever binds sets its scale.
        (zoom ? shotSvg(s.state, boxes, color, zoom, "zoom", Math.min(320, (420 * zoom[2]) / zoom[3])) : "") + `</div>`;
    }).join("");
    return `<article class="card" data-sev="${f.severity}" data-cat="${esc(f.category)}" data-text="${esc(`${f.id} ${f.title} ${f.problem} ${f.fix} ${f.shots.map((s) => s.state).join(" ")}`.toLowerCase())}">` +
      `<header><span class="sev" style="background:${color}">${f.severity}</span><span class="cat">${esc(f.category)}</span><h2>${esc(f.title)}</h2><code>${esc(f.id)}</code></header>` +
      `<div class="body"><div class="shots">${shots}</div><div class="text">` +
      (f.problem ? `<h3>Problem</h3><p>${esc(f.problem)}</p>` : "") +
      (f.fix ? `<h3>Suggested change</h3><p>${esc(f.fix)}</p>` : "") +
      (legend.length ? `<h3>Marks</h3><ol class="legend">${legend.join("")}</ol>` : "") +
      `</div></div></article>`;
  }).join("");

  const count = (sev) => review.findings.filter((f) => f.severity === sev).length;
  const cats = [...new Set(review.findings.map((f) => f.category))].sort();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(review.title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b0b0d;color:#e8e8ea;font:14px/1.5 system-ui,sans-serif}
header.top{position:sticky;top:0;z-index:2;background:#111113ee;backdrop-filter:blur(8px);border-bottom:1px solid #222;padding:12px 20px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
header.top h1{margin:0;font-size:16px}.meta{color:#999;font-size:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{border:1px solid #333;background:#18181b;color:#ccc;border-radius:99px;padding:4px 10px;font-size:12px;cursor:pointer}
.chip[aria-pressed=false]{opacity:.35}.chip b{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
input[type=search]{background:#18181b;border:1px solid #333;color:inherit;border-radius:8px;padding:6px 10px;min-width:220px}
label.tog{font-size:12px;color:#bbb;display:flex;gap:6px;align-items:center}
.intro{max-width:980px;padding:4px 20px 0;color:#bbb}
.problems{margin:12px 20px;padding:10px 14px;border:1px solid #6b3b00;background:#241700;border-radius:10px;font-size:12px;color:#ffcf8a}
main{padding:12px 20px 60px;display:grid;gap:16px;max-width:1500px}
.card{background:#141416;border:1px solid #232326;border-radius:14px;overflow:hidden}
.card>header{display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid #222}
.card h2{margin:0;font-size:15px;flex:1}.card code{color:#777;font-size:11px}
.sev{color:#0b0b0d;font-weight:700;font-size:11px;text-transform:uppercase;border-radius:6px;padding:2px 7px}.cat{font-size:11px;color:#aaa;border:1px solid #333;border-radius:6px;padding:1px 7px}
.body{display:grid;grid-template-columns:minmax(0,auto) minmax(280px,1fr);gap:16px;padding:14px 16px}
.shots{display:flex;gap:14px;flex-wrap:wrap}.shot{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
.shot .cap{flex-basis:100%;font:11px ui-monospace,monospace;color:#8a8a90}.shot .cap span{margin-left:8px;font-family:system-ui;color:#666}
svg{display:block;border-radius:10px;border:1px solid #2a2a2e;background:#000;cursor:zoom-in}svg.full{width:230px}
body.nomarks .marks{display:none}
.text h3{margin:12px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8a8a90}.text h3:first-child{margin-top:0}.text p{margin:0;white-space:pre-wrap}
.legend{list-style:none;padding:0;margin:0;display:grid;gap:4px}.legend b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:#0b0b0d;font-size:11px;margin-right:8px}
.legend li.err{color:#ff9d9d}.missing{color:#ff9d9d;font-size:12px}.hidden{display:none}
#lb{position:fixed;inset:0;background:#000d;display:none;place-items:center;z-index:9;cursor:zoom-out}#lb svg{width:auto!important;height:92vh;max-width:96vw;cursor:zoom-out}
@media (max-width:900px){.body{grid-template-columns:1fr}}
</style></head><body>
<header class="top"><h1>${esc(review.title)}</h1><span class="meta">${review.findings.length} findings · ${esc(meta.app)} · ${esc(meta.viewport)} · ${esc(meta.capturedAt)}</span>
<div class="chips" id="sev">${SEVERITIES.map((s) => `<button class="chip" aria-pressed="true" data-v="${s}"><b style="background:${COLOR[s]}"></b>${s} ${count(s)}</button>`).join("")}</div>
<div class="chips" id="cat">${cats.map((c) => `<button class="chip" aria-pressed="true" data-v="${esc(c)}">${esc(c)}</button>`).join("")}</div>
<input type="search" id="q" placeholder="filter: text or state id"><label class="tog"><input type="checkbox" id="nomarks"> hide marks</label></header>
${review.intro ? `<p class="intro">${esc(review.intro)}</p>` : ""}
${problems.length ? `<div class="problems"><b>${problems.length} marks did not resolve</b> (the finding is stale or the anchor is wrong):<br>${problems.map(esc).join("<br>")}</div>` : ""}
<main>${cards}</main><div id="lb"></div>
<script>
const IMG=${JSON.stringify(images)};
for(const im of document.querySelectorAll("image[data-img]"))im.setAttribute("href","data:image/webp;base64,"+IMG[im.dataset.img]);
const off={sev:new Set(),cat:new Set()};
function apply(){const q=document.getElementById("q").value.trim().toLowerCase();for(const c of document.querySelectorAll(".card"))c.classList.toggle("hidden",off.sev.has(c.dataset.sev)||off.cat.has(c.dataset.cat)||(q&&!c.dataset.text.includes(q)));}
for(const k of ["sev","cat"])document.getElementById(k).addEventListener("click",(e)=>{const b=e.target.closest(".chip");if(!b)return;const on=b.getAttribute("aria-pressed")==="true";b.setAttribute("aria-pressed",String(!on));on?off[k].add(b.dataset.v):off[k].delete(b.dataset.v);apply();});
document.getElementById("q").addEventListener("input",apply);
document.getElementById("nomarks").addEventListener("change",(e)=>document.body.classList.toggle("nomarks",e.target.checked));
const lb=document.getElementById("lb");
document.addEventListener("click",(e)=>{const s=e.target.closest("main svg");if(s){lb.replaceChildren(s.cloneNode(true));lb.style.display="grid";}else if(e.target.closest("#lb"))lb.style.display="none";});
document.addEventListener("keydown",(e)=>{if(e.key==="Escape")lb.style.display="none";});
</script></body></html>`;
  return { html, problems };
}
