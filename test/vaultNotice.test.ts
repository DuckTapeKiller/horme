import { test } from "node:test";
import assert from "node:assert/strict";
import { VAULT_NOTHING, normaliseVaultNotice } from "../src/utils/vaultNotice";

void test("the notice after the answer moves to the top", () => {
  assert.equal(
    normaliseVaultNotice("The Colosseum is an amphitheatre.\n\nNothing in your vault on this."),
    `${VAULT_NOTHING}\n\nThe Colosseum is an amphitheatre.`,
  );
});

void test("the model's own wording at the start becomes the exact line", () => {
  assert.equal(
    normaliseVaultNotice("**Nothing in your vault on this**\nAnswer."),
    `${VAULT_NOTHING}\n\nAnswer.`,
  );
  assert.equal(
    normaliseVaultNotice("Nothing in the vault. Answer here."),
    `${VAULT_NOTHING}\n\nAnswer here.`,
  );
  assert.equal(
    normaliseVaultNotice("No hay nada en tu bóveda sobre esto.\n\nRespuesta."),
    `${VAULT_NOTHING}\n\nRespuesta.`,
  );
  assert.equal(normaliseVaultNotice("Nothing in your vault on this."), VAULT_NOTHING);
});

void test("an answer without the notice, or that only mentions it in a sentence, is left alone", () => {
  const plain = "Your vault has nothing in your vault on this topic? No: it has two notes.";
  assert.equal(normaliseVaultNotice(plain), plain);
  assert.equal(normaliseVaultNotice("Plain answer."), "Plain answer.");
});
