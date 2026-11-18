import { test } from "node:test";
import assert from "node:assert";
import { replyLanguage } from "../src/utils/replyLanguage";

void test("questions in English and Spanish are told apart", () => {
  for (const q of [
    "How many days passed between 1914-07-28 and 1918-11-11?",
    "Look up Titivillus on Wikipedia and tell me who he was, in two sentences.",
    "Which of my notes are related to Sally Rooney's Normal People? Link them.",
    "Show me a picture of a lighthouse.",
    "What does Britannica say about the Colosseum? Two sentences.",
  ])
    assert.strictEqual(replyLanguage(q), "English", q);
  for (const q of [
    "Según mis notas de gramática, ¿es correcto decir «le vi ayer» refiriéndose a un hombre? Explica brevemente.",
    "¿Cuántos días pasaron entre el 28 de julio de 1914 y el 11 de noviembre de 1918?",
    "Según esta nota, ¿qué hacía Titivillus? Una frase.",
  ])
    assert.strictEqual(replyLanguage(q), "Spanish", q);
});

void test("short or unclear messages name no language", () => {
  for (const q of ["Hello", "Titivillus", "OK", "1914-07-28"]) assert.strictEqual(replyLanguage(q), null, q);
});

void test("short commands with a link are told apart too", () => {
  assert.strictEqual(
    replyLanguage("Summarise this page in three sentences: https://en.wikipedia.org/wiki/Titivillus"),
    "English",
  );
  assert.strictEqual(
    replyLanguage("Resume esta página en tres frases: https://en.wikipedia.org/wiki/Titivillus"),
    "Spanish",
  );
  assert.strictEqual(replyLanguage("Show me a picture of a lighthouse."), "English");
  assert.strictEqual(replyLanguage("Busca en la Wikipedia en inglés quién fue Titivillus"), "Spanish");
  assert.strictEqual(
    replyLanguage("Create a concept note about the scriptorium in medieval monasteries."),
    "English",
  );
});
