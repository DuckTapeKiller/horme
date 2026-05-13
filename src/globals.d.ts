export {};

declare global {
  /**
   * Obsidian-provided reference to the currently active document.
   * Use this instead of `document` for popout window compatibility.
   */
  const activeDocument: Document;
}

