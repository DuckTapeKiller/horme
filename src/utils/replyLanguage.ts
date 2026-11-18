/**
 * The language of a message, English or Spanish, when it is clear; null when
 * it is short or mixed. A small model told only "answer in the user's
 * language" often follows the notes or skill results instead (a Spanish vault
 * pulls English questions into Spanish), so the chat names the language.
 */
const SPANISH =
  /[¿¡ñ]|\b(qué|cómo|cuál|cuáles|cuántos|cuántas|cuándo|dónde|quién|según|mis|notas|nota|sobre|el|la|los|las|del|que|es|son|para|con|una|un|por|está|están|decir|hay|tengo|esta|este|en|de|y|resume|resúmeme|explica|explícame|explícamelo|dame|busca|crea|créame|haz|hazme|muestra|enséñame|frases|página|palabra|significa|investiga|cita|fuentes|foto|imagen)\b/giu;
const ENGLISH =
  /\b(the|and|what|how|which|who|whom|when|where|why|my|is|are|was|were|of|to|about|notes|note|does|did|do|show|tell|write|find|search|picture|photo|this|that|there|many|from|in|on|a|an|it|for|with|page|please|summarise|summarize|explain|give|me|three|two|sentences|briefly|look|up|list|create|research|cite|your|sources|word|mean|means|say|says|check)\b/gi;

export function replyLanguage(text: string): "English" | "Spanish" | null {
  // Addresses hold words of every language ("en.wikipedia.org/wiki/…").
  const words = text.replace(/https?:\/\/\S+/g, " ");
  const es = (words.match(SPANISH) ?? []).length + (/[áéíóú]/i.test(words) ? 2 : 0);
  const en = (words.match(ENGLISH) ?? []).length;
  if (en >= 2 && en >= es * 2) return "English";
  if (es >= 2 && es >= en * 2) return "Spanish";
  return null;
}
