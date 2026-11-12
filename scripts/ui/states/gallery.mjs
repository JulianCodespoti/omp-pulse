// The self-contained HTML gallery: every state as a WebP data URL, grouped,
// filterable, with before/after/diff for anything that changed against the
// baseline and the audit findings each state carries.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (d) => `${((d.changed / d.total) * 100).toFixed(d.changed / d.total < 0.001 ? 3 : 2)}%`;
const img = (b64) => `data:image/webp;base64,${b64}`;

function badge(r) {
  if (r.error) return `<span class="b bad">failed</span>`;
  if (r.diff.status === "changed") return `<span class="b chg">${r.diff.sizeChanged ? "size changed" : `changed ${pct(r.diff)}`}</span>`;
  if (r.diff.status === "new") return `<span class="b new">new</span>`;
  if (r.diff.status === "same") return `<span class="b same">same</span>`;
  return "";
}

function card(r) {
  const changed = r.diff.status === "changed";
  const intro = r.findingsDelta?.introduced ?? [];
  const resolved = r.findingsDelta?.resolved ?? [];
  const flags = [r.error && "bad", changed && "chg", intro.length && "fnd"].filter(Boolean).join(" ");
  const views = changed
    ? `<div class="views"><button data-src="${img(r.webp)}" class="on">after</button><button data-src="${img(r.baseWebp)}">before</button>${r.diffWebp ? `<button data-src="${img(r.diffWebp)}">diff</button>` : ""}</div>`
    : "";
  const findings = r.findings.length
    ? `<details><summary>${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}${intro.length ? `, <b class="err">${intro.length} new</b>` : ""}${resolved.length ? `, <b class="ok">${resolved.length} resolved</b>` : ""}</summary><ul>${r.findings.map((f) => `<li${intro.includes(f) ? ' class="err"' : ""}>${esc(f)}</li>`).join("")}${resolved.map((f) => `<li class="ok">resolved: ${esc(f)}</li>`).join("")}</ul></details>`
    : resolved.length ? `<p class="ok">${resolved.length} finding(s) resolved</p>` : "";
  return `
<figure class="card ${flags}" data-id="${esc(r.id)}" data-text="${esc(`${r.id} ${r.title} ${r.note}`.toLowerCase())}">
  ${r.webp ? `<img loading="lazy" decoding="async" src="${img(r.webp)}" alt="${esc(r.title)}">` : `<div class="noimg">no image</div>`}
  ${views}
  <figcaption>
    <b>${esc(r.title)}</b><code>${esc(r.id)}</code>${badge(r)}<span class="ms">${r.ms} ms</span>
    ${r.note ? `<p>${esc(r.note)}</p>` : ""}
    ${r.error ? `<p class="err">${esc(r.error)}</p>` : ""}
    ${r.warning ? `<p class="warn">${esc(r.warning)}</p>` : ""}
    ${r.pageErrors.length ? `<p class="err">page errors: ${esc(r.pageErrors.join(" | "))}</p>` : ""}
    ${findings}
  </figcaption>
</figure>`;
}

