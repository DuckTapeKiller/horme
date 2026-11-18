/** Opens an answer when Vault Brain searched and found nothing on the question. */
export const VAULT_NOTHING = "Nothing in your vault on this.";
/** The same line under an answer in Spanish: the whole answer is in the question's language. */
export const VAULT_NOTHING_ES = "No hay nada sobre esto en tu bóveda.";

const WORDS =
  "(?:nothing in (?:your|the) vault(?: on this)?|no hay nada (?:sobre esto )?en tu bóveda(?: sobre esto)?)";
const MARK = "(?:\\*\\*|__|\\*|_)?";

/** The notice opening the answer, with the answer perhaps going on in the same line. */
const LEADING = new RegExp(`^\\s*${MARK}\\s*${WORDS}\\s*[.!:]?\\s*${MARK}[ \\t]*`, "i");
/** The notice as a line of its own anywhere. */
const OWN_LINE = new RegExp(`^[ \\t]*${MARK}[ \\t]*${WORDS}[ \\t]*[.!:]?[ \\t]*${MARK}[ \\t]*$`, "gim");

/**
 * The notice in the model's wording ("**Nothing in your vault on this**",
 * "No hay nada en tu bóveda", at the start or on a line of its own after the
 * answer, as qwen 3.5 2B wrote it) becomes the exact line at the top, where
 * the rules that keep or drop it look.
 */
export function normaliseVaultNotice(text: string): string {
  let body = text;
  let found = false;
  const lead = LEADING.exec(body);
  if (lead) {
    body = body.slice(lead[0].length);
    found = true;
  }
  if (new RegExp(OWN_LINE.source, "im").test(body)) {
    body = body.replace(OWN_LINE, "");
    found = true;
  }
  if (!found) return text;
  const rest = body.replace(/\n{3,}/g, "\n\n").trim();
  return rest ? `${VAULT_NOTHING}\n\n${rest}` : VAULT_NOTHING;
}
