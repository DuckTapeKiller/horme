export type RoleMessage = { role: string; content: string };

/**
 * Splits chat messages for providers that take a single system prompt (Claude,
 * Gemini) or accept system messages only at the start (Mistral).
 *
 * System messages before the first user or assistant turn become the system
 * prompt. Later ones (skill results, injected context) become user turns, so
 * they reach the model instead of being dropped or rejected. Any other role
 * (tool_result) is sent as a user turn too.
 */
export function splitSystemMessages(msgs: RoleMessage[]): {
  system: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of msgs) {
    if (m.role === "system" && turns.length === 0) {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    turns.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return { system: systemParts.join("\n\n"), turns };
}

/** Joins consecutive turns of the same role, for APIs that expect them to alternate. */
export function mergeConsecutiveTurns<T extends { role: string; content: string }>(turns: T[]): T[] {
  const out: T[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role)
      out[out.length - 1] = { ...last, content: `${last.content}\n\n${t.content}` };
    else out.push({ ...t });
  }
  return out;
}

/**
 * Claude models from 4.7 on (and Sonnet 5.5, Haiku 5.5, Fable) reject a
 * temperature (or any but the default), so it is sent only to older models.
 */
export function claudeAcceptsTemperature(model: string): boolean {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:$|-)/.exec(model.trim());
  if (!m) return /^claude-(?:instant|2|3)/.test(model.trim());
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] !== undefined ? Number(m[3]) : 0;
  if (family === "fable" || family === "mythos") return false;
  if (major >= 5) return false;
  if (major === 4 && minor >= 7) return false;
  return true;
}

/**
 * OpenAI reasoning models take max_completion_tokens and only the default
 * temperature. GPT-6 (gpt-6-astra, gpt-6.1-sol…) is one too: Chat Completions
 * defaults its reasoning effort to "medium", and with any effort but "none" a
 * temperature is refused.
 */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(o\d|gpt-(?:[5-9]|\d{2,})(?:[.-]|$))/i.test(model.trim());
}
