import { test } from "node:test";
import assert from "node:assert/strict";
import { onlyAsksForPictures, pictureRequest } from "../src/utils/pictureRequest";
import { cardCredit, imagesSummary } from "../src/utils/images";

void test("English picture requests are recognised, with subject and count", () => {
  const cases: Array<[string, string, number]> = [
    ["Show me a photo of the Roman Colosseum", "the Roman Colosseum", 1],
    ["show me a photo of the Roman Colosseum?", "the Roman Colosseum", 1],
    ["Can you show me 3 pictures of Frida Kahlo?", "Frida Kahlo", 3],
    ["Please find two images of the Sagrada Familia", "the Sagrada Familia", 2],
    ["Show me pictures of axolotls", "axolotls", 3],
    ["picture of a red fox in snow", "a red fox in snow", 1],
    ["Could you show me some paintings of Van Gogh please", "Van Gogh", 3],
    ["Get me a few photos of Machu Picchu.", "Machu Picchu", 3],
    ["What does a pangolin look like?", "a pangolin", 1],
    ['Show me a picture of "The Starry Night"', "The Starry Night", 1],
  ];
  for (const [text, query, count] of cases) {
    assert.deepEqual(pictureRequest(text), { query, count, language: "en" }, text);
  }
});

void test("Spanish picture requests are recognised, with subject and count", () => {
  const cases: Array<[string, string, number]> = [
    ["Muéstrame una foto de la Sagrada Familia de Barcelona", "la Sagrada Familia de Barcelona", 1],
    ["muestrame una foto del Coliseo", "Coliseo", 1],
    ["¿Me puedes mostrar tres fotos de Frida Kahlo?", "Frida Kahlo", 3],
    ["Enséñame imágenes de ajolotes", "ajolotes", 3],
    ["Quiero ver un cuadro de Goya", "Goya", 1],
    ["fotos de Machu Picchu, por favor", "Machu Picchu", 3],
  ];
  for (const [text, query, count] of cases) {
    assert.deepEqual(pictureRequest(text), { query, count, language: "es" }, text);
  }
});

void test("messages that ask for more than pictures are left to the model", () => {
  for (const text of [
    "Who is Dean Benedetti?",
    "Tell me briefly about the Eiffel Tower.",
    "Show me a photo of the Colosseum and tell me when it was built",
    "Muéstrame una foto del Coliseo y explícame su historia",
    "Show me a photo of the Colosseum. Why was it built?",
    "Show me a picture of my notes on Rome",
    "What is 15% of 80?",
    "Summarise this photo of a page",
    "Show me a photo of\nthe Colosseum",
    "Show me the latest notes about photos",
    "Show me a photo of " + "very ".repeat(20) + "long thing",
    "",
  ]) {
    assert.equal(pictureRequest(text), null, text);
  }
});

void test("a message that only asks for pictures ends the turn once they are shown", () => {
  assert.equal(onlyAsksForPictures("I'd love to see a photo of Machu Picchu"), true);
  assert.equal(onlyAsksForPictures("Show me a photo of the Colosseum"), true);
  assert.equal(onlyAsksForPictures("Me gustaría ver fotos de Petra"), true);
  assert.equal(onlyAsksForPictures("Tell me about the Colosseum"), false);
  assert.equal(onlyAsksForPictures("Show me a photo of the Colosseum and tell me when it was built"), false);
  assert.equal(onlyAsksForPictures("Who painted this picture? And when? And where?"), false);
});

void test("the reply under shown pictures gives each title and credit", () => {
  const base = {
    thumbUrl: "https://thumb.wikimedia.org/x.jpg",
    saveUrl: "https://thumb.wikimedia.org/y.jpg",
    pageUrl: "",
    description: "",
    width: 0,
    height: 0,
  };
  const wiki = {
    ...base,
    source: "Wikimedia Commons",
    title: "Colosseo [2020]",
    author: "Diliff",
    licence: "CC BY-SA 4.0",
  };
  const pexels = { ...base, source: "Pexels", title: "Fox", author: "Photo by Ana on Pexels", licence: "" };
  assert.equal(cardCredit(wiki), "Diliff · CC BY-SA 4.0 · Wikimedia Commons");
  assert.equal(cardCredit(pexels), "Photo by Ana on Pexels");
  assert.equal(
    imagesSummary([wiki, pexels]),
    "- **Colosseo 2020** — Diliff · CC BY-SA 4.0 · Wikimedia Commons\n- **Fox** — Photo by Ana on Pexels",
  );
});
