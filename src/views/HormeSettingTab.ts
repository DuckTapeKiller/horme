import {
  App,
  PluginSettingTab,
  Setting,
  requireApiVersion,
  TFile,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
  type SettingGroupItem,
} from "obsidian";
import HormePlugin from "../../main";
import { DEFAULT_SETTINGS } from "../constants";
import type { HormeSettings } from "../types";
import { FileOrFolderSuggest } from "../utils/Suggest";
import { GenericConfirmModal } from "../modals/GenericConfirmModal";
import { CustomSkillModal } from "../modals/CustomSkillModal";
import { modelField } from "./settings/modelField";
import {
  PROVIDERS,
  embeddingProvider,
  isLocalProvider,
  providerInfo,
  providerModel,
  providerOptions,
  type ProviderInfo,
} from "./settings/providers";
import type { SettingKey, SettingsHost } from "./settings/types";
import {
  ConnectionChecker,
  ISSUES_URL,
  activityLogItem,
  connectionItem,
  healthItem,
  heroItem,
  indexItem,
  linkItem,
  noteItem,
  supportItem,
  tagTranslationTestItem,
} from "./settings/widgets";
import { disposeFallback, renderFallback } from "./settings/fallback";
import { IMAGE_SOURCES, imageSourceInfo } from "../utils/imageSources";
import { sourceKeys } from "../services/ImageSearch";

type Item = SettingDefinitionItem<SettingKey>;
type GroupItem = SettingGroupItem<SettingKey>;

const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Dutch",
  "Polish",
  "Russian",
  "Turkish",
  "Arabic",
  "Hindi",
  "Chinese",
  "Japanese",
  "Korean",
];

/** Text settings that fall back to their default when cleared. */
const DEFAULT_WHEN_BLANK: Partial<Record<SettingKey, string>> = {
  exportFolder: DEFAULT_SETTINGS.exportFolder,
  grammarFolderPath: DEFAULT_SETTINGS.grammarFolderPath,
  grammarLanguage: DEFAULT_SETTINGS.grammarLanguage,
  summaryField: DEFAULT_SETTINGS.summaryField,
  summaryLanguage: DEFAULT_SETTINGS.summaryLanguage,
  conceptNoteSourceField: DEFAULT_SETTINGS.conceptNoteSourceField,
};

/** Settings whose change alters which options, pages or labels are drawn. */
const STRUCTURAL_KEYS = new Set<SettingKey>([
  "aiProvider",
  "mobileProvider",
  "tagsProvider",
  "tagTranslationProvider",
  "tagTranslationFallbackProvider",
  "connectionsDisplayStyle",
  "tagShadowingLanguage",
]);

const SAVE_DELAY_MS = 400;

export class HormeSettingTab extends PluginSettingTab implements SettingsHost {
  plugin: HormePlugin;
  private saveTimer: number | null = null;
  /** True when Obsidian is older than 1.13 and calls display() itself. */
  private fallbackMode = false;
  private checker: ConnectionChecker;

  constructor(app: App, plugin: HormePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.checker = new ConnectionChecker(plugin);
    this.icon = "cone";
  }

