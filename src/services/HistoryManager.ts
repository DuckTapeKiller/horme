import { normalizePath } from "obsidian";
import { ChatMessage, SavedConversation } from "../types";
import HormePlugin from "../../main";
import { asArray, errorToMessage, getNumberProp, getRecordProp, getStringProp } from "../utils/TypeGuards";

const MAX_CONVERSATIONS = 200;
const WRITE_DEBOUNCE_MS = 2000;

export class HistoryManager {
  private historyPath: string;
  private pendingConvo: SavedConversation | null = null;
  private writeTimeout: number | null = null;

  constructor(private plugin: HormePlugin) {
    const configDir = plugin.app.vault.configDir;
    this.historyPath = normalizePath(
      `${configDir}/plugins/${plugin.manifest.id}/chat-history.json`
    );
  }

  private parseConversation(value: unknown): SavedConversation | null {
    const id = getStringProp(value, "id");
    if (!id) return null;
    const title = getStringProp(value, "title") ?? "Untitled chat";
    const timestamp = getNumberProp(value, "timestamp") ?? 0;

    const messagesUnknown = getRecordProp(value, "messages");
    const messagesArr = asArray(messagesUnknown) ?? [];
    const messages: ChatMessage[] = [];
    for (const m of messagesArr) {
      const role = getStringProp(m, "role");
      const content = getStringProp(m, "content");
      if (!role || !content) continue;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      const imagesUnknown = getRecordProp(m, "images");
      const images = Array.isArray(imagesUnknown)
        ? imagesUnknown.filter((x): x is string => typeof x === "string")
        : undefined;
      const audioUnknown = getRecordProp(m, "audio");
      const audio = typeof audioUnknown === "string" ? audioUnknown : null;
      messages.push({ role, content, images, audio });
    }

    return { id, title, timestamp, messages };
  }

  private parseConversations(data: string): SavedConversation[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: SavedConversation[] = [];
    for (const item of parsed) {
      const c = this.parseConversation(item);
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * Schedules a debounced write. Rapid calls during a conversation
   * only result in a single disk write 2 seconds after the last message.
   */
  async append(convo: SavedConversation): Promise<void> {
    this.pendingConvo = convo;
    if (this.writeTimeout !== null) window.clearTimeout(this.writeTimeout);
    this.writeTimeout = window.setTimeout(() => {
      void this.flushPending();
    }, WRITE_DEBOUNCE_MS);
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

      await this.plugin.app.vault.adapter.write(
        this.historyPath,
        JSON.stringify(conversations)
      );
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("History", `Failed to write history: ${errorToMessage(e)}`);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      let conversations = await this.load();
      conversations = conversations.filter(c => c.id !== id);
      await this.plugin.app.vault.adapter.write(
        this.historyPath,
        JSON.stringify(conversations)
      );
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("History", `Failed to delete history: ${errorToMessage(e)}`);
    }
  }

  async deleteAll(): Promise<void> {
    try {
      await this.plugin.app.vault.adapter.write(this.historyPath, JSON.stringify([]));
    } catch (e: unknown) {
      this.plugin.diagnosticService.report("History", `Failed to clear history: ${errorToMessage(e)}`);
    }
  }

  async load(): Promise<SavedConversation[]> {
    try {
      const exists = await this.plugin.app.vault.adapter.exists(this.historyPath);
      if (!exists) return [];
      const data = await this.plugin.app.vault.adapter.read(this.historyPath);
      return this.parseConversations(data);
    } catch {
      return [];
    }
  }
}
