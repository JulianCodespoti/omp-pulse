#!/usr/bin/env node
// Render the social preview card, docs/media/social-card.png (1280x640):
//
//   the app icon, "OMP Pulse", the tagline and footer line on the left, a phone
//   showing the "Reply ready" screenshot on the right, on the site's dark violet
//
//   node scripts/docs/render-social-card.mjs
//
// The website serves this PNG as og:image / twitter:image (website/build.mjs)
// and it is the repository's GitHub social preview. Link previews on X,
// LinkedIn, Facebook, Slack, Discord and iMessage do not render SVG, so the
// card has to be a raster image at an absolute URL. 2:1 suits GitHub and X's
// large card; Open Graph's 1.91:1 crops a sliver off the sides.
//
// No daemon is needed: it lays out an HTML composition in headless Chromium,
// with Geist and Geist Mono loaded from web/node_modules (not system fonts) so
// the output is the same on every machine, then compresses the PNG with
// pngquant or ImageMagick (`magick`) like capture-readme-media.mjs. Needs
// `npm ci` in web/ and a Chromium (see e2e/README.md).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, loadPuppeteer } from "../../e2e/lib/env.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/media/social-card.png");
const WIDTH = 1280;
const HEIGHT = 640;

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

// Tokens from website/styles.css :root; phone frame from its .phone-device.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: "Geist"; src: url("${fonts.sans}") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "Geist Mono"; src: url("${fonts.mono}") format("woff2"); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #08090c; }
  body {
    position: relative;
    font-family: "Geist", sans-serif;
    color: #f3f4f8;
    background:
      radial-gradient(ellipse 560px 520px at 1056px 330px, rgba(145, 121, 255, 0.34), transparent 70%),
      radial-gradient(ellipse 700px 420px at 0 0, rgba(145, 121, 255, 0.10), transparent 70%),
      #08090c;
  }
  .copy {
    position: absolute;
    left: 72px; top: 64px; bottom: 64px; width: 700px;
    display: flex; flex-direction: column;
  }
  .icon { width: 96px; height: 96px; display: block; filter: drop-shadow(0 12px 28px rgba(145, 121, 255, 0.32)); }
  .icon svg { width: 100%; height: 100%; display: block; }
  h1 { margin-top: 36px; font-size: 92px; line-height: 1; font-weight: 700; letter-spacing: -3.4px; }
  .tagline { margin-top: 22px; font-size: 42px; line-height: 1.15; font-weight: 600; letter-spacing: -1px; color: #b19fff; }
  .sub { margin-top: 26px; width: 620px; font-size: 27px; line-height: 1.4; font-weight: 400; color: #9aa2b2; }
  .footer { margin-top: auto; font-family: "Geist Mono", monospace; font-size: 20px; letter-spacing: -0.2px; color: #666f82; }
  .phone {
    position: absolute;
    left: 908px; top: 48px;
    width: 300px; height: 544px;
    padding: 10px;
    border-radius: 40px;
    background: linear-gradient(165deg, #252936 0%, #11131a 48%, #1c202c 100%);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 32px 80px -12px rgba(0, 0, 0, 0.78),
      0 0 90px -20px rgba(145, 121, 255, 0.24);
  }
  .screen {
    width: 100%; height: 100%;
    border-radius: 30px; overflow: hidden;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .screen img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
</style>
</head>
<body>
  <div class="copy">
    <div class="icon">${icon}</div>
    <h1>OMP Pulse</h1>
    <p class="tagline">Your coding agent, in your pocket.</p>
    <p class="sub">Follow, answer and steer omp from your phone, or run it on Android with no computer at all.</p>
    <p class="footer">Free and open source · github.com/${REPO_SLUG}</p>
  </div>
  <div class="phone"><div class="screen"><img src="${fileUrl("docs/media/screenshot-notice.png")}" alt=""></div></div>
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

const work = mkdtempSync(join(tmpdir(), "omp-pulse-social-card-"));
try {
  // A file:// page, so the font and screenshot file URLs are allowed to load.
  const page = join(work, "card.html");
  writeFileSync(page, html);

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({ executablePath: chromium(), headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] });
  try {
    const tab = await browser.newPage();
    await tab.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    await tab.goto(pathToFileURL(page).href, { waitUntil: "load" });
    await tab.evaluate(() => document.fonts.ready);
    const loaded = await tab.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").length);
    if (loaded < 2) throw new Error(`expected Geist and Geist Mono to load, got ${loaded} font face(s)`);
    const raw = `${OUT}.raw.png`;
    await tab.screenshot({ path: raw, type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    optimisePng(raw, OUT);
  } finally {
    await browser.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`wrote ${OUT}`);
