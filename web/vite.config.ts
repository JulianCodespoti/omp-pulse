import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const daemonTarget = process.env.OMP_PULSE_WEB_TARGET ?? "http://127.0.0.1:7682";
const releaseId = (process.env.VITE_RELEASE_ID ?? "dev").trim() || "dev";

// Protocol numbers come from the repository-root protocol-version.json, the one
// source shared with build.rs, Gradle and the deploy manifest. They are
// replaced as literals, so the client needs no runtime fetch and no env var.
const protocol = JSON.parse(
  readFileSync(new URL("../protocol-version.json", import.meta.url), "utf8"),
) as { protocolVersion?: unknown; minClientProtocolVersion?: unknown };
const protocolKeys = Object.keys(protocol).sort();
if (
  protocolKeys.length !== 2 ||
  protocolKeys[0] !== "minClientProtocolVersion" ||
  protocolKeys[1] !== "protocolVersion" ||
  !Number.isSafeInteger(protocol.protocolVersion) ||
  Number(protocol.protocolVersion) <= 0 ||
  !Number.isSafeInteger(protocol.minClientProtocolVersion) ||
  Number(protocol.minClientProtocolVersion) <= 0 ||
  Number(protocol.minClientProtocolVersion) > Number(protocol.protocolVersion)
) {
  throw new Error(
    "protocol-version.json must contain exactly protocolVersion and minClientProtocolVersion, both positive, minimum <= version",
  );
}
const protocolVersion = Number(protocol.protocolVersion);
const minClientProtocolVersion = Number(protocol.minClientProtocolVersion);

// ── Shiki grammar subset ────────────────────────────────────────────────────
// The full shiki install ships 300+ grammars (614 chunks when duplicated).
// Sessions mostly show diffs/logs from Rust + TypeScript + Python + shell +
// JSON/YAML/TOML + diff + markdown. Everything else falls back to plain text.
// Languages not in this set resolve to a tiny empty module so Vite never emits
// their chunks, and the highlighter callback falls back to `text`.
const allowedShikiLangs: Record<string, true> = {
  rust: true,
  typescript: true,
  javascript: true,
  tsx: true,
  jsx: true,
  python: true,
  bash: true,
  shellscript: true,
  shell: true,
  sh: true,
  json: true,
  jsonc: true,
  yaml: true,
  toml: true,
  diff: true,
  markdown: true,
  text: true,
  plaintext: true,
  css: true,
  html: true,
};

const EMPTY_LANG_ID = "\0empty-shiki-lang";

function restrictShikiLangs() {
  return {
    name: "restrict-shiki-langs",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (id.startsWith("@shikijs/langs/")) {
        const raw = id.split("/").pop() ?? "";
        const lang = raw.replace(/\.(mjs|js)$/, "");
        // INVARIANT: every disallowed grammar resolves to the SAME module id.
        // Returning a per-language id made Rollup emit ~200 separate stub
        // chunks — correct, but 200 pointless files in `dist/` and 200 entries
        // the deploy has to copy.
        if (!allowedShikiLangs[lang]) return EMPTY_LANG_ID;
      }
      return null;
    },
    load(id: string) {
      // No grammars: a `@shikijs/langs/*` module's default export is the LIST
      // of grammars it needs, so `[]` loads nothing, the language is never
      // registered, and code-plugin.ts falls back to `text` (plain monospaced
      // text, the intended fallback). An object here was read as ONE grammar
      // with no scopeName, and shiki's registry threw on it ("reading
      // 'split'") for every fence in a restricted language, production only.
      if (id === EMPTY_LANG_ID) return "export default [];";
      return null;
    },
  };
}

// ── Shiki theme subset ──────────────────────────────────────────────────────
// CodeBlock only uses github-light / github-dark (see code-block.tsx). The
// full shiki install ships 50+ themes; emitting them all costs ~500 KB of
// dist/ and bloats the daemon binary (public/ is embedded). Themes not in
// this set resolve to the same empty stub as disallowed langs.
const allowedShikiThemes: Record<string, true> = {
  "github-light": true,
  "github-dark": true,
};

const EMPTY_THEME_ID = "\0empty-shiki-theme";

