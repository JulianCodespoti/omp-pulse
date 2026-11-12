#!/usr/bin/env node
// Static website & documentation generator for OMP Pulse.
//
// Reads Cargo.toml, README.md, docs/**, SECURITY.md, CONTRIBUTING.md, and
// CHANGELOG.md directly from the repository so documentation, version numbers,
// and repository links never drift from the codebase.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(HERE, "dist");

const require = createRequire(join(ROOT, "web/package.json"));
const { unified } = await import(require.resolve("unified"));
const { default: remarkParse } = await import(require.resolve("remark-parse"));
const { default: remarkGfm } = await import(require.resolve("remark-gfm"));
const { default: remarkRehype } = await import(require.resolve("remark-rehype"));
const { toHtml } = await import(require.resolve("hast-util-to-html"));

// ── Metadata from Cargo.toml (rewritten automatically by set-repo.sh) ──────

const cargoToml = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const VERSION = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "0.1.0";
const REPO_URL =
  cargoToml.match(/^repository\s*=\s*"([^"]+)"/m)?.[1]?.replace(/\/+$/, "") ??
  "https://github.com/JulianCodespoti/omp-pulse";
const REPO_SLUG = REPO_URL.replace(/^https?:\/\/github\.com\//, "");
const RAW_MAIN = `https://raw.githubusercontent.com/${REPO_SLUG}/main`;
const RELEASES_LATEST = `${REPO_URL}/releases/latest`;
const APK_DIRECT = `${RELEASES_LATEST}/download/omp-pulse.apk`;

// ── Documentation manifest ─────────────────────────────────────────────────

export const DOC_PAGES = [
  {
    slug: "docs/index.html",
    source: "docs/README.md",
    group: "Overview",
    title: "Documentation Overview",
    shortTitle: "Overview",
    description: "Complete user, contributor, and architecture documentation for OMP Pulse.",
  },
  {
    slug: "docs/phone-mode.html",
    source: "docs/user/phone-mode.md",
    group: "User Guides",
    title: "Android Phone Mode",
    shortTitle: "Android Phone Mode",
    description: "Run omp and the Pulse daemon directly on an Android phone with an Alpine Linux workspace and Android agent tools.",
  },
  {
    slug: "docs/configuration.html",
    source: "docs/user/configuration.md",
    group: "User Guides",
    title: "Configuration & CLI Reference",
    shortTitle: "Configuration & CLI",
    description: "Commands, pairing roles, config.toml, state files, environment variables, and local speech-to-text.",
  },
  {
    slug: "docs/networking.html",
    source: "docs/user/networking.md",
    group: "User Guides",
    title: "Networking & HTTPS",
    shortTitle: "Networking & HTTPS",
    description: "Connect your phone over Tailscale HTTPS, Cloudflare Tunnel, or trusted LAN, and why secure contexts matter.",
  },
  {
    slug: "docs/windows.html",
    source: "docs/user/windows.md",
    group: "User Guides",
    title: "Running on Windows",
    shortTitle: "Windows Setup",
    description: "Installing and running the OMP Pulse daemon on Windows 10 and 11.",
  },
  {
    slug: "docs/plugins.html",
    source: "docs/user/plugins.md",
    group: "User Guides",
    title: "Sandboxed Phone Plugins",
    shortTitle: "Plugins",
    description: "Extend OMP Pulse with sandboxed UI plugins fed by host commands, custom cards, drawer chips, and reviewable actions.",
  },
  {
    slug: "docs/architecture.html",
    source: "docs/internals/architecture.md",
    group: "Internals & Security",
    title: "Architecture & Live Sync",
    shortTitle: "Architecture",
    description: "How the single-binary Rust daemon coordinates RPC children, desktop bridges, collab relays, and file tailing.",
  },
  {
    slug: "docs/security.html",
    source: "SECURITY.md",
    group: "Internals & Security",
    title: "Security & Threat Model",
    shortTitle: "Security Model",
    description: "Device roles, credential storage, session write arbitration, on-device proot runtime boundaries, and vulnerability reporting.",
  },
  {
    slug: "docs/contributing.html",
    source: "CONTRIBUTING.md",
    group: "Project",
    title: "Contributing",
    shortTitle: "Contributing",
    description: "Building the React client, Rust daemon, and Android APK, plus running the CI validation gate.",
  },
  {
    slug: "docs/changelog.html",
    source: "CHANGELOG.md",
    group: "Project",
    title: "Changelog",
    shortTitle: "Changelog",
    description: "Release history and notable improvements in OMP Pulse.",
  },
];

const SOURCE_TO_SLUG = new Map(DOC_PAGES.map((p) => [p.source, p.slug]));

// ── Markdown rendering & link rewriting ────────────────────────────────────

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function textContent(node) {
  if (!node) return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value || "";
  if (Array.isArray(node.children)) return node.children.map(textContent).join("");
  return "";
}

function resolveDocLink(href, sourceFile, currentSlug) {
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const [rawPath, hashPart] = href.split("#");
  const suffix = hashPart ? `#${hashPart}` : "";
  if (!rawPath) return suffix;

  const sourceDir = posix.dirname(sourceFile);
  const repoRel = posix.normalize(posix.join(sourceDir, rawPath));

  if (repoRel === "README.md") {
    const relRoot = posix.relative(posix.dirname(currentSlug), "index.html") || "index.html";
    return `${relRoot}${suffix}`;
  }

  const mapped = SOURCE_TO_SLUG.get(repoRel);
  if (mapped) {
    return `${posix.relative(posix.dirname(currentSlug), mapped)}${suffix}`;
  }

  // Link to any other repository file -> GitHub blob/tree view so zero links 404.
  const fullOnDisk = join(ROOT, repoRel);
  if (existsSync(fullOnDisk)) {
    return `${REPO_URL}/blob/main/${repoRel}${suffix}`;
  }
  return href;
}

function transformHast(tree, sourceFile, currentSlug) {
  const seenIds = new Map();
  const visit = (node) => {
    if (node.type === "element") {
      if (/^h[1-6]$/.test(node.tagName)) {
        const base = slugifyHeading(textContent(node)) || "section";
        const count = seenIds.get(base) ?? 0;
        seenIds.set(base, count + 1);
        node.properties = node.properties || {};
        node.properties.id = count === 0 ? base : `${base}-${count}`;
      } else if (node.tagName === "a" && typeof node.properties?.href === "string") {
        const resolved = resolveDocLink(node.properties.href, sourceFile, currentSlug);
        node.properties.href = resolved;
        if (/^https?:\/\//i.test(resolved)) {
          node.properties.target = "_blank";
          node.properties.rel = "noopener noreferrer";
        }
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(tree);
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

function renderMarkdown(markdown, sourceFile, currentSlug) {
  const mdast = processor.parse(markdown);
  const hast = processor.runSync(mdast);
  transformHast(hast, sourceFile, currentSlug);
  return toHtml(hast);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ── Shared Chrome ──────────────────────────────────────────────────────────

function renderHeader(rootPrefix, activeSection) {
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="${rootPrefix}index.html">
      <img class="brand-mark" src="${rootPrefix}assets/icon.svg" width="30" height="30" alt="OMP Pulse icon">
      <span>OMP Pulse</span>
      <span class="brand-tag">v${escapeHtml(VERSION)}</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
      <a class="nav-link" href="${rootPrefix}index.html#tour"${activeSection === "home" ? ' aria-current="page"' : ""}>Product</a>
      <a class="nav-link" href="${rootPrefix}index.html#phone-mode">Phone Mode</a>
      <a class="nav-link" href="${rootPrefix}index.html#architecture">Architecture</a>
      <a class="nav-link" href="${rootPrefix}index.html#downloads">Downloads</a>
      <a class="nav-link" href="${rootPrefix}docs/index.html"${activeSection === "docs" ? ' aria-current="page"' : ""}>Docs</a>
    </nav>
    <div class="header-actions">
      <a class="btn btn-secondary hide-sm" href="${escapeHtml(REPO_URL)}" target="_blank" rel="noopener noreferrer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>
        GitHub
      </a>
      <a class="btn btn-primary" href="${rootPrefix}index.html#downloads">Get Pulse</a>
      <button class="mobile-menu-btn" type="button" data-mobile-menu aria-label="Toggle navigation" aria-expanded="false">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
  </div>
</header>`;
}

function renderFooter(rootPrefix) {
  return `<footer class="site-footer">
  <div class="container footer-inner">
    <div>
      <strong>OMP Pulse</strong> · MIT Licensed · Independent companion for <a href="https://github.com/can1357/oh-my-pi" target="_blank" rel="noopener noreferrer" style="color:var(--fg-muted);text-decoration:underline">omp (Oh My Pi)</a>.
    </div>
    <div class="footer-links">
      <a href="${rootPrefix}docs/index.html">Documentation</a>
      <a href="${rootPrefix}docs/phone-mode.html">Phone Mode</a>
      <a href="${rootPrefix}docs/security.html">Security</a>
      <a href="${rootPrefix}docs/changelog.html">Changelog</a>
      <a href="${escapeHtml(REPO_URL)}" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
  </div>
</footer>`;
}

function renderDocument({ title, description, rootPrefix, activeSection, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#08090c">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${rootPrefix}assets/media/og-card.svg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <link rel="icon" type="image/svg+xml" href="${rootPrefix}assets/icon.svg">
  <link rel="stylesheet" href="${rootPrefix}styles.css">
</head>
<body>
${renderHeader(rootPrefix, activeSection)}
${bodyHtml}
${renderFooter(rootPrefix)}
<script src="${rootPrefix}site.js" defer></script>
</body>
</html>
`;
}

// ── Landing Page ───────────────────────────────────────────────────────────

function buildLandingPage() {
  const unixInstall = `curl -fsSL ${RAW_MAIN}/install.sh | sh`;
  const winInstall = `irm ${RAW_MAIN}/install.ps1 | iex`;
  const cargoInstall = `cargo install --git ${REPO_URL} --locked`;

  const tourItems = [
    {
      id: "chat",
      title: "Live Transcript & Work Rail",
      tag: "Streaming",
      desc: "Watch thoughts, file reads, inline diffs, and test runs stream at token granularity. Steer mid-turn, queue a follow-up, or dictate by voice.",
      img: "assets/media/screenshot-chat.png",
      alt: "OMP Pulse chat screen showing expanded work rail, inline pagination reply, context ring, and composer",
    },
    {
      id: "drawer",
      title: "Unified Session Drawer",
      tag: "Navigation",
      desc: "One gesture slides open your computer connection, project folders, Needs-you prompts, pinned sessions, recent chats, and full-transcript search.",
      img: "assets/media/screenshot-drawer.png",
      alt: "Left session drawer showing connected computer status, project folders, Needs you, Pinned, and Recent sessions",
    },
    {
      id: "workspace",
      title: "Workspace beside the Chat",
      tag: "5 Tabs",
      desc: "Inspect uncommitted git diffs, browse and edit files with conflict guards, steer subagents, check todo progress, or run commands in a terminal.",
      img: "assets/media/screenshot-workspace.png",
      alt: "Right workspace drawer open on Changes tab showing syntax-coloured git diff and bottom tab bar",
    },
    {
      id: "ask",
      title: "Answer Blocking Questions Anywhere",
      tag: "Unblock",
      desc: "Push notifications wake your phone when omp calls ask_user or finishes a long turn. Answer structured single- or multi-choice prompts in one tap.",
      img: "assets/media/screenshot-ask.png",
      alt: "Answer sheet presenting structured choices with Recommended badge over an active coding session",
    },
  ];

  const bodyHtml = `<main id="main">
  <!-- Hero -->
  <section class="hero">
    <div class="container hero-grid">
      <div>
        <div class="eyebrow">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span>Open-source mobile companion &amp; Android runtime for omp</span>
        </div>
        <h1>Keep shipping with <span class="accent-word">omp</span> from your phone.</h1>
        <p class="hero-lead">
          Drive live desktop <strong>Oh My Pi</strong> coding sessions over authenticated WebSockets — or run <code>omp</code> and a full Alpine Linux workspace directly on an Android phone, with no computer involved.
        </p>

        <div class="install-box" aria-label="Install OMP Pulse daemon">
          <div class="install-tabs" role="tablist" aria-label="Install platform">
            <button class="install-tab" type="button" role="tab" aria-selected="true" data-install-tab data-prompt="$" data-cmd="${escapeHtml(unixInstall)}">Linux &amp; macOS</button>
            <button class="install-tab" type="button" role="tab" aria-selected="false" data-install-tab data-prompt="PS>" data-cmd="${escapeHtml(winInstall)}">Windows</button>
            <button class="install-tab" type="button" role="tab" aria-selected="false" data-install-tab data-prompt="$" data-cmd="${escapeHtml(cargoInstall)}">From Source</button>
          </div>
          <div class="install-cmd-row">
            <div class="install-cmd">
              <span class="prompt-sigil" data-install-prompt>$</span><code id="hero-install-cmd" data-install-cmd>${escapeHtml(unixInstall)}</code>
            </div>
            <button class="copy-btn" type="button" data-copy-target="#hero-install-cmd">Copy</button>
          </div>
        </div>

        <div class="hero-ctas">
          <a class="btn btn-primary btn-lg" href="${escapeHtml(APK_DIRECT)}">Download Android APK</a>
          <a class="btn btn-secondary btn-lg" href="docs/index.html">Read the Docs</a>
        </div>

        <div class="hero-facts">
          <span>Single Rust binary · Zero OpenSSL</span>
          <span>·</span>
          <span>Installable PWA + Signed arm64 APK</span>
          <span>·</span>
          <span>MIT Licensed</span>
        </div>
      </div>

      <div class="hero-stage">
        <div>
          <div class="phone-device">
            <div class="phone-screen">
              <img src="assets/media/demo.gif" width="380" height="822" alt="Animated demonstration of opening a running omp session from the drawer and watching edits, Vitest output, and the final reply stream live">
            </div>
          </div>
          <div class="stage-caption">Real capture · Live turn streaming over WebSocket</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Two Ways to Run -->
  <section class="section" id="modes">
    <div class="container">
      <div class="section-header">
        <p class="section-kicker">Two ways to run</p>
        <h2 class="section-title">Bridge your workstation, or run entirely on your phone.</h2>
        <p class="section-desc">
          One interface serves both worlds. Pair with your laptop or workstation over Tailscale, or turn an Android phone into a self-contained coding environment.
        </p>
      </div>

      <div class="modes-grid">
        <article class="mode-card">
          <div>
            <span class="mode-badge">Desktop &amp; Server Mode</span>
            <h3>Your computer’s sessions in your pocket</h3>
            <p>
              <code>omp-pulse</code> runs a lightweight Rust daemon alongside your existing <code>omp</code> installation on Linux, macOS, or Windows. Scan a one-use QR code to pair.
            </p>
            <ul class="mode-points">
              <li>Watches every session in <code>~/.local/share/omp/sessions</code> without moving your workflow.</li>
              <li>Enforces strict single-writer ownership so phone and terminal never clobber a JSONL file.</li>
              <li>Works seamlessly behind <code>tailscale serve</code> HTTPS with Web Push notifications and offline outbox queueing.</li>
              <li>Switch models and reasoning effort on live desktop sessions without typing slash commands.</li>
            </ul>
          </div>
          <div>
            <a class="btn btn-secondary" href="docs/configuration.html">Desktop Setup Guide →</a>
          </div>
        </article>

        <article class="mode-card mode-card--phone">
          <div>
            <span class="mode-badge">Android Phone Mode · Standalone</span>
            <h3>Full Linux workspace &amp; omp on Android</h3>
            <p>
              No laptop required. Choose <strong>Run on this phone</strong> in the Android app to provision a SHA-256-pinned Alpine Linux userspace via <code>proot</code> with <code>omp</code> and the Pulse daemon running locally.
            </p>
            <ul class="mode-points">
              <li>Sign in to Anthropic, OpenAI Codex, GitHub Copilot, Gemini, OpenRouter, or DeepSeek right on the phone.</li>
              <li>Clone repositories, run compilers and test suites, and edit code locally on arm64 Android 7.0+.</li>
              <li>Optional <strong>Phone tools for the agent</strong> let <code>omp</code> inspect the screen, launch apps, read the clipboard, and automate Android tasks.</li>
              <li>Switch between on-device mode and any saved computer in two taps.</li>
            </ul>
          </div>
          <div>
            <a class="btn btn-primary" href="docs/phone-mode.html">Explore Phone Mode →</a>
          </div>
        </article>
      </div>
    </div>
  </section>

  <!-- Interactive Product Tour -->
  <section class="section" id="tour">
    <div class="container">
      <div class="section-header">
        <p class="section-kicker">Designed for thumbs, built for real code</p>
        <h2 class="section-title">Every surface tuned for a phone screen.</h2>
        <p class="section-desc">
          Not a shrunken desktop IDE and not a chat toy. Spring-driven drawers, readable inline diffs, durable drafts, and instant session switching.
        </p>
      </div>

      <div class="showcase-layout">
        <div class="showcase-tabs" role="tablist" aria-label="Product surfaces">
          ${tourItems
            .map(
              (item, idx) => `<button
            class="showcase-tab"
            type="button"
            role="tab"
            aria-selected="${idx === 0 ? "true" : "false"}"
            tabindex="${idx === 0 ? "0" : "-1"}"
            data-showcase-tab="${item.id}"
          >
            <div class="showcase-tab-title">
              <span>${escapeHtml(item.title)}</span>
              <span class="showcase-tab-tag">${escapeHtml(item.tag)}</span>
            </div>
            <p class="showcase-tab-desc">${escapeHtml(item.desc)}</p>
          </button>`,
            )
            .join("\n          ")}
        </div>

        <div class="showcase-viewer">
          ${tourItems
            .map(
              (item, idx) => `<div class="showcase-panel" role="tabpanel" data-showcase-panel="${item.id}"${idx === 0 ? "" : " hidden"}>
            <div class="phone-device">
              <div class="phone-screen">
                <img src="${item.img}" width="412" height="892" loading="${idx === 0 ? "eager" : "lazy"}" alt="${escapeHtml(item.alt)}">
              </div>
            </div>
          </div>`,
            )
            .join("\n          ")}
        </div>
      </div>
    </div>
  </section>

  <!-- Android Phone Mode & Agent Tools Deep Dive -->
  <section class="section" id="phone-mode">
    <div class="container android-spotlight">
      <div>
        <p class="section-kicker">Android Native Shell + On-Device Agent</p>
        <h2 class="section-title">An agent that lives on your phone — and can operate it.</h2>
        <p class="section-desc">
          The Capacitor Android APK bundles a static <code>aarch64-musl</code> daemon binary alongside Termux <code>proot</code>, aligned for both 4 KB and Android 15+ 16 KB page kernels.
        </p>

        <div class="tool-chips" aria-label="On-device capabilities">
          <span class="tool-chip">Alpine Linux + git + ripgrep</span>
          <span class="tool-chip">SHA-256 pinned runtime</span>
          <span class="tool-chip">Screen hierarchy &amp; tap/swipe</span>
          <span class="tool-chip">Shared storage &amp; APK install</span>
          <span class="tool-chip">Native notification stream</span>
          <span class="tool-chip">On-device / provider OAuth</span>
        </div>

        <div class="callout-note">
          <strong>Explicit permission gates.</strong> By default, the phone agent works strictly inside its Linux workspace. Enabling <em>Settings › Phone access › Phone tools for the agent</em> exposes the <code>android</code> CLI and <code>phone</code> MCP tool server, gated by Android’s own storage, package-install, and accessibility permissions.
        </div>
      </div>

      <div class="phone-pair">
        <div class="phone-device">
          <div class="phone-screen">
            <img src="assets/media/screenshot-phone-mode.png" width="412" height="892" loading="lazy" alt="Android first-run screen offering Run on this phone or Connect a computer">
          </div>
        </div>
        <div class="phone-device">
          <div class="phone-screen">
            <img src="assets/media/screenshot-phone-tools.png" width="412" height="892" loading="lazy" alt="Settings Phone access screen showing Phone tools for the agent switch and Android permissions">
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Architecture & Reliability -->
  <section class="section" id="architecture">
    <div class="container">
      <div class="section-header">
        <p class="section-kicker">Engineering &amp; Safety</p>
        <h2 class="section-title">Four live producers, one bounded fan-out hub.</h2>
        <p class="section-desc">
          <code>omp</code> rewrites session files wholesale from memory, so two simultaneous writers would corrupt history. OMP Pulse arbitrates ownership before a single byte is written.
        </p>
      </div>

      <div class="arch-diagram" aria-label="Architecture data flow">
<pre><code>phone ──HTTPS / WSS──▶ server/http.rs ──▶ server/ws.rs (bounded hub) ──▶ phone
                             │                 ▲   ▲   ▲   ▲
                             │                 │   │   │   └── omp/collab.rs   (desktop /collab relay, token stream)
                             │                 │   │   └────── omp/bridge.rs   (desktop extension, token stream)
                             │                 │   └────────── omp/child.rs    (daemon rpc-ui pool, token stream)
                             └────────────────▶│               sessions/watcher.rs (JSONL file tail, zero-idle read)</code></pre>
      </div>

      <div class="arch-grid">
        <div class="arch-card">
          <div class="arch-card-kicker">01 · Ownership Guard</div>
          <h3>Single-writer guarantee</h3>
          <p>Detects live terminal owners via process descriptors, bridge sockets, and terminal multiplexers. Refuses unsafe writes and guides you to <code>/collab</code> instead of guessing.</p>
        </div>
        <div class="arch-card">
          <div class="arch-card-kicker">02 · Bounded Memory &amp; I/O</div>
          <h3>Zero idle parse, capped queues</h3>
          <p>The file watcher sleeps when no client listens. Each WebSocket client is bounded by frame count and byte budget; slow links resync cleanly via sequence-keyed deltas.</p>
        </div>
        <div class="arch-card">
          <div class="arch-card-kicker">03 · Pure-Rust Crypto</div>
          <h3>Device-scoped credentials</h3>
          <p>Five-minute single-use pairing codes mint revocable per-device tokens stored as SHA-256 digests. RFC 8291 Web Push encryption runs in pure Rust with zero OpenSSL dependency.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Downloads -->
  <section class="section" id="downloads">
    <div class="container">
      <div class="section-header">
        <p class="section-kicker">Get Started</p>
        <h2 class="section-title">Download OMP Pulse v${escapeHtml(VERSION)}</h2>
        <p class="section-desc">
          Every release publishes SHA-256 checksums, static Linux musl archives, macOS and Windows binaries, and a signed Android arm64 APK.
        </p>
      </div>

      <div class="downloads-grid">
        <div class="download-card">
          <div class="download-card-head">
            <div>
              <h3>Android App (Phone Mode + Remote)</h3>
              <div class="download-meta">arm64-v8a · Android 7.0+ · 4 KB &amp; 16 KB page aligned</div>
            </div>
          </div>
          <p style="margin:0;color:var(--fg-muted);font-size:0.9rem">
            Signed APK with embedded web client, native background notification stream, and standalone Alpine + <code>omp</code> runtime. Track updates automatically with Obtainium.
          </p>
          <div class="download-links">
            <a class="asset-pill" href="${escapeHtml(APK_DIRECT)}">omp-pulse.apk ↓</a>
            <a class="asset-pill" href="${escapeHtml(RELEASES_LATEST)}" target="_blank" rel="noopener noreferrer">SHA256SUMS ↗</a>
          </div>
        </div>

        <div class="download-card">
          <div class="download-card-head">
            <div>
              <h3>Linux Daemon</h3>
              <div class="download-meta">Static musl · Zero runtime dependencies · systemd user service</div>
            </div>
          </div>
          <p style="margin:0;color:var(--fg-muted);font-size:0.9rem">
            Single self-contained binary with embedded PWA. Runs on any glibc or musl distribution.
          </p>
          <div class="download-links">
            <a class="asset-pill" href="${escapeHtml(RELEASES_LATEST)}/download/omp-pulse-${escapeHtml(VERSION)}-x86_64-unknown-linux-musl.tar.gz">x86_64 musl (.tar.gz) ↓</a>
            <a class="asset-pill" href="${escapeHtml(RELEASES_LATEST)}/download/omp-pulse-${escapeHtml(VERSION)}-aarch64-unknown-linux-musl.tar.gz">aarch64 musl (.tar.gz) ↓</a>
          </div>
        </div>

        <div class="download-card">
          <div class="download-card-head">
            <div>
              <h3>macOS Daemon</h3>
              <div class="download-meta">Apple Silicon &amp; Intel · launchd background agent</div>
            </div>
          </div>
          <p style="margin:0;color:var(--fg-muted);font-size:0.9rem">
            Install via <code>install.sh</code>, run <code>omp-pulse setup</code>, and expose over <code>tailscale serve</code>.
          </p>
          <div class="download-links">
            <a class="asset-pill" href="${escapeHtml(RELEASES_LATEST)}/download/omp-pulse-${escapeHtml(VERSION)}-aarch64-apple-darwin.tar.gz">Apple Silicon (.tar.gz) ↓</a>
            <a class="asset-pill" href="${escapeHtml(RELEASES_LATEST)}/download/omp-pulse-${escapeHtml(VERSION)}-x86_64-apple-darwin.tar.gz">Intel x86_64 (.tar.gz) ↓</a>
          </div>
        </div>

        <div class="download-card">
          <div class="download-card-head">
            <div>
              <h3>Windows Daemon</h3>
              <div class="download-meta">Windows 10 / 11 x86_64 · Task Scheduler service</div>
            </div>
          </div>
          <p style="margin:0;color:var(--fg-muted);font-size:0.9rem">
            Native MSVC executable importing only system DLLs. Install via <code>install.ps1</code> or standalone zip.
          </p>
          <div class="download-links">
            <a class="asset-pill" href="${escapeHtml(RELEASES_LATEST)}/download/omp-pulse-${escapeHtml(VERSION)}-x86_64-pc-windows-msvc.zip">Windows x64 (.zip) ↓</a>
            <a class="asset-pill" href="docs/windows.html">Windows Guide →</a>
          </div>
        </div>
      </div>
    </div>
  </section>
</main>`;

  return renderDocument({
    title: "OMP Pulse — Mobile Interface & On-Device Android Runtime for omp",
    description:
      "Keep working with Oh My Pi (omp) from your phone. Single-binary Rust daemon and PWA for desktop sessions, plus a standalone Android Linux runtime.",
    rootPrefix: "",
    activeSection: "home",
    bodyHtml,
  });
}

// ── Documentation Pages ────────────────────────────────────────────────────

function buildDocPage(pageIndex) {
  const page = DOC_PAGES[pageIndex];
  const rootPrefix = "../";
  const markdown = readFileSync(join(ROOT, page.source), "utf8");
  const articleHtml = renderMarkdown(markdown, page.source, page.slug);

  const groups = new Map();
  for (const entry of DOC_PAGES) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }

  const sidebarHtml = Array.from(groups.entries())
    .map(
      ([group, items]) => `<div class="docs-nav-group">
        <h2 class="docs-nav-heading">${escapeHtml(group)}</h2>
        <ul class="docs-nav-list">
          ${items
            .map((item) => {
              const href = posix.relative(posix.dirname(page.slug), item.slug);
              const current = item.slug === page.slug ? ' aria-current="page"' : "";
              return `<li class="docs-nav-item"><a href="${href}"${current}>${escapeHtml(item.shortTitle)}</a></li>`;
            })
            .join("\n          ")}
        </ul>
      </div>`,
    )
    .join("\n      ");

  const mobilePickerHtml = `<div class="docs-mobile-picker">
    <label class="sr-only" for="docs-page-select" style="position:absolute;left:-9999px">Documentation section</label>
    <select id="docs-page-select" data-docs-select aria-label="Jump to documentation page">
      ${DOC_PAGES.map((item) => {
        const href = posix.relative(posix.dirname(page.slug), item.slug);
        const selected = item.slug === page.slug ? " selected" : "";
        return `<option value="${href}"${selected}>${escapeHtml(item.group)} — ${escapeHtml(item.shortTitle)}</option>`;
      }).join("\n      ")}
    </select>
  </div>`;

  const prev = pageIndex > 0 ? DOC_PAGES[pageIndex - 1] : null;
  const next = pageIndex < DOC_PAGES.length - 1 ? DOC_PAGES[pageIndex + 1] : null;
  const pagerHtml = `<nav class="docs-pager" aria-label="Documentation pagination">
    ${
      prev
        ? `<a class="pager-link" href="${posix.relative(posix.dirname(page.slug), prev.slug)}">
            <span class="pager-label">← Previous</span>
            <span class="pager-title">${escapeHtml(prev.shortTitle)}</span>
          </a>`
        : "<span></span>"
    }
    ${
      next
        ? `<a class="pager-link" style="text-align:right;margin-left:auto" href="${posix.relative(posix.dirname(page.slug), next.slug)}">
            <span class="pager-label">Next →</span>
            <span class="pager-title">${escapeHtml(next.shortTitle)}</span>
          </a>`
        : ""
    }
  </nav>`;

  const bodyHtml = `<div class="container docs-shell">
    <aside class="docs-sidebar" aria-label="Documentation navigation">
      ${sidebarHtml}
    </aside>
    <main id="main" class="docs-article">
      ${mobilePickerHtml}
      <div class="docs-breadcrumbs">
        <a href="../index.html">OMP Pulse</a>
        <span>/</span>
        <span>${escapeHtml(page.group)}</span>
        <span>/</span>
        <span style="color:var(--fg)">${escapeHtml(page.shortTitle)}</span>
      </div>
      <article class="prose">
        ${articleHtml}
      </article>
      ${pagerHtml}
    </main>
  </div>`;

  return renderDocument({
    title: `${page.title} — OMP Pulse Docs`,
    description: page.description,
    rootPrefix,
    activeSection: "docs",
    bodyHtml,
  });
}

// ── Social OpenGraph Card (SVG) ────────────────────────────────────────────

function buildOgCardSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="OMP Pulse — Keep working with omp from your phone">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0d13"/>
      <stop offset="1" stop-color="#121521"/>
    </linearGradient>
    <radialGradient id="glow" cx="78%" cy="22%" r="60%">
      <stop offset="0" stop-color="#8f76ff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#8f76ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="pulse" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#b19fff"/>
      <stop offset="1" stop-color="#755be8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="36" y="36" width="1128" height="558" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>

  <g transform="translate(88, 92)">
    <rect width="76" height="76" rx="18" fill="#181b26" stroke="#ffffff" stroke-opacity="0.12"/>
    <path d="M14 40 H26 L31 28 L38 49 L44 36 L48 40 H62" fill="none" stroke="url(#pulse)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="62" cy="40" r="3.5" fill="#b19fff"/>
  </g>

  <text x="88" y="256" fill="#f3f4f8" font-family="ui-sans-serif, -apple-system, Inter, sans-serif" font-size="64" font-weight="700" letter-spacing="-2">OMP Pulse</text>
  <text x="88" y="324" fill="#b19fff" font-family="ui-sans-serif, -apple-system, Inter, sans-serif" font-size="34" font-weight="500" letter-spacing="-0.6">Keep working with omp from your phone.</text>
  <text x="88" y="392" fill="#9aa2b2" font-family="ui-sans-serif, -apple-system, Inter, sans-serif" font-size="24">Single-binary Rust daemon + PWA for desktop sessions,</text>
  <text x="88" y="428" fill="#9aa2b2" font-family="ui-sans-serif, -apple-system, Inter, sans-serif" font-size="24">or run omp natively on Android with an Alpine Linux workspace.</text>

  <text x="88" y="524" fill="#666f82" font-family="ui-monospace, Menlo, monospace" font-size="20">MIT Licensed · Zero OpenSSL · github.com/${escapeHtml(REPO_SLUG)}</text>
</svg>
`;
}

// ── Build Entrypoint ───────────────────────────────────────────────────────

export function buildSite(outDir = DIST) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "docs"), { recursive: true });
  mkdirSync(join(outDir, "assets/media"), { recursive: true });
  mkdirSync(join(outDir, "assets/fonts"), { recursive: true });

  // Styles, progressive JS, and GitHub Pages .nojekyll marker
  copyFileSync(join(HERE, "styles.css"), join(outDir, "styles.css"));
  copyFileSync(join(HERE, "site.js"), join(outDir, "site.js"));
  copyFileSync(join(ROOT, "web/public/icon.svg"), join(outDir, "assets/icon.svg"));
  writeFileSync(join(outDir, ".nojekyll"), "");

  // Geist Mono Latin variable font from web workspace
  const fontSrc = join(ROOT, "web/node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2");
  if (existsSync(fontSrc)) {
    copyFileSync(fontSrc, join(outDir, "assets/fonts/geist-mono-latin.woff2"));
  }

  // Authentic captured product screenshots & demo GIF
  const mediaFiles = [
    "demo.gif",
    "screenshot-chat.png",
    "screenshot-drawer.png",
    "screenshot-workspace.png",
    "screenshot-ask.png",
    "screenshot-phone-mode.png",
    "screenshot-phone-tools.png",
  ];
  for (const name of mediaFiles) {
    const src = join(ROOT, "docs/media", name);
    if (!existsSync(src)) {
      throw new Error(`Missing required media asset: ${relative(ROOT, src)} (run scripts/docs/capture-readme-media.mjs)`);
    }
    copyFileSync(src, join(outDir, "assets/media", name));
  }
  writeFileSync(join(outDir, "assets/media/og-card.svg"), buildOgCardSvg());

  // Landing page + 404 fallback
  writeFileSync(join(outDir, "index.html"), buildLandingPage());
  writeFileSync(
    join(outDir, "404.html"),
    renderDocument({
      title: "Page Not Found — OMP Pulse",
      description: "Page not found.",
      rootPrefix: "",
      activeSection: "",
      bodyHtml: `<main id="main" class="container" style="padding:120px 24px;text-align:center">
        <p class="section-kicker">404</p>
        <h1 class="section-title">Page not found</h1>
        <p class="section-desc" style="margin:0 auto 28px;max-width:46ch">The page you requested does not exist or moved into the documentation hub.</p>
        <div style="display:inline-flex;gap:12px">
          <a class="btn btn-primary" href="index.html">Back to Home</a>
          <a class="btn btn-secondary" href="docs/index.html">Browse Docs</a>
        </div>
      </main>`,
    }),
  );

  // Documentation pages
  DOC_PAGES.forEach((_, idx) => {
    const html = buildDocPage(idx);
    writeFileSync(join(outDir, DOC_PAGES[idx].slug), html);
  });

  return { outDir, pages: ["index.html", "404.html", ...DOC_PAGES.map((p) => p.slug)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildSite();
  console.log(`Built OMP Pulse website (${result.pages.length} pages) -> ${relative(ROOT, result.outDir)}`);
}
