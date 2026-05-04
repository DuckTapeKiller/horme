import {
  App,
  Editor,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  MenuItem,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

/* Inlined worker code injected by esbuild for 100% offline support. */
declare var __PDF_WORKER_CODE__: string;
const workerBlob = new Blob([__PDF_WORKER_CODE__], { type: "application/javascript" });
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

/* ════════════════════════════════════════════════════════
   Settings
   ════════════════════════════════════════════════════════ */

interface HormeSettings {
  ollamaBaseUrl: string;
  defaultModel: string;
  systemPrompt: string;
  temperature: number;
  exportFolder: string;
  promptPresets: Array<{ name: string; prompt: string }>;
}

const DEFAULT_SETTINGS: HormeSettings = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  defaultModel: "",
  systemPrompt: "",
  temperature: 0.6,
  exportFolder: "HORME",
  promptPresets: [],
};

/** Stored conversation for history. */
interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: Array<{ role: string; content: string }>;
}

const VIEW_TYPE = "horme-chat";

/** Action definitions shared by context menu and commands. */
const ACTIONS: Array<{ id: string; title: string; prompt: string }> = [
  {
    id: "proofread",
    title: "Proofread",
    prompt: "Proofread the following text. Fix grammar, spelling, and punctuation errors. Return only the corrected text with no explanation.",
  },
  {
    id: "rewrite",
    title: "Rewrite",
    prompt: "Rewrite the following text to improve clarity and readability. Preserve the original meaning. Return only the rewritten text.",
  },
  {
    id: "expand",
    title: "Expand",
    prompt: "Expand the following text with more detail while maintaining the original meaning and tone. Return only the expanded text.",
  },
  {
    id: "summarize",
    title: "Summarize",
    prompt: "Summarize the following text concisely, preserving key points. Return only the summary.",
  },
  {
    id: "beautify",
    title: "Beautify Format",
    prompt: "You are a markdown formatting assistant. The user will send you a block of markdown text. Your job is to fix and beautify its structure: correct heading hierarchy, clean up bullet points and lists, normalize spacing, and ensure consistent use of bold and italics. Never alter the actual words or meaning. Return only the corrected markdown with no explanation or preamble.",
  },
  {
    id: "fact-check",
    title: "Fact check",
    prompt: "Fact-check the following text. For each claim, state whether it is accurate, inaccurate, or unverifiable, and briefly explain why. Return only the fact-check analysis.",
  },
];

/* ════════════════════════════════════════════════════════
   Translate Modal
   ════════════════════════════════════════════════════════ */

class TranslateModal extends Modal {
  private onSubmit: (lang: string) => void;

  constructor(app: App, onSubmit: (lang: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Translate to…" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "e.g. Spanish, French, Japanese",
    });
    input.addClass("horme-input");
    input.style.width = "100%";
    input.style.marginBottom = "12px";
    input.focus();

