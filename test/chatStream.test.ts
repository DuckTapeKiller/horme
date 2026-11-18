import { test } from "node:test";
import assert from "node:assert";
import {
  cleanAndConsolidateMsgs,
  formatSkillSummary,
  processChunk,
  stepSummary,
  pastCall,
  repeatsEarlierCall,
  unwrapQuotedAnswer,
  readableSkillNames,
  repeatsEarlierResult,
  stripSkillCallXml,
} from "../src/utils/chatStream";

function read(line: string): { content: string; reasoning: string; tools: unknown[] } {
  const out = { content: "", reasoning: "", tools: [] as unknown[] };
  processChunk(
    line,
    (t) => out.tools.push(...t),
    (c, r) => {
      out.content += c;
      out.reasoning += r ?? "";
    },
  );
  return out;
}

void test("each provider's chunk format gives its text and reasoning", () => {
  // OpenAI-style servers (llama.cpp, LM Studio, OpenAI, Groq...): reasoning_content, then content.
  assert.deepStrictEqual(
    read('{"choices":[{"delta":{"reasoning_content":"thinking"}}]}').reasoning,
    "thinking",
  );
  assert.strictEqual(read('{"choices":[{"delta":{"content":"Hello"}}]}').content, "Hello");
  // Ollama: message.content and message.thinking.
  assert.deepStrictEqual(read('{"message":{"content":"Hi","thinking":"hm"},"done":false}'), {
    content: "Hi",
    reasoning: "hm",
    tools: [],
  });
  // Claude and Gemini.
  assert.strictEqual(read('{"delta":{"text":"Claude says"}}').content, "Claude says");
  assert.strictEqual(
    read('{"candidates":[{"content":{"parts":[{"text":"Gemini says"}]}}]}').content,
    "Gemini says",
  );
});

void test("native tool calls are handed over; end markers and broken lines are ignored", () => {
  assert.strictEqual(read('{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}').tools.length, 1);
  assert.strictEqual(read('{"message":{"tool_calls":[{"function":{"name":"x"}}]}}').tools.length, 1);
  assert.deepStrictEqual(read("data: [DONE]"), { content: "", reasoning: "", tools: [] });
  assert.deepStrictEqual(read('{"choices":[{"delta":'), { content: "", reasoning: "", tools: [] });
});

void test("skill-call markup is removed from what the reader sees", () => {
  const out = stripSkillCallXml('Let me check. <call:wikipedia>{"query":"Rome"}</call> Done.');
  assert.doesNotMatch(out, /call:wikipedia|query/);
  assert.match(out, /Let me check\./);
});

void test("a skill call is summed up with its language, when it has one", () => {
  assert.strictEqual(
    formatSkillSummary("Wikipedia", { query: "Titivillus", language: "es" }),
    "Skill used: Wikipedia (Spanish)",
  );
  assert.strictEqual(
    formatSkillSummary("Date & Time Calculator", { operation: "difference" }),
    "Skill used: Date & Time Calculator",
  );
});

