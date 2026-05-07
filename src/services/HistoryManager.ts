import { App, normalizePath } from "obsidian";
import { SavedConversation } from "../types";

const MAX_CONVERSATIONS = 200;
const WRITE_DEBOUNCE_MS = 2000;

export class HistoryManager {
  private app: App;
  private historyPath: string;
  private pendingConvo: SavedConversation | null = null;
  private writeTimeout: number | null = null;

  constructor(app: App) {
    this.app = app;
    const configDir = this.app.vault.configDir;
    this.historyPath = normalizePath(
      `${configDir}/plugins/horme/chat-history.json`
    );
  }

  /**
   * Schedules a debounced write. Rapid calls during a conversation
   * only result in a single disk write 2 seconds after the last message.
   */
  async append(convo: SavedConversation): Promise<void> {
    this.pendingConvo = convo;
    if (this.writeTimeout !== null) window.clearTimeout(this.writeTimeout);
    this.writeTimeout = window.setTimeout(() => this.flushPending(), WRITE_DEBOUNCE_MS);
  }

  /**
   * Force an immediate write. Call this from onClose() so
   * in-progress conversations are never lost when the view closes.
   */
  async flush(): Promise<void> {
    if (this.writeTimeout !== null) {
      window.clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    await this.flushPending();
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingConvo) return;
    const convo = this.pendingConvo;
    this.pendingConvo = null;

    try {
      let conversations = await this.load();
      const idx = conversations.findIndex(c => c.id === convo.id);
      if (idx >= 0) conversations[idx] = convo;
      else conversations.unshift(convo);

      // Trim oldest conversations beyond the cap
      if (conversations.length > MAX_CONVERSATIONS) {
        conversations = conversations.slice(0, MAX_CONVERSATIONS);
      }

      await this.app.vault.adapter.write(
        this.historyPath,
        JSON.stringify(conversations)
      );
    } catch (e) {
      console.error("Horme: Failed to write chat history", e);
    }
  }

  async load(): Promise<SavedConversation[]> {
    try {
      const exists = await this.app.vault.adapter.exists(this.historyPath);
      if (!exists) return [];
      const data = await this.app.vault.adapter.read(this.historyPath);
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}
