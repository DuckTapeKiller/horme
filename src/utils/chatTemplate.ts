/**
 * Where a chat template puts its thinking switch. Qwen-style templates close
 * an empty thinking block at the end of the prompt, so turning thinking off
 * for one round leaves the rest of the prompt as it was. Gemma 4 writes its
 * switch at the very top: turning thinking off there changes the whole prompt,
 * and the server reads all of it again instead of reusing its cache (34 s
 * instead of 9 s for a 9,600-token prompt with gemma 4 E4B on llama.cpp).
 */
export function thinkingSwitchAtTop(promptOn: string, promptOff: string, userText: string): boolean {
  const n = Math.min(promptOn.length, promptOff.length);
  let i = 0;
  while (i < n && promptOn[i] === promptOff[i]) i++;
  if (i === promptOn.length && i === promptOff.length) return false; // no switch at all
  const user = promptOn.indexOf(userText);
  return user >= 0 && i < user;
}