    const btn = contentEl.createEl("button", { text: "Translate" });
    btn.addClass("mod-cta");
    btn.addEventListener("click", () => {
      const lang = input.value.trim();
      if (lang) {
        this.onSubmit(lang);
        this.close();
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btn.click();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ════════════════════════════════════════════════════════
   Confirm Replace Modal
   ════════════════════════════════════════════════════════ */

class ConfirmReplaceModal extends Modal {
  private original: string;
  private replacement: string;
  private onAccept: () => void;

  constructor(app: App, original: string, replacement: string, onAccept: () => void) {
    super(app);
    this.original = original;
    this.replacement = replacement;
    this.onAccept = onAccept;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("horme-diff-modal");
    contentEl.createEl("h3", { text: "Review changes" });

    const container = contentEl.createDiv("horme-diff-container");

    const origCol = container.createDiv("horme-diff-col");
    origCol.createEl("div", { text: "Original", cls: "horme-diff-label horme-diff-label-old" });
    origCol.createEl("pre", { text: this.original, cls: "horme-diff-text" });

    const newCol = container.createDiv("horme-diff-col");
    newCol.createEl("div", { text: "Replacement", cls: "horme-diff-label horme-diff-label-new" });
    newCol.createEl("pre", { text: this.replacement, cls: "horme-diff-text" });

    const btnRow = contentEl.createDiv("horme-diff-buttons");
    const acceptBtn = btnRow.createEl("button", { text: "Accept", cls: "mod-cta" });
    acceptBtn.addEventListener("click", () => {
      this.onAccept();
      this.close();
    });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ════════════════════════════════════════════════════════
   Plugin
   ════════════════════════════════════════════════════════ */

export default class HormePlugin extends Plugin {
  settings: HormeSettings = DEFAULT_SETTINGS;
  models: string[] = [];

  /** Tracks the most recently focused markdown leaf so the chat panel
   *  can reference it even though the chat itself steals focus. */
  lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new HormeChatView(leaf, this));

    this.addRibbonIcon("cone", "Open Horme chat", () =>
      this.activateChat()
    );

    this.addCommand({
      id: "open-chat",
      name: "Open chat panel",
      callback: () => this.activateChat(),
    });

    /* Register a command for each text action so users can bind hotkeys */
    for (const a of ACTIONS) {
      this.addCommand({
        id: a.id,
        name: a.title,
        editorCallback: (editor: Editor) => {
          const sel = editor.getSelection();
          if (!sel) {
            new Notice("Horme: Select some text first.");
            return;
          }
          this.runAction(editor, sel, a.prompt);
        },
      });
    }

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection();
        if (!sel) return;
        menu.addItem((item) => {
          item.setTitle("Horme").setIcon("cone");
          const sub: Menu = (item as any).setSubmenu();
          this.buildSubmenu(sub, editor, sel);
        });
      })
    );

    /* Track the last active markdown leaf */
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView) {
          this.lastActiveMarkdownLeaf = leaf;
        }
      })
    );

    this.addSettingTab(new HormeSettingTab(this.app, this));
    this.fetchModels();
  }

  /* ── Chat activation ── */

  async activateChat() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /* ── Context menu ── */

  private buildSubmenu(menu: Menu, editor: Editor, sel: string) {
    for (const a of ACTIONS) {
      menu.addItem((item: MenuItem) => {
        item.setTitle(a.title);
        item.onClick(() => this.runAction(editor, sel, a.prompt));
      });
    }

    /* Change tone submenu */
    menu.addItem((item: MenuItem) => {
      item.setTitle("Change tone");
      const toneSub: Menu = (item as any).setSubmenu();
      for (const tone of ["Formal", "Casual", "Concise", "Friendly"]) {
        toneSub.addItem((ti: MenuItem) => {
          ti.setTitle(tone);
          ti.onClick(() =>
            this.runAction(
              editor,
              sel,
              `Change the tone of the following text to ${tone.toLowerCase()}. Return only the modified text.`
            )
          );
        });
      }
    });

    /* Fact check — already in ACTIONS loop above */

    /* Translate */
    menu.addItem((item: MenuItem) => {
      item.setTitle("Translate");
      item.onClick(() => {
        new TranslateModal(this.app, (lang) =>
          this.runAction(
            editor,
            sel,
            `Translate the following text to ${lang}. Return only the translation.`
          )
        ).open();
      });
    });
  }

  /* ── Ollama calls ── */

  private async runAction(editor: Editor, sel: string, sysPrompt: string) {
    const model = this.settings.defaultModel;
    if (!model) {
      new Notice("Horme: No model selected — configure one in settings.");
      return;
    }
    new Notice("Horme: Processing…");

    try {
      const result = await this.ollamaSync(sysPrompt, sel, model);
      /* Show confirmation modal so the user can review the diff */
      new ConfirmReplaceModal(this.app, sel, result, () => {
        editor.replaceSelection(result);
        new Notice("Horme: Done ✓");
      }).open();
    } catch (e: any) {
      this.handleError(e);
    }
  }

  /** Non-streaming call (context-menu actions). */
  async ollamaSync(
    sysPrompt: string,
    userMsg: string,
    model?: string
  ): Promise<string> {
    const msgs = this.buildMessages(sysPrompt, userMsg);
    const res = await this.ollamaFetch(msgs, false, model);
    const data = await res.json();
    return (data.message?.content ?? "").trim();
  }

  /** Streaming call (chat). Returns a ReadableStream reader. */
  async ollamaStream(
    msgs: Array<{ role: string; content: string }>,
    model?: string
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await this.ollamaFetch(msgs, true, model);
    if (!res.body) throw new Error("No response body");
    return res.body.getReader();
  }

  private async ollamaFetch(
    messages: Array<{ role: string; content: string }>,
    stream: boolean,
    model?: string
  ): Promise<Response> {
    const url = `${this.settings.ollamaBaseUrl}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model || this.settings.defaultModel,
          messages,
          stream,
          options: { temperature: this.settings.temperature },
        }),
      });
    } catch {
      throw new Error("CONN");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  /**
   * Build the messages array for Ollama.
   * Concatenates the global system prompt and the action-specific prompt
   * into a single system message to avoid issues with models that
   * mishandle multiple system messages (e.g. Gemma, Phi).
   */
  buildMessages(
    sysPrompt: string,
    userMsg: string
  ): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];

    const systemParts: string[] = [];
    const effectivePrompt = this.getEffectiveSystemPrompt();
    if (effectivePrompt) {
      systemParts.push(effectivePrompt);
    }
    if (sysPrompt) {
      systemParts.push(sysPrompt);
    }
    if (systemParts.length) {
      msgs.push({ role: "system", content: systemParts.join("\n\n") });
    }

    msgs.push({ role: "user", content: userMsg });
    return msgs;
  }

  handleError(e: any) {
    if (e?.message === "CONN") {
      new Notice("Ollama is not running. Start it and try again.");
    } else {
      new Notice(`Horme error: ${e?.message ?? "Unknown error"}`);
    }
  }

  /* ── Models ── */

  async fetchModels(): Promise<string[]> {
    try {
      const res = await fetch(
        `${this.settings.ollamaBaseUrl}/api/tags`
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      this.models = (data.models || []).map((m: any) => m.name as string);
      if (!this.settings.defaultModel && this.models.length) {
        this.settings.defaultModel = this.models[0];
        await this.saveSettings();
      }
    } catch {
      this.models = [];
    }
    return this.models;
  }

  /** Check if Ollama is reachable. */
  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.settings.ollamaBaseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Get the effective system prompt, considering per-note frontmatter overrides. */
  getEffectiveSystemPrompt(): string {
    /* Check if the last active note has a horme-prompt frontmatter key */
    const mdLeaf = this.lastActiveMarkdownLeaf;
    if (mdLeaf?.view instanceof MarkdownView) {
      const file = mdLeaf.view.file;
      if (file) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fmPrompt = cache?.frontmatter?.["horme-prompt"];
        if (typeof fmPrompt === "string" && fmPrompt.trim()) {
          return fmPrompt.trim();
        }
      }
    }
    return this.settings.systemPrompt;
  }

  /* ── Persistence ── */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ── Chat history storage ── */

  private historyStorageKey = "horme-chat-history";

  async loadChatHistory(): Promise<SavedConversation[]> {
    const raw = localStorage.getItem(this.historyStorageKey);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as SavedConversation[];
    } catch {
      return [];
    }
  }

  async saveChatHistory(convos: SavedConversation[]) {
    localStorage.setItem(this.historyStorageKey, JSON.stringify(convos));
  }

  async appendConversation(convo: SavedConversation) {
    const all = await this.loadChatHistory();
    /* Update if same id exists, else prepend */
    const idx = all.findIndex((c) => c.id === convo.id);
    if (idx >= 0) {
      all[idx] = convo;
    } else {
      all.unshift(convo);
    }
    /* Keep last 50 */
    await this.saveChatHistory(all.slice(0, 50));
  }

  async deleteAllChatHistory() {
    localStorage.removeItem(this.historyStorageKey);
  }
}

/* ════════════════════════════════════════════════════════
   Chat View
   ════════════════════════════════════════════════════════ */

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

class HormeChatView extends ItemView {
  plugin: HormePlugin;
  private history: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private contextToggle!: HTMLInputElement;
  private contextNoteLabel!: HTMLElement;
  private connectionDot!: HTMLElement;
  private presetSelect!: HTMLSelectElement;
  private isGenerating = false;
  private showingHistory = false;

  /** Active stream reader — stored so we can cancel it. */
  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  /** Last messages array sent — stored for regenerate. */
  private lastMsgs: Array<{ role: string; content: string }> | null = null;
  private lastModel: string | null = null;

  /** Unique id for the current conversation session. */
  private conversationId: string = this.generateId();

  /** Uploaded document context (injected as system message on next send). */
  private uploadedDocContent: string | null = null;
  private uploadedDocName: string | null = null;

  /** Event ref for leaf change listener (cleaned up on close). */
  private leafChangeRef: ReturnType<typeof this.app.workspace.on> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HormePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Horme";
  }

  getIcon(): string {
    return "cone";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("horme-chat-container");

    /* ── Header ── */
    const header = root.createDiv("horme-header");

    const row0 = header.createDiv("horme-header-row");
    this.connectionDot = row0.createDiv("horme-connection-dot");
    this.modelSelect = row0.createEl("select", { cls: "horme-model-select" });
    this.modelSelect.addEventListener("change", () => {
      this.plugin.settings.defaultModel = this.modelSelect.value;
      this.plugin.saveSettings();
    });

    const row1 = header.createDiv("horme-header-row");
    const clearBtn = row1.createEl("button", {
      cls: "horme-header-btn",
      text: "Clear",
    });
    clearBtn.addEventListener("click", () => this.clearChat());

    const historyBtn = row1.createEl("button", { cls: "horme-header-btn" });
    setIcon(historyBtn, "history");
    historyBtn.title = "Chat history";
    historyBtn.addEventListener("click", () => this.toggleHistoryPanel());

    const exportBtn = row1.createEl("button", { cls: "horme-header-btn" });
    setIcon(exportBtn, "download");
    exportBtn.title = "Export conversation";
    exportBtn.addEventListener("click", () => this.exportConversation());

    const refreshBtn = row1.createEl("button", { cls: "horme-header-btn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.title = "Refresh models";
    refreshBtn.addEventListener("click", () => this.refreshModels());

    /* Preset selector */
    const presets = this.plugin.settings.promptPresets;
    if (presets.length > 0) {
      const row1b = header.createDiv("horme-header-row");
      this.presetSelect = row1b.createEl("select", { cls: "horme-model-select" });
      this.presetSelect.createEl("option", { text: "Default prompt", value: "" });
      for (const p of presets) {
        this.presetSelect.createEl("option", { text: p.name, value: p.prompt });
      }
      this.presetSelect.addEventListener("change", () => {
        /* Temporarily override the system prompt for this session */
        this.plugin.settings.systemPrompt = this.presetSelect.value || "";
      });
    }

    const row2 = header.createDiv("horme-header-row");
    const label = row2.createEl("label", { cls: "horme-context-toggle" });
    this.contextToggle = label.createEl("input", { type: "checkbox" });
    label.createSpan({ text: "Use current note as context" });

    this.contextNoteLabel = header.createDiv("horme-context-note-label");
    this.contextToggle.addEventListener("change", () =>
      this.updateContextNoteLabel()
    );

    /* Listen for tab changes to keep the label current */
    this.leafChangeRef = this.app.workspace.on("active-leaf-change", () =>
      this.updateContextNoteLabel()
    );
    this.registerEvent(this.leafChangeRef);

    /* ── Messages ── */
    this.messagesEl = root.createDiv("horme-messages");
    this.renderEmpty();

    /* ── Input ── */
    const inputArea = root.createDiv("horme-input-area");

    /* Paperclip / upload button */
    const uploadBtn = inputArea.createEl("button", { cls: "horme-upload-btn" });
    setIcon(uploadBtn, "paperclip");
    uploadBtn.title = "Upload a document (PDF, TXT, MD)";
    uploadBtn.addEventListener("click", () => this.pickDocument());

    this.inputEl = inputArea.createEl("textarea", {
      cls: "horme-input",
      attr: { placeholder: "Ask Horme…", rows: "1" },
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl("button", { cls: "horme-send-btn" });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => {
      if (this.isGenerating) {
        this.stopGeneration();
      } else {
        this.sendMessage();
      }
    });

    await this.refreshModels();
    this.updateConnectionStatus();
  }

  async onClose() {
    this.contentEl.empty();
  }

  /* ── Context note label ── */

  private updateContextNoteLabel() {
    if (!this.contextToggle.checked) {
      this.contextNoteLabel.empty();
      this.contextNoteLabel.style.display = "none";
      return;
    }
    this.contextNoteLabel.style.display = "";
    const mdLeaf = this.plugin.lastActiveMarkdownLeaf;
    const mdView = mdLeaf?.view instanceof MarkdownView ? mdLeaf.view : null;
    if (mdView && mdView.file) {
      this.contextNoteLabel.textContent = `📄 ${mdView.file.basename}`;
    } else {
      this.contextNoteLabel.textContent = "No note open";
    }
  }

  /* ── Model dropdown ── */

  private async refreshModels() {
    const models = await this.plugin.fetchModels();
    this.modelSelect.empty();
    if (!models.length) {
      this.modelSelect.createEl("option", {
        text: "No models found",
        value: "",
      });
      return;
    }
    for (const m of models) {
      const opt = this.modelSelect.createEl("option", { text: m, value: m });
      if (m === this.plugin.settings.defaultModel) opt.selected = true;
    }
    this.updateConnectionStatus();
  }

  private async updateConnectionStatus() {
    const ok = await this.plugin.checkConnection();
    this.connectionDot.className = ok
      ? "horme-connection-dot horme-dot-online"
      : "horme-connection-dot horme-dot-offline";
    this.connectionDot.title = ok ? "Ollama connected" : "Ollama unreachable";
  }

  private async stopGeneration() {
    if (this.activeReader) {
      try { await this.activeReader.cancel(); } catch { /* ignore */ }
      this.activeReader = null;
    }
    this.isGenerating = false;
    setIcon(this.sendBtn, "send");
    this.sendBtn.classList.remove("horme-stop-btn");
  }

  /** Rough token estimate (~4 chars per token). */
  private estimateTokens(msgs: Array<{ role: string; content: string }>): number {
    const totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
    return Math.round(totalChars / 4);
  }

  /* ── Document upload ── */

  private pickDocument() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf,.txt,.md";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      try {
        let text: string;
        if (file.name.toLowerCase().endsWith(".pdf")) {
          text = await this.extractPdfText(file);
        } else {
          text = await file.text();
        }

        this.uploadedDocContent = text;
        this.uploadedDocName = file.name;

        /* Show confirmation in chat */
        if (!this.history.length) this.messagesEl.empty();
        const notice = this.messagesEl.createDiv("horme-doc-notice");
        notice.textContent = `📎 ${file.name} loaded as context`;
        this.scrollToBottom();

        new Notice(`📎 ${file.name} loaded as context`);
      } catch (err: any) {
        new Notice(`Could not extract text from PDF: ${err.message || err}`);
        console.error("Horme PDF extraction error:", err);
      } finally {
        fileInput.remove();
      }
    });

    fileInput.click();
  }

  private async extractPdfText(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items
        .filter((item: any) => "str" in item)
        .map((item: any) => item.str);
      pages.push(strings.join(" "));
    }

    return pages.join("\n\n");
  }

  /* ── Chat logic ── */

  private async sendMessage(regenerate = false) {
    if (this.isGenerating) return;

    let text: string;
    let msgs: Array<{ role: string; content: string }>;
    let model: string;

    if (regenerate && this.lastMsgs && this.lastModel) {
      /* Regenerate: remove last assistant message from history */
      if (this.history.length && this.history[this.history.length - 1].role === "assistant") {
        this.history.pop();
      }
      msgs = this.lastMsgs;
      model = this.lastModel;
      text = "";
    } else {
      text = this.inputEl.value.trim();
      if (!text) return;

      model = this.modelSelect.value;
      if (!model) {
        new Notice("Horme: No model selected.");
        return;
      }

      /* Clear empty state on first message */
      if (!this.history.length) this.messagesEl.empty();

      this.inputEl.value = "";
      this.autoGrow();
      this.addMessageBubble("user", text);
      this.history.push({ role: "user", content: text });

      /* Build messages array */
      msgs = [];

      /* Single merged system prompt (respects frontmatter override) */
      const systemParts: string[] = [];
      const effectivePrompt = this.plugin.getEffectiveSystemPrompt();

      if (effectivePrompt) {
        systemParts.push(effectivePrompt);
      }

      /* Note context */
      if (this.contextToggle.checked) {
        const mdLeaf = this.plugin.lastActiveMarkdownLeaf;
        const mdView =
          mdLeaf?.view instanceof MarkdownView ? mdLeaf.view : null;
        if (mdView) {
          const noteContent = mdView.editor.getValue();
          systemParts.push(
            `The user's current note:\n\n${noteContent}`
          );
        }
      }

      /* Uploaded document context */
      if (this.uploadedDocContent) {
        systemParts.push(
          `The user has uploaded a document. Its content is:\n\n${this.uploadedDocContent}`
        );
      }

      if (systemParts.length) {
        msgs.push({ role: "system", content: systemParts.join("\n\n") });
      }

      /* Conversation history */
      for (const m of this.history) {
        msgs.push({ role: m.role, content: m.content });
      }
    }

    /* Token warning */
    const tokenEstimate = this.estimateTokens(msgs);
    if (tokenEstimate > 6000) {
      new Notice(`⚠️ ~${tokenEstimate} tokens — may exceed model context window`);
    }

    /* Store for regenerate */
    this.lastMsgs = msgs;
    this.lastModel = model;

    /* Switch send button to stop button */
    this.isGenerating = true;
    setIcon(this.sendBtn, "square");
    this.sendBtn.classList.add("horme-stop-btn");
    const loadingEl = this.showLoading();

    /* Create assistant bubble */
    const bubbleEl = this.addMessageBubble("assistant", "");
    let fullContent = "";

    try {
      const reader = await this.plugin.ollamaStream(msgs, model);
      this.activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let streamDone = false;

      /* Remove loading, show bubble */
      loadingEl.remove();

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              fullContent += data.message.content;
              bubbleEl.textContent = fullContent;
              this.scrollToBottom();
            }
            if (data.done) {
              streamDone = true;
              break;
            }
          } catch {
            /* skip malformed */
          }
        }
      }

      this.activeReader = null;

      /* Re-render with markdown */
      bubbleEl.empty();
      await MarkdownRenderer.render(
        this.app,
        fullContent,
        bubbleEl,
        "",
        this
      );

      this.history.push({ role: "assistant", content: fullContent });

      /* Persist conversation after each assistant response */
      this.persistCurrentConversation();

      /* Action buttons beneath assistant bubble */
      this.addAssistantActions(bubbleEl, fullContent);
    } catch (e: any) {
      loadingEl.remove();
      if (!fullContent) bubbleEl.remove();
      this.plugin.handleError(e);
    } finally {
      this.isGenerating = false;
      this.activeReader = null;
      setIcon(this.sendBtn, "send");
      this.sendBtn.classList.remove("horme-stop-btn");
    }
  }

  /* ── Assistant action buttons ── */

  private addAssistantActions(bubbleEl: HTMLElement, content: string) {
    const wrapper = this.messagesEl.createDiv("horme-save-wrapper");

    /* Copy */
    const copyBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Copy" });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(content);
      new Notice("Copied to clipboard");
    });

    /* Regenerate */
    const regenBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Regenerate" });
    setIcon(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      /* Remove this bubble and actions before regenerating */
      bubbleEl.remove();
      wrapper.remove();
      this.sendMessage(true);
    });

    /* Save as note */
    const saveBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Save as note" });
    setIcon(saveBtn, "file-plus");
    saveBtn.addEventListener("click", async () => {
      const folder = this.plugin.settings.exportFolder.trim() || "HORME";
      if (!(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.createFolder(folder);
      }
      let baseName = this.uploadedDocName
        ? this.uploadedDocName.replace(/\.[^.]+$/, "")
        : "Horme response";
      let fileName = `${folder}/${baseName}.md`;
      if (await this.app.vault.adapter.exists(fileName)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        fileName = `${folder}/${baseName} ${ts}.md`;
      }
      await this.app.vault.create(fileName, content);
      new Notice(`Saved as ${fileName}`);
    });
  }

  /* ── Export full conversation ── */

  private async exportConversation() {
    if (!this.history.length) {
      new Notice("No conversation to export.");
      return;
    }
    const folder = this.plugin.settings.exportFolder.trim() || "HORME";
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }

    const lines: string[] = [];
    for (const m of this.history) {
      if (m.role === "system") continue;
      const label = m.role === "user" ? "**You**" : "**Horme**";
      lines.push(`${label}:\n${m.content}\n`);
    }
    const content = lines.join("\n---\n\n");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `${folder}/Horme chat ${ts}.md`;
    await this.app.vault.create(fileName, content);
    new Notice(`Exported to ${fileName}`);
  }

  /* ── UI helpers ── */

  private addMessageBubble(
    role: "user" | "assistant",
    content: string
  ): HTMLElement {
    const el = this.messagesEl.createDiv(`horme-msg horme-msg-${role}`);
    if (content) el.textContent = content;
    this.scrollToBottom();
    return el;
  }

  private showLoading(): HTMLElement {
    const el = this.messagesEl.createDiv("horme-loading");
    el.createSpan({ text: "Thinking" });
    const dots = el.createSpan({ cls: "horme-dot-pulse" });
    dots.createEl("span");
    dots.createEl("span");
    dots.createEl("span");
    this.scrollToBottom();
    return el;
  }

  private renderEmpty() {
    const empty = this.messagesEl.createDiv("horme-empty");
    const iconWrap = empty.createDiv("horme-empty-icon");
    setIcon(iconWrap, "cone");
    /* Scale the SVG up 3× */
    const svg = iconWrap.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "72");
      svg.setAttribute("height", "72");
    }
    empty.createDiv({
      cls: "horme-empty-text",
      text: "Start a conversation with Horme.",
    });
  }

  private clearChat() {
    /* Save current conversation before clearing (if it has messages) */
    this.persistCurrentConversation();
    this.history = [];
    this.conversationId = this.generateId();
    this.uploadedDocContent = null;
    this.uploadedDocName = null;
    this.messagesEl.empty();
    this.renderEmpty();
  }

  /** Persist the current conversation to history storage. */
  private async persistCurrentConversation() {
    if (this.history.length === 0) return;
    const firstUserMsg = this.history.find((m) => m.role === "user");
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60)
      : "Untitled chat";
    await this.plugin.appendConversation({
      id: this.conversationId,
      title,
      timestamp: Date.now(),
      messages: this.history.map((m) => ({ role: m.role, content: m.content })),
    });
  }

  /* ── History panel ── */

  private async toggleHistoryPanel() {
    if (this.showingHistory) {
      /* Return to chat */
      this.showingHistory = false;
      this.messagesEl.empty();
      if (this.history.length) {
        for (const m of this.history) {
          if (m.role === "user" || m.role === "assistant") {
            const bubble = this.addMessageBubble(m.role, "");
            if (m.role === "assistant") {
              await MarkdownRenderer.render(this.app, m.content, bubble, "", this);
            } else {
              bubble.textContent = m.content;
            }
          }
        }
      } else {
        this.renderEmpty();
      }
      return;
    }

    /* Show history */
    this.showingHistory = true;
    this.messagesEl.empty();
    const panel = this.messagesEl.createDiv("horme-history-panel");

    const header = panel.createDiv("horme-history-header");
    header.createEl("h4", { text: "Chat History" });

    const actions = header.createDiv("horme-history-actions");
    const backBtn = actions.createEl("button", {
      cls: "horme-header-btn",
      text: "Back",
    });
    backBtn.addEventListener("click", () => this.toggleHistoryPanel());

    const deleteAllBtn = actions.createEl("button", {
      cls: "horme-header-btn",
      text: "Delete history",
    });
    deleteAllBtn.style.color = "var(--text-error)";
    deleteAllBtn.addEventListener("click", async () => {
      await this.plugin.deleteAllChatHistory();
      this.toggleHistoryPanel(); /* re-render as empty */
      this.showingHistory = true; /* stay in history view */
      this.messagesEl.empty();
      const p2 = this.messagesEl.createDiv("horme-history-panel");
      const h2 = p2.createDiv("horme-history-header");
      h2.createEl("h4", { text: "Chat History" });
      const a2 = h2.createDiv("horme-history-actions");
      const bb = a2.createEl("button", { cls: "horme-header-btn", text: "Back" });
      bb.addEventListener("click", () => this.toggleHistoryPanel());
      p2.createDiv({ cls: "horme-history-empty", text: "No saved conversations" });
      new Notice("Chat history deleted");
    });

    const list = panel.createDiv("horme-history-list");
    const convos = await this.plugin.loadChatHistory();

    if (!convos.length) {
      list.createDiv({ cls: "horme-history-empty", text: "No saved conversations" });
      return;
    }

    for (const c of convos) {
      const item = list.createDiv("horme-history-item");
      const info = item.createDiv("horme-history-item-info");
      info.createDiv({ cls: "horme-history-item-title", text: c.title });
      info.createDiv({
        cls: "horme-history-item-date",
        text: new Date(c.timestamp).toLocaleString(),
      });
      item.addEventListener("click", () => this.loadConversation(c));
    }
  }

  private async loadConversation(convo: SavedConversation) {
    /* Persist current before switching */
    await this.persistCurrentConversation();

    this.showingHistory = false;
    this.conversationId = convo.id;
    this.history = convo.messages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));
    this.messagesEl.empty();

    for (const m of this.history) {
      if (m.role === "user" || m.role === "assistant") {
        const bubble = this.addMessageBubble(m.role, "");
        if (m.role === "assistant") {
          await MarkdownRenderer.render(this.app, m.content, bubble, "", this);
          this.addAssistantActions(bubble, m.content);
        } else {
          bubble.textContent = m.content;
        }
      }
    }
    this.scrollToBottom();
  }

  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private autoGrow() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 140) + "px";
  }
}

