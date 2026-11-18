import type { ChatMessage } from "../types";

/**
 * Reading what a model streams back, and tidying the chat for the next
 * request: the text and reasoning in each streamed chunk (any provider's
 * format), skill-call markup the reader should not see, a plain summary of a
 * skill call, and the message list with consecutive turns merged. No
 * Obsidian calls, so it is tested directly.
 */

/**
 * Strips raw skill call XML (e.g. `<call:wikipedia>{...}</call>`) from content
 * so the user sees clean text instead of the model's internal tool invocations.
 */
export function stripSkillCallXml(content: string): string {
  const tagRegex = /<call:([a-zA-Z0-9_]+)>/g;
  let match;

  const isEscaped = (str: string, index: number): boolean => {
    let count = 0;
    for (let i = index - 1; i >= 0; i--) {
      if (str[i] === "\\") count++;
      else break;
    }
    return count % 2 !== 0;
  };

  let cleanText = "";
  let lastIndex = 0;
  tagRegex.lastIndex = 0;

  while ((match = tagRegex.exec(content)) !== null) {
    const startTagIdx = match.index;
    const startIdx = startTagIdx + match[0].length;

    // Find the opening '{' that begins the JSON parameter object.
    let jsonStart = -1;
    for (let i = startIdx; i < content.length; i++) {
      const char = content[i];
      if (char === "{") {
        jsonStart = i;
        break;
      }
      if (char === "<") {
        break;
      }
    }

    if (jsonStart === -1) {
      continue;
    }

    // Use the brace-counting parser to extract the balanced JSON object.
    let braceCount = 0;
    let inString = false;
    let jsonEnd = -1;

    for (let i = jsonStart; i < content.length; i++) {
      const char = content[i];
      if (char === '"' && !isEscaped(content, i)) {
        inString = !inString;
      }
      if (!inString) {
        if (char === "{") {
          braceCount++;
        } else if (char === "}") {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i;
            break;
          }
        }
      }
    }

    if (jsonEnd === -1) {
      // A call still streaming in: hidden from its tag to the end until it completes.
      cleanText += content.slice(lastIndex, startTagIdx);
      lastIndex = content.length;
      break;
    }

    // The </call> tag is removed with the call when present; a call without
    // it (small models leave it out) is removed all the same.
    const closeTagMatch = /^\s*<\/call>/.exec(content.slice(jsonEnd + 1));
    const endTagIdx = jsonEnd + 1 + (closeTagMatch ? closeTagMatch[0].length : 0);

    // Add preceding non-tag text to cleanText
    cleanText += content.slice(lastIndex, startTagIdx);
    lastIndex = endTagIdx;

    // Update regex index to skip past the closing tag
    tagRegex.lastIndex = endTagIdx;
  }

  // A call tag only partly streamed in ("<call:wiki") is hidden too.
  cleanText += content.slice(lastIndex).replace(/<(?:c(?:a(?:l(?:l(?::[a-zA-Z0-9_]*)?)?)?)?)?$/, "");
  return cleanText.trim();
}

/**
 * Builds a human-readable summary for the skill result box.
 * Adds contextual details like language names where applicable.
 */
const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  nl: "Dutch",
  ar: "Arabic",
  tr: "Turkish",
  hi: "Hindi",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  cs: "Czech",
  el: "Greek",
  he: "Hebrew",
  th: "Thai",
  vi: "Vietnamese",
  uk: "Ukrainian",
  ro: "Romanian",
  hu: "Hungarian",
  ca: "Catalan",
};

export function formatSkillSummary(skillName: string, params: unknown): string {
  // Add language detail for skills that use it (Wikipedia, Wiktionary)
  const language =
    typeof params === "object" &&
    params !== null &&
    typeof (params as Record<string, unknown>)["language"] === "string"
      ? ((params as Record<string, unknown>)["language"] as string)
      : null;
  if (language) {
    const code = language.toLowerCase().slice(0, 2);
    const langName = LANG_NAMES[code] || language.toUpperCase();
    return `Skill used: ${skillName} (${langName})`;
  }
  return `Skill used: ${skillName}`;
}

/** Words that say nothing about what a call is for. */
const FILLER = new Set(
  (
    "the and about for with from that this what how which who does into are was were " +
    "que los las del una por para con según mis tus sus notes notas note nota"
  ).split(" "),
);

/** The key words of a skill call's text values (folded, three letters or more), for comparing two calls. */
function callWords(params: unknown): Set<string> {
  const text =
    params && typeof params === "object"
      ? Object.values(params as Record<string, unknown>)
          .filter((v): v is string => typeof v === "string")
          .join(" ")
      : "";
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]{3,}/gu);
  return new Set((words ?? []).filter((w) => !FILLER.has(w)));
}

/** A skill call made this turn, kept to spot repeats; `ok` when it found something. */
export interface PastCall {
  skillId: string;
  words: Set<string>;
  ok: boolean;
  /** The words of what it returned, to spot a reworded call that brought back the same thing. */
  found: Set<string>;
}

