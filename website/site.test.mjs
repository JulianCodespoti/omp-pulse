import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSite, DOC_PAGES } from "./build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

test("website builds cleanly and all internal links, anchors, and media resolve", () => {
  const out = mkdtempSync(join(tmpdir(), "omp-pulse-site-test-"));
  try {
    const { pages } = buildSite(out);
    assert.equal(pages.length, 2 + DOC_PAGES.length);

    const cargo = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
    const repoSlug = cargo.match(/^repository\s*=\s*"https:\/\/github\.com\/([^"]+)"/m)?.[1];
    assert.ok(repoSlug, "Cargo.toml has a GitHub repository URL");

    // Pre-parse heading/element IDs in every built HTML page
    const pageIds = new Map();
    const pageHtml = new Map();
    for (const relPage of pages) {
      const full = join(out, relPage);
      assert.ok(existsSync(full), `expected page ${relPage} to exist`);
      const html = readFileSync(full, "utf8");
      pageHtml.set(relPage, html);
      const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
      pageIds.set(relPage, ids);
    }

    // Landing page contract checks
    const landing = pageHtml.get("index.html");
    assert.match(landing, new RegExp(repoSlug.replace("/", "\\/")));
    assert.match(landing, /Run on this phone/);
    assert.match(landing, /Phone tools for the agent/);
    assert.doesNotMatch(landing, /SessionsScreen|all-chats-layer|screenshot-sessions\.png/);
    assert.doesNotMatch(landing, /\b[\w/]+\.rs\b/, "landing page shows no source file names");

    // Validate every href and src across every generated HTML page
    for (const [relPage, html] of pageHtml.entries()) {
      const pageDir = dirname(join(out, relPage));

      for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        const ref = match[1];
        if (/^(?:https?:|mailto:|data:)/i.test(ref)) continue;

        const [rawPath, fragment] = ref.split("#");
        const targetPath = rawPath ? resolve(pageDir, rawPath) : join(out, relPage);
        assert.ok(
          existsSync(targetPath) && statSync(targetPath).isFile(),
          `${relPage} references missing local path: ${ref} (-> ${targetPath})`,
        );

        if (fragment && targetPath.endsWith(".html")) {
          const relTarget = targetPath.slice(out.length + 1).replaceAll("\\", "/");
          const ids = pageIds.get(relTarget);
          assert.ok(ids?.has(fragment), `${relPage} references missing anchor #${fragment} in ${relTarget}`);
        }
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("every page's og:image and twitter:image are absolute URLs of a card that exists in the build", () => {
  const out = mkdtempSync(join(tmpdir(), "omp-pulse-site-test-"));
  try {
    const { pages } = buildSite(out);

    const cargo = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
    const repoSlug = cargo.match(/^repository\s*=\s*"https:\/\/github\.com\/([^"]+)"/m)?.[1];
    assert.ok(repoSlug, "Cargo.toml has a GitHub repository URL");
    const [owner, name] = repoSlug.replace(/\/+$/, "").split("/");
    const siteUrl = `https://${owner.toLowerCase()}.github.io/${name}/`;

    for (const relPage of pages) {
      const html = readFileSync(join(out, relPage), "utf8");
      for (const property of ["og:image", "twitter:image"]) {
        const attr = property.startsWith("og:") ? "property" : "name";
        const url = html.match(new RegExp(`<meta ${attr}="${property}" content="([^"]+)"`))?.[1];
        assert.ok(url, `${relPage} has ${property}`);
        assert.ok(url.startsWith(siteUrl), `${relPage} ${property} ${url} is under ${siteUrl}`);
        const file = join(out, url.slice(siteUrl.length));
        assert.ok(existsSync(file) && statSync(file).isFile(), `${relPage} ${property} points at ${url}, which the build does not contain`);
      }
      const ogUrl = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1];
      assert.ok(ogUrl?.startsWith(siteUrl), `${relPage} og:url ${ogUrl} is under ${siteUrl}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("SEO metadata, JSON-LD, sitemap.xml, robots.txt and llms.txt are valid and consistent", () => {
  const out = mkdtempSync(join(tmpdir(), "omp-pulse-site-test-"));
  const prevGoogle = process.env.OMP_PULSE_GOOGLE_SITE_VERIFICATION;
  const prevBing = process.env.OMP_PULSE_BING_SITE_VERIFICATION;
  delete process.env.OMP_PULSE_GOOGLE_SITE_VERIFICATION;
  delete process.env.OMP_PULSE_BING_SITE_VERIFICATION;
  try {
    const { pages } = buildSite(out);

    const cargo = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
    const repoSlug = cargo.match(/^repository\s*=\s*"https:\/\/github\.com\/([^"]+)"/m)?.[1];
    assert.ok(repoSlug, "Cargo.toml has a GitHub repository URL");
    const [owner, name] = repoSlug.replace(/\/+$/, "").split("/");
    const siteUrl = `https://${owner.toLowerCase()}.github.io/${name}/`;

    // robots.txt
    const robots = readFileSync(join(out, "robots.txt"), "utf8");
    assert.match(robots, /^User-agent: \*/m);
    assert.match(robots, new RegExp(`^Sitemap: ${siteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}sitemap\\.xml$`, "m"));

    // sitemap.xml: includes every indexable page and excludes 404.html
    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    const locs = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1]);
    assert.equal(locs.length, 1 + DOC_PAGES.length);
    assert.ok(locs.includes(siteUrl), "sitemap includes root landing URL");
    assert.ok(locs.includes(`${siteUrl}docs/`), "sitemap includes canonical docs/ URL");
    assert.ok(!locs.some((u) => u.includes("404.html")), "sitemap excludes 404.html");

    // llms.txt
    const llms = readFileSync(join(out, "llms.txt"), "utf8");
    assert.match(llms, new RegExp(`https://github\\.com/${repoSlug.replace("/", "\\/")}`));
    assert.match(llms, new RegExp(siteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const doc of DOC_PAGES) {
      assert.ok(llms.includes(doc.title), `llms.txt lists ${doc.title}`);
    }

    // Per-page canonical, robots and JSON-LD checks
    for (const relPage of pages) {
      const html = readFileSync(join(out, relPage), "utf8");
      const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
      const ogUrl = html.match(/<meta property="og:url" content="([^"]+)">/)?.[1];
      assert.doesNotMatch(html, /google-site-verification|msvalidate\.01/);

      if (relPage === "404.html") {
        assert.match(html, /<meta name="robots" content="noindex, follow">/);
        assert.equal(canonical, undefined, "404.html omits canonical link");
        continue;
      }

      assert.equal(canonical, ogUrl, `${relPage} canonical matches og:url`);
      assert.ok(locs.includes(canonical), `${relPage} canonical ${canonical} is listed in sitemap.xml`);

      const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
      assert.ok(ldMatch, `${relPage} has JSON-LD structured data`);
      const parsed = JSON.parse(ldMatch[1]);
      assert.equal(parsed["@context"], "https://schema.org");
      assert.ok(Array.isArray(parsed["@graph"]) && parsed["@graph"].length >= 2);

      if (relPage === "index.html") {
        const types = parsed["@graph"].flatMap((node) => (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]));
        assert.ok(types.includes("WebSite"));
        assert.ok(types.includes("SoftwareApplication"));
        assert.ok(types.includes("SoftwareSourceCode"));
        assert.ok(types.includes("VideoObject"));
        assert.ok(types.includes("FAQPage"));
      }
    }

    // Optional Search Console / Bing verification meta tags render only when configured
    process.env.OMP_PULSE_GOOGLE_SITE_VERIFICATION = "test-google-token";
    process.env.OMP_PULSE_BING_SITE_VERIFICATION = "test-bing-token";
    buildSite(out);
    const verifiedLanding = readFileSync(join(out, "index.html"), "utf8");
    assert.match(verifiedLanding, /<meta name="google-site-verification" content="test-google-token">/);
    assert.match(verifiedLanding, /<meta name="msvalidate\.01" content="test-bing-token">/);
  } finally {
    if (prevGoogle === undefined) delete process.env.OMP_PULSE_GOOGLE_SITE_VERIFICATION;
    else process.env.OMP_PULSE_GOOGLE_SITE_VERIFICATION = prevGoogle;
    if (prevBing === undefined) delete process.env.OMP_PULSE_BING_SITE_VERIFICATION;
    else process.env.OMP_PULSE_BING_SITE_VERIFICATION = prevBing;
    rmSync(out, { recursive: true, force: true });
  }
});
