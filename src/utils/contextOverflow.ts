import type { AiProvider } from "../types";

/**
 * llama-server's refusal when a request does not fit the context window, as
 * llama.cpp, LM Studio's llama.cpp engine and Ollama (which runs llama-server)
 * all pass it on: "request (9462 tokens) exceeds the available context size
 * (4096 tokens), try increasing it".
 */
const OVERFLOW = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i;

/**
 * OpenAI's wording, which vLLM, LiteLLM and other OpenAI-compatible servers
 * pass on: "This model's maximum context length is 8192 tokens. However, you
 * requested 10240 tokens (2048 in the messages, 8192 in the completion)", or
 * "However, your messages resulted in 130000 tokens". These servers count the
 * room asked for the reply (max_tokens) as part of the request.
 */
const OPENAI_OVERFLOW =
  /maximum context length is (\d+) tokens\.?\s*However,? (?:you requested|your messages resulted in) (\d+) tokens(?: \((\d+) in the messages, (\d+) in the completion\))?/i;

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
  const fmt = (n: number) => n.toLocaleString("en-GB");
  let needed: number;
  let available: number;
  let reply = 0;
  const llama = OVERFLOW.exec(message);
  const openai = llama ? null : OPENAI_OVERFLOW.exec(message);
  if (llama) {
    needed = Number(llama[1]);
    available = Number(llama[2]);
  } else if (openai) {
    available = Number(openai[1]);
    needed = Number(openai[2]);
    reply = Number(openai[4] ?? 0);
  } else {
    return null;
  }
  const where = WHERE[provider] ?? "Give the model a larger context window";
  const intro = `This request (${fmt(needed)} tokens) is bigger than the context window ${providerName} gave the model (${fmt(available)} tokens). `;
  // The server counted the room kept for the reply, and that room alone takes
  // half the window or more: the prompt is not what is too long.
  if (reply > 0 && reply * 2 >= available)
    return (
      intro +
      `${fmt(reply)} of those tokens are the room kept for the reply. Lower Longest reply in Horme's Chat settings, or ${where.charAt(0).toLowerCase()}${where.slice(1)}.`
    );
  return (
    intro +
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
 * The context window to ask Ollama for (num_ctx): the setting, or the window
 * the model is already loaded with when that is larger, capped at what the
 * model was built for; null leaves it to Ollama (setting 0).
 *
 * Never less than the loaded window: on its llama.cpp runner Ollama reloads a
 * model for a different num_ctx, so asking for less would reload it (a second
 * or more) only to shrink a window another app, or OLLAMA_CONTEXT_LENGTH,
 * made larger. The cap matters too: asking past the model's length gains
 * nothing and costs memory.
 */
export function ollamaNumCtx(
  setting: number,
  modelMax: number | null,
  loaded: number | null = null,
): number | null {
  if (!Number.isFinite(setting) || setting <= 0) return null;
  const wanted = Math.max(Math.floor(setting), loaded && loaded > 0 ? Math.floor(loaded) : 0);
  return modelMax && modelMax > 0 ? Math.min(wanted, modelMax) : wanted;
}
