#!/usr/bin/env node
// Render the composed brand images in docs/media/ from the app screenshots:
//
//   social-card.png  1280x640: the app icon, "OMP Pulse", the tagline and footer
//                    line on the left, a phone showing the "Reply ready"
//                    screenshot on the right, on the brand's dark violet
//   readme-hero.webp 1600x1300 (800x650 at 2x), transparent: three framed
//                    phones (Reply ready, a question, the diff) for the top of
//                    the README
//
//   node scripts/docs/render-brand-images.mjs
//
// The website serves social-card.png as og:image / twitter:image
// (website/build.mjs) and it is the repository's GitHub social preview. Link
// previews on X, LinkedIn, Facebook, Slack, Discord and iMessage do not render
// SVG, so the card has to be a raster image at an absolute URL. 2:1 suits GitHub
// and X's large card; Open Graph's 1.91:1 crops a sliver off the sides.
//
// The README hero has no background so it sits on GitHub's white and dark
// themes alike; that is why its phones cast a neutral shadow, where the card's
// violet glow would look muddy on white. It is a lossy WebP with a lossless
// alpha channel: under a third of the PNG's size with the screens' text
// indistinguishable, and GitHub renders WebP in READMEs.
//
// No daemon is needed: it lays out HTML compositions in headless Chromium,
// with Geist and Geist Mono loaded from web/node_modules (not system fonts) so
// the output is the same on every machine, then compresses the PNGs with
// pngquant or ImageMagick (`magick`) like capture-readme-media.mjs; the hero's
// WebP needs `magick`. Needs `npm ci` in web/ and a Chromium (see e2e/README.md).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, loadPuppeteer } from "../../e2e/lib/env.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CARD_OUT = join(ROOT, "docs/media/social-card.png");
const CARD_WIDTH = 1280;
const CARD_HEIGHT = 640;
const HERO_OUT = join(ROOT, "docs/media/readme-hero.webp");
const HERO_WIDTH = 800;
const HERO_HEIGHT = 650;
// Rendered at 2x so the screens' text stays sharp at the 800 px the README shows.
const HERO_SCALE = 2;

// Repository slug, read from Cargo.toml as website/build.mjs does.
const cargoToml = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const REPO_URL =
  cargoToml.match(/^repository\s*=\s*"([^"]+)"/m)?.[1]?.replace(/\/+$/, "") ?? "https://github.com/JulianCodespoti/omp-pulse";
