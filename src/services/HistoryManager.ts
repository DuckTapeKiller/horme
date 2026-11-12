import { Notice, normalizePath } from "obsidian";
import { ChatMessage, SavedConversation } from "../types";
import HormePlugin from "../../main";
import { asArray, errorToMessage, getNumberProp, getRecordProp, getStringProp } from "../utils/TypeGuards";

const MAX_CONVERSATIONS = 200;
const WRITE_DEBOUNCE_MS = 2000;

export class HistoryManager {
  private historyPath: string;
  private writeTimeout: number | null = null;

  constructor(private plugin: HormePlugin) {
    const configDir = plugin.app.vault.configDir;
    this.historyPath = normalizePath(`${configDir}/plugins/${plugin.manifest.id}/chat-history.json`);
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
      const content = getStringProp(m, "content") ?? "";
      const reasoning = getStringProp(m, "reasoning");
      const context = getStringProp(m, "context");
      if (!role) continue;
      if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool_result") continue;
      // Keep messages that carry only a reasoning/context trace (e.g. a stopped
      // reasoning-model turn), but still skip genuinely empty ones.
      if (!content && !reasoning && !context) continue;
      const imagesUnknown = getRecordProp(m, "images");
      const images = Array.isArray(imagesUnknown)
        ? imagesUnknown.filter((x): x is string => typeof x === "string")
        : undefined;
      const audioUnknown = getRecordProp(m, "audio");
      const audio = typeof audioUnknown === "string" ? audioUnknown : null;
      const sourcesUnknown = getRecordProp(m, "sources");
      const sources = Array.isArray(sourcesUnknown)
        ? sourcesUnknown.filter((x): x is string => typeof x === "string")
        : undefined;
      // A reply that was only pictures: drawn as the cards above it, without text.
      const picturesOnly = getRecordProp(m, "picturesOnly") === true ? true : undefined;
      messages.push({ role, content, images, audio, reasoning, context, sources, picturesOnly });
    }

    return { id, title, timestamp, messages };
  }

  /** Parses the history file. Throws when it is not a valid history, so callers never overwrite it. */
  private parseConversations(data: string): { list: SavedConversation[]; unparsed: unknown[] } {
    if (!data.trim()) return { list: [], unparsed: [] };
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) throw new Error("chat-history.json does not hold a list of chats");
    const list: SavedConversation[] = [];
    // Entries Horme cannot read are written back untouched, never dropped.
    const unparsed: unknown[] = [];
    for (const item of parsed) {
      const c = this.parseConversation(item);
      if (c) list.push(c);
      else unparsed.push(item);
    }
    return { list, unparsed };
  }

  /** Chats waiting for the debounced write, by id. */
  private pending = new Map<string, SavedConversation>();
  /** Writes run one after another, so two saves never interleave their read and write. */
  private chain: Promise<void> = Promise.resolve();
  /** Set once the file proved unreadable; writing is refused until Obsidian restarts. */
  private unreadable = false;

  /**
   * Schedules a debounced write. Rapid calls during a conversation
   * only result in a single disk write 2 seconds after the last message.
   */
  async append(convo: SavedConversation): Promise<void> {
    this.pending.set(convo.id, convo);
    if (this.writeTimeout !== null) window.clearTimeout(this.writeTimeout);
    this.writeTimeout = window.setTimeout(() => {
      this.writeTimeout = null;
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

  private flushPending(): Promise<void> {
    if (this.pending.size === 0) return this.chain;
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    // A failed write puts the batch back (unless a newer save replaced it), so
    // the next message or the close of the view tries again.
    const requeue = () => {
      for (const convo of batch) if (!this.pending.has(convo.id)) this.pending.set(convo.id, convo);
    };
    return this.update(
      (conversations) => {
        for (const convo of batch) {
          const idx = conversations.findIndex((c) => c.id === convo.id);
          if (idx >= 0) conversations.splice(idx, 1);
          // The chat used last goes first, so the cap drops the least recently used.
          conversations.unshift(convo);
        }
        return conversations.slice(0, MAX_CONVERSATIONS);
      },
      "write",
      requeue,
    );
  }

  /** Reads, changes and writes the history file, after any write already queued. */
  private update(
    change: (list: SavedConversation[]) => SavedConversation[],
    what: string,
    onFail?: () => void,
  ): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        const { list, unparsed } = await this.readStrict();
        const next: unknown[] = [...change(list), ...unparsed];
        await this.plugin.app.vault.adapter.write(this.historyPath, JSON.stringify(next));
      } catch (e: unknown) {
        onFail?.();
        this.report(what, e);
      }
    });
    return this.chain;
  }

  async delete(id: string): Promise<void> {
    // A save still waiting would bring the chat back.
    this.pending.delete(id);
    await this.update((list) => list.filter((c) => c.id !== id), "delete");
  }

  async deleteAll(): Promise<void> {
    this.pending.clear();
    if (this.writeTimeout !== null) {
      window.clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    // Clearing replaces the file outright, so it works even when the file could
    // not be read (a copy of it was kept when that was found).
    this.chain = this.chain.then(async () => {
      try {
        await this.plugin.app.vault.adapter.write(this.historyPath, "[]");
        this.unreadable = false;
      } catch (e: unknown) {
        this.report("clear", e);
      }
    });
    await this.chain;
  }

  private report(what: string, e: unknown): void {
    this.plugin.diagnosticService.report("History", `Failed to ${what} history: ${errorToMessage(e)}`);
    new Notice(
      `Horme: Chat history could not be ${what === "write" ? "saved" : what === "delete" ? "updated" : "cleared"}. See Diagnostics.`,
    );
  }

  /**
   * Reads the file for a write. A missing file is an empty history; a file
   * that exists but cannot be read or parsed throws, and is backed up once, so
   * a passing read error (a sync tool mid-write, a lock) never wipes it.
   */
  private async readStrict(): Promise<{ list: SavedConversation[]; unparsed: unknown[] }> {
    if (this.unreadable) throw new Error("the history file could not be read earlier; not overwriting it");
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(this.historyPath))) return { list: [], unparsed: [] };
    const data = await adapter.read(this.historyPath);
    try {
      return this.parseConversations(data);
    } catch (e: unknown) {
      this.unreadable = true;
      const backup = `${this.historyPath}.unreadable-${Date.now()}.bak`;
      try {
        await adapter.write(backup, data);
      } catch {
        /* the original stays in place either way */
      }
      throw new Error(
        `chat-history.json could not be parsed (${errorToMessage(e)}); kept as is, copy at ${backup}`,
      );
    }
  }

  /** The saved chats, newest first, including any not yet written to disk. */
  async load(): Promise<SavedConversation[]> {
    let list: SavedConversation[] = [];
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (await adapter.exists(this.historyPath))
        list = this.parseConversations(await adapter.read(this.historyPath)).list;
    } catch (e: unknown) {
      this.plugin.diagnosticService.report(
        "History",
        `Failed to read history: ${errorToMessage(e)}`,
        "warning",
      );
    }
    for (const convo of this.pending.values()) {
      list = [convo, ...list.filter((c) => c.id !== convo.id)];
    }
    return list;
  }
}
