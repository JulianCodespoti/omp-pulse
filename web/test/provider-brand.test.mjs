import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// The real mapping module, bundled once; no DOM, network or daemon involved.
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-provider-brand-"));
after(() => rm(directory, { recursive: true, force: true }));
const bundle = await rolldown({
  input: resolve(root, "web/src/app/ui/ProviderLogo.tsx"), platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { jsx: { runtime: "automatic" }, define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "import.meta.env": JSON.stringify({ BASE_URL: "./" }),
  } },
});
const bundlePath = resolve(directory, "provider-logo.mjs");
try { await bundle.write({ file: bundlePath, format: "esm" }); }
finally { await bundle.close(); }
const { providerBrand } = await import(pathToFileURL(bundlePath).href);
const hasIcon = (id) => existsSync(resolve(root, "web/public/providers", `${id}.svg`));

test("observed model ids map to their maker", () => {
  const cases = [
    ["claude-opus-5-5", undefined, "anthropic", "Anthropic"],
    ["anthropic/claude-sonnet-5-5", undefined, "anthropic", "Anthropic"],
    ["gpt-6-astra", undefined, "openai", "OpenAI"],
    ["openai-codex/gpt-6-astra", undefined, "openai", "OpenAI"],
    ["gpt-5.6-luna", "openai-codex", "openai", "OpenAI"],
    ["deepseek-v4.1-flash", undefined, "deepseek", "DeepSeek"],
    ["opencode-go/deepseek-v4.1-flash", undefined, "deepseek", "DeepSeek"],
    ["kimi-k2.7-code", "opencode-go", "moonshot", "Moonshot"],
    ["claude-haiku-4-5-20251001", "amazon-bedrock", "anthropic", "Anthropic"],
    ["anthropic.claude-3-5-haiku-20241022-v1:0", "amazon-bedrock", "anthropic", "Anthropic"],
    ["claude-fable-5-1@default", "google-vertex", "anthropic", "Anthropic"],
    ["glm-5.1", "zai", "zai", "Z.ai"],
    ["grok-2", undefined, "xai", "xAI"],
    ["mimo-v2.5", undefined, "xiaomi", "Xiaomi"],
    ["MiniMax-M2.5", undefined, "minimax", "MiniMax"],
    ["gemini-1.5-flash", undefined, "google", "Google"],
    ["gpt-oss-120b", "groq", "openai", "OpenAI"],
    ["meta-llama/Llama-3.3-70B", "together", "meta", "Meta"],
  ];
  for (const [model, provider, id, label] of cases) {
    assert.deepEqual(providerBrand(model, provider), { id, label }, `${provider ?? ""} ${model}`);
  }
});

test("unknown models fall back to the host, then to the generic mark", () => {
  assert.equal(providerBrand("some-unknown-model", "groq").id, "groq");
  assert.equal(providerBrand("coder-model", "qwen-portal").id, "qwen");
  assert.equal(providerBrand("mystery", "ollama-cloud:work").id, "ollama");
  assert.equal(providerBrand("mystery", "factory-droid").id, "generic");
  assert.equal(providerBrand("mystery-model", "my-proxy").id, "generic");
  assert.equal(providerBrand().id, "generic");
});

test("every reachable brand has an icon file", () => {
  const models = ["claude", "gpt-5", "o3-mini", "codex-mini", "chatgpt-4o", "daybreak", "gemma-3", "deep-research",
    "deepseek-r1", "kimi-k2", "glm-4", "grok-4", "mimo", "minimax-m1", "qwq-32b", "qwen3", "codestral", "devstral",
    "llama-3.1-nemotron-70b", "llama-4", "command-r", "phi-4", "granite-3", "sonar-pro", "wan-2.1", "jamba-1.5",
    "ernie-4", "doubao-pro", "seed-oss", "hunyuan-t1", "step-3", "ling-1t", "ring-1t"];
  const providers = ["groq", "cerebras", "together", "huggingface", "nvidia", "ollama", "ollama-cloud", "azure",
    "amazon-bedrock", "google-vertex", "github-copilot", "openrouter", "venice", "zenmux", "kilo", "nanogpt",
    "cloudflare-ai-gateway", "opencode-go", "factory-droid", "charm-hyper", "alibaba-coding-plan", "qwen-portal",
    "xiaomi", "minimax-cn", "moonshot", "zai", "deepseek", "xai", "mistral", "anthropic", "openai", "openai-codex",
    "google", "commandcode"];
  const brands = [...models.map((m) => providerBrand(m)), ...providers.map((p) => providerBrand("unknown", p))];
  for (const { id, label } of brands) {
    assert.ok(hasIcon(id), `missing web/public/providers/${id}.svg`);
    assert.ok(label.length > 0);
  }
  assert.equal(models.filter((m) => providerBrand(m).id === "generic").length, 0);
  assert.ok(hasIcon("generic"));
});
