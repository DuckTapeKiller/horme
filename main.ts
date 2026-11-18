import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  WorkspaceLeaf,
  TFile,
  TAbstractFile,
  TFolder,
  Platform,
  addIcon,
} from "obsidian";

// Modals
import { RewriteModal } from "./src/modals/RewriteModal";
import { HormeErrorModal } from "./src/modals/HormeErrorModal";

// Services
import { DocxService } from "./src/services/DocxService";
import { HistoryManager } from "./src/services/HistoryManager";
import { TagService } from "./src/services/TagService";
import { EmbeddingService } from "./src/services/EmbeddingService";
import { VaultIndexer } from "./src/services/VaultIndexer";
import { VaultSearch } from "./src/services/VaultSearch";
import { NoteActions } from "./src/services/NoteActions";
import { AppleModelServer } from "./src/services/AppleModelServer";
import { TagTranslator } from "./src/services/TagTranslator";
import { TagIndexer } from "./src/services/TagIndexer";
import { SkillManager } from "./src/services/SkillManager";
import { GrammarIndexer } from "./src/services/GrammarIndexer";
import { DiagnosticService } from "./src/services/DiagnosticService";

// Providers
import { AiGateway } from "./src/providers/AiGateway";
import { errorToMessage } from "./src/utils/TypeGuards";

// Views
import { HormeChatView } from "./src/views/HormeChatView";
import { HormeConnectionsView } from "./src/views/HormeConnectionsView";
import { HormeSettingTab } from "./src/views/HormeSettingTab";

// Constants & Types
import {
  DEFAULT_SETTINGS,
  VIEW_TYPE,
  CONNECTIONS_VIEW_TYPE,
  ACTIONS,
  PROVIDER_MODELS,
  DEFAULT_SYSTEM_PROMPT,
} from "./src/constants";
import { HormeSettings, AiProvider } from "./src/types";
import { RETIRED_MODELS, replaceRetiredModels } from "./src/utils/retiredModels";
import {
  applyMobileOverride,
  parsePhoneChoice,
  removeMobileOverride,
  settingsForDisk,
  syncMobileOverride,
  type MobileOverride,
  type PhoneChoice,
} from "./src/utils/mobileOverride";
import { checkConnection, listModels, ollamaModelTags } from "./src/providers/catalog";
import { isOllamaEmbeddingModel, pickOllamaChatModel, type OllamaModelTag } from "./src/utils/ollamaModels";
import { providerInfo, providerSecretId } from "./src/providers/registry";
import { repairSettings } from "./src/utils/settingsRepair";
import {
  bearer,
  embeddingBlock,
  isLocalServer,
  notesDestination,
  initialEmbeddingSource,
  keepsNotesPrivate,
  type LocalServerId,
} from "./src/utils/providerAccess";

/** Where a phone keeps the provider and model it chose for itself (device storage). */
const PHONE_CHOICE_KEY = "horme-phone-choice";

export default class HormePlugin extends Plugin {
  // Set in onload(), before anything reads them.
  settings!: HormeSettings;
  models: string[] = [];
  lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;

  docxService!: DocxService;
  historyManager!: HistoryManager;
  tagService!: TagService;
  embeddingService!: EmbeddingService;
  vaultIndexer!: VaultIndexer;
  vaultSearch!: VaultSearch;
  tagTranslator!: TagTranslator;
  tagIndexer!: TagIndexer;
  aiGateway!: AiGateway;
  noteActions!: NoteActions;
  skillManager!: SkillManager;
  grammarIndexer!: GrammarIndexer;
  diagnosticService!: DiagnosticService;
  /** Apple's model server on this Mac, started when Apple Intelligence is first used. */
  readonly appleServer = new AppleModelServer();
  private settingTab: HormeSettingTab | null = null;

