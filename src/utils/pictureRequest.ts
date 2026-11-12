/**
 * Recognises a message that only asks to see pictures ("show me a photo of the
 * Colosseum", "muéstrame tres fotos de Frida Kahlo"), so Horme can show them
 * without a round trip through the model. Anything more than that (a second
 * request, a question about the subject) is left to the model.
 */

export interface PictureAsk {
  query: string;
  count: number;
  /** Wikipedia language for the article picture. */
  language: "en" | "es";
}

const NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  "a couple of": 2,
  "a few": 3,
  some: 3,
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  unas: 3,
  unos: 3,
  algunas: 3,
  algunos: 3,
};

const EN_NOUNS = "photos?|pictures?|images?|pics?|photographs?|paintings?|portraits?|drawings?";
const ES_NOUNS = "fotos?|fotograf[íi]as?|im[áa]genes|imagen|retratos?|cuadros?|pinturas?|dibujos?";

const EN = new RegExp(
  "^(?:(?:please|hey)[,\\s]+)?(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?" +
    "(?:(?:show|find|get|give|send|display|fetch|bring)(?:\\s+me)?\\s+)?" +
    "(?:(an?|one|two|three|four|five|six|seven|eight|some|a few|a couple of|\\d+)\\s+)?" +
    "(?:(?:good|nice|beautiful|famous|real|old|recent)\\s+)?" +
    `(${EN_NOUNS})\\s+(?:of|showing)\\s+(.+?)\\s*(?:,?\\s*please)?[?.!]*$`,
  "i",
);

const EN_LOOK =
  /^(?:(?:can|could)\s+you\s+show\s+me\s+)?what\s+(?:does|do|did)\s+(.+?)\s+look\s+like\s*[?.!]*$/i;

const ES = new RegExp(
  "^(?:por\\s+favor[,\\s]+)?¿?\\s*(?:(?:me\\s+)?(?:puedes|podr[íi]as)\\s+)?" +
    "(?:(?:mu[ée]strame|mostrarme|mostrar|ens[ée][ñn]ame|ense[ñn]arme|b[úu]scame|buscarme|buscar|dame|darme|ponme|quiero\\s+ver|quisiera\\s+ver)\\s+)?" +
    "(?:(una?|uno|unas|unos|dos|tres|cuatro|cinco|seis|siete|ocho|algunas|algunos|\\d+)\\s+)?" +
    `(${ES_NOUNS})\\s+(?:del?|sobre)\\s+(.+?)\\s*(?:,?\\s*por\\s+favor)?[?.!]*$`,
  "i",
);

/** A second request after the picture one: "… and tell me when it was built". */
const MORE =
  /\b(?:and|then|also|plus|y|e|luego|tambi[ée]n|adem[áa]s)\s+(?:tell|explain|describe|write|give|say|list|summari[sz]e|compare|what|why|how|when|who|where|dime|cu[ée]ntame|expl[íi]ca(?:me)?|describe|escribe|resume|compara|qu[ée]|por\s+qu[ée]|c[óo]mo|cu[áa]ndo|qui[ée]n|d[óo]nde)\b/i;

function countOf(word: string | undefined, noun: string): number {
  if (word) {
    const w = word.toLowerCase();
    const n = /^\d+$/.test(w) ? parseInt(w, 10) : NUMBERS[w];
    if (n) return n;
  }
  // "photos of X" with no number: a few; "photo of X": one. Every plural here ends in s.
  return /s$/i.test(noun) ? 3 : 1;
}

function tidy(subject: string): string {
  return subject
    .replace(/^["“«']+|["”»']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function plausible(subject: string, whole: string): boolean {
  if (!subject || subject.length > 100) return false;
  // A second sentence ("… the Colosseum. Why was it built?") is more than a picture request.
  if (/[.!?;:]\s+\S/.test(subject)) return false;
  if (subject.split(" ").length > 12) return false;
  // Two questions, or a second request, go to the model.
  if ((whole.match(/\?/g) ?? []).length > 1 || MORE.test(whole)) return false;
  // "a photo of my note" is about the vault, not a picture search.
  if (
    /\b(?:my|this|that|these|those|mi|mis|esta|este|estas|estos)\s+(?:note|notes|vault|file|nota|notas|archivo)\b/i.test(
      subject,
    )
  )
    return false;
  return true;
}

/** The picture request in a message, or null when the message asks for more than pictures. */
export function pictureRequest(text: string): PictureAsk | null {
  const whole = text.trim();
  if (!whole || whole.includes("\n") || whole.length > 160) return null;

  let m = EN.exec(whole);
  if (m) {
    const query = tidy(m[3]);
    return plausible(query, whole) ? { query, count: countOf(m[1], m[2]), language: "en" } : null;
  }
  m = ES.exec(whole);
  if (m) {
    const query = tidy(m[3]);
    return plausible(query, whole) ? { query, count: countOf(m[1], m[2]), language: "es" } : null;
  }
  m = EN_LOOK.exec(whole);
  if (m) {
    const query = tidy(m[1]);
    return plausible(query, whole) ? { query, count: 1, language: "en" } : null;
  }
  return null;
}

/**
 * True when a message is about seeing pictures and nothing else, even if it is
 * phrased in a way pictureRequest() does not take apart ("I'd love to see a
 * photo of Machu Picchu"). Used to end a turn once the pictures are shown.
 */
export function onlyAsksForPictures(text: string): boolean {
  const whole = text.trim();
  if (!whole || whole.length > 200 || whole.includes("\n")) return false;
  if (pictureRequest(whole)) return true;
  const nouns = new RegExp(`\\b(?:${EN_NOUNS}|${ES_NOUNS})\\b`, "i");
  if (!nouns.test(whole)) return false;
  return (whole.match(/\?/g) ?? []).length <= 1 && !MORE.test(whole) && whole.split(/\s+/).length <= 25;
}
