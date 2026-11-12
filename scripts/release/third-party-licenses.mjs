#!/usr/bin/env node
// Writes the licence notices of every third-party Rust crate and production
// npm package compiled into omp-pulse into <outDir>/licenses/:
//
//   rust-crates.txt   crates linked into the daemon (Linux, Windows) and the
//                     phone runtime libomppulse.so (aarch64 musl)
//   npm-packages.txt  packages reachable from web/package.json "dependencies"
//
// MIT, BSD, ISC and Apache-2.0 require their notices to travel with binary
// copies. <outDir> is the vite output (public/app), which cargo embeds in the
// daemon (include_dir!) and Capacitor bundles into the APK, so the notices
// ship with both. web/vite.config.ts runs this after every `vite build`;
// manually: node scripts/release/third-party-licenses.mjs public/app
//
// Licence texts are read from the crate sources cargo downloaded and from
// web/node_modules, so `cargo metadata` must work and `npm ci` must have run.
// Output is deterministic: sorted, no timestamps or absolute paths. Texts that
// are identical up to whitespace are written once and referenced by number.
// Exits non-zero when a crate or package has neither a licence file nor a
// licence expression.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = join(ROOT, "web");

// Every target a binary is built for: the published daemons
// (scripts/release/targets.json, built by .github/workflows/release.yml),
// scripts/android/build-runtime.sh (aarch64 musl), native builds on glibc
// Linux hosts (scripts/deploy/pulse-deploy.sh) and the Windows gate build in
// scripts/ci.sh.
const TARGETS = [
  ...new Set([
    ...JSON.parse(readFileSync(join(ROOT, "scripts/release/targets.json"), "utf8")).map((entry) => entry.target),
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-gnu",
  ]),
].sort();

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i;
const LICENSE_DIR = /^licen[cs]es?$/i;

function die(message) {
  console.error(`third-party-licenses: ${message}`);
  process.exit(1);
}

// Licence files at the top of a package, plus the contents of a top-level
// LICENSES/ directory (REUSE layout). Returns [{ name, text }] sorted by name.
function licenseFiles(dir, extra) {
  const found = new Map();
  const add = (rel) => {
    const path = join(dir, rel);
    if (found.has(rel) || !existsSync(path) || !statSync(path).isFile()) return;
    found.set(rel, readFileSync(path, "utf8"));
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE.test(entry.name)) add(entry.name);
    if (entry.isDirectory() && LICENSE_DIR.test(entry.name)) {
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (inner.isFile()) add(`${entry.name}/${inner.name}`);
      }
    }
  }
  if (extra) add(extra);
  return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => ({ name, text }));
}

// Texts are shared by number. Line endings and trailing whitespace are
// normalised for output; the identity ignores all whitespace so reflowed
// copies of the same licence collapse into one.
class TextTable {
  constructor() {
    this.byKey = new Map();
    this.texts = [];
  }
  ref(raw) {
    const text = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n")
      .replace(/^\n+/, "").replace(/\n+$/, "");
    const key = createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
    let id = this.byKey.get(key);
    if (id === undefined) {
      this.texts.push(text);
      id = this.texts.length;
      this.byKey.set(key, id);
    }
    return id;
  }
}

// The SPDX MIT text, for packages that declare MIT but publish no licence
// file; their authors are listed next to the reference.
const MIT_TEXT = `MIT License (standard text; the copyright holders are the authors listed
with the package)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function render({ title, intro, entries }) {
  const table = new TextTable();
  const blocks = entries.map((e) => {
    const lines = [`${e.name} ${e.version}`, `  Licence: ${e.license || "(none declared)"}`];
    if (e.source) lines.push(`  Source: ${e.source}`);
    if (e.files.length) {
      for (const f of e.files) lines.push(`  ${f.name}: see text [${table.ref(f.text)}]`);
    } else {
      lines.push("  No licence file is included in the published package.");
      if (e.authors) lines.push(`  Authors: ${e.authors}`);
      if (/\bMIT\b/.test(e.license)) lines.push(`  MIT licence text: see text [${table.ref(MIT_TEXT)}]`);
      else if (/\bApache-2\.0\b/.test(e.license)) lines.push("  Apache-2.0 licence text: Apache-2.0.txt in this directory");
    }
    return lines.join("\n");
  });
  const bar = "=".repeat(78);
  const out = [
    title,
    "",
    ...intro,
    "",
    `${entries.length} packages, ${table.texts.length} distinct licence texts. Each package lists its`,
    "licence files by number; the texts follow the package list.",
    "",
    bar,
    "",
    blocks.join("\n\n"),
    "",
    bar,
    "LICENCE TEXTS",
    bar,
    ...table.texts.flatMap((text, i) => ["", `----- [${i + 1}] ${"-".repeat(66)}`, "", text]),
    "",
  ];
  return { body: out.join("\n"), texts: table.texts.length };
}

// ── Rust ─────────────────────────────────────────────────────────────────────
// Normal dependencies only, followed from the omp-pulse package per target:
// dev-dependencies never ship, and build-dependencies (with everything only
// they pull in) run at compile time and are not linked into the binary.
function rustEntries() {
  const ids = new Set();
  const packages = new Map();
  let members;
  for (const target of TARGETS) {
    let json;
    try {
      json = execFileSync("cargo", [
        "metadata", "--format-version", "1", "--locked",
        "--manifest-path", join(ROOT, "Cargo.toml"), "--filter-platform", target,
      ], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "inherit"] });
    } catch (error) {
      die(`cargo metadata failed for ${target}: ${error.message}`);
    }
    const meta = JSON.parse(json);
    for (const p of meta.packages) packages.set(p.id, p);
    members ??= new Set(meta.workspace_members);
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const stack = [...members];
    const seen = new Set(stack);
    while (stack.length) {
      const node = nodes.get(stack.pop());
      for (const dep of node.deps) {
        if (!dep.dep_kinds.some((k) => k.kind === null) || seen.has(dep.pkg)) continue;
        seen.add(dep.pkg);
        stack.push(dep.pkg);
      }
    }
    for (const id of seen) if (!members.has(id)) ids.add(id);
  }
  return [...ids].map((id) => {
    const p = packages.get(id);
    const dir = dirname(p.manifest_path);
    const registry = p.source?.startsWith("registry+") || p.source?.startsWith("sparse+");
    return {
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? `see ${p.license_file}` : ""),
      source: registry ? `https://crates.io/crates/${p.name}/${p.version}` : p.repository ?? "",
      authors: (p.authors ?? []).join(", "),
      files: licenseFiles(dir, p.license_file ?? undefined),
    };
  });
}