  private indexDebounceMap = new Map<string, number>();
  private statusBarItem: HTMLElement | null = null;
  private backgroundStatusText: string | null = null;
  private foregroundStatusText: string | null = null;
  private settingsChangeListeners = new Set<() => void>();
  /** Set on a phone or tablet while "Use a different provider on mobile" is on. */
  private mobileOverride: MobileOverride | null = null;
  /** The phone's own choice as last written to this device's storage, as JSON. */
  private storedPhoneChoice: string | null = null;
  /** The provider in use at the last save, for the cloud privacy warnings. */
  /** Where the chat's requests went at the last save (see notesDestination). */
  private _lastPersistedDestination: string | null = null;

  onSettingsChange(cb: () => void): () => void {
    this.settingsChangeListeners.add(cb);
    return () => this.settingsChangeListeners.delete(cb);
  }

  private isCloudProvider(p: AiProvider): boolean {
    return !keepsNotesPrivate(this.settings, p);
  }

  private getSecretIdForProvider(p: AiProvider): string | null {
    return providerSecretId(this.settings, p) || null;
  }

  /**
   * The Authorization header for a local server, or no header when it has no
   * key. The llama.cpp embedding server uses its own key, else the chat
   * server's (both are usually started with the same --api-key).
   */
  serverAuth(p: LocalServerId, purpose: "chat" | "embedding" = "chat"): Record<string, string> {
    if (p === "llamacpp" && purpose === "embedding") {
      return bearer(
        this.getSecretValue(this.settings.llamaCppEmbeddingSecretId) || this.getApiKeyForProvider("llamacpp"),
      );
    }
    return bearer(this.getApiKeyForProvider(p));
  }

  /** A key kept in Obsidian's keychain, by the name stored in the settings; "" when unset. */
  getSecretValue(secretId: string): string {
    const id = (secretId || "").trim();
    if (!id) return "";
    try {
      return this.app.secretStorage.getSecret(id) ?? "";
    } catch {
      return "";
    }
  }

  getApiKeyForProvider(p: AiProvider): string {
    const secretId = this.getSecretIdForProvider(p);
    if (!secretId) return "";
    try {
      return this.app.secretStorage.getSecret(secretId) ?? "";
    } catch {
      return "";
    }
  }

  debugLog(...args: unknown[]) {
    if (!this.settings?.debugLoggingEnabled) return;
    // console.debug (not console.log) prints to DevTools while satisfying Obsidian's
    // no-console rule, which allows debug/warn/error but not log.
    console.debug(...args);
  }

  private lastProviderWarning = 0;

  /**
   * Something the user should know about a reply that still arrived (Ollama
   * cut the request to fit its context window). Always logged; shown at most
   * once a minute, so a long chat is not covered in notices.
   */
  providerWarning(source: string, message: string): void {
    this.diagnosticService.report(source, message, "warning");
    if (Date.now() - this.lastProviderWarning < 60_000) return;
    this.lastProviderWarning = Date.now();
    new Notice(`Horme: ${message}`, 15000);
  }

  debugWarn(...args: unknown[]) {
    if (!this.settings?.debugLoggingEnabled) return;
    console.warn(...args);
  }

  /** Sets Ollama's chat model when none is set or the one set is no longer installed. */
  private async maybeAutodetectOllamaDefaultModel(tagsModels: OllamaModelTag[], fetchedNames: string[]) {
    const current = (this.settings.defaultModel || "").trim();
    if (current && fetchedNames.includes(current)) return;

    const picked = pickOllamaChatModel(tagsModels, current);
    if (!picked) return;

    const prev = current;
    this.settings.defaultModel = picked;
    await this.saveSettings();

    if (prev) {
      this.diagnosticService?.report(
        "Ollama",
        `Default model "${prev}" not found. Auto-selected "${picked}".`,
        "warning",
      );
      new Notice(`Horme: Ollama model "${prev}" not found. Switched to "${picked}".`);
    } else {
      this.diagnosticService?.report("Ollama", `Auto-selected default model "${picked}".`, "info");
    }
  }