const EMPTY_WASM_ID = "\0empty-shiki-wasm";

function dropWasmEngine() {
  return {
    name: "drop-shiki-wasm",
    enforce: "pre" as const,
    resolveId(id: string) {
      // Shiki's JS engine is used everywhere (code-block.tsx and @streamdown/code both
      // use createJavaScriptRegexEngine), so the oniguruma WASM engine is never needed.
      // Stubbing it saves 622 KB (232 KB gzip) plus WASM compile time on a 4x-throttled phone.
      if (
        id === "@shikijs/engine-oniguruma" ||
        id === "shiki/wasm" ||
        id.endsWith("/engine-oniguruma.mjs") ||
        id.endsWith("/wasm.mjs") ||
        id.includes("onig.wasm")
      ) {
        return EMPTY_WASM_ID;
      }
      return null;
    },
    load(id: string) {
      if (id === EMPTY_WASM_ID) return "export default {}; export const createOnigurumaEngine = () => { throw new Error('wasm disabled'); }; export const loadWasm = async () => {};";
      return null;
    },
  };
}

function restrictShikiThemes() {
  return {
    name: "restrict-shiki-themes",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (id.startsWith("@shikijs/themes/")) {
        const raw = id.split("/").pop() ?? "";
        const theme = raw.replace(/\.(mjs|js)$/, "");
        if (!allowedShikiThemes[theme]) return EMPTY_THEME_ID;
      }
      return null;
    },
    load(id: string) {
      if (id === EMPTY_THEME_ID) return "export default {};";
      return null;
    },
  };
}

// ── rehype-raw ──────────────────────────────────────────────────────────────
// streamdown imports `rehype-raw` statically for its default plugin list, but
// markdown.tsx never passes it (raw HTML renders as literal text, see there).
// Left in, it drags parse5 + entities + hast-util-raw (~150 KB raw) into the
// markdown chunk that the sessions list preloads on every launch. A no-op
// plugin keeps streamdown's import and its `defaultRehypePlugins.raw` valid.
const EMPTY_REHYPE_RAW_ID = "\0empty-rehype-raw";

function dropRehypeRaw() {
  return {
    name: "drop-rehype-raw",
    enforce: "pre" as const,
    resolveId(id: string) {
      return id === "rehype-raw" ? EMPTY_REHYPE_RAW_ID : null;
    },
    load(id: string) {
      if (id === EMPTY_REHYPE_RAW_ID) return "export default function rehypeRaw() {}";
      return null;
    },
  };
}

// ── Third-party licence notices ─────────────────────────────────────────────
// Every build path (pulse-deploy.sh, android-phone-build.sh, release-local.sh,
// ci-local.sh) runs `vite build`, and cargo embeds / Capacitor bundles its
// output, so generating here makes the crate and npm notices ship with every
// binary. Fails the build when cargo metadata or web/node_modules is missing.
function thirdPartyLicenses() {
  let outDir = "";
  return {
    name: "third-party-licenses",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      sequential: true,
      handler() {
        execFileSync(process.execPath, [
          fileURLToPath(new URL("../scripts/release/third-party-licenses.mjs", import.meta.url)), outDir,
        ], { stdio: "inherit" });
      },
    },
  };
}

// ── Precompressed sidecars ──────────────────────────────────────────────────
// The daemon embeds this output and used to gzip-6 every static response for
// remote clients at RUNTIME: ~85 ms of phone CPU per cold remote load, and
// gzip only. Writing `<file>.br` (quality 11) and `<file>.gz` (level 9) once
// here lets `src/server/assets.rs` serve stored bytes instead (br is ~16% smaller
// than gzip on these chunks). Loopback still gets identity: decoding costs the
// on-phone WebView more than the saved memcpy. Android's aaptOptions ignore
// the sidecars, so the bundled shell does not carry them.
const PRECOMPRESS = /\.(js|mjs|css|html|svg|json|webmanifest)$/;
const PRECOMPRESS_MIN_BYTES = 1024;

