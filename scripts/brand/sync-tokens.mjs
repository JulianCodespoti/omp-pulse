#!/usr/bin/env node
// Keep every pinned copy of the brand tokens in step with brand/tokens.json:
//
//   node scripts/brand/sync-tokens.mjs           # rewrite the files that drifted
//   node scripts/brand/sync-tokens.mjs --check   # list every drifted file, exit 1 (in the gate)
//
// WHY: the brand colours used to be copied by hand into the website, the
// Android resources, the README badge and the icon, and they drifted. The
// website build and the social-card script read brand/tokens.json directly;
// this script covers the consumers that cannot, because they are static files
// a tool outside this repository reads (Android's resource compiler, GitHub's
// README renderer, anything that fetches the icon SVG).
//
// What it writes or checks:
//   - mobile/android/app/src/main/res/values/brand_colors.xml  (generated whole)
//   - values/styles.xml (colorPrimary, colorAccent), values/widget_colors.xml
//     (widget_accent) and values/ic_launcher_background.xml reference those
//     colours instead of repeating a hex literal
//   - the release badge's `color=` in README.md (violet 600)
//   - the mark gradient and end dot in web/public/icon.svg (violet 400 / 700)
//
// The in-app web accent (web/src/styles.css) is deliberately not synced: it is
// contrast-tuned separately. See docs/contributing/brand.md.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RES = "mobile/android/app/src/main/res/values";

const tokens = JSON.parse(readFileSync(join(ROOT, "brand/tokens.json"), "utf8"));

const HEX = /^#[0-9a-f]{6}$/;
const colours = {
  brand_violet_300: tokens.violet["300"],
  brand_violet_400: tokens.violet["400"],
  brand_violet_500: tokens.violet["500"],
  brand_violet_600: tokens.violet["600"],
  brand_violet_700: tokens.violet["700"],
  brand_ink_950: tokens.ink["950"],
  brand_ink_900: tokens.ink["900"],
  brand_plate: tokens.ink.plate,
  brand_text: tokens.text.default,
  brand_text_muted: tokens.text.muted,
  brand_text_subtle: tokens.text.subtle,
  brand_success: tokens.status.success,
  brand_warning: tokens.status.warning,
  brand_danger: tokens.status.danger,
};
for (const [name, value] of Object.entries(colours)) {
  // Lower case and six digits, so a comparison against a file never trips on spelling.
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error(`brand/tokens.json: ${name} must be a lower-case #rrggbb colour, got ${JSON.stringify(value)}`);
  }
}

const brandColorsXml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from brand/tokens.json by scripts/brand/sync-tokens.mjs. Do not
     edit: change the token and run the script. -->
<resources>
${Object.entries(colours)
  .map(([name, value]) => `    <color name="${name}">${value}</color>`)
  .join("\n")}
</resources>
`;

// A rewrite replaces exactly one match; zero means the file's shape changed
// and this script must be updated, so say so instead of silently passing.
function replaceOnce(text, pattern, replacement, file) {
  const hits = text.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (hits?.length !== 1) {
    throw new Error(`${file}: expected exactly one match for ${pattern}, found ${hits?.length ?? 0}`);
  }
  return text.replace(pattern, replacement);
}

const resItem = (name) => new RegExp(`(<item name="${name}">)[^<]*(</item>)`);
const resColour = (name) => new RegExp(`(<color name="${name}">)[^<]*(</color>)`);
const stop = (offset) => new RegExp(`(<stop offset="${offset}" stop-color=")#[0-9a-fA-F]{6}(")`);

/** file -> function from its current text to the text it should have. */
const edits = {
  [`${RES}/styles.xml`]: (text, file) => {
    text = replaceOnce(text, resItem("colorPrimary"), "$1@color/brand_violet_400$2", file);
    return replaceOnce(text, resItem("colorAccent"), "$1@color/brand_violet_400$2", file);
  },
  [`${RES}/widget_colors.xml`]: (text, file) =>
    replaceOnce(text, resColour("widget_accent"), "$1@color/brand_violet_400$2", file),
  [`${RES}/ic_launcher_background.xml`]: (text, file) =>
    replaceOnce(text, resColour("ic_launcher_background"), "$1@color/brand_plate$2", file),
  "README.md": (text, file) =>
    replaceOnce(
      text,
      /(img\.shields\.io\/github\/v\/release\/[^"\s]*?[?&]color=)[0-9a-fA-F]{6}/,
      `$1${tokens.violet["600"].slice(1)}`,
      file,
    ),
  "web/public/icon.svg": (text, file) => {
    // Only the "mark" gradient and the dot that ends the trace; the field
    // gradient behind them is the icon's own neutral, not a brand token.
    const gradient = /(<linearGradient id="mark"[\s\S]*?<\/linearGradient>)/;
    let next = replaceOnce(
      text,
      gradient,
      (block) =>
        block
          .replace(stop(0), `$1${tokens.violet["400"]}$2`)
          .replace(stop(1), `$1${tokens.violet["700"]}$2`),
      file,
    );
    return replaceOnce(next, /(<circle [^>]*fill=")#[0-9a-fA-F]{6}(")/, `$1${tokens.violet["400"]}$2`, file);
  },
};

const wanted = new Map([[`${RES}/brand_colors.xml`, brandColorsXml]]);
for (const [file, edit] of Object.entries(edits)) {
  wanted.set(file, edit(readFileSync(join(ROOT, file), "utf8"), file));
}

const check = process.argv.includes("--check");
const unknown = process.argv.slice(2).filter((a) => a !== "--check");
if (unknown.length) {
  console.error(`usage: sync-tokens.mjs [--check] (unknown argument ${unknown[0]})`);
  process.exit(2);
}

const drifted = [];
for (const [file, text] of wanted) {
  const path = join(ROOT, file);
  if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
  drifted.push(file);
  if (!check) writeFileSync(path, text);
}

if (check) {
  if (drifted.length) {
    console.error("brand tokens drifted from brand/tokens.json in:");
    for (const file of drifted) console.error(`  ${file}`);
    console.error("run: node scripts/brand/sync-tokens.mjs");
    process.exit(1);
  }
  console.log("brand tokens in sync");
} else {
  console.log(drifted.length ? `updated:\n${drifted.map((f) => `  ${f}`).join("\n")}` : "brand tokens already in sync");
}