  async onload() {
    await this.loadSettings();

    // Register Custom Icons
    // addIcon takes the drawing only, on a 100 × 100 grid: Obsidian supplies the
    // <svg>. A whole 24 × 24 <svg> here became a second <svg> inside the icon,
    // which the stop button's spin rule also turned, about its top-left corner.
    addIcon(
      "horme-shell",
      `<g transform="scale(4.1666667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22 2 2 0 1 1 3.16 2.44"/></g>`,
    );

    // On a phone or tablet, switch to the mobile provider and model.
    this.updateMobileOverride();
    this._lastPersistedDestination = notesDestination(this.settings, this.settings.aiProvider);

    // Initialize Services
    this.diagnosticService = new DiagnosticService(this);
    this.register(() => this.appleServer.stop());
    this.docxService = new DocxService();
    this.historyManager = new HistoryManager(this);
    this.tagService = new TagService(this.app);
    this.embeddingService = new EmbeddingService(this);
    this.grammarIndexer = new GrammarIndexer(this);
    this.tagTranslator = new TagTranslator(this);
    this.vaultIndexer = new VaultIndexer(this);
    this.vaultSearch = new VaultSearch(this, this.vaultIndexer);
    this.tagIndexer = new TagIndexer(this);
    this.skillManager = new SkillManager(this);
    this.aiGateway = new AiGateway(this);
    this.noteActions = new NoteActions(this);

    this.registerView(VIEW_TYPE, (leaf) => new HormeChatView(leaf, this));
    this.registerView(CONNECTIONS_VIEW_TYPE, (leaf) => new HormeConnectionsView(leaf, this));

    this.addRibbonIcon("cone", "Open Horme chat", () => {
      void this.activateChat().catch((e) => this.handleError(e));
    });
    this.addRibbonIcon("cable", "Open Horme connections", () => {
      void this.activateConnections().catch((e) => this.handleError(e));
    });

    this.registerCommands();
    this.registerMenus();
    this.registerIndexing();

    this.settingTab = new HormeSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Load indexes
    await this.grammarIndexer.loadIndex();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("horme-status-bar-item");
    this.statusBarItem.hide();

    // Not awaited: a provider that is down or slow must not hold up Obsidian's start.
    void this.fetchModels();

    // The note already open counts as the current note, even when the chat
    // had the focus when Obsidian last closed. The workspace may still be
    // loading here, so it is looked up again once the layout is ready.
    this.rememberOpenNote();
    this.app.workspace.onLayoutReady(() => this.rememberOpenNote());

    this.trackActiveNote();
  }