function precompressOutput() {
  let outDir = "";
  return {
    name: "precompress-output",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // closeBundle, not generateBundle: files vite copies from `public/`
    // (sw.js, offline.html, the manifest) are only on disk by now.
    closeBundle: {
      order: "post" as const,
      sequential: true,
      handler() {
        const walk = (dir: string): string[] =>
          readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
        for (const file of walk(outDir)) {
          if (!PRECOMPRESS.test(file) || statSync(file).size < PRECOMPRESS_MIN_BYTES) continue;
          const body = readFileSync(file);
          writeFileSync(`${file}.gz`, gzipSync(body, { level: 9 }));
          writeFileSync(`${file}.br`, brotliCompressSync(body, {
            params: {
              [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
              [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
              [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          }));
        }
      },
    },
  };
}
export default defineConfig({
  define: {
    // Keep development identity explicit; production is stamped by the
    // canonical deploy helper and passed unchanged to daemon/native builds.
    "import.meta.env.VITE_RELEASE_ID": JSON.stringify(releaseId),
    // Protocol numbers are integers, so they are injected as numbers rather
    // than the strings import.meta.env would otherwise carry.
    "import.meta.env.VITE_PROTOCOL_VERSION": String(protocolVersion),
    "import.meta.env.VITE_MIN_CLIENT_PROTOCOL_VERSION": String(minClientProtocolVersion),
  },
  plugins: [
    {
      name: "release-identity",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "release-id", source: `${releaseId}\n` });
      },
      writeBundle: {
        order: "post",
        sequential: true,
        handler(output, bundle) {
          if (!output.dir) throw new Error("release worker requires an output directory");
          // writeBundle sees final HTML after Vite's preload/CSS rewriting.
          // Every emitted asset is included, not just static entry imports:
          // lazy screens, grammar chunks, CSS and fonts must work offline too.
          // Compression runs later in closeBundle; the worker requests these
          // original URLs and HTTP content decoding supplies the original bytes.
          const shell = readFileSync(join(output.dir, "index.html"));
          const shellHash = createHash("sha256").update(shell).digest("hex");
          const assets = Object.keys(bundle).filter((name) => name.startsWith("assets/")).sort();
          const worker = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8")
            .replaceAll("__OMP_PULSE_SHELL_HASH__", shellHash)
            .replace("/*__OMP_PULSE_RELEASE_ASSETS__*/ []", JSON.stringify(assets));
          writeFileSync(join(output.dir, "sw.js"), worker);
        },
      },
    },
    restrictShikiLangs(), restrictShikiThemes(), dropWasmEngine(), dropRehypeRaw(), react(), tailwindcss(),
    thirdPartyLicenses(), precompressOutput(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // INVARIANT: `shiki` must resolve to exactly one copy. `@streamdown/code`
    // declares `shiki@^3.19.0` while the app depended on `shiki@^4.4.3`, so npm
    // installed a second nested copy with its own `@shikijs/langs`. Every
    // grammar was then emitted twice under different hashes — 300 duplicates,
    // 9.6 MB of `dist/` (e.g. `cpp` at both 785 KB and 626 KB).
    //
    // The fix is the `shiki` override in package.json pinning both consumers to
    // the 3.x line `@streamdown/code` supports. `dedupe` is the correct Vite
    // mechanism to reinforce that. It must NOT be an `alias` to a directory
    // path: that bypasses the package's `exports` map, so subpaths such as
    // `shiki/engine/javascript` and `shiki/wasm` resolve to directories that do
    // not exist and the build fails with UNLOADABLE_DEPENDENCY.
    dedupe: ["shiki"],
  },
  // package.json declares `"sideEffects": ["*.css"]` (JSON has no comments,
  // so the reason lives here). Without it Rollup must keep every app module
  // that is merely IMPORTED, even when none of its exports are used: the
  // shadcn `select`/`command` wrappers rode into the entry and chat chunks
  // through ai-elements files that re-export them, ~10 KB gzipped of the
  // entry alone. A module that must run for its side effects therefore has to
  // be imported for a value, or listed there — `offline-queue.ts` is safe
  // because its top-level listener lives beside exports that are used.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: daemonTarget },
      "/ws": { target: daemonTarget, ws: true },
    },
  },
});
