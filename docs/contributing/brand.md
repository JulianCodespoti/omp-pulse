# Brand

The product is **OMP Pulse**, and its colour is violet. This page is the rules
for the name, the colours, the type and the icon, and the steps for changing
any of them. The values live in one file, [brand/tokens.json](../../brand/tokens.json);
JSON has no comments, so what each token is *for* is written here.

## The name

- **OMP Pulse** in prose, headings, the website, the app's UI and store text.
- **Pulse** as the short form once the full name has appeared in the same
  passage ("Pulse joins the session once the terminal shares it").
- `omp-pulse` only where it is a literal: the command, the binary, the package
  and file names (`omp-pulse pair`, `omp-pulse.apk`). Never in running text.
- The product is a companion for omp (Oh My Pi), not part of it. Say
  "omp" for the agent and "OMP Pulse" for this app.

The tokens file carries the name as `name`; the website's header, footer and
`og:site_name` and the social card read it from there.

## Colour roles

| Token | Value | Role |
|---|---|---|
| `violet.300` | `#b19fff` | Accent text and links on dark ground; the social card tagline |
| `violet.400` | `#9d86ff` | The icon's gradient start and end dot, Android `colorPrimary`/`colorAccent`, the widget accent. The default "brand violet" |
| `violet.500` | `#9179ff` | The website's accent: buttons, focus rings, tinted fills and glows |
| `violet.600` | `#7c65ec` | Pinned places that want a deeper violet: the README release badge |
| `violet.700` | `#6e56e7` | The icon gradient's far end |
| `ink.950` | `#08090c` | The page background, the `theme-color` meta, the social card ground |
| `ink.900` | `#0e1015` | One step up from the page: the website's elevated bands |
| `ink.plate` | `#1b1b22` | The Android launcher icon's background plate |
| `text.default` | `#f3f4f8` | Body text on ink |
| `text.muted` | `#9aa2b2` | Secondary text |
| `text.subtle` | `#666f82` | Captions and footers; decorative-weight text only |
| `status.success` | `#34d399` | Live, connected, done |
| `status.warning` | `#f59e0b` | Needs attention |
| `status.danger` | `#f87171` | Errors and destructive actions |

`radius` (8, 14, 20, 28 px) is the website's corner scale, small to extra
large. `font.sans` and `font.mono` are the font stacks, each in order of
preference with fallbacks.

Contrast, measured against `ink.950`:

- `violet.400` text on ink: **6.9:1**, and `violet.300` **8.8:1**, both comfortably above
  the 4.5:1 AA bar for body text. On the Android widget's lighter surface (`#1b1d23`)
  `violet.400` text still holds **5.9:1**.
- Dark text (ink) on a `violet.400` fill: **6.9:1**, so a violet button takes dark
  text, not white. White on the same fill is only **2.9:1**.
- `text.subtle` is **3.9:1**, below 4.5:1 for small text. Use it for captions, never for
  anything a reader must read to proceed.

### The in-app accent is a separate, tuned colour

The web client does not use `violet.400`. Its violet accent,
`html[data-accent="violet"]` in [web/src/styles.css](../../web/src/styles.css), is
defined in OKLCH and tuned for contrast on every surface the app has (page and
the three surface steps, including the Dim and Grey themes): a fill that carries
white text at 4.5:1, and a text violet that holds 4.5:1 on all of them. The brand
violet is lighter and fails the first of those. So the app's violet is a
*derivative* of the brand hue (around 300 degrees), not a copy of the token.

That file is therefore not synced from `brand/tokens.json`. If you change the
brand hue substantially, retune that block by hand against its contrast notes and
run the web checks; do not paste a token into it.

## Type

Two typefaces, both Geist, both from `@fontsource-variable` in `web/node_modules`
so no font is fetched from a third party:

- **Geist** (sans) for text on the website and the social card. The web client keeps
  the system sans for body text, so the app reads as native on each phone.
- **Geist Mono** for telemetry, code, commands and small labels, on the website, the
  social card and in the web client.

The website copies the Latin variable files into its build and fails the build if
either is missing (`npm ci` in `web/` fixes that). The stacks in the tokens fall
back to the platform's UI fonts for the few glyphs the Latin subset lacks, such as
the right arrow.

## The icon and what is derived from it

[web/public/icon.svg](../../web/public/icon.svg) is the master: a pulse line traced
through a dark rounded plate, in a violet gradient with a glow. Everything else is
a rendering of it:

- **Synced by the script:** the gradient stops and the end dot in the SVG itself
  (`violet.400` to `violet.700`).
- **Android launcher:** `ic_launcher_background` is `ink.plate`; the foreground
  (`@mipmap/ic_launcher_foreground`) is a raster export of the pulse and dot.
  `ic_launcher_monochrome.xml` is the same line and dot as one silhouette for
  themed icons.
- **Notification glyph:** `ic_stat_omp.xml`, the same silhouette in white, because
  Android masks status-bar icons by alpha only.
- **PNG icons:** `web/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`
  and `badge-96.png`, served by the web client and, for `icon-192.png`, the website's
  favicon and Apple touch icon.
- **Social card:** `docs/media/social-card.png`, rendered from the tokens and the
  icon by `scripts/docs/render-brand-images.mjs`, which also renders the README's
  three-phone hero, `docs/media/readme-hero.webp`.

The raster exports (the PNG icons and the launcher foreground mipmaps) have no
generator: if the icon's artwork or violet changes, re-export them from the SVG
by hand.

## Changing a token

1. Edit `brand/tokens.json`.
2. Run `node scripts/brand/sync-tokens.mjs`. It writes
   `mobile/android/app/src/main/res/values/brand_colors.xml` (generated; never edit
   it), keeps `styles.xml`, `widget_colors.xml` and `ic_launcher_background.xml`
   pointing at it, and updates the README release badge colour and the icon
   gradient. `--check` does the same comparison without writing and is a step in the
   gate ("brand tokens in sync"), so a hand edit to any of those files fails CI.
3. The website needs nothing more: `website/build.mjs` reads the tokens at build time
   and emits them as `--brand-*` custom properties ahead of `website/styles.css`,
   which aliases them to its own short names (`--bg`, `--accent`, ...).
4. Re-render the social card, since a PNG cannot read the tokens:
   `node scripts/docs/render-brand-images.mjs` (see [UI review](ui-review.md) for the
   browser it needs).
5. If the change touches the icon's artwork or the in-app accent, do the manual steps
   above.

The values in `values-v31/` widget resources are the system wallpaper palette, not
brand colours, and stay as they are.