void test("consecutive turns of one role are merged before sending", () => {
  const msgs = cleanAndConsolidateMsgs([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.strictEqual(msgs.filter((m) => m.role === "user").length, 1);
});

void test("tool calls are put back together from OpenAI's fragments and Ollama's whole calls", async () => {
  const { ToolCallAssembler } = await import("../src/utils/chatStream");
  const openai = new ToolCallAssembler();
  assert.strictEqual(openai.isEmpty, true);
  openai.add([{ index: 0, function: { name: "wikipedia", arguments: '{"qu' } }]);
  openai.add([{ index: 0, function: { arguments: 'ery":"Rome"}' } }]);
  openai.add([{ index: 1, function: { name: "date_calc", arguments: "{}" } }]);
  assert.deepStrictEqual(openai.calls(), [
    { name: "wikipedia", args: '{"query":"Rome"}' },
    { name: "date_calc", args: "{}" },
  ]);
  const ollama = new ToolCallAssembler();
  ollama.add([{ function: { name: "date_calc", arguments: { operation: "difference" } } }]);
  assert.deepStrictEqual(ollama.calls(), [
    { name: "date_calc", args: "", argsObj: { operation: "difference" } },
  ]);
});

void test("a throttled render runs at most once per interval, and never twice at once", async () => {
  const { throttledRender } = await import("../src/utils/chatStream");
  const seen: string[] = [];
  let finish: () => void = () => undefined;
  const render = throttledRender((text) => {
    seen.push(text);
    return new Promise<void>((r) => (finish = r));
  }, 20);
  const el = {} as HTMLElement;
  render("a", el);
  render("b", el); // within the interval
  await new Promise((r) => setTimeout(r, 30));
  render("c", el); // the first render is still running
  finish();
  await new Promise((r) => setTimeout(r, 30));
  render("d", el);
  assert.deepStrictEqual(seen, ["a", "d"]);
});

void test("a skill call without its closing tag is still hidden from the reader", () => {
  const out = stripSkillCallXml(
    '<call:wikipedia>{"query": "what did Titivillus do", "language": "en"} Titivillus was a demon.',
  );
  assert.strictEqual(out, "Titivillus was a demon.");
  // While it streams in, a call not yet complete stays out of sight too.
  assert.doesNotMatch(stripSkillCallXml('Checking. <call:wikipedia>{"query": "Tit'), /\{"query"/);
});

void test("a call tag only partly streamed in is hidden; ordinary text is not touched", () => {
  assert.strictEqual(stripSkillCallXml("Let me look. <call:wiki"), "Let me look.");
  assert.strictEqual(stripSkillCallXml("Five < six and that is all."), "Five < six and that is all.");
});

void test("an error a server sends inside a stream is recognised", async () => {
  const { streamError } = await import("../src/utils/chatStream");
  assert.strictEqual(
    streamError(
      '{"error":{"type":"server_error","message":"Provided 12,147 tokens, but the maximum allowed is 8192.","code":"500"}}',
    ),
    "Provided 12,147 tokens, but the maximum allowed is 8192.",
  );
  assert.strictEqual(streamError('{"error":"Rate limit reached"}'), "Rate limit reached");
  assert.strictEqual(streamError('{"choices":[{"delta":{"content":"Hi"}}]}'), null);
  assert.strictEqual(streamError('{"error":null,"choices":[]}'), null);
});

void test("a step shows an address as host and path, and long text cut short", () => {
  assert.strictEqual(
    stepSummary({ url: "https://en.wikipedia.org/wiki/Titivillus" }),
    "en.wikipedia.org/wiki/Titivillus",
  );
  assert.strictEqual(
    stepSummary({ url: "https://www.example.org/a/Caf%C3%A9_noir/" }),
    "example.org/a/Café noir",
  );
  assert.strictEqual(stepSummary({ query: "Titivillus", language: "en" }), "Titivillus");
  assert.strictEqual(stepSummary({ count: 2 }), "");
  const long = stepSummary({ question: "x".repeat(200) });
  assert.strictEqual(long.length, 80);
  assert.ok(long.endsWith("…"));
});

void test("after a call that found something, a reworded call to that skill is a repeat", () => {
  const ok = "## Grammar notes\n\nLeísmo: «le vi ayer» se admite para un hombre…";
  const past = [
    pastCall(
      "grammar_scholar",
      {
        query:
          "Según mis notas de gramática, ¿es correcto decir «le vi ayer» refiriéndose a un hombre? Explica brevemente.",
      },
      ok,
    ),
  ];
  assert.equal(
    repeatsEarlierCall(
      "grammar_scholar",
      { query: "«le vi ayer» refiriéndose a un hombre según mis notas de gramática" },
      past,
    ),
    true,
  );
  // The screenshot case: a pasted list of examples, then the short question.
  const pasted = [
    pastCall(
      "grammar_scholar",
      { query: "«A Juan le vi ayer; A Juan y a Antonio les vi ayer; A María le vi ayer. Aunque…" },
      ok,
    ),
  ];
  assert.equal(repeatsEarlierCall("grammar_scholar", { query: "«le vi ayer» about a man" }, pasted), true);
  assert.equal(repeatsEarlierCall("grammar_scholar", { query: "uso de la tilde en «solo»" }, past), false);
  assert.equal(repeatsEarlierCall("wikipedia", { query: "le vi ayer" }, past), false);
  const lookups = [
    pastCall("wikipedia", { query: "Peter Abelard" }, "## Wikipedia: Peter Abelard\n\nPeter Abelard was…"),
  ];
  assert.equal(repeatsEarlierCall("wikipedia", { query: "Heloise" }, lookups), false);
  assert.equal(repeatsEarlierCall("wikipedia", { query: "peter abelard", language: "en" }, lookups), true);
});

void test("after a call that found nothing, a corrected retry is allowed but the same call is not", () => {
  const past = [
    pastCall("vault_query", { action: "find", folder: "_GBG test_" }, "No notes found in folder _GBG test_."),
  ];
  assert.equal(repeatsEarlierCall("vault_query", { action: "find", folder: "_GBS test" }, past), false);
  assert.equal(repeatsEarlierCall("vault_query", { action: "find", folder: "_GBG test_" }, past), true);
});

void test("a skill runs at most three times for one message", () => {
  const past = ["Abelard", "Heloise", "Fulbert"].map((q) =>
    pastCall("wikipedia", { query: q }, `## Wikipedia: ${q}`),
  );
  assert.equal(repeatsEarlierCall("wikipedia", { query: "Astrolabe" }, past), true);
  assert.equal(repeatsEarlierCall("britannica", { query: "Astrolabe" }, past), false);
});

void test("an answer written as one quotation loses the outer marks only", () => {
  assert.strictEqual(
    unwrapQuotedAnswer("«The word 'serendipity' means a happy accident, said «Walpole».»"),
    "The word 'serendipity' means a happy accident, said «Walpole».",
  );
  assert.strictEqual(
    unwrapQuotedAnswer("«Le vi ayer» es correcto y «lo vi ayer» también."),
    "«Le vi ayer» es correcto y «lo vi ayer» también.",
  );
  assert.strictEqual(
    unwrapQuotedAnswer("«Sí», es correcto decir «le vi ayer»"),
    "«Sí», es correcto decir «le vi ayer»",
  );
  assert.strictEqual(unwrapQuotedAnswer("Plain."), "Plain.");
});

void test("skill ids in an answer read as their names; ordinary words and code stay", () => {
  const skills = [
    { id: "grammar_scholar", name: "Grammar Scholar" },
    { id: "wikipedia", name: "Wikipedia Search" },
  ];
  assert.strictEqual(
    readableSkillNames("I can consult the `grammar_scholar` tool, or Wikipedia, or grammar_scholar.", skills),
    "I can consult the Grammar Scholar tool, or Wikipedia, or Grammar Scholar.",
  );
  assert.strictEqual(
    readableSkillNames("```\ngrammar_scholar()\n```", skills),
    "```\ngrammar_scholar()\n```",
  );
});

void test("a reworded call that brings back the same pages is a repeat; another subject is not", () => {
  const manual =
    "Findings from your Grammar Manuals: [Manual: 12. Leísmo, laísmo y loísmo] Se debe usar lo o la para complementos directos de persona. Aunque lo más indicado es usar lo, se admite el uso de le para complementos directos de persona en masculino singular: A Juan le vi ayer. Se rechaza el uso de les para el plural.";
  const past = [
    pastCall("grammar_scholar", { context_sentence: "«A Juan le vi ayer; A María le vi ayer»" }, manual),
  ];
  assert.equal(repeatsEarlierResult("grammar_scholar", `${manual} (Relevance: 0.83)`, past), true);
  assert.equal(repeatsEarlierResult("wikipedia", manual, past), false);
  const other =
    "Findings from your Grammar Manuals: [Manual: 3. Acentuación] Las palabras agudas llevan tilde cuando terminan en vocal, ene o ese. Las llanas llevan tilde cuando no terminan en vocal, ene o ese. Las esdrújulas llevan siempre tilde.";
  assert.equal(repeatsEarlierResult("grammar_scholar", other, past), false);
});