/* ════════════════════════════════════════════════════════
   Settings Tab
   ════════════════════════════════════════════════════════ */

class HormeSettingTab extends PluginSettingTab {
  plugin: HormePlugin;

  constructor(app: App, plugin: HormePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Horme Settings" });

    /* Ollama URL */
    new Setting(containerEl)
      .setName("Ollama base URL")
      .setDesc("Base URL for the Ollama API server.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange(async (v) => {
            this.plugin.settings.ollamaBaseUrl = v.trim() || DEFAULT_SETTINGS.ollamaBaseUrl;
            await this.plugin.saveSettings();
          })
      );

    /* Model selector */
    await this.plugin.fetchModels();
    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Select the Ollama model to use.")
      .addDropdown((dd) => {
        if (!this.plugin.models.length) {
          dd.addOption("", "No models found");
        }
        for (const m of this.plugin.models) {
          dd.addOption(m, m);
        }
        dd.setValue(this.plugin.settings.defaultModel);
        dd.onChange(async (v) => {
          this.plugin.settings.defaultModel = v;
          await this.plugin.saveSettings();
        });
      });

    /* System prompt */
    new Setting(containerEl)
      .setName("Custom system prompt")
      .setDesc("Applied to all interactions (chat and context-menu actions).")
      .addTextArea((ta) =>
        ta
          .setPlaceholder("e.g. Always reply in a concise style.")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (v) => {
            this.plugin.settings.systemPrompt = v;
            await this.plugin.saveSettings();
          })
      );

    /* Temperature */
    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(`Controls randomness (current: ${this.plugin.settings.temperature.toFixed(1)})`)
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.1)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.temperature = v;
            await this.plugin.saveSettings();
            this.display(); // refresh description
          })
      );

    /* Export folder */
    new Setting(containerEl)
      .setName("Export folder")
      .setDesc("Folder where \"Save as note\" files are created (relative to vault root).")
      .addText((text) =>
        text
          .setPlaceholder("HORME")
          .setValue(this.plugin.settings.exportFolder)
          .onChange(async (v) => {
            this.plugin.settings.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
            await this.plugin.saveSettings();
          })
      );

    /* ── Prompt Presets ── */
    containerEl.createEl("h3", { text: "System Prompt Presets" });
    containerEl.createEl("p", {
      text: "Named presets appear as a dropdown in the chat panel. You can also override the system prompt per-note by adding horme-prompt: \"your prompt\" to the note's YAML frontmatter.",
      cls: "setting-item-description",
    });

    const presets = this.plugin.settings.promptPresets;

    for (let i = 0; i < presets.length; i++) {
      const p = presets[i];
      new Setting(containerEl)
        .setName(p.name || `Preset ${i + 1}`)
        .addText((t) =>
          t.setPlaceholder("Name").setValue(p.name).onChange(async (v) => {
            presets[i].name = v;
            await this.plugin.saveSettings();
          })
        )
        .addTextArea((ta) =>
          ta.setPlaceholder("System prompt").setValue(p.prompt).onChange(async (v) => {
            presets[i].prompt = v;
            await this.plugin.saveSettings();
          })
        )
        .addButton((btn) =>
          btn.setButtonText("Delete").onClick(async () => {
            presets.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Add preset").setCta().onClick(async () => {
        presets.push({ name: "", prompt: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}
