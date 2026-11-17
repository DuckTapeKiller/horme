import type { AiProvider } from "../types";

/**
 * llama-server's refusal when a request does not fit the context window, as
 * llama.cpp, LM Studio's llama.cpp engine and Ollama (which runs llama-server)
 * all pass it on: "request (9462 tokens) exceeds the available context size
 * (4096 tokens), try increasing it".
 */
const OVERFLOW = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i;

/** Where each provider's context window is set. */
const WHERE: Partial<Record<AiProvider, string>> = {
  ollama: "Raise Context window on Ollama's page in Horme's Models settings",
  llamacpp: "Start llama-server with a larger --ctx-size (ctx-size in a preset)",
  lmstudio: "Load the model in LM Studio with a larger context length",
  custom: "Give the model a larger context window on the server",
};

/**
 * Turns a context-window refusal into what to do about it, or null for any
 * other error. A chat with Vault Brain sends its passages and the skill
 * descriptions with every question, which outgrows a 4,096-token window
 * (Ollama's default on many computers) by the second question or sooner.
 */
export function explainContextOverflow(
  message: string,
  provider: AiProvider,
  providerName: string,
): string | null {
  const m = OVERFLOW.exec(message);
  if (!m) return null;
  const needed = Number(m[1]).toLocaleString("en-GB");
  const available = Number(m[2]).toLocaleString("en-GB");
  const where = WHERE[provider] ?? "Give the model a larger context window";
  return (
    `This request (${needed} tokens) is bigger than the context window ${providerName} gave the model (${available} tokens). ` +
    `${where}: 16,384 tokens or more suits Horme with Vault Brain. ` +
    "Or turn off Vault Brain, or the skills, for this chat."
  );
}

/**
 * Normal text runs about four characters to a token and never eight, so a
 * request read as fewer tokens than one per eight characters was cut. Ollama
 * does that, without a word, to a request bigger than the model's context
 * window on some models (others refuse it): it keeps the end, so the system
 * prompt, with Horme's instructions and the note passages, is what goes.
 */
export function wasCut(promptChars: number, promptTokens: unknown): boolean {
  return typeof promptTokens === "number" && promptTokens > 0 && promptTokens * 8 < promptChars;
}

/**
 * The context window to ask Ollama for (num_ctx): the setting, capped at
 * what the model was built for, or null to leave it to Ollama (setting 0).
 * The cap matters: asking past the model's length gains nothing and costs
 * memory.
 */
export function ollamaNumCtx(setting: number, modelMax: number | null): number | null {
  if (!Number.isFinite(setting) || setting <= 0) return null;
  const wanted = Math.floor(setting);
  return modelMax && modelMax > 0 ? Math.min(wanted, modelMax) : wanted;
}