// ── npm ──────────────────────────────────────────────────────────────────────
// Walks web/package.json "dependencies" through node's resolution: required
// dependencies and non-optional peers must be installed; optional ones that
// npm skipped on this platform are not part of the bundle.
function npmEntries() {
  const nodeModules = join(WEB, "node_modules");
  if (!existsSync(nodeModules)) die("web/node_modules is missing; run `npm --prefix web ci` first");
  const readPkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const resolveDep = (fromDir, name) => {
    for (let dir = fromDir; dir.startsWith(WEB); dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (dir === WEB) break;
    }
    return null;
  };
  const requires = (pkg) => {
    const out = [];
    for (const name of Object.keys(pkg.dependencies ?? {})) out.push([name, false]);
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) out.push([name, true]);
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      out.push([name, pkg.peerDependenciesMeta?.[name]?.optional === true]);
    }
    return out;
  };
  const found = new Map();
  const stack = [[WEB, readPkg(WEB)]];
  while (stack.length) {
    const [dir, pkg] = stack.pop();
    for (const [name, optional] of requires(pkg)) {
      const depDir = resolveDep(dir, name);
      if (!depDir) {
        if (optional) continue;
        die(`${name} (required by ${pkg.name ?? dir}) is not installed in web/node_modules; run \`npm --prefix web ci\``);
      }
      if (found.has(depDir)) continue;
      const depPkg = readPkg(depDir);
      found.set(depDir, depPkg);
      stack.push([depDir, depPkg]);
    }
  }
  return [...found].map(([dir, pkg]) => {
    const license = typeof pkg.license === "string" ? pkg.license
      : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(" OR ") : "");
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    return {
      name: pkg.name,
      version: pkg.version,
      license,
      source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      authors: author ?? "",
      files: licenseFiles(dir),
    };
  });
}

function write(outDir, fileName, title, intro, raw) {
  const byKey = new Map();
  for (const e of raw) byKey.set(`${e.name}@${e.version}`, e);
  const entries = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const bare = entries.filter((e) => !e.files.length && !e.license);
  if (bare.length) die(`no licence file and no licence expression: ${bare.map((e) => `${e.name}@${e.version}`).join(", ")}`);
  const { body, texts } = render({ title, intro, entries });
  const path = join(outDir, "licenses", fileName);
  writeFileSync(path, body);
  const noFile = entries.filter((e) => !e.files.length).length;
  console.log(`third-party-licenses: ${fileName}: ${entries.length} packages, ${texts} distinct texts, `
    + `${noFile} without a licence file, ${(Buffer.byteLength(body) / 1024).toFixed(0)} KiB`);
}

const outDir = process.argv[2];
if (!outDir) die("usage: node scripts/release/third-party-licenses.mjs <outDir>   (e.g. public/app)");
mkdirSync(join(resolve(outDir), "licenses"), { recursive: true });
write(resolve(outDir), "rust-crates.txt", "omp-pulse: third-party Rust crates", [
  "The omp-pulse daemon and the phone runtime library (libomppulse.so in the",
  "Android app) are compiled from these crates. Listed: every normal dependency",
  `for the published targets (${TARGETS.join(", ")}),`,
  "with the licence expression from its Cargo.toml and every licence file in the",
  "published crate. Generated by scripts/release/third-party-licenses.mjs.",
], rustEntries());
write(resolve(outDir), "npm-packages.txt", "omp-pulse: third-party npm packages", [
  "The omp-pulse web client (served by the daemon and bundled in the Android",
  "app) is built from these packages: everything reachable from the",
  "\"dependencies\" of web/package.json, with the licence expression from each",
  "package.json and every licence file in the package. Generated by",
  "scripts/release/third-party-licenses.mjs.",
], npmEntries());