const REPO_SLUG = REPO_URL.replace(/^https?:\/\/github\.com\//, "");

const fileUrl = (path) => pathToFileURL(join(ROOT, path)).href;
const fonts = {
  sans: fileUrl("web/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"),
  mono: fileUrl("web/node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2"),
};
const icon = readFileSync(join(ROOT, "web/public/icon.svg"), "utf8").replace(/<\?xml[^>]*\?>/, "").trim();

// Colours, font names and the product name come from brand/tokens.json, the
// same source the website reads, so the card cannot drift from the site. The
// phone frame is the one in website/styles.css's .phone-device.
const brand = JSON.parse(readFileSync(join(ROOT, "brand/tokens.json"), "utf8"));
const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${alpha})`;
const [sansFamily] = brand.font.sans;
const [monoFamily] = brand.font.mono;
const { violet, ink, text } = brand;

// The phone frame both images share, sized by --w (the phone's outer width) so
// the card's single phone and the hero's three differ only in scale and shadow.
// The bezel's 1px light ring is what separates it from a dark page.
const phoneCss = `
  .phone {
    position: absolute;
    width: var(--w); height: calc(var(--w) * 1.8133);
    padding: calc(var(--w) / 30);
    border-radius: calc(var(--w) * 2 / 15);
    background: linear-gradient(165deg, #252936 0%, #11131a 48%, #1c202c 100%);
  }
  .screen {
    width: 100%; height: 100%;
    border-radius: calc(var(--w) / 10); overflow: hidden;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .screen img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
`;
const phone = (screenshot, style) =>
  `<div class="phone" style="${style}"><div class="screen"><img src="${fileUrl(`docs/media/${screenshot}`)}" alt=""></div></div>`;

const fontFaces = `
  @font-face { font-family: "${sansFamily}"; src: url("${fonts.sans}") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "${monoFamily}"; src: url("${fonts.mono}") format("woff2"); font-weight: 100 900; }
`;

const cardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  ${fontFaces}
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; overflow: hidden; background: ${ink["950"]}; }
  body {
    position: relative;
    font-family: "${sansFamily}", sans-serif;
    color: ${text.default};
    background:
      radial-gradient(ellipse 560px 520px at 1056px 330px, ${rgba(violet["500"], 0.34)}, transparent 70%),
      radial-gradient(ellipse 700px 420px at 0 0, ${rgba(violet["500"], 0.1)}, transparent 70%),
      ${ink["950"]};
  }
  .copy {
    position: absolute;
    left: 72px; top: 64px; bottom: 64px; width: 700px;
    display: flex; flex-direction: column;
  }
  .icon { width: 96px; height: 96px; display: block; filter: drop-shadow(0 12px 28px ${rgba(violet["500"], 0.32)}); }
  .icon svg { width: 100%; height: 100%; display: block; }
  h1 { margin-top: 36px; font-size: 92px; line-height: 1; font-weight: 700; letter-spacing: -3.4px; }
  .tagline { margin-top: 22px; font-size: 42px; line-height: 1.15; font-weight: 600; letter-spacing: -1px; color: ${violet["300"]}; }
  .sub { margin-top: 26px; width: 620px; font-size: 27px; line-height: 1.4; font-weight: 400; color: ${text.muted}; }
  .footer { margin-top: auto; font-family: "${monoFamily}", monospace; font-size: 20px; letter-spacing: -0.2px; color: ${text.subtle}; }
  ${phoneCss}
  .phone {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 32px 80px -12px rgba(0, 0, 0, 0.78),
      0 0 90px -20px ${rgba(violet["500"], 0.24)};
  }
</style>
</head>
<body>
  <div class="copy">
    <div class="icon">${icon}</div>
    <h1>${brand.name}</h1>
    <p class="tagline">Your coding agent, in your pocket.</p>
    <p class="sub">Follow, answer and steer omp from your phone, or run it on Android with no computer at all.</p>
    <p class="footer">Free and open source · github.com/${REPO_SLUG}</p>
  </div>
  ${phone("screenshot-notice.png", "--w: 300px; left: 908px; top: 48px")}
</body>
</html>
`;

// No background, so the image works on GitHub's white and dark themes. The
// shadow is neutral and soft: a violet glow, as on the card, turns muddy on white.
// The middle phone is larger, raised and last in the markup, so it sits in front
// and its shadow falls across the two beside it.
const heroHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${HERO_WIDTH}px; height: ${HERO_HEIGHT}px; overflow: hidden; background: transparent; }
  body { position: relative; }
  ${phoneCss}
  .phone {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 0 1.5px rgba(0, 0, 0, 0.18),
      0 28px 56px -16px rgba(16, 20, 32, 0.4),
      0 8px 20px -8px rgba(16, 20, 32, 0.3);
  }
  .phone.front {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 0 1.5px rgba(0, 0, 0, 0.18),
      0 40px 80px -18px rgba(16, 20, 32, 0.5),
      0 12px 28px -10px rgba(16, 20, 32, 0.34);
  }
</style>
</head>
<body>
  ${phone("screenshot-notice.png", "--w: 250px; left: 34px; top: 84px")}
  ${phone("screenshot-workspace.png", "--w: 250px; left: 516px; top: 84px")}
  ${phone("screenshot-ask.png", "--w: 290px; left: 255px; top: 36px").replace('class="phone"', 'class="phone front"')}
</body>
</html>
`;

function optimisePng(raw, out) {
  try {
    execFileSync("pngquant", ["--quality", "75-96", "--speed", "1", "--strip", "--force", "--output", out, raw], { stdio: "inherit" });
    rmSync(raw);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    execFileSync("magick", [raw, "-strip", "-define", "png:compression-level=9", "-define", "png:compression-filter=5", out], { stdio: "inherit" });
    rmSync(raw);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  console.warn("neither pngquant nor magick found: writing an unoptimised PNG");
  renameSync(raw, out);
}

function encodeWebp(raw, out) {
  try {
    execFileSync("magick", [raw, "-strip", "-quality", "92", "-define", "webp:alpha-quality=100", "-define", "webp:method=6", out], { stdio: "inherit" });
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("ImageMagick (`magick`) with WebP support is needed to write the README hero");
    throw e;
  }
  rmSync(raw);
}

async function render(browser, { html, width, height, scale, transparent, out, expectFonts, encode }) {
  const tab = await browser.newPage();
  try {
    await tab.setViewport({ width, height, deviceScaleFactor: scale });
    // A file:// page, so the font and screenshot file URLs are allowed to load.
    const page = join(work, `${basename(out).replace(/\.\w+$/, "")}.html`);
    writeFileSync(page, html);
    await tab.goto(pathToFileURL(page).href, { waitUntil: "load" });
    await tab.evaluate(() => document.fonts.ready);
    if (expectFonts) {
      const loaded = await tab.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").length);
      if (loaded < 2) throw new Error(`expected ${sansFamily} and ${monoFamily} to load, got ${loaded} font face(s)`);
    }
    const raw = join(work, `${basename(out)}.raw.png`);
    await tab.screenshot({ path: raw, type: "png", omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
    encode(raw, out);
    console.log(`wrote ${out}`);
  } finally {
    await tab.close();
  }
}

const work = mkdtempSync(join(tmpdir(), "omp-pulse-brand-images-"));
try {
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({ executablePath: chromium(), headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] });
  try {
    await render(browser, { html: cardHtml, width: CARD_WIDTH, height: CARD_HEIGHT, scale: 1, transparent: false, out: CARD_OUT, expectFonts: true, encode: optimisePng });
    await render(browser, { html: heroHtml, width: HERO_WIDTH, height: HERO_HEIGHT, scale: HERO_SCALE, transparent: true, out: HERO_OUT, expectFonts: false, encode: encodeWebp });
  } finally {
    await browser.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
