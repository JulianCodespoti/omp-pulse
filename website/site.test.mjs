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
