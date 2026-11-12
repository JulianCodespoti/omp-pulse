import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { LinkedText } from ${JSON.stringify(resolve(root, "web/src/app/ui/LinkedText.tsx"))};
  window.fixture = { render: (text) => act(async () => createRoot(document.getElementById("root")).render(h("p", null, h(LinkedText, { text })))) };
`);

async function links(t, text) {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  await dom.window.fixture.render(text);
  const p = dom.window.document.querySelector("p");
  return {
    text: p.textContent,
    links: Array.from(p.querySelectorAll("a"), (a) => `${a.getAttribute("href")}|${a.getAttribute("target") ?? "in-app"}`),
  };
}

test("a link on the app's own address opens in the app; others open in the browser", async (t) => {
  const r = await links(t, "Preview: http://synthetic.invalid/preview/dev-preview/ or see https://example.com/doc.");
  assert.equal(r.text, "Preview: http://synthetic.invalid/preview/dev-preview/ or see https://example.com/doc.", "text is unchanged");
  assert.deepEqual(r.links, ["http://synthetic.invalid/preview/dev-preview/|in-app", "https://example.com/doc|_blank"]);
});

test("a review link opens the review screen in place, whatever host it names, and never navigates", async (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  await dom.window.fixture.render("Review https://phone-host.example/app/#dev=live-turn&turn=a%401 please");
  const opened = [];
  dom.window.addEventListener("omp:open-review", (event) => opened.push(event.detail));
  const link = dom.window.document.querySelector("a");
  assert.equal(`${link.getAttribute("href")}|${link.getAttribute("target") ?? "in-app"}`, "#dev=live-turn&turn=a%401|in-app");
  assert.equal(link.textContent, "Open review", "a button, not the encoded address");
  link.click();
  assert.deepEqual(opened, ["#dev=live-turn&turn=a%401"]);
  assert.equal(dom.window.location.hash, "", "no history entry: a fragment change is read as Back");
});

test("credentials and non-http schemes never become links", async (t) => {
  const r = await links(t, "no https://user:pw@example.com/x javascript:alert(1) file:///etc/passwd");
  assert.deepEqual(r.links, []);
});