export function renderHtml(results, meta) {
  const groups = [...new Set(results.map((r) => r.group))];
  const s = meta.summary;
  const compared = meta.baseline ? ` · vs baseline ${esc(meta.baseline)}: ${s.changed} changed, ${s.new} new, ${s.introduced} findings introduced, ${s.resolved} resolved` : " · no baseline";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>omp-pulse UI states</title>
<style>
:root{color-scheme:dark;font:14px/1.45 system-ui,sans-serif;background:#0b0b0c;color:#e8e8ea}
body{margin:0}
header{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 20px;background:#111113ee;backdrop-filter:blur(8px);border-bottom:1px solid #222}
header h1{margin:0;font-size:16px}header .meta{color:#999;font-size:12px}
header input[type=search]{flex:1;min-width:200px;padding:8px 12px;border-radius:8px;border:1px solid #333;background:#18181b;color:inherit}
header label{display:flex;align-items:center;gap:6px;font-size:12px;color:#bbb}
nav{display:flex;flex-wrap:wrap;gap:6px;width:100%}nav a{font-size:12px;color:#9ab;text-decoration:none;padding:2px 8px;border:1px solid #2a2a30;border-radius:99px}
section{padding:8px 20px 24px}section h2{font-size:14px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{margin:0;background:#141416;border:1px solid #232327;border-radius:12px;overflow:hidden}
.card.chg{border-color:#c80}.card.bad{border-color:#a33}
.card img{display:block;width:100%;height:auto;cursor:zoom-in;background:#000}
.noimg{aspect-ratio:390/844;display:grid;place-items:center;color:#666}
.views{display:flex;gap:4px;padding:6px 10px 0}.views button{font:inherit;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid #333;background:#18181b;color:#bbb;cursor:pointer}.views button.on{background:#c80;color:#000;border-color:#c80}
figcaption{padding:8px 10px;font-size:12px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
figcaption b{flex-basis:100%;font-size:13px}figcaption code{color:#8ab}figcaption .ms{color:#666;margin-left:auto}
figcaption p,figcaption details{margin:2px 0 0;flex-basis:100%;color:#aaa}figcaption ul{margin:4px 0 0;padding-left:16px}
figcaption summary b{display:inline;font-size:12px}
.b{font-size:11px;padding:0 6px;border-radius:99px;border:1px solid}.b.bad{color:#f88;border-color:#733}.b.chg{color:#fc6;border-color:#860}.b.new{color:#8cf;border-color:#357}.b.same{color:#6a6;border-color:#353}
.err{color:#f88}.warn{color:#db6}.ok{color:#7c7}
.hidden{display:none}
#lb{position:fixed;inset:0;z-index:5;background:#000d;display:none;place-items:center;cursor:zoom-out}
#lb img{max-height:96vh;max-width:96vw}
</style></head><body>
<header>
  <h1>omp-pulse UI states</h1>
  <span class="meta">${results.length} states · ${s.failed} failed${compared} · ${esc(meta.viewport)} · ${esc(meta.app)} · ${esc(meta.capturedAt)} · ${(meta.ms / 1000).toFixed(1)} s</span>
  <input id="q" type="search" placeholder="Filter by id, title or note">
  <label><input class="only" type="checkbox" value="bad"> failures</label>
  <label><input class="only" type="checkbox" value="chg"> changed</label>
  <label><input class="only" type="checkbox" value="fnd"> new findings</label>
  <nav>${groups.map((g) => `<a href="#g-${esc(g)}">${esc(g)}</a>`).join("")}</nav>
</header>
${groups.map((g) => `<section id="g-${esc(g)}"><h2>${esc(g)}</h2><div class="grid">${results.filter((r) => r.group === g).map(card).join("")}</div></section>`).join("\n")}
<div id="lb"><img alt=""></div>
<script>
const q=document.getElementById("q"),only=[...document.querySelectorAll(".only")],lb=document.getElementById("lb");
function apply(){const n=q.value.trim().toLowerCase();const want=only.filter(o=>o.checked).map(o=>o.value);
for(const c of document.querySelectorAll(".card"))c.classList.toggle("hidden",(n&&!c.dataset.text.includes(n))||(want.length&&!want.some(w=>c.classList.contains(w))));
for(const s of document.querySelectorAll("section"))s.classList.toggle("hidden",!s.querySelector(".card:not(.hidden)"));}
q.oninput=apply;for(const o of only)o.onchange=apply;
document.addEventListener("click",e=>{const v=e.target.closest(".views button");
if(v){const card=v.closest(".card");card.querySelector("img").src=v.dataset.src;for(const b of v.parentElement.children)b.classList.toggle("on",b===v);return;}
if(e.target.matches(".card img")){lb.firstElementChild.src=e.target.src;lb.style.display="grid";}else if(e.target.closest("#lb"))lb.style.display="none";});
</script>
</body></html>`;
}
