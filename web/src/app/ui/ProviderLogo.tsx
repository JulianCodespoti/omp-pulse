import type { JSX } from "react";

import { cn } from "@/lib/utils";

// Monochrome maker logos from @lobehub/icons-static-svg (Xiaomi from
// simple-icons: lobehub only has the MiMo wordmark, unreadable at 14px), stored
// as web/public/providers/<id>.svg and painted through a CSS mask so they take
// the surrounding text colour. `id` is always a file stem in that directory.
export type ProviderBrand = { id: string; label: string };

type Rule = readonly [RegExp, string, string];

// The model's maker wins over the host serving it: claude on Bedrock is
// still Anthropic. Matched against the normalised bare model id.
const MODEL_RULES: readonly Rule[] = [
  [/^claude/, "anthropic", "Anthropic"],
  [/^(?:gpt|chatgpt|codex|daybreak)|^o[134](?:$|[-.])/, "openai", "OpenAI"],
  [/^(?:gemini|gemma|deep-research)/, "google", "Google"],
  [/^deepseek/, "deepseek", "DeepSeek"],
  [/^(?:kimi|moonshot)/, "moonshot", "Moonshot"],
  [/^(?:glm|chatglm)/, "zai", "Z.ai"],
  [/^grok/, "xai", "xAI"],
  [/^mimo/, "xiaomi", "Xiaomi"],
  [/^(?:minimax|abab)/, "minimax", "MiniMax"],
  [/^(?:qwen|qwq|qvq)/, "qwen", "Qwen"],
  [/^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral)/, "mistral", "Mistral"],
  // Before meta: nvidia ships Llama fine-tunes named `llama-*-nemotron-*`.
  [/nemotron/, "nvidia", "NVIDIA"],
  [/^llama/, "meta", "Meta"],
  [/^(?:command|c4ai|aya)/, "cohere", "Cohere"],
  [/^phi/, "microsoft", "Microsoft"],
  [/^granite/, "ibm", "IBM"],
  [/^sonar/, "perplexity", "Perplexity"],
  [/^wan/, "alibaba", "Alibaba"],
  [/^jamba/, "ai21", "AI21"],
  [/^ernie/, "baidu", "Baidu"],
  [/^(?:doubao|seed)/, "bytedance", "ByteDance"],
  [/^hunyuan/, "tencent", "Tencent"],
  [/^step/, "stepfun", "StepFun"],
  [/^(?:ling|ring)(?:$|-)/, "antgroup", "Ant Group"],
];

// Host fallback when the model is unknown, matched against the provider id.
const PROVIDER_RULES: readonly Rule[] = [
  [/^groq/, "groq", "Groq"],
  [/^cerebras/, "cerebras", "Cerebras"],
  [/^together/, "together", "Together AI"],
  [/^huggingface/, "huggingface", "Hugging Face"],
  [/^nvidia/, "nvidia", "NVIDIA"],
  [/^ollama/, "ollama", "Ollama"],
  [/^azure/, "azure", "Azure"],
  [/^(?:amazon-bedrock|bedrock|aws)/, "aws", "AWS"],
  [/^github-copilot/, "githubcopilot", "GitHub Copilot"],
  [/^openrouter/, "openrouter", "OpenRouter"],
  [/^venice/, "venice", "Venice"],
  [/^zenmux/, "zenmux", "ZenMux"],
  [/^kilo/, "kilocode", "Kilo"],
  [/^nanogpt/, "generic", "NanoGPT"],
  [/^cloudflare/, "cloudflare", "Cloudflare"],
  [/^opencode/, "opencode", "OpenCode"],
  [/^factory/, "generic", "Factory"],
  [/^charm/, "generic", "Charm"],
  [/^(?:alibaba|dashscope)/, "alibaba", "Alibaba"],
  [/^qwen/, "qwen", "Qwen"],
  [/^xiaomi/, "xiaomi", "Xiaomi"],
  [/^minimax/, "minimax", "MiniMax"],
  [/^(?:moonshot|kimi)/, "moonshot", "Moonshot"],
  [/^(?:zai|zhipu)/, "zai", "Z.ai"],
  [/^deepseek/, "deepseek", "DeepSeek"],
  [/^xai/, "xai", "xAI"],
  [/^mistral/, "mistral", "Mistral"],
  [/^anthropic/, "anthropic", "Anthropic"],
  [/^openai/, "openai", "OpenAI"],
  [/^google/, "google", "Google"],
  [/^commandcode/, "commandcode", "Command Code"],
];

// Bedrock-style vendor prefixes, optionally region-scoped: `us.anthropic.claude-…`.
const VENDOR_PREFIX = /^(?:[a-z]{2}\.)?(?:anthropic|meta|amazon|mistral|cohere|ai21|deepseek|qwen|openai|google|writer)\./;

const match = (rules: readonly Rule[], value: string): ProviderBrand | undefined => {
  for (const [pattern, id, label] of rules) if (pattern.test(value)) return { id, label };
  return undefined;
};

export function providerBrand(model?: string, provider?: string): ProviderBrand {
  const raw = (model ?? "").trim().toLowerCase().replace(/~/g, "");
  const slash = raw.lastIndexOf("/");
  const name = raw.slice(slash + 1).replace(/@.*$/, "").replace(VENDOR_PREFIX, "");
  const fromModel = name ? match(MODEL_RULES, name) : undefined;
  if (fromModel) return fromModel;
  const host = (provider?.trim().toLowerCase() || (slash > 0 ? raw.slice(0, slash) : "")).split(":")[0];
  return (host && match(PROVIDER_RULES, host)) || { id: "generic", label: provider?.trim() || "Model" };
}

export function ProviderLogo({ model, provider, className }: { model?: string; provider?: string; className?: string }): JSX.Element {
  const { id } = providerBrand(model, provider);
  const mask = `url("${import.meta.env.BASE_URL}providers/${id}.svg")`;
  return (
    <span
      aria-hidden
      data-provider={id}
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={{
        maskImage: mask, WebkitMaskImage: mask,
        maskSize: "contain", WebkitMaskSize: "contain",
        maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat",
        maskPosition: "center", WebkitMaskPosition: "center",
      }}
    />
  );
}

const AVATAR_SIZE = {
  sm: "size-5 rounded-sm [&>span]:size-3",
  md: "size-7 rounded-md [&>span]:size-4",
} as const;

/**
 * The maker's logo on a quiet tile: the identity anchor for an assistant turn
 * and a session row. Neutral surface, muted glyph: brand colour would turn a
 * list of twenty rows into confetti, and violet stays reserved for selection.
 */
export function ModelAvatar({ model, provider, size = "md", className }: { model?: string; provider?: string; size?: keyof typeof AVATAR_SIZE; className?: string }): JSX.Element {
  return (
    <span aria-hidden data-slot="model-avatar" className={cn("inline-flex shrink-0 items-center justify-center bg-surface-2 text-muted-foreground", AVATAR_SIZE[size], className)}>
      <ProviderLogo model={model} provider={provider} />
    </span>
  );
}