function resultWords(result: string): Set<string> {
  return new Set(
    (result
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/\p{L}{4,}/gu) ?? []) as string[],
  );
}

/**
 * Whether a result brings back what an earlier call to the same skill already
 * did: qwen 3.5 2B asked Grammar Scholar once with a note's example sentences
 * and once with the question, words that share almost nothing, and got the
 * same manual pages twice. Compared on what came back, not on how it was asked.
 */
export function repeatsEarlierResult(skillId: string, result: string, past: PastCall[]): boolean {
  const words = resultWords(result);
  if (words.size < 15) return false;
  return past.some((p) => {
    if (p.skillId !== skillId || !p.ok || p.found.size < 15) return false;
    let shared = 0;
    for (const w of words) if (p.found.has(w)) shared++;
    return shared / Math.min(words.size, p.found.size) >= 0.8;
  });
}

/** The most times one skill runs for one message. */
export const MAX_CALLS_PER_SKILL = 3;

/** Whether a skill's result says it found nothing or failed. */
export function skillFailed(result: string): boolean {
  return /^\s*(?:error\b|no |invalid |nothing )|not found|no results|returned no|found nothing|could not|failed|no notes?\b|0 notes/i.test(
    result,
  );
}

/**
 * Whether a call repeats one already made this turn. After a call that found
 * something, another call to that skill sharing half its key words is a
 * repeat ("¿es correcto decir «le vi ayer»…?" sent four times by qwen 3.5 2B,
 * reworded each time). After a call that found nothing, only the same call
 * again is: a retry with a corrected folder name is fair. A different subject
 * ("Abelard", then "Heloise") is never a repeat, and no skill runs more than
 * MAX_CALLS_PER_SKILL times for one message.
 */
export function repeatsEarlierCall(skillId: string, params: unknown, past: PastCall[]): boolean {
  const same = past.filter((p) => p.skillId === skillId);
  if (same.length >= MAX_CALLS_PER_SKILL) return true;
  const words = callWords(params);
  return same.some((p) => {
    if (words.size === 0 || p.words.size === 0) return words.size === p.words.size;
    let shared = 0;
    for (const w of words) if (p.words.has(w)) shared++;
    const overlap = shared / Math.min(words.size, p.words.size);
    return p.ok ? overlap >= 0.5 : overlap >= 0.9 && words.size === p.words.size;
  });
}

/** The record of a call and its result, for repeatsEarlierCall. */
export function pastCall(skillId: string, params: unknown, result: string): PastCall {
  return { skillId, words: callWords(params), ok: !skillFailed(result), found: resultWords(result) };
}

/**
 * What a step in the Steps list was asked: the call's first text value, an
 * address shown as host and path ("en.wikipedia.org/wiki/Titivillus"), long
 * text cut short. The full value stays in the row's tooltip.
 */
export function stepSummary(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const first = Object.values(params as Record<string, unknown>).find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  if (!first) return "";
  let text = first.trim().replace(/\s+/g, " ");
  if (/^https?:\/\/\S+$/i.test(text)) {
    try {
      const u = new URL(text);
      let path = u.pathname.replace(/\/$/, "");
      try {
        path = decodeURIComponent(path);
      } catch {
        // Kept encoded.
      }
      text = `${u.hostname.replace(/^www\./, "")}${path.replace(/_/g, " ")}`;
    } catch {
      // Not a valid address: shown as written.
    }
  }
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

export function processChunk(
  line: string,
  onToolCalls: (fragments: unknown[]) => void,
  onContent: (c: string, r?: string) => void,
) {
  const raw = line.trim();
  if (!raw || raw === "data: [DONE]") return;
  try {
    // The upstream brace-counting parser already extracts clean JSON objects,
    // so no SSE "data: " prefix stripping is needed here.
    const data: unknown = JSON.parse(raw);

    // Native tool calls: OpenAI streams indexed fragments in
    // choices[0].delta.tool_calls; Ollama sends whole calls in
    // message.tool_calls.
    const toolCallFragments =
      getArrayAtPath(data, ["choices", 0, "delta", "tool_calls"]) ??
      getArrayAtPath(data, ["message", "tool_calls"]);
    if (toolCallFragments && toolCallFragments.length) onToolCalls(toolCallFragments);

    const content =
      getStringAtPath(data, ["message", "content"]) ??
      getStringAtPath(data, ["choices", 0, "delta", "content"]) ??
      getStringAtPath(data, ["delta", "text"]) ??
      getStringAtPath(data, ["candidates", 0, "content", "parts", 0, "text"]) ??
      "";

    const reasoning =
      getStringAtPath(data, ["choices", 0, "delta", "reasoning_content"]) ??
      getStringAtPath(data, ["choices", 0, "delta", "reasoning"]) ??
      getStringAtPath(data, ["message", "reasoning"]) ??
      getStringAtPath(data, ["message", "thinking"]) ??
      "";

    if (content || reasoning) onContent(content, reasoning);
  } catch {
    // Ignore malformed partial chunks.
  }
}

function getArrayAtPath(obj: unknown, path: Array<string | number>): unknown[] | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
      continue;
    }
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return Array.isArray(cur) ? cur : undefined;
}

