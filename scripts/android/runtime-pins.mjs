#!/usr/bin/env node
// runtime-pins: verify and bump the downloads the phone runtime trusts.
//
// The APK installs a Linux guest by downloading an Alpine minirootfs and the omp
// binary, and RuntimeCore refuses any byte stream whose sha256 or length differs
// from `assets/runtime/runtime.json`. That file is therefore the whole trust
// anchor of phone mode: a wrong pin bricks first-run for every user, a stale one
// silently ships an old omp. This tool is the only thing that should write it.
//
// Usage:
//   node scripts/android/runtime-pins.mjs --check                 verify every pin against upstream
//   node scripts/android/runtime-pins.mjs --update-omp latest     pin the newest omp release
//   node scripts/android/runtime-pins.mjs --update-omp v18.10.4   pin a specific omp tag
//   --file <path>  operate on another runtime.json (default: the APK asset)
//
// Upstream truth: GitHub publishes a `digest` ("sha256:…") and `size` per
// release asset; Alpine publishes `<tarball>.sha256` next to every release
// tarball. --check never downloads the 230 MB omp binary or the rootfs: it
// compares the pins with those published digests and with the Content-Length
// the URL (and every mirror) actually serves.
// GITHUB_TOKEN, when set, is sent to api.github.com to lift the anonymous rate limit.
//
// Node stdlib only: this runs on the phone and on laptops without `npm install`.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_FILE = join(ROOT, "mobile/android/app/src/main/assets/runtime/runtime.json");
// Android ABI → Alpine architecture directory. Adding an ABI to runtime.json
// needs an entry here only so --check can find that ABI's package index.
const ALPINE_ARCH = { "arm64-v8a": "aarch64", "x86_64": "x86_64", "armeabi-v7a": "armv7", "x86": "x86" };
const GITHUB_ASSET = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
const SHA256 = /^[0-9a-f]{64}$/;

function usage(message) {
  if (message) console.error(`runtime-pins: ${message}`);
  console.error("usage: node scripts/android/runtime-pins.mjs [--file runtime.json] (--check | --update-omp <tag|latest>)");
  process.exit(2);
}

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, check: false, updateOmp: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--update-omp") args.updateOmp = argv[++i] ?? usage("--update-omp needs a tag or 'latest'");
    else if (arg === "--file") args.file = argv[++i] ?? usage("--file needs a path");
    else usage(`unknown argument: ${arg}`);
  }
  if (args.check === (args.updateOmp !== null)) usage("pass exactly one of --check or --update-omp");
  return args;
}

function loadPins(file) {
  const pins = JSON.parse(readFileSync(file, "utf8"));
  if (pins.schema !== 1) throw new Error(`${file}: unsupported schema ${pins.schema} (this tool knows schema 1)`);
  if (!Array.isArray(pins.packages) || pins.packages.length === 0 || !pins.packages.every((p) => typeof p === "string" && p)) {
    throw new Error(`${file}: packages must be a non-empty list of Alpine package names`);
  }
  if (!pins.abis || typeof pins.abis !== "object" || Object.keys(pins.abis).length === 0) {
    throw new Error(`${file}: abis must name at least one ABI`);
  }
  return pins;
}

// Atomic rewrite: a half-written runtime.json is an APK that cannot install.
function savePins(file, pins) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`);
  renameSync(tmp, file);
}

async function request(url, init = {}) {
  const headers = { "user-agent": "omp-pulse-runtime-pins", ...(init.headers ?? {}) };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { redirect: "follow", ...init, headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} → HTTP ${response.status}`);
  return response;
}

