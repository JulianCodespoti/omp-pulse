import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-composer-surface-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { AttachmentStrip } from ${JSON.stringify(resolve(root, "web/src/app/composer/AttachmentStrip.tsx"))};
  export const render = images => renderToStaticMarkup(createElement(AttachmentStrip, {images,onRemove(){}}));
`;
const build = await rolldown({ input: "composer-surface-test", platform: "node",
  transform: { jsx: { runtime: "automatic" } },
  plugins: [{ name: "fixture", resolveId: id => id === "composer-surface-test" ? "\0fixture" : null,
    load: id => id === "\0fixture" ? source : null }],
});
try { await build.write({ file: resolve(directory, "fixture.mjs"), format: "esm" }); }
finally { await build.close(); }
const { render } = await import(pathToFileURL(resolve(directory, "fixture.mjs")).href);
const image = name => ({ name, previewUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', data: 'AA==', width: 1, height: 1 });

test('empty attachment strips do not reserve a row', () => {
  assert.equal(render([]), '');
});

test('tiles carry no filename caption; the name stays in alt text and the remove label', () => {
  const html = render([image('screenshot.png')]);
  assert.equal(html.includes('data-testid="attachment-name"'), false);
  assert.match(html, /alt="screenshot.png"/);
  assert.match(html, /aria-label="Remove screenshot.png"/);
});

test('56px tiles keep a 44px remove target inside the tile corner with a 24px badge', () => {
  const html = render([image('image.png')]);
  assert.ok(html.includes('size-14 rounded-md'));
  assert.ok(/data-testid="attachment-remove"/.test(html) && html.includes('absolute right-0 top-0 flex size-11'));
  assert.ok(html.includes('size-6 place-items-center rounded-full'));
});

test('special filenames are safely escaped', () => {
  const html = render([image('very-long-diagram & screenshot <final>.png')]);
  assert.ok(html.includes('very-long-diagram &amp; screenshot &lt;final&gt;.png'));
  assert.equal(html.includes('<final>'), false);
});

test('multiple images retain individual controls and the near-limit count', () => {
  const html = render(Array.from({ length: 6 }, (_, i) => image(`image-${i}.png`)));
  assert.equal((html.match(/data-testid="attachment-remove"/g) ?? []).length, 6);
  assert.ok(html.includes('6/8'));
});