  /* ── Storage ─────────────────────────────────────────────────────────── */

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === "vaultBrainEnabled") return s.vaultBrainEnabled && this.vaultBrainAllowed();
    return (s as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void {
    this.commit(key as SettingKey, value);
  }

  commit(key: SettingKey, value: unknown): void {
    const s = this.plugin.settings;
    const record = s as unknown as Record<string, unknown>;

    // Sending notes to the cloud needs an explicit yes.
    if (key === "allowCloudRAG" && value === true && !s.allowCloudRAG) {
      new GenericConfirmModal(
        this.app,
        "Allow cloud providers to receive passages from your notes? Passages will leave this computer whenever a cloud provider answers.",
        () => {
          s.allowCloudRAG = true;
          this.saveSoon();
          this.refresh(true, true);
        },
        () => this.refresh(true, true),
      ).open();
      return;
    }

    if (typeof value === "string" && key in DEFAULT_WHEN_BLANK) {
      value = value.trim() || DEFAULT_WHEN_BLANK[key];
    } else if (typeof value === "string" && /Path$|Folder$|Url$|BaseUrl$/.test(key)) {
      value = value.trim();
    }
    const before = record[key];
    record[key] = value;

    // Keep dependent choices valid.
    let changedOthers = false;
    if (key === "allowCloudRAG" && value === false && !isLocalProvider(s.tagsProvider)) {
      s.tagsProvider = isLocalProvider(s.aiProvider) ? s.aiProvider : "ollama";
      s.tagsModel = "";
      changedOthers = true;
    }
    if (key === "allowCloudTagTranslation" && value === false && !isLocalProvider(s.tagTranslationProvider)) {
      s.tagTranslationProvider = s.tagTranslationFallbackProvider;
      changedOthers = true;
    }
    if (key === "tagsProvider" && value !== before && s.tagsModel) {
      s.tagsModel = "";
      changedOthers = true;
    }
    // A model belongs to its provider: Gemini's model sent to Mistral fails.
    if (key === "mobileProvider" && value !== before && s.mobileModel) {
      s.mobileModel = "";
      changedOthers = true;
    }

    this.saveSoon();
    this.refresh(typeof value === "boolean" || STRUCTURAL_KEYS.has(key) || changedOthers, changedOthers);
  }

  private saveSoon(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings().catch((e: unknown) => this.plugin.handleError(e, "Settings"));
    }, SAVE_DELAY_MS);
  }

  /** Writes any change still waiting to be saved. */
  flushSave(): void {
    if (this.saveTimer === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.plugin.saveSettings().catch((e: unknown) => this.plugin.handleError(e, "Settings"));
  }

  hide(): void {
    this.flushSave();
    if (this.fallbackMode) disposeFallback();
    super.hide();
  }

  /**
   * Redraws after a change. `valuesChangedInCode`: values were set by code (a
   * confirmation, a reset), not typed or clicked. Obsidian leaves a focused
   * control as it is when it redraws, so focus is released first, or the
   * control the user last touched would keep showing the old value.
   */
  refresh(structural: boolean, valuesChangedInCode = false): void {
    if (this.fallbackMode || !requireApiVersion("1.13.0")) {
      // The old renderer redraws everything; only for changes that alter what is
      // shown, so moving between text fields never loses the next one.
      if (structural || valuesChangedInCode) this.display();
      return;
    }
    if (requireApiVersion("1.13.0")) {
      if (valuesChangedInCode) {
        const active = this.containerEl.ownerDocument.activeElement;
        if (active?.instanceOf(HTMLElement) && this.containerEl.ownerDocument.body.contains(active))
          active.blur();
      }
      if (structural) this.update();
      this.refreshDomState();
    }
  }

  /* ── Rendering ───────────────────────────────────────────────────────── */

  /** Obsidian before 1.13 calls display() and knows nothing of setting definitions. */
  display(): void {
    this.fallbackMode = true;
    renderFallback(this, this.containerEl, this.getSettingDefinitions());
  }

  getSettingDefinitions(): Item[] {
    return [
      { type: "group", cls: "horme-hero-group", items: [heroItem(this, this.checker)] },
      { type: "group", heading: "Set-up", items: [this.modelsPage(), this.chatPage()] },
      {
        type: "group",
        heading: "Your notes",
        items: [this.vaultBrainPage(), this.connectionsPage(), this.tagsPage()],
      },
      { type: "group", heading: "Tools", items: [this.writingPage(), this.skillsPage(), this.imagesPage()] },
      { type: "group", heading: "More", items: [this.mobilePage(), this.diagnosticsPage()] },
      {
        type: "group",
        heading: "About",
        items: [
          supportItem(this),
          linkItem(
            "Report a bug or suggest an idea",
            "Opens Horme's issues on GitHub.",
            "Open issues",
            ISSUES_URL,
          ),
          {
            name: "Version",
            desc: `${this.plugin.manifest.name} ${this.plugin.manifest.version}`,
            searchable: false,
          },
        ],
      },
    ];
  }

  /* ── Shared checks ───────────────────────────────────────────────────── */

  private get s(): HormeSettings {
    return this.plugin.settings;
  }

  private vaultBrainAllowed(): boolean {
    return isLocalProvider(this.s.aiProvider) || this.s.allowCloudRAG;
  }

  private hasKey(p: ProviderInfo): boolean {
    return p.local || Boolean(this.plugin.getApiKeyForProvider(p.id));
  }

  private providerSummary(p: ProviderInfo): string {
    if (!this.hasKey(p)) return "No API key";
    return providerModel(this.s, p.id) || (p.local ? "Automatic" : "No model");
  }

  /* ── Models ──────────────────────────────────────────────────────────── */

  private providerItems(p: ProviderInfo): GroupItem[] {
    const items: GroupItem[] = [];
    if (p.urlKey) {
      const fallback = String(DEFAULT_SETTINGS[p.urlKey]);
      items.push({
        name: "Server address",
        desc:
          p.id === "llamacpp"
            ? "Where llama-server answers chat requests. Router mode and single-model servers both work."
            : `Where ${p.name}'s server answers.`,
        control: {
          type: "text",
          key: p.urlKey,
          placeholder: fallback,
          validate: (v: string) =>
            /^https?:\/\/\S+$/i.test(v.trim()) ? undefined : `Enter a full address, such as ${fallback}`,
        },
      });
    }
    if (p.secretKey) {
      items.push({
        name: "API key",
        desc: "Kept in Obsidian's keychain, never in Horme's settings file.",
        control: { type: "secret", key: p.secretKey },
      });
    }
    items.push(
      modelField(this, {
        name: "Model",
        desc:
          p.id === "llamacpp"
            ? "Leave empty to use the model the server has loaded."
            : p.local
              ? "Pick a model the server offers, or type its name."
              : "Pick a model or type any model ID the provider accepts.",
        key: p.modelKey,
        listId: `horme-${p.id}-models`,
        placeholder: p.local ? "Automatic" : undefined,
        provider: () => p.id,
        purpose: "chat",
        sourceKey: () => (p.urlKey ? String(this.s[p.urlKey]) : String(this.s[p.secretKey ?? "aiProvider"])),
      }),
    );
    return items;
  }

  private modelsPage(): SettingDefinitionPage<SettingKey> {
    const active = () => providerInfo(this.s.aiProvider);
    return {
      type: "page",
      name: "Models",
      desc: "Choose the AI that answers you, and connect it.",
      displayValue: () => `${active().name} · ${this.providerSummary(active())}`,
      status: () => (!this.hasKey(active()) ? "warning" : null),
      items: [
        {
          type: "group",
          heading: "Active provider",
          items: [
            {
              name: "Provider",
              desc: "Chat, text actions and summaries use this. Local providers keep your notes on this computer.",
              aliases: ["AI provider", "Ollama", "LM Studio", "llama.cpp", "Claude", "Gemini", "OpenAI"],
              control: { type: "dropdown", key: "aiProvider", options: providerOptions() },
            },
            connectionItem(this, this.checker),
          ],
        },
        ...PROVIDERS.map(
          (p): Item => ({
            type: "group",
            heading: p.name,
            visible: () => this.s.aiProvider === p.id,
            items: this.providerItems(p),
          }),
        ),
        {
          type: "group",
          heading: "Other providers",
          items: PROVIDERS.map(
            (p): GroupItem => ({
              type: "page",
              name: p.name,
              desc: p.blurb,
              displayValue: () => this.providerSummary(p),
              visible: () => this.s.aiProvider !== p.id,
              items: [{ type: "group", items: this.providerItems(p) }],
            }),
          ),
        },
      ],
    };
  }

  /* ── Chat ────────────────────────────────────────────────────────────── */

  private chatPage(): SettingDefinitionPage<SettingKey> {
    const presets = this.s.presetsPaths;
    return {
      type: "page",
      name: "Chat",
      desc: "How replies are written, and what Horme is told.",
      displayValue: () => {
        const n = this.s.presetsPaths.filter((p) => p.trim()).length;
        return n ? `${n} preset source${n === 1 ? "" : "s"}` : "";
      },
      items: [
        {
          type: "group",
          heading: "Replies",
          items: [
            {
              name: "Temperature",
              desc: "Lower gives steadier answers, higher gives more varied ones. Newer Claude and OpenAI reasoning models ignore it.",
              control: {
                type: "slider",
                key: "temperature",
                min: 0,
                max: 1,
                step: 0.05,
                displayFormat: (v: number) => v.toFixed(2),
              },
            },
            {
              name: "Longest reply",
              desc: "The most tokens a model may write in one reply. Raise it for long documents.",
              aliases: ["Max output tokens", "max tokens"],
              control: {
                type: "number",
                key: "maxTokens",
                min: 256,
                step: 256,
                validate: (v: number) =>
                  Number.isInteger(v) && v >= 256 ? undefined : "Use a whole number of 256 or more.",
              },
            },
          ],
        },
        {
          type: "group",
          heading: "Instructions",
          items: [
            {
              name: "System prompt note",
              desc: "A note whose text replaces Horme's built-in instructions. Leave empty to use the built-in ones.",
              control: {
                type: "file",
                key: "systemPromptPath",
                placeholder: "Built-in instructions",
                filter: (f: TFile) => f.extension === "md",
              },
            },
          ],
        },
        {
          type: "list",
          heading: "Prompt presets",
          emptyState:
            "No preset sources. Add a note, or a folder of notes: each note becomes a preset in the chat's preset menu.",
          addItem: {
            name: "Add a note or folder",
            action: () => {
              this.s.presetsPaths.push("");
              this.saveSoon();
              this.refresh(true);
            },
          },
          onDelete: (index: number) => {
            this.s.presetsPaths.splice(index, 1);
            this.saveSoon();
            this.refresh(true);
          },
          items: presets.map(
            (path, i): GroupItem => ({
              name: path || "New preset source",
              searchable: false,
              render: (setting: Setting) => {
                setting
                  .setName(`Source ${i + 1}`)
                  .setDesc("A note, or a folder whose notes are all presets.");
                setting.addText((t) => {
                  new FileOrFolderSuggest(this.app, t.inputEl);
                  t.setPlaceholder("Folder/or/note.md").setValue(path);
                  t.inputEl.addEventListener("change", () => {
                    this.s.presetsPaths[i] = t.inputEl.value.trim();
                    this.saveSoon();
                  });
                  t.inputEl.addEventListener("input", () => {
                    this.s.presetsPaths[i] = t.inputEl.value.trim();
                    this.saveSoon();
                  });
                });
              },
            }),
          ),
        },
        {
          type: "group",
          heading: "Context and files",
          items: [
            {
              name: "Folder context limit",
              desc: 'The most characters "+ Add folders" sends in one message. Larger folders are cut short; pick notes one by one instead.',
              control: {
                type: "number",
                key: "contextFoldersMaxChars",
                min: 1000,
                step: 1000,
                validate: (v: number) =>
                  Number.isInteger(v) && v >= 1000 ? undefined : "Use a whole number of 1,000 or more.",
              },
            },
            {
              name: "Export folder",
              desc: "Where exported chats and DOCX files are saved.",
              control: {
                type: "folder",
                key: "exportFolder",
                placeholder: DEFAULT_SETTINGS.exportFolder,
                includeRoot: true,
              },
            },
          ],
        },
      ],
    };
  }

  /* ── Vault Brain ─────────────────────────────────────────────────────── */

  private embeddingItems(): GroupItem[] {
    const ep = () => embeddingProvider(this.s);
    return [
      noteItem(() =>
        isLocalProvider(this.s.aiProvider)
          ? `Embeddings come from ${providerInfo(ep()).name}, your chat provider.`
          : "Your chat provider is in the cloud, so embeddings come from Ollama on this computer.",
      ),
      modelField(this, {
        name: "Embedding model",
        desc: "An embedding model in Ollama, such as nomic-embed-text. Rebuild the index after changing it.",
        key: "ragEmbeddingModel",
        listId: "horme-embed-models",
        provider: () => "ollama",
        purpose: "embedding",
        sourceKey: () => this.s.ollamaBaseUrl,
        visible: () => ep() === "ollama",
      }),
      modelField(this, {
        name: "Embedding model",
        desc: "Leave empty to use the first embedding model LM Studio has loaded. Rebuild the index after changing it.",
        key: "lmStudioEmbeddingModel",
        listId: "horme-lmstudio-embedding-models",
        provider: () => "lmstudio",
        purpose: "embedding",
        sourceKey: () => this.s.lmStudioUrl,
        visible: () => ep() === "lmstudio",
      }),
      {
        name: "Embedding server address",
        desc: "The llama-server started with --embedding, usually the chat port plus one.",
        visible: () => ep() === "llamacpp",
        control: {
          type: "text",
          key: "llamaCppEmbeddingUrl",
          placeholder: DEFAULT_SETTINGS.llamaCppEmbeddingUrl,
          validate: (v: string) =>
            /^https?:\/\/\S+$/i.test(v.trim())
              ? undefined
              : `Enter a full address, such as ${DEFAULT_SETTINGS.llamaCppEmbeddingUrl}`,
        },
      },
      modelField(this, {
        name: "Embedding model",
        desc: "Leave empty to use the model the embedding server has loaded. Rebuild the index after changing it.",
        key: "llamaCppEmbeddingModel",
        listId: "horme-llamacpp-embedding-models",
        provider: () => "llamacpp",
        purpose: "embedding",
        sourceKey: () => this.s.llamaCppEmbeddingUrl,
        visible: () => ep() === "llamacpp",
      }),
    ];
  }

  private vaultBrainPage(): SettingDefinitionPage<SettingKey> {
    const on = () => this.s.vaultBrainEnabled && this.vaultBrainAllowed();
    const blocked = () => this.s.vaultBrainEnabled && !this.vaultBrainAllowed();
    return {
      type: "page",
      name: "Vault Brain",
      desc: "Index your notes so Horme can find and use them.",
      displayValue: () => {
        if (!this.s.vaultBrainEnabled) return "Off";
        if (blocked()) return "Paused";
        const vb = this.plugin.vaultIndexer;
        return vb.isLoaded ? `${vb.index.length.toLocaleString()} passages` : "On";
      },
      status: () => (blocked() || (on() && !this.plugin.vaultIndexer.isSpaceCompatible()) ? "warning" : null),
      items: [
        {
          type: "group",
          items: [
            {
              name: "Use Vault Brain",
              desc: "Horme indexes your notes on this computer and brings the relevant passages into the chat.",
              aliases: ["RAG", "local vault memory", "semantic search"],
              control: {
                type: "toggle",
                key: "vaultBrainEnabled",
                disabled: () => !this.vaultBrainAllowed(),
              },
            },
            noteItem(
              "Paused: your chat provider is in the cloud and cloud access to notes is off. Choose a local provider, or allow cloud access below.",
              "warning",
              () => !this.vaultBrainAllowed(),
            ),
            indexItem(this, "vault", {
              canRebuild: on,
              rebuildHint: "Turn on Vault Brain first.",
            }),
          ],
        },
        {
          type: "group",
          heading: "Privacy",
          items: [
            {
              name: "Let cloud providers read notes",
              desc: "Off keeps every passage on this computer. On sends passages to a cloud chat provider, and lets cloud providers suggest tags.",
              aliases: ["Allow cloud provider access", "cloud RAG"],
              control: { type: "toggle", key: "allowCloudRAG" },
            },
          ],
        },
        { type: "group", heading: "Embeddings", visible: on, items: this.embeddingItems() },
        {
          type: "group",
          heading: "What to index",
          visible: on,
          items: [
            {
              name: "Only these files",
              desc: "Patterns, one per line or separated by commas, such as Music/**. Leave empty to index every note. Rebuild after changing.",
              aliases: ["include patterns"],
              control: {
                type: "textarea",
                key: "vaultIndexIncludePatterns",
                placeholder: "Music/**\nSources/**/*.md",
                rows: 3,
              },
            },
            {
              name: "Leave out",
              desc: "Patterns for files to skip, such as Templates/**. Rebuild after changing.",
              aliases: ["exclude patterns"],
              control: {
                type: "textarea",
                key: "vaultIndexExcludePatterns",
                placeholder: "Templates/**\nArchive/**",
                rows: 3,
              },
            },
            {
              name: "Index PDFs",
              desc: 'Uses the text the "Text Extractor" community plugin pulls from each PDF. Rebuild after changing.',
              control: { type: "toggle", key: "vaultIndexIndexPdf" },
            },
            {
              name: "Most text per PDF",
              desc: "Characters taken from each PDF. Larger PDFs are cut short.",
              visible: () => this.s.vaultIndexIndexPdf,
              control: {
                type: "slider",
                key: "vaultIndexPdfMaxChars",
                min: 10_000,
                max: 2_000_000,
                step: 10_000,
                displayFormat: (v: number) => v.toLocaleString(),
              },
            },
          ],
        },
        {
          type: "group",
          heading: "Highlights",
          visible: on,
          items: [
            {
              name: "Index highlights",
              desc: "Gives each note's ==highlights== their own entry, so the text you marked is found first. Rebuild after changing.",
              control: { type: "toggle", key: "indexHighlightsEnabled" },
            },
            {
              name: "Highlight boost",
              desc: "Extra weight for results that come from highlights.",
              visible: () => this.s.indexHighlightsEnabled,
              control: {
                type: "slider",
                key: "highlightBoost",
                min: 0,
                max: 1,
                step: 0.05,
                displayFormat: (v: number) => `${Math.round(v * 100)}%`,
              },
            },
            {
              name: "Highlights per note",
              desc: "The most highlights indexed from one note.",
              visible: () => this.s.indexHighlightsEnabled,
              control: { type: "slider", key: "maxHighlightsPerNote", min: 1, max: 60, step: 1 },
            },
            {
              name: "Highlight text per note",
              desc: "The most characters of highlights indexed from one note.",
              visible: () => this.s.indexHighlightsEnabled,
              control: {
                type: "slider",
                key: "maxHighlightCharsPerNote",
                min: 250,
                max: 10_000,
                step: 250,
                displayFormat: (v: number) => v.toLocaleString(),
              },
            },
          ],
        },
        {
          type: "group",
          heading: "Advanced",
          visible: on,
          items: [this.searchTuningPage()],
        },
      ],
    };
  }

  private searchTuningPage(): SettingDefinitionPage<SettingKey> {
    return {
      type: "page",
      name: "Search tuning",
      desc: "How results are ranked. The defaults suit most vaults.",
      displayValue: () =>
        this.s.searchMetadataCap === DEFAULT_SETTINGS.searchMetadataCap &&
        this.s.searchContentCap === DEFAULT_SETTINGS.searchContentCap &&
        this.s.vaultBrainUseRrfHybridSearch === DEFAULT_SETTINGS.vaultBrainUseRrfHybridSearch &&
        this.s.vaultBrainRrfK === DEFAULT_SETTINGS.vaultBrainRrfK
          ? "Defaults"
          : "Customised",
      items: [
        {
          type: "group",
          items: [
            {
              name: "Hybrid search",
              desc: "Blends meaning-based and keyword-based rankings (reciprocal rank fusion). Sturdier across mixed notes.",
              aliases: ["RRF", "reciprocal rank fusion"],
              control: { type: "toggle", key: "vaultBrainUseRrfHybridSearch" },
            },
            {
              name: "Fusion constant",
              desc: "Higher values flatten the difference between top and lower ranks. 60 is the usual choice.",
              aliases: ["RRF k"],
              visible: () => this.s.vaultBrainUseRrfHybridSearch,
              control: { type: "slider", key: "vaultBrainRrfK", min: 10, max: 200, step: 5 },
            },
            {
              name: "Title and tag matches",
              desc: "The most extra weight for words that match a note's title, summary, headings or tags.",
              aliases: ["Metadata keyword weight"],
              control: {
                type: "slider",
                key: "searchMetadataCap",
                min: 0,
                max: 1,
                step: 0.05,
                displayFormat: (v: number) => v.toFixed(2),
              },
            },
            {
              name: "Body text matches",
              desc: "The most extra weight for words found in the passage itself.",
              aliases: ["Content keyword weight"],
              control: {
                type: "slider",
                key: "searchContentCap",
                min: 0,
                max: 1,
                step: 0.05,
                displayFormat: (v: number) => v.toFixed(2),
              },
            },
            {
              name: "Restore the defaults",
              desc: "Hybrid search on, constant 60, weights 0.25 and 0.20.",
              action: () => {
                this.s.vaultBrainUseRrfHybridSearch = DEFAULT_SETTINGS.vaultBrainUseRrfHybridSearch;
                this.s.vaultBrainRrfK = DEFAULT_SETTINGS.vaultBrainRrfK;
                this.s.searchMetadataCap = DEFAULT_SETTINGS.searchMetadataCap;
                this.s.searchContentCap = DEFAULT_SETTINGS.searchContentCap;
                this.saveSoon();
                this.refresh(true, true);
              },
            },
          ],
        },
      ],
    };
  }

  /* ── Live connections ────────────────────────────────────────────────── */

  private connectionsPage(): SettingDefinitionPage<SettingKey> {
    const on = () => this.s.connectionsEnabled;
    return {
      type: "page",
      name: "Live connections",
      desc: "A side panel of notes related to the one you are reading.",
      displayValue: () => (!on() ? "Off" : this.s.vaultBrainEnabled ? "On" : "Needs Vault Brain"),
      items: [
        {
          type: "group",
          items: [
            {
              name: "Show related notes",
              desc: "Finds notes close in meaning to the open one. Works from the Vault Brain index.",
              aliases: ["Enable live connections"],
              control: { type: "toggle", key: "connectionsEnabled" },
            },
            noteItem(
              "Vault Brain is off, so there is nothing to compare notes against. Turn it on in Vault Brain.",
              "warning",
              () => on() && !this.s.vaultBrainEnabled,
            ),
            {
              name: "Open the connections panel",
              desc: "Shows the panel in the right sidebar.",
              visible: on,
              action: () => {
                void this.plugin.activateConnections().catch((e: unknown) => this.plugin.handleError(e));
              },
            },
          ],
        },
        {
          type: "group",
          heading: "What to show",
          visible: on,
          items: [
            {
              name: "How close",
              desc: "How similar a note must be to appear. Higher shows fewer, closer notes.",
              aliases: ["Similarity threshold"],
              control: {
                type: "slider",
                key: "connectionsThreshold",
                min: 0.1,
                max: 0.9,
                step: 0.05,
                displayFormat: (v: number) => v.toFixed(2),
              },
            },
            {
              name: "Most notes shown",
              aliases: ["Max results"],
              control: { type: "slider", key: "connectionsMaxResults", min: 5, max: 50, step: 1 },
            },
            {
              name: "Leave out folders",
              desc: "Folder paths separated by commas, such as Templates, Daily notes. Their subfolders are left out too.",
              aliases: ["Excluded folders"],
              control: {
                type: "text",
                key: "connectionsExcludedFolders",
                placeholder: "Templates, Daily notes",
              },
            },
            {
              name: "Style",
              control: {
                type: "dropdown",
                key: "connectionsDisplayStyle",
                options: { minimal: "Titles only", detailed: "Titles and folders" },
              },
            },
            {
              name: "Open in a new tab",
              desc: "Clicking a related note opens it beside the current one.",
              control: { type: "toggle", key: "connectionsOpenInNewTab" },
            },
          ],
        },
      ],
    };
  }

  /* ── Tags ────────────────────────────────────────────────────────────── */

  private tagsPage(): SettingDefinitionPage<SettingKey> {
    const shadowing = () => this.s.tagShadowingEnabled;
    const translatorIsCloud = () => !isLocalProvider(this.s.tagTranslationProvider);
    const localTranslator = () =>
      isLocalProvider(this.s.tagTranslationProvider)
        ? this.s.tagTranslationProvider
        : this.s.tagTranslationFallbackProvider;
    // llama.cpp needs no model name: it answers with the one it has loaded.
    const localTranslatorModel = () =>
      this.s.tagTranslationModel.trim() ||
      providerModel(this.s, localTranslator()) ||
      (localTranslator() === "llamacpp" ? "automatic" : "");

    const translationOptions: Record<string, string> = providerOptions(this.s.allowCloudTagTranslation);
    return {
      type: "page",
      name: "Tags",
      desc: "Tag suggestions, and tags translated for search.",
      displayValue: () => {
        const n = this.plugin.tagIndexer.entryCount;
        return n > 0 ? `${n.toLocaleString()} tags indexed` : "";
      },
      status: () => (shadowing() && this.s.vaultBrainEnabled && !localTranslatorModel() ? "warning" : null),
      items: [
        {
          type: "group",
          heading: "Tag suggestions",
          items: [
            {
              name: "Tag list note",
              desc: "Optional. A note listing the tags Horme may suggest, one per line. Leave empty to use every tag in the vault.",
              control: {
                type: "file",
                key: "tagsFilePath",
                placeholder: "Every tag in the vault",
                filter: (f: TFile) => f.extension === "md",
              },
            },
            {
              name: "Tags per suggestion",
              desc: "The most tags Horme proposes for one note.",
              control: { type: "slider", key: "maxSuggestedTags", min: 1, max: 30, step: 1 },
            },
            {
              name: "Provider",
              desc: "Used only by the Tags button and command. Leave the model empty to use your chat provider instead.",
              aliases: ["Tag generation provider"],
              control: {
                type: "dropdown",
                key: "tagsProvider",
                options: providerOptions(this.s.allowCloudRAG),
              },
            },
            modelField(this, {
              name: "Model",
              desc: "Leave empty to use your chat provider and model.",
              key: "tagsModel",
              listId: "horme-tags-gen-model",
              provider: () => this.s.tagsProvider,
              purpose: "chat",
              placeholder: "Same as chat",
            }),
            noteItem(
              "Only local providers are offered. Let cloud providers read notes, in Vault Brain, to offer cloud ones.",
              "info",
              () => !this.s.allowCloudRAG,
            ),
            indexItem(this, "tags"),
          ],
        },
        {
          type: "group",
          heading: "Bilingual tag shadowing",
          items: [
            {
              name: "Translate tags for search",
              desc: "While Vault Brain indexes, each tag is also stored in a second language, so a search in either language finds the note. Your notes and tags are never changed.",
              aliases: ["Bilingual tag shadowing"],
              control: { type: "toggle", key: "tagShadowingEnabled" },
            },
            noteItem(
              "This takes effect when Vault Brain is on.",
              "info",
              () => shadowing() && !this.s.vaultBrainEnabled,
            ),
            {
              name: "Second language",
              visible: shadowing,
              aliases: ["Shadowing target language"],
              control: {
                type: "dropdown",
                key: "tagShadowingLanguage",
                options: Object.fromEntries(LANGUAGES.map((l) => [l, l])),
              },
            },
            {
              name: "Allow cloud translation",
              desc: "Sends tag names, never note text, to a cloud provider. Tag names can still be private.",
              visible: shadowing,
              control: { type: "toggle", key: "allowCloudTagTranslation" },
            },
            {
              name: "Translate with",
              visible: shadowing,
              aliases: ["Tag translation provider"],
              control: { type: "dropdown", key: "tagTranslationProvider", options: translationOptions },
            },
            noteItem(
              () =>
                `Uses the model set for ${providerInfo(this.s.tagTranslationProvider).name} in Models: ${providerModel(this.s, this.s.tagTranslationProvider) || "none set"}.`,
              "info",
              () => shadowing() && translatorIsCloud(),
            ),
            {
              name: "If the cloud fails, use",
              visible: () => shadowing() && translatorIsCloud(),
              aliases: ["Tag translation fallback"],
              control: {
                type: "dropdown",
                key: "tagTranslationFallbackProvider",
                options: providerOptions(false),
              },
            },
            modelField(this, {
              name: "Translation model",
              desc: "A local model for translating tags. Leave empty to use that provider's chat model.",
              key: "tagTranslationModel",
              listId: "horme-tag-trans-models",
              provider: localTranslator,
              purpose: "chat",
              visible: shadowing,
            }),
            noteItem(
              "No local model is set for translation, so tags will not be translated. Set a model above, or one for that provider in Models.",
              "warning",
              () => shadowing() && !localTranslatorModel(),
            ),
            tagTranslationTestItem(this, shadowing),
          ],
        },
      ],
    };
  }

  /* ── Writing tools ───────────────────────────────────────────────────── */

  private writingPage(): SettingDefinitionPage<SettingKey> {
    return {
      type: "page",
      name: "Writing tools",
      desc: "Proofreading, summaries and concept notes.",
      items: [
        {
          type: "group",
          heading: "Proofreading",
          items: [
            {
              name: "Grammar notes folder",
              desc: "A folder of grammar and style notes. Proofreading consults them for texts in the language below.",
              aliases: ["Grammar manual folder"],
              control: {
                type: "folder",
                key: "grammarFolderPath",
                placeholder: DEFAULT_SETTINGS.grammarFolderPath,
              },
            },
            {
              name: "Language of those notes",
              desc: "Proofreading uses the grammar notes only for text in this language.",
              aliases: ["Grammar language"],
              control: {
                type: "text",
                key: "grammarLanguage",
                placeholder: DEFAULT_SETTINGS.grammarLanguage,
              },
            },
            indexItem(this, "grammar"),
          ],
        },
        {
          type: "group",
          heading: "Frontmatter summaries",
          items: [
            {
              name: "Property name",
              desc: "Where the summary is written, such as summary, resumen or abstract.",
              aliases: ["Summary field"],
              control: { type: "text", key: "summaryField", placeholder: DEFAULT_SETTINGS.summaryField },
            },
            {
              name: "Summary language",
              control: {
                type: "text",
                key: "summaryLanguage",
                placeholder: DEFAULT_SETTINGS.summaryLanguage,
              },
            },
          ],
        },
        {
          type: "group",
          heading: "Concept notes",
          items: [
            {
              name: "Folder",
              desc: "Where new concept notes are created.",
              aliases: ["Concept folder path"],
              control: {
                type: "folder",
                key: "conceptNoteFolder",
                placeholder: DEFAULT_SETTINGS.conceptNoteFolder,
              },
            },
            {
              name: "Source property",
              desc: "The property that holds the research link. In the template it is ${sourceField}.",
              control: {
                type: "text",
                key: "conceptNoteSourceField",
                placeholder: DEFAULT_SETTINGS.conceptNoteSourceField,
              },
            },
            {
              name: "Note template",
              desc: "Placeholders: ${title}, ${tag}, ${sourceField}, ${source}, ${content}.",
              control: { type: "textarea", key: "conceptNoteTemplate", rows: 8 },
            },
          ],
        },
      ],
    };
  }

  /* ── Skills and agent ────────────────────────────────────────────────── */

  /* ── Images ──────────────────────────────────────────────────────────── */

  private moveImageSource(index: number, by: -1 | 1): void {
    const list = this.s.imageSources;
    const to = index + by;
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    this.saveSoon();
    this.refresh(true);
  }

  private imagesPage(): SettingDefinitionPage<SettingKey> {
    const enabled = (id: string) => this.s.imageSources.some((src) => src.id === id && src.enabled);
    const missingKey = (id: (typeof IMAGE_SOURCES)[number]["id"]) =>
      imageSourceInfo(id).keys.length > 0 && sourceKeys(this.plugin, id) === null;
    const keyed = IMAGE_SOURCES.filter((src) => src.keys.length > 0);

    const sourceRows = this.s.imageSources.map((entry, i): GroupItem => {
      const info = imageSourceInfo(entry.id);
      const desc = () =>
        entry.enabled && missingKey(entry.id) ? `${info.desc} Needs its key, in Keys below.` : info.desc;
      return {
        name: info.name,
        desc: info.desc,
        render: (setting: Setting) => {
          setting.setName(info.name).setDesc(desc());
          setting.addExtraButton((b) => {
            b.setIcon("arrow-up")
              .setTooltip("Try earlier")
              .setDisabled(i === 0);
            b.onClick(() => this.moveImageSource(i, -1));
          });
          setting.addExtraButton((b) => {
            b.setIcon("arrow-down")
              .setTooltip("Try later")
              .setDisabled(i === this.s.imageSources.length - 1);
            b.onClick(() => this.moveImageSource(i, 1));
          });
          setting.addToggle((t) => {
            t.setValue(entry.enabled);
            t.onChange((value) => {
              entry.enabled = value;
              this.saveSoon();
              this.refresh(true);
            });
          });
        },
      };
    });

    const keyItems = keyed.flatMap((info): GroupItem[] =>
      info.keys.map((k, ki) => ({
        name: k.name,
        desc:
          ki === 0 && info.signUpUrl
            ? createFragment((f) => {
                f.appendText(
                  `For ${info.name}. Kept in Obsidian's keychain, never in Horme's settings file. `,
                );
                f.createEl("a", { text: "Sign up for a key", href: info.signUpUrl });
              })
            : `For ${info.name}. Kept in Obsidian's keychain, never in Horme's settings file.`,
        visible: () => enabled(info.id),
        control: { type: "secret", key: k.key },
      })),
    );

    return {
      type: "page",
      name: "Images",
      desc: "Where pictures come from, and when answers show them.",
      displayValue: () => {
        const on = this.s.imageSources.filter((src) => src.enabled).length;
        return on ? `${on} source${on === 1 ? "" : "s"}` : "Off";
      },
      status: () => (this.s.imageSources.some((src) => src.enabled && missingKey(src.id)) ? "warning" : null),
      items: [
        {
          type: "group",
          heading: "Answers",
          items: [
            {
              name: "Pictures in answers",
              desc: "With Wikipedia lookups, an answer that looks something up on Wikipedia shows the article's picture. With every lookup, Britannica, web search and deep research also come with a picture of what they looked up, fetched while the lookup runs. Neither adds a model round.",
              aliases: ["Images", "Photos", "Illustrate answers"],
              control: {
                type: "dropdown",
                key: "imagesInAnswers",
                options: {
                  off: "Off",
                  wikipedia: "With Wikipedia lookups",
                  always: "With every lookup",
                },
              },
            },
            {
              name: "Answer picture requests directly",
              desc: "“Show me a photo of the Colosseum” or “muéstrame tres fotos de Frida Kahlo” shows the pictures straight away, without the model: a second or two instead of two model rounds. Requests that ask for more go to the model as usual.",
              aliases: ["Quick pictures", "Fast pictures"],
              control: { type: "toggle", key: "imageQuickRequests" },
            },
            {
              name: "Most pictures per request",
              desc: "The most pictures one request shows, however many are asked for.",
              control: { type: "slider", key: "imageMaxCount", min: 1, max: 8, step: 1 },
            },
            {
              name: "Save pictures to",
              desc: "The folder for pictures saved from the chat with their download button. Leave empty to use Obsidian's own place for attachments (Files and links).",
              aliases: ["Image folder", "Save to vault", "Attachments"],
              control: {
                type: "folder",
                key: "imageSaveFolder",
                placeholder: "Obsidian's attachment folder",
              },
            },
          ],
        },
        {
          type: "group",
          heading: "Sources",
          items: [
            noteItem(
              "Find image tries the sources that are on, from the top, until it has enough pictures. Your search terms go to these services; your notes never do.",
            ),
            ...sourceRows,
            noteItem(
              "No source is on, so Find image cannot show pictures.",
              "warning",
              () => !this.s.imageSources.some((src) => src.enabled),
            ),
          ],
        },
        {
          type: "group",
          heading: "Keys",
          visible: () => keyed.some((info) => enabled(info.id)),
          items: keyItems,
        },
      ],
    };
  }

  private skillsPage(): SettingDefinitionPage<SettingKey> {
    const skills = this.s.customSkills;
    return {
      type: "page",
      name: "Skills and agent",
      desc: "How Horme uses tools, and your own web skills.",
      displayValue: () => {
        const n = this.s.customSkills.length;
        return n ? `${n} custom skill${n === 1 ? "" : "s"}` : "";
      },
      items: [
        {
          type: "group",
          heading: "Agent",
          items: [
            {
              name: "Native tool calling",
              desc: "Offers skills to local models as structured tools, which tool-trained models (Gemma, Qwen, Llama 3) use far more reliably. Other models get the skills as text instructions.",
              control: { type: "toggle", key: "nativeToolCalling" },
            },
            {
              name: "Agent mode",
              desc: "The model plans first and may use more skills per request. Each skill call appears as a step in the chat.",
              control: { type: "toggle", key: "agentMode" },
            },
            {
              name: "Skill calls per request",
              desc: "The most skill calls in agent mode. Without agent mode the limit is 5.",
              aliases: ["Agent tool budget"],
              visible: () => this.s.agentMode,
              control: { type: "slider", key: "agentMaxRounds", min: 1, max: 50, step: 1 },
            },
            {
              name: "Think again after a skill",
              desc: "Off: once a skill has answered, a local model (llama.cpp, Ollama) writes the reply without a second thinking phase, which is much faster. On: it thinks again first, as on the first round.",
              aliases: ["Reasoning after skills", "Thinking"],
              control: { type: "toggle", key: "thinkAfterSkills" },
            },
          ],
        },
        {
          type: "list",
          heading: "Custom skills",
          emptyState:
            "No custom skills yet. A custom skill lets Horme call any web API, such as a dictionary or a catalogue.",
          addItem: {
            name: "Add a custom skill",
            action: () => {
              new CustomSkillModal(this.app, this.plugin, (def) => {
                this.s.customSkills.push(def);
                this.saveSoon();
                this.refresh(true);
              }).open();
            },
          },
          onDelete: (index: number) => {
            this.s.customSkills.splice(index, 1);
            this.saveSoon();
            this.refresh(true);
          },
          items: skills.map(
            (skill, i): GroupItem => ({
              name: skill.name,
              desc: skill.description,
              render: (setting: Setting) => {
                setting.setName(skill.name).setDesc(skill.description);
                setting.addExtraButton((b) =>
                  b
                    .setIcon("pencil")
                    .setTooltip("Edit")
                    .onClick(() => {
                      new CustomSkillModal(
                        this.app,
                        this.plugin,
                        (def) => {
                          this.s.customSkills[i] = def;
                          this.saveSoon();
                          this.refresh(true);
                        },
                        skill,
                      ).open();
                    }),
                );
              },
            }),
          ),
        },
      ],
    };
  }

  /* ── Mobile ──────────────────────────────────────────────────────────── */

  private mobilePage(): SettingDefinitionPage<SettingKey> {
    const on = () => this.s.useMobileOverride;
    return {
      type: "page",
      name: "On mobile",
      desc: "A different provider for phones and tablets.",
      displayValue: () =>
        on()
          ? `${providerInfo(this.s.mobileProvider).name} · ${this.s.mobileModel || "default model"}`
          : "Off",
      items: [
        {
          type: "group",
          items: [
            {
              name: "Use a different provider on mobile",
              desc: "Phones and tablets use the provider and model below, and keep any provider or model you pick on the phone, here or in the chat. Desktop settings stay as they are.",
              aliases: ["Enable mobile override", "Platform overrides"],
              control: { type: "toggle", key: "useMobileOverride" },
            },
            {
              name: "Mobile provider",
              visible: on,
              control: { type: "dropdown", key: "mobileProvider", options: providerOptions() },
            },
            modelField(this, {
              name: "Mobile model",
              desc: "Pick a model or type its name. Leave empty to use the provider's model from the Models page.",
              key: "mobileModel",
              listId: "horme-mobile-models",
              provider: () => this.s.mobileProvider,
              purpose: "chat",
              visible: on,
            }),
            noteItem(
              "A phone cannot reach a server on this computer at 127.0.0.1 or localhost. Use a cloud provider, or a server address on your network.",
              "info",
              () => on() && isLocalProvider(this.s.mobileProvider),
            ),
          ],
        },
      ],
    };
  }

  /* ── Diagnostics ─────────────────────────────────────────────────────── */

  private diagnosticsPage(): SettingDefinitionPage<SettingKey> {
    return {
      type: "page",
      name: "Diagnostics",
      desc: "Index health and recent problems.",
      displayValue: () => {
        const n = this.plugin.diagnosticService.getSummary().errors;
        return n ? `${n} error${n === 1 ? "" : "s"}` : "";
      },
      status: () => (this.plugin.diagnosticService.getSummary().errors > 0 ? "warning" : null),
      items: [
        { type: "group", heading: "Indexes", items: [healthItem(this)] },
        { type: "group", heading: "Activity", items: [activityLogItem(this)] },
        {
          type: "group",
          heading: "Developer",
          items: [
            {
              name: "Debug logging",
              desc: "Writes extra detail to the developer console, including file paths. Leave off for everyday use.",
              control: { type: "toggle", key: "debugLoggingEnabled" },
            },
          ],
        },
      ],
    };
  }
}