  /** Commands: open the panels, the text actions, tags, summaries and DOCX export. */
  private registerCommands(): void {
    this.addCommand({
      id: "open-chat",
      name: "Open chat panel",
      callback: () => {
        void this.activateChat().catch((e) => this.handleError(e));
      },
    });

    this.addCommand({
      id: "open-connections",
      name: "Open connections panel",
      callback: () => {
        void this.activateConnections().catch((e) => this.handleError(e));
      },
    });

    // Register text actions
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
          void this.noteActions.runAction(editor, sel, a.prompt, a.id).catch((e) => this.handleError(e));
        },
      });
    }

    // Rewrite (with tone picker)
    this.addCommand({
      id: "rewrite",
      name: "Rewrite",
      editorCallback: (editor: Editor) => {
        const sel = editor.getSelection();
        if (!sel) {
          new Notice("Horme: Select some text first.");
          return;
        }
        new RewriteModal(this.app, (tone) => {
          const prompt = `Rewrite the following text in a ${tone} tone. Preserve the original meaning. Return only the rewritten text.`;
          void this.noteActions.runAction(editor, sel, prompt, "rewrite").catch((e) => this.handleError(e));
        }).open();
      },
    });

    // Generate frontmatter summary
    this.addCommand({
      id: "generate-summary",
      name: "Generate frontmatter summary",
      callback: () => {
        void this.noteActions.generateFrontmatterSummary().catch((e) => this.handleError(e));
      },
    });

    this.addCommand({
      id: "suggest-frontmatter-tags",
      name: "Suggest frontmatter tags",
      checkCallback: (checking) => {
        const view =
          this.app.workspace.getActiveViewOfType(MarkdownView) ||
          (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView
            ? this.lastActiveMarkdownLeaf.view
            : null);
        const hasFile = Boolean(view?.file);
        if (checking) return hasFile;
        if (hasFile) void this.noteActions.suggestTagsForActiveNote().catch((e) => this.handleError(e));
        return true;
      },
    });

    this.addCommand({
      id: "convert-note-to-docx",
      name: "Convert active note to DOCX",
      checkCallback: (checking: boolean) => {
        const view =
          this.app.workspace.getActiveViewOfType(MarkdownView) ||
          (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView
            ? this.lastActiveMarkdownLeaf.view
            : null);
        if (view) {
          if (!checking) void this.noteActions.convertActiveNoteToDocx(view);
          return true;
        }
        return false;
      },
    });
  }

  /** Horme's items in the editor's right-click menu and the file menu. */
  private registerMenus(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection();
        if (!sel) return;
        menu.addItem((item) => {
          item.setTitle("Horme").setIcon("cone");
          const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
          this.noteActions.buildSubmenu(sub, editor, sel);
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Horme: Convert to DOCX")
              .setIcon("download")
              .onClick(() => {
                void this.noteActions.convertMarkdownFileToDocx(file);
              });
          });
        }
      }),
    );
  }

  /** Keeps Vault Brain's index in step with the vault: edits, new notes, deletions and renames. */
  private registerIndexing(): void {
    // --- Vault Brain Auto-Pilot ---
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || !file.path.endsWith(".md")) return;

        // Debounce 2 seconds per file
        const existing = this.indexDebounceMap.get(file.path);
        if (existing !== undefined) window.clearTimeout(existing);
        const timeout = window.setTimeout(() => {
          void this.vaultIndexer
            .enqueueIndex(file)
            .catch((e) =>
              this.diagnosticService.report(
                "Vault Brain",
                `Auto-index failed: ${e instanceof Error ? e.message : String(e)}`,
                "warning",
              ),
            )
            .finally(() => this.indexDebounceMap.delete(file.path));
        }, 2000);
        this.indexDebounceMap.set(file.path, timeout);
      }),
    );

    // Obsidian fires "create" for every file while the vault loads; registering
    // after the layout is ready means only notes created afterwards are queued.
    this.app.workspace.onLayoutReady(() => {
      // Notes deleted, added or changed while Horme was not running.
      void this.vaultIndexer
        .reconcileWithVault()
        .catch((e: unknown) =>
          this.diagnosticService.report(
            "Vault Brain",
            `Start-up clean-up failed: ${errorToMessage(e)}`,
            "warning",
          ),
        );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && this.vaultIndexer.indexes(file)) {
            void this.vaultIndexer.enqueueIndex(file).catch((e) => this.handleError(e));
          }
        }),
      );
    });

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.path.endsWith(".md")) {
          const existing = this.indexDebounceMap.get(file.path);
          if (existing !== undefined) {
            window.clearTimeout(existing);
            this.indexDebounceMap.delete(file.path);
          }
        }
        this.vaultIndexer.forgetNote(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const existing = this.indexDebounceMap.get(oldPath);
        if (existing !== undefined) {
          window.clearTimeout(existing);
          this.indexDebounceMap.delete(oldPath);
        }
        this.vaultIndexer.forgetNote(oldPath);
        // Under its new name, if Vault Brain indexes it there: notes, and PDFs
        // when PDF indexing is on (a renamed PDF used to leave the index).
        if (this.vaultIndexer.indexes(file)) {
          void this.vaultIndexer.enqueueIndex(file).catch((e) => this.handleError(e));
        }
      }),
    );
  }

  /** Remembers the note last used, for the chat's current note, tags and summaries. */
  private trackActiveNote(): void {
    // LIVE NOTE TRACKING: Ensure Horme always knows which note is active for Tagging/Context
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastActiveMarkdownLeaf = leaf;

          // Trigger connections view refresh if it's open
          if (this.settings.connectionsEnabled) {
            const connLeaves = this.app.workspace.getLeavesOfType(CONNECTIONS_VIEW_TYPE);
            if (connLeaves.length > 0) {
              const connView = connLeaves[0].view;
              if (leaf.view.file && connView instanceof HormeConnectionsView) {
                connView.updateConnections(leaf.view.file.path);
              }
            }
          }
        }
      }),
    );
  }

  onunload() {
    // A change made in the last moment before the plugin is turned off.
    this.settingTab?.flushSave();
    for (const handle of this.indexDebounceMap.values()) window.clearTimeout(handle);
    this.indexDebounceMap.clear();
    void this.vaultIndexer?.flush();
    void this.historyManager?.flush();
  }

  /**
   * True when the chat provider keeps what it is sent on the user's own
   * machines: a local server, or the OpenAI-compatible server the user says
   * is theirs. Every privacy check asks this.
   */
  /** Takes the most recently used note in the main area as the current note, if none is known. */
  private rememberOpenNote(): void {
    if (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView) return;
    const ws = this.app.workspace;
    const recent = ws.getMostRecentLeaf();
    this.lastActiveMarkdownLeaf =
      ws.getActiveViewOfType(MarkdownView)?.leaf ??
      (recent?.view instanceof MarkdownView ? recent : null) ??
      ws.getLeavesOfType("markdown")[0] ??
      null;
  }

  isLocalProviderActive(): boolean {
    return keepsNotesPrivate(this.settings, this.settings.aiProvider);
  }

  /**
   * Why Vault Brain cannot use its embedding server on this device, or null
   * when it can: the server may not be sent notes, or (on a phone or tablet)
   * its address is the device itself. It has nothing to do with the chat
   * provider.
   */
  embeddingBlock(): string | null {
    return embeddingBlock(this.settings, Platform.isMobile);
  }

  /* ── Core ── */

  async activateChat() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      // Explicitly try to get the right sidebar leaf
      leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf;
      if (!leaf) {
        new Notice("Horme: Could not open chat panel.");
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    // On mobile, ensure the right sidebar is actually opened
    if (Platform.isMobile) {
      this.app.workspace.rightSplit.expand();
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  async activateConnections() {
    if (!this.settings.connectionsEnabled) {
      new Notice("Horme: Connections feature is disabled in settings.");
      return;
    }

    let leaf = this.app.workspace.getLeavesOfType(CONNECTIONS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf;
      if (!leaf) {
        new Notice("Horme: Could not open connections panel.");
        return;
      }
      await leaf.setViewState({ type: CONNECTIONS_VIEW_TYPE, active: true });
    }

    if (Platform.isMobile) {
      this.app.workspace.rightSplit.expand();
    }

    await this.app.workspace.revealLeaf(leaf);

    // Initial load
    const activeView =
      this.app.workspace.getActiveViewOfType(MarkdownView) ||
      (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView ? this.lastActiveMarkdownLeaf.view : null);
    if (activeView && activeView.file) {
      (leaf.view as HormeConnectionsView).updateConnections(activeView.file.path);
    }
  }

  /**
   * The models the chat's model menu offers: what a server the user runs has
   * (Ollama's chat model is picked when none is set), or the common models of
   * a cloud service, whose own lists can run to hundreds.
   */
  async fetchModels(): Promise<string[]> {
    const provider = this.settings.aiProvider;
    if (provider === "ollama") {
      const tags = await ollamaModelTags(this);
      // Embedding models cannot chat; keep them out of the chat's model menu.
      const names = tags.filter((t) => !isOllamaEmbeddingModel(t)).map((t) => t.name);
      await this.maybeAutodetectOllamaDefaultModel(tags, names);
      this.models = names;
    } else if (isLocalServer(provider) || provider === "custom" || provider === "apple") {
      this.models = (await listModels(this, provider, "chat")).models;
    } else {
      this.models = PROVIDER_MODELS[provider] ?? [];
    }
    return this.models;
  }

  /** True when the chat provider answers: reachable, and its key (if any) accepted. */
  checkConnection(): Promise<boolean> {
    return checkConnection(this);
  }

  handleError(e: unknown, context?: string) {
    console.error("Horme Error:", e);
    const title = context || "Plugin Error";
    const message = errorToMessage(e) || "An unknown error occurred.";

    // Log to Intelligence Hub
    this.diagnosticService.report(title, message, "error");

    // Visual alert
    new HormeErrorModal(this.app, title, message).open();
  }

  async getEffectiveSystemPrompt(): Promise<string> {
    let prompt = DEFAULT_SYSTEM_PROMPT;
    const path = this.settings.systemPromptPath.trim();
    if (path) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          const content = await this.app.vault.read(file);
          if (content.trim()) prompt = content;
        } catch (e: unknown) {
          console.error("Horme: Failed to read system prompt note", e);
          this.diagnosticService.report(
            "System Prompt",
            `Failed to read prompt note: ${errorToMessage(e)}`,
            "warning",
          );
        }
      }
    }

    // Always append mandatory quotation rules by language
    prompt +=
      '\n\nQuotation marks by language: If responding in Spanish, use angled quotation marks (« ») for normal quotations and do not use standard double quotes (" ") except where technically required (code, commands, file paths, JSON/YAML, programming syntax) or for inner quotations nested within « ». If responding in English, use standard double quotes (" ") for normal quotations and do not use « ». Preserve code and technical syntax exactly as required.';

    return prompt;
  }

  async getChatPresets(): Promise<Array<{ name: string; prompt: string }>> {
    const paths = this.settings.presetsPaths || [];
    const presets: Array<{ name: string; prompt: string }> = [];
    const seenPaths = new Set<string>();

    for (const path of paths) {
      if (!path.trim()) continue;
      const abstractFile = this.app.vault.getAbstractFileByPath(path.trim());
      if (!abstractFile) continue;

      if (abstractFile instanceof TFile && abstractFile.extension === "md") {
        await this.addPresetFromFile(abstractFile, presets, seenPaths);
      } else if (abstractFile instanceof TFolder) {
        for (const child of abstractFile.children) {
          if (child instanceof TFile && child.extension === "md") {
            await this.addPresetFromFile(child, presets, seenPaths);
          }
        }
      }
    }
    return presets;
  }

  private async addPresetFromFile(
    file: TFile,
    presets: Array<{ name: string; prompt: string }>,
    seenPaths: Set<string>,
  ) {
    if (seenPaths.has(file.path)) return;
    try {
      const content = await this.app.vault.read(file);
      presets.push({
        name: file.basename,
        prompt: content.trim(),
      });
      seenPaths.add(file.path);
    } catch (e: unknown) {
      console.error(`Horme: Failed to read preset note ${file.path}`, e);
      this.diagnosticService.report(
        "Presets",
        `Failed to read preset: ${file.path} — ${errorToMessage(e)}`,
        "warning",
      );
    }
  }

  setIndexingStatus(text: string | null) {
    if (!this.statusBarItem) return;

    const isBackgroundPattern =
      text &&
      (text.includes("Indexing") ||
        text.includes("Scanning") ||
        text.includes("Pre-translating") ||
        text.includes("Loading Vault Index") ||
        text.includes("Saving brain index") ||
        text.includes("Waiting for brain index") ||
        text.includes("Initializing"));

    if (text === null) {
      const isBackgroundActive = this.vaultIndexer?.isIndexing || this.vaultIndexer?.isProcessingQueue;
      if (!isBackgroundActive) {
        this.backgroundStatusText = null;
      }
      this.foregroundStatusText = null;
    } else {
      if (isBackgroundPattern) {
        this.backgroundStatusText = text;
      } else {
        this.foregroundStatusText = text;
      }
    }

    const displayValue =
      this.foregroundStatusText ??
      (this.vaultIndexer?.isIndexing || this.vaultIndexer?.isProcessingQueue
        ? this.backgroundStatusText
        : null);

    if (displayValue === null) {
      this.statusBarItem.hide();
    } else {
      this.statusBarItem.show();
      this.statusBarItem.textContent = `● ${displayValue}`;
    }
  }

  private migrateLegacyApiKeysToSecretStorage(loaded: Record<string, unknown>): boolean {
    const mappings: Array<{
      legacyField: string;
      secretIdField: string;
      defaultSecretId: string;
    }> = [
      {
        legacyField: "claudeApiKey",
        secretIdField: "claudeSecretId",
        defaultSecretId: "horme-claude-api-key",
      },
      {
        legacyField: "geminiApiKey",
        secretIdField: "geminiSecretId",
        defaultSecretId: "horme-gemini-api-key",
      },
      {
        legacyField: "openaiApiKey",
        secretIdField: "openaiSecretId",
        defaultSecretId: "horme-openai-api-key",
      },
      { legacyField: "groqApiKey", secretIdField: "groqSecretId", defaultSecretId: "horme-groq-api-key" },
      {
        legacyField: "openRouterApiKey",
        secretIdField: "openRouterSecretId",
        defaultSecretId: "horme-openrouter-api-key",
      },
      {
        legacyField: "mistralApiKey",
        secretIdField: "mistralSecretId",
        defaultSecretId: "horme-mistral-api-key",
      },
    ];

    let changed = false;
    let migratedCount = 0;

    for (const m of mappings) {
      // Boolean() because Function.prototype.call is typed `any` without strictBindCallApply.
      const hadLegacyField = Boolean(Object.prototype.hasOwnProperty.call(loaded, m.legacyField));
      const legacyRaw = loaded[m.legacyField];
      const legacyValue = typeof legacyRaw === "string" ? legacyRaw.trim() : "";

      if (hadLegacyField) {
        delete loaded[m.legacyField];
        changed = true;
      }

      if (!legacyValue) continue;

      const existingSecretRaw = loaded[m.secretIdField];
      const existingSecretId = typeof existingSecretRaw === "string" ? existingSecretRaw.trim() : "";
      const secretId = existingSecretId || m.defaultSecretId;

      try {
        this.app.secretStorage.setSecret(secretId, legacyValue);
        loaded[m.secretIdField] = secretId;
        changed = true;
        migratedCount++;
      } catch {
        // If the secret id is invalid or storage fails, keep settings migrated (keys removed)
        // but don't block plugin startup.
      }
    }

    if (migratedCount > 0) {
      new Notice(
        `Horme: Migrated ${migratedCount} API key${migratedCount === 1 ? "" : "s"} to Obsidian Secret Storage.`,
      );
    }

    return changed;
  }

  /** Repairs the loaded settings (see repairSettings) and says what changed for the user. */
  private repairSettings(): boolean {
    const { changed, notices } = repairSettings(this.settings);
    for (const message of notices) new Notice(message, 15000);
    return changed;
  }

  async loadSettings() {
    const loadedUnknown: unknown = await this.loadData();
    const loaded: Record<string, unknown> =
      loadedUnknown && typeof loadedUnknown === "object"
        ? { ...(loadedUnknown as Record<string, unknown>) }
        : {};

    const migrated = this.migrateLegacyApiKeysToSecretStorage(loaded);
    // Embeddings used to follow the chat provider; settings from before keep
    // the server their index was built with.
    const embeddingSource = initialEmbeddingSource(loaded, DEFAULT_SETTINGS.aiProvider);
    if (embeddingSource) loaded.embeddingSource = embeddingSource;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    const sanitized = this.repairSettings();
    // A model its provider has retired can only fail: move it to the replacement.
    const moved = replaceRetiredModels(this.settings, (p) => providerInfo(p).modelKey);
    for (const m of moved) {
      const name = providerInfo(m.provider).name;
      new Notice(
        m.gone
          ? `Horme: ${name} retired ${m.from} on ${m.gone}. Now using ${m.to}, its replacement.`
          : `Horme: ${name} no longer offers ${m.from}. Now using ${m.to}.`,
        10000,
      );
    }
    if (migrated || sanitized || moved.length > 0 || embeddingSource) {
      // Persist the sanitized settings immediately so API keys never remain in data.json.
      await this.saveData(this.settings);
    }
    // Track the provider last saved to disk so we can apply privacy guards on change.
    this._lastPersistedDestination = notesDestination(this.settings, this.settings.aiProvider);
  }

  /**
   * Obsidian calls this when a sync service rewrites data.json. Without it the
   * settings in memory went stale, and the next save on this device wrote them
   * back over what the other device had just chosen.
   */
  async onExternalSettingsChange() {
    this.mobileOverride = null;
    await this.loadSettings();
    this.updateMobileOverride();
    this._lastPersistedDestination = notesDestination(this.settings, this.settings.aiProvider);
    this.settingsChangeListeners.forEach((cb) => cb());
    this.skillManager?.loadCustomSkills();
  }

  /**
   * Keeps the phone's provider and model in step with the settings: switches the
   * override on or off when the toggle changes, and stores a provider or model
   * picked on the phone as the mobile one. Does nothing on a computer.
   */
  private updateMobileOverride(): void {
    const modelKey = (p: AiProvider) => providerInfo(p).modelKey;
    const s = this.settings;
    if (this.mobileOverride) {
      syncMobileOverride(s, this.mobileOverride, modelKey);
      if (!s.useMobileOverride || !Platform.isMobile) {
        removeMobileOverride(s, this.mobileOverride, modelKey);
        this.mobileOverride = null;
      }
    } else if (Platform.isMobile && s.useMobileOverride) {
      this.mobileOverride = applyMobileOverride(s, modelKey, this.loadPhoneChoice());
    }
    if (this.mobileOverride) this.storePhoneChoice(this.mobileOverride.choice);
  }

  /**
   * The provider and model this phone chose for itself. They are kept in the
   * device's own storage, not in data.json: sync shares that file, and another
   * device saving its copy put the phone back on the model it had before.
   */
  private loadPhoneChoice(): PhoneChoice | null {
    const stored: unknown = this.app.loadLocalStorage(PHONE_CHOICE_KEY);
    const choice = parsePhoneChoice(stored);
    this.storedPhoneChoice = JSON.stringify(choice);
    if (!choice) return null;
    // A model its provider has retired since can only fail.
    const retired = RETIRED_MODELS[choice.provider]?.[choice.model];
    return retired ? { ...choice, model: retired.to } : choice;
  }

  private storePhoneChoice(choice: PhoneChoice | null): void {
    const json = JSON.stringify(choice);
    if (json === this.storedPhoneChoice) return;
    this.storedPhoneChoice = json;
    this.app.saveLocalStorage(PHONE_CHOICE_KEY, choice);
  }

  async saveSettings() {
    this.updateMobileOverride();

    // Privacy guard: the privacy questions are asked once per destination.
    // When the chat's requests start going to a different cloud destination (a
    // cloud provider, another address for the OpenAI-compatible server, an
    // Ollama cloud model), the answers are forgotten, so the user is asked
    // again before any note or document content leaves the device.
    const provider = this.settings.aiProvider;
    const destination = notesDestination(this.settings, provider);
    if (
      this._lastPersistedDestination &&
      destination !== this._lastPersistedDestination &&
      this.isCloudProvider(provider)
    ) {
      this.settings.contextCloudWarningShown = false;
      this.settings.contextNotesCloudWarningShown = false;
      this.settings.contextFoldersCloudWarningShown = false;
      this.settings.documentCloudWarningShown = false;
    }

    // With the mobile override on, the file keeps the desktop's provider and model,
    // so the phone's never reach a computer. A copy is saved: the settings in
    // memory stay the phone's while the write is in progress.
    const o = this.mobileOverride;
    await this.saveData(
      o ? settingsForDisk(this.settings, o, (p) => providerInfo(p).modelKey) : this.settings,
    );
    this._lastPersistedDestination = destination;
    this.settingsChangeListeners.forEach((cb) => cb());
    this.skillManager?.loadCustomSkills();
  }
}