function getStringAtPath(obj: unknown, path: Array<string | number>): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
      continue;
    }
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

export function cleanAndConsolidateMsgs(rawMsgs: ChatMessage[]): ChatMessage[] {
  const consolidated: ChatMessage[] = [];
  for (const m of rawMsgs) {
    if (consolidated.length > 0 && consolidated[consolidated.length - 1].role === m.role) {
      consolidated[consolidated.length - 1].content += "\n\n" + m.content;
      if (m.images) {
        consolidated[consolidated.length - 1].images = [
          ...(consolidated[consolidated.length - 1].images || []),
          ...m.images,
        ];
      }
    } else {
      consolidated.push({ ...m });
    }
  }
  return consolidated;
}

/** A native tool call as assembled from a stream. */
export interface AssembledCall {
  name: string;
  /** Arguments as streamed text (OpenAI's fragments), or */
  args: string;
  /** as an object (Ollama sends whole calls). */
  argsObj?: unknown;
}

/**
 * Puts native tool calls back together across a stream: OpenAI's shape
 * sends indexed fragments of name and argument text, Ollama's whole calls.
 */
export class ToolCallAssembler {
  private parts = new Map<number, AssembledCall>();
  private cursor = 0;

  add(fragments: unknown[]): void {
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== "object") continue;
      const record = fragment as Record<string, unknown>;
      const index = typeof record.index === "number" ? record.index : this.cursor;
      let part = this.parts.get(index);
      if (!part) {
        part = { name: "", args: "" };
        this.parts.set(index, part);
      }
      this.cursor = Math.max(this.cursor, index + 1);
      const fn = record.function;
      if (fn && typeof fn === "object") {
        const fnRecord = fn as Record<string, unknown>;
        if (typeof fnRecord.name === "string" && fnRecord.name && !part.name) part.name = fnRecord.name;
        if (typeof fnRecord.arguments === "string") part.args += fnRecord.arguments;
        else if (fnRecord.arguments && typeof fnRecord.arguments === "object")
          part.argsObj = fnRecord.arguments;
      }
    }
  }

  get isEmpty(): boolean {
    return this.parts.size === 0;
  }

  calls(): AssembledCall[] {
    return [...this.parts.values()];
  }
}

/**
 * Wraps a render so that calling it often (once per streamed chunk) renders
 * at most every `everyMs`, and never while a render is still running.
 */
export function throttledRender(
  render: (text: string, target: HTMLElement) => Promise<void>,
  everyMs = 200,
): (text: string, target: HTMLElement) => void {
  let last = 0;
  let running: Promise<void> | null = null;
  return (text, target) => {
    const now = Date.now();
    if (now - last < everyMs || running) return;
    last = now;
    running = render(text, target).finally(() => {
      running = null;
    });
  };
}

/**
 * The error a server sends inside a stream that had already begun, or null:
 * {"error": {"message": …}} or {"error": "…"}. Apple's model server, vLLM,
 * LiteLLM and OpenRouter report a failure this way after answering 200, and
 * a reader that only looks for text ends the reply in silence.
 */
export function streamError(json: string): string | null {
  try {
    const data: unknown = JSON.parse(json);
    if (!data || typeof data !== "object") return null;
    const error = (data as Record<string, unknown>).error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  } catch {
    // not a whole JSON object: nothing to read
  }
  return null;
}

/**
 * An answer written as one quotation, «…» from first to last character (qwen
 * 3.5 2B did this), loses the outer marks; quotations inside are kept.
 */
export function unwrapQuotedAnswer(text: string): string {
  const t = text.trim();
  if (!t.startsWith("«") || !t.endsWith("»")) return text;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "«") depth++;
    else if (t[i] === "»") {
      depth--;
      // The opening mark closes before the end: separate quotations, not a wrapper.
      if (depth === 0 && i < t.length - 1) return text;
    }
  }
  return depth === 0 ? t.slice(1, -1).trim() : text;
}

/**
 * Skill ids in a reply written as the names the reader sees ("grammar_scholar"
 * → "Grammar Scholar"). Only ids with an underscore are changed: "wikipedia"
 * in a sentence is a word. Code blocks are left as they are.
 */
export function readableSkillNames(text: string, skills: Array<{ id: string; name: string }>): string {
  const pieces = text.split(/(```[\s\S]*?```)/);
  for (let i = 0; i < pieces.length; i += 2) {
    for (const skill of skills) {
      if (!skill.id.includes("_")) continue;
      pieces[i] = pieces[i].replace(new RegExp(`\`?\\b${skill.id}\\b\`?`, "g"), skill.name);
    }
  }
  return pieces.join("");
}