async function githubRelease(owner, repo, tag) {
  const path = tag === "latest" ? "releases/latest" : `releases/tags/${encodeURIComponent(tag)}`;
  const response = await request(`https://api.github.com/repos/${owner}/${repo}/${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  return response.json();
}

function githubAssetParts(url) {
  const match = GITHUB_ASSET.exec(url);
  if (!match) throw new Error(`omp url is not a GitHub release asset URL: ${url}`);
  const [, owner, repo, tag, name] = match;
  return { owner, repo, tag: decodeURIComponent(tag), name: decodeURIComponent(name) };
}

// GitHub only started publishing `digest` in 2025; older releases lack it, and
// a pin without a verified hash is worse than no update.
function assetDigest(asset) {
  const digest = typeof asset.digest === "string" ? asset.digest : "";
  if (!digest.startsWith("sha256:")) throw new Error(`release asset ${asset.name} publishes no sha256 digest`);
  return digest.slice("sha256:".length).toLowerCase();
}

// HEAD is enough to prove the URL still serves exactly `bytes` without pulling
// hundreds of megabytes; GitHub redirects to its object store, which answers it.
async function servedLength(url) {
  const response = await request(url, { method: "HEAD" });
  const length = response.headers.get("content-length");
  if (length === null) throw new Error(`HEAD ${url} returned no Content-Length`);
  return Number(length);
}

function validPin(label, pin) {
  const problems = [];
  if (typeof pin?.version !== "string" || !pin.version) problems.push("version missing");
  if (typeof pin?.url !== "string" || !pin.url.startsWith("https://")) problems.push("url must be https");
  if (!Array.isArray(pin?.mirrors) || !pin.mirrors.every((m) => typeof m === "string" && m.startsWith("https://"))) {
    problems.push("mirrors must be a list of https URLs");
  }
  if (typeof pin?.sha256 !== "string" || !SHA256.test(pin.sha256)) problems.push("sha256 must be 64 lowercase hex");
  if (!Number.isSafeInteger(pin?.bytes) || pin.bytes <= 0) problems.push("bytes must be a positive integer");
  if (problems.length) throw new Error(`${label}: ${problems.join("; ")}`);
}

async function checkMirrors(label, pin, report) {
  for (const mirror of pin.mirrors) {
    const length = await servedLength(mirror);
    report(length === pin.bytes, `${label} mirror ${mirror} serves ${length} bytes (pin ${pin.bytes})`);
  }
}

async function checkOmp(abi, pin, report) {
  const label = `${abi} omp`;
  validPin(label, pin);
  const { owner, repo, tag, name } = githubAssetParts(pin.url);
  report(tag === pin.version, `${label} url tag ${tag} matches version ${pin.version}`);
  const release = await githubRelease(owner, repo, tag);
  const asset = (release.assets ?? []).find((a) => a.name === name);
  if (!asset) throw new Error(`${label}: release ${tag} has no asset ${name}`);
  report(assetDigest(asset) === pin.sha256, `${label} sha256 matches GitHub digest of ${name}`);
  report(asset.size === pin.bytes, `${label} size ${asset.size} matches pin ${pin.bytes}`);
  const length = await servedLength(pin.url);
  report(length === pin.bytes, `${label} url serves ${length} bytes`);
  await checkMirrors(label, pin, report);
}

async function checkRootfs(abi, entry, report) {
  const label = `${abi} rootfs`;
  const pin = entry.rootfs;
  validPin(label, pin);
  report(pin.url.includes(pin.version), `${label} url names version ${pin.version}`);
  const published = (await (await request(`${pin.url}.sha256`)).text()).trim().split(/\s+/)[0].toLowerCase();
  report(published === pin.sha256, `${label} sha256 matches ${pin.url.split("/").pop()}.sha256`);
  const length = await servedLength(pin.url);
  report(length === pin.bytes, `${label} url serves ${length} bytes (pin ${pin.bytes})`);
  await checkMirrors(label, pin, report);
}

// RuntimeCore runs `apk add` against alpineRepo, so a repo that moved (Alpine
// retires old branches from the CDN) breaks installs even with good tarballs.
async function checkRepo(abi, entry, report) {
  const arch = ALPINE_ARCH[abi];
  if (!arch) throw new Error(`${abi}: no Alpine architecture known; add it to ALPINE_ARCH in this script`);
  if (typeof entry.alpineRepo !== "string" || !entry.alpineRepo.startsWith("https://")) {
    throw new Error(`${abi}: alpineRepo must be an https URL`);
  }
  for (const section of ["main", "community"]) {
    const index = `${entry.alpineRepo}/${section}/${arch}/APKINDEX.tar.gz`;
    await servedLength(index);
    report(true, `${abi} package index ${index} reachable`);
  }
  if (!entry.rootfs?.url?.startsWith(`${entry.alpineRepo}/releases/${arch}/`)) {
    report(false, `${abi} rootfs url lies under ${entry.alpineRepo}/releases/${arch}/ (same branch as apk add)`);
  }
}

async function check(file) {
  const pins = loadPins(file);
  let failures = 0;
  const report = (ok, message) => {
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  };
  for (const [abi, entry] of Object.entries(pins.abis)) {
    for (const step of [checkRepo, checkRootfs, (a, e, r) => checkOmp(a, e.omp, r)]) {
      try {
        await step(abi, entry, report);
      } catch (error) {
        report(false, error.message);
      }
    }
  }
  if (failures) {
    console.error(`runtime-pins: ${failures} check(s) failed in ${file}`);
    process.exit(1);
  }
  console.log(`runtime-pins: every pin in ${file} matches upstream`);
}

async function updateOmp(file, wanted) {
  const pins = loadPins(file);
  const releases = new Map();
  for (const [abi, entry] of Object.entries(pins.abis)) {
    const old = entry.omp;
    // The asset NAME is the per-ABI fact (omp-linux-musl-arm64, …); keep it and
    // move only the tag, so adding an ABI never needs a code change here.
    const { owner, repo, name } = githubAssetParts(old.url);
    const key = `${owner}/${repo}`;
    if (!releases.has(key)) releases.set(key, await githubRelease(owner, repo, wanted));
    const release = releases.get(key);
    const asset = (release.assets ?? []).find((a) => a.name === name);
    if (!asset) throw new Error(`${abi}: release ${release.tag_name} has no asset ${name}`);
    const tag = release.tag_name;
    const mirrors = old.mirrors.map((mirror) => {
      if (!mirror.includes(old.version)) {
        throw new Error(`${abi}: mirror ${mirror} does not contain ${old.version}; update it by hand`);
      }
      return mirror.replaceAll(old.version, tag);
    });
    entry.omp = {
      version: tag,
      url: `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      mirrors,
      sha256: assetDigest(asset),
      bytes: asset.size,
    };
    validPin(`${abi} omp`, entry.omp);
    console.log(`${abi}: omp ${old.version} → ${tag} (${asset.size} bytes, sha256 ${entry.omp.sha256})`);
  }
  savePins(file, pins);
  console.log(`runtime-pins: wrote ${file}; run --check, then rebuild the APK`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.check) await check(args.file);
  else await updateOmp(args.file, args.updateOmp);
} catch (error) {
  console.error(`runtime-pins: ${error.message}`);
  process.exit(1);
}
