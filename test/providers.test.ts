import { test } from "node:test";
import assert from "node:assert";
import { requests } from "./support/obsidian";
import { createProvider, type ProviderSource } from "../src/providers/createProvider";
import { DEFAULT_SETTINGS } from "../src/constants";
import type { AiProvider, HormeSettings } from "../src/types";

/** A plugin as the provider factory sees it, with keys by provider. */
function source(
  over: Partial<HormeSettings> = {},
  keys: Partial<Record<AiProvider, string>> = {},
): ProviderSource {
  return { settings: { ...DEFAULT_SETTINGS, ...over }, getApiKeyForProvider: (p) => keys[p] ?? "" };
}

const reply = (content: string) => ({ status: 200, json: { choices: [{ message: { content } }] } });

function lastBody(): Record<string, unknown> {
  const req = requests.sent[requests.sent.length - 1];
  return JSON.parse(req.body ?? "{}") as Record<string, unknown>;
}

/** Records window.fetch calls (cloud streaming) and answers with an empty stream. */
function stubFetch(status = 200): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  (globalThis as unknown as { window: unknown }).window = {
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        status === 200
          ? new Response(new ReadableStream({ start: (c) => c.close() }), { status })
          : new Response("nope", { status }),
      );
    },
  };
  return calls;
}

void test("cloud services share one client: address, key and body per the registry", async () => {
  const cases: Array<[AiProvider, string]> = [
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["groq", "https://api.groq.com/openai/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
    ["mistral", "https://api.mistral.ai/v1/chat/completions"],
  ];
  for (const [id, url] of cases) {
    requests.sent = [];
    requests.respond = () => reply(`hi from ${id}`);
    const p = createProvider(source({ temperature: 0.3, maxTokens: 512 }, { [id]: "sk-test" }), id);
    assert.strictEqual(await p.generate("Hello", "Be brief.", "some-model"), `hi from ${id}`);
    const req = requests.sent[0];
    assert.strictEqual(req.url, url, id);
    assert.strictEqual(req.headers?.Authorization, "Bearer sk-test", id);
    const body = lastBody();
    assert.deepStrictEqual(body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello" },
    ]);
    assert.strictEqual(body.temperature, 0.3);
    assert.strictEqual(body.max_tokens, 512);
    assert.strictEqual(body.stream, false);
  }
});

void test("OpenRouter sends its two extra headers; others do not", async () => {
  requests.sent = [];
  requests.respond = () => reply("ok");
  await createProvider(source({}, { openrouter: "k" }), "openrouter").generate("a", "b", "m");
  assert.strictEqual(requests.sent[0].headers?.["X-Title"], "Horme");
  assert.ok(requests.sent[0].headers?.["HTTP-Referer"]);
  requests.sent = [];
  await createProvider(source({}, { groq: "k" }), "groq").generate("a", "b", "m");
  assert.strictEqual(requests.sent[0].headers?.["X-Title"], undefined);
});

void test("OpenAI's reasoning models get max_completion_tokens and no temperature", async () => {
  requests.respond = () => reply("ok");
  await createProvider(source({ maxTokens: 900 }, { openai: "k" }), "openai").generate(
    "a",
    "b",
    "gpt-5-mini",
  );
  assert.deepStrictEqual(
    [lastBody().max_completion_tokens, lastBody().temperature, lastBody().max_tokens],
    [900, undefined, undefined],
  );
  // Groq hosts openai/gpt-oss but is not OpenAI: the usual pair.
  await createProvider(source({ maxTokens: 900 }, { groq: "k" }), "groq").generate(
    "a",
    "b",
    "openai/gpt-oss-20b",
  );
  assert.strictEqual(lastBody().max_tokens, 900);
});

void test("Mistral gets one system message, first; later ones become user turns", async () => {
  requests.respond = () => reply("ok");
  await createProvider(source({}, { mistral: "k" }), "mistral").generateChat(
    [
      { role: "system", content: "A" },
      { role: "user", content: "q" },
      { role: "system", content: "B" },
    ],
    "m",
  );
  const roles = (lastBody().messages as Array<{ role: string }>).map((m) => m.role);
  assert.strictEqual(roles.filter((r) => r === "system").length, 1);
  assert.strictEqual(roles[0], "system");
});

void test("a cloud service without a key refuses before sending anything", async () => {
  requests.sent = [];
  await assert.rejects(createProvider(source(), "groq").generate("a", "b", "m"), /No Groq API Key/);
  await assert.rejects(createProvider(source(), "mistral").stream([], "m"), /No Mistral AI API Key/);
  assert.strictEqual(requests.sent.length, 0);
});

void test("cloud streaming goes through the browser's fetch, with the key and stream: true", async () => {
  const calls = stubFetch();
  const reader = await createProvider(source({}, { openai: "sk-x" }), "openai").stream(
    [{ role: "user", content: "hi" }],
    "gpt-4.1-mini",
  );
  assert.ok(reader);
  assert.strictEqual(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.strictEqual((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-x");
  assert.strictEqual((JSON.parse(calls[0].init.body as string) as { stream: boolean }).stream, true);
  stubFetch(401);
  await assert.rejects(
    createProvider(source({}, { groq: "bad" }), "groq").stream([{ role: "user", content: "hi" }], "m"),
    /Groq stream error/,
  );
});

void test("the OpenAI-compatible server needs an address and a model; its key is optional", async () => {
  await assert.rejects(
    createProvider(source({ customUrl: "" }), "custom").generate("a", "b", "m"),
    /No server address/,
  );
  await assert.rejects(
    createProvider(source({ customUrl: "http://lan:4000/v1" }), "custom").generate("a", "b", " "),
    /No model chosen/,
  );
  requests.sent = [];
  requests.respond = () => reply("ok");
  await createProvider(source({ customUrl: "http://lan:4000/v1/chat/completions" }), "custom").generate(
    "a",
    "b",
    "m",
  );
  assert.strictEqual(requests.sent[0].url, "http://lan:4000/v1/chat/completions");
  assert.strictEqual(requests.sent[0].headers?.Authorization, undefined);
});

void test("llama.cpp: one-shot jobs turn thinking off; the key is sent when set", async () => {
  requests.sent = [];
  requests.respond = (req) =>
    req.url.endsWith("/v1/models")
      ? { status: 200, json: { data: [{ id: "gemma", status: { value: "loaded" } }] } }
      : reply("ok");
  const p = createProvider(source({ llamaCppUrl: "http://127.0.0.1:8130" }, { llamacpp: "lk" }), "llamacpp");
  assert.strictEqual(await p.generate("a", "b", ""), "ok");
  const chat = requests.sent.find((r) => r.url.endsWith("/v1/chat/completions"));
  assert.ok(chat);
  assert.strictEqual(chat.headers?.Authorization, "Bearer lk");
  const body = JSON.parse(chat.body ?? "{}") as Record<string, unknown>;
  assert.strictEqual(body.model, "gemma"); // "Automatic" resolved to the loaded model
  assert.deepStrictEqual(body.chat_template_kwargs, { enable_thinking: false });
});

void test("LM Studio: no thinking switch is sent", async () => {
  requests.sent = [];
  requests.respond = (req) =>
    req.url.includes("/models") && !req.url.includes("load")
      ? { status: 200, json: { data: [{ id: "qwen", state: "loaded", type: "llm" }] } }
      : reply("ok");
  await createProvider(source({ lmStudioUrl: "http://localhost:1234" }), "lmstudio").generate("a", "b", "");
  const chat = requests.sent.find((r) => r.url.endsWith("/v1/chat/completions"));
  const body = JSON.parse(chat?.body ?? "{}") as Record<string, unknown>;
  assert.strictEqual(body.model, "qwen");
  assert.strictEqual(body.chat_template_kwargs, undefined);
});
