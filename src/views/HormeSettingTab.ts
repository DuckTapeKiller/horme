import { App, PluginSettingTab, Setting, Notice, setIcon, requestUrl, SecretComponent } from "obsidian";
import HormePlugin from "../../main";
import { PROVIDER_MODELS } from "../constants";
import { AiProvider } from "../types";
import { FileSuggest, FolderSuggest, FileOrFolderSuggest } from "../utils/Suggest";
import { GenericConfirmModal } from "../modals/GenericConfirmModal";
import { CustomSkillModal } from "../modals/CustomSkillModal";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";
import { normalizeBaseUrl } from "../utils/normalizeBaseUrl";

type CloudProviderId = Exclude<AiProvider, "ollama" | "lmstudio">;
type CloudSecretIdField =
  | "claudeSecretId"
  | "geminiSecretId"
  | "openaiSecretId"
  | "groqSecretId"
  | "openRouterSecretId"
  | "mistralSecretId";
type CloudModelField =
  | "claudeModel"
  | "geminiModel"
  | "openaiModel"
  | "groqModel"
  | "openRouterModel"
  | "mistralModel";
type CloudProviderConfig = {
  id: CloudProviderId;
  name: string;
  secretId: CloudSecretIdField;
  model: CloudModelField;
};

export class HormeSettingTab extends PluginSettingTab {
  plugin: HormePlugin;
  private expandedSections: Record<string, boolean> = {};

  constructor(app: App, plugin: HormePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private isAiProvider(value: string): value is AiProvider {
    return (
      value === "ollama" ||
      value === "lmstudio" ||
      value === "claude" ||
      value === "gemini" ||
      value === "openai" ||
      value === "groq" ||
      value === "openrouter" ||
      value === "mistral"
    );
  }

  // ── Updated model suggestions ──────────────────────────────────────────────
  // These supplement (and override) whatever is in PROVIDER_MODELS from constants.
  // Users can always type any model ID not listed here — the datalist is just
  // a convenience, not a constraint.
  private static readonly UPDATED_MODELS: Record<string, string[]> = {
    claude: [
      "claude-opus-4-5-20251001",
      "claude-sonnet-4-5-20251001",
      "claude-haiku-4-5-20251001",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307",
    ],
    openai: [
      "gpt-4o",
      "gpt-4o-mini",
      "o1",
      "o1-mini",
      "o3",
      "o3-mini",
      "gpt-4-turbo",
      "gpt-4",
      "gpt-3.5-turbo",
    ],
    gemini: [
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-1.0-pro",
    ],
    groq: [
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
    ],
    openrouter: [
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-pro",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "meta-llama/llama-3.3-70b-instruct:free",
      "mistralai/mixtral-8x7b-instruct",
      "deepseek/deepseek-chat",
    ],
    mistral: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "open-mistral-7b",
      "open-mixtral-8x7b",
      "pixtral-12b-latest",
      "codestral-latest",
    ],
  };

  /**
   * Renders a text input with Obsidian-native type-ahead suggestions.
   * Unlike addDropdown, the user can type any value — suggestions are
   * just convenience, not a constraint.
   *
   * @param setting     The Setting instance to attach the control to.
   * @param modelsFn    Async function that resolves to the suggestion list.
   *                    Failures are silent — user can still type manually.
   * @param currentValue The currently saved model string (shown immediately).
   * @param onSave      Called with the trimmed value whenever it changes.
   */
  private buildModelCombo(
    setting: Setting,
    listId: string,
    modelsFn: () => Promise<string[]>,
    currentValue: string,
    onSave: (v: string) => Promise<void>,
  ): void {
    setting.addText((t) => {
      t.setPlaceholder("Type or select a model…");
      t.inputEl.setCssProps({ width: "100%" });

      // Set saved value immediately — never wait on network for this
      t.setValue(currentValue);

      // Settings UX goal: show a dropdown list (even before typing) while still allowing
      // free text entry. HTML datalist does that well in Obsidian’s desktop renderer.
      t.inputEl.setAttr("list", listId);

      const datalist = setting.controlEl.createEl("datalist", { attr: { id: listId } });

      const normalize = (models: string[]) =>
        Array.from(new Set(models.map((m) => m.trim()).filter(Boolean)));

      const renderOptions = (models: string[]) => {
        datalist.empty();
        for (const model of models) {
          datalist.createEl("option", { attr: { value: model } });
        }
      };

      const readCustom = (): string[] => {
        const record = this.plugin.settings.customModelSuggestions ?? {};
        return normalize(record[listId] ?? []);
      };

      const writeCustom = (models: string[]) => {
        const record = this.plugin.settings.customModelSuggestions ?? {};
        record[listId] = normalize(models).slice(0, 50);
        this.plugin.settings.customModelSuggestions = record;
      };

      const currentTrimmed = currentValue.trim();
      let modelsCache: string[] = normalize([...(currentTrimmed ? [currentTrimmed] : []), ...readCustom()]);

      // Render immediately using stored suggestions + current value, then refresh from live sources.
      renderOptions(modelsCache);

      void modelsFn()
        .then((models) => {
          const merged = normalize([...(currentTrimmed ? [currentTrimmed] : []), ...readCustom(), ...models]);
          modelsCache = merged;
          renderOptions(modelsCache);
        })
        .catch(() => {
          // Keep whatever we already had (current + stored custom suggestions).
        });

      const commitValue = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return;

        // Remember manually-entered models so they appear in the dropdown next time.
        if (!modelsCache.includes(trimmed)) {
          modelsCache = normalize([trimmed, ...modelsCache]);
          renderOptions(modelsCache);
        }
        writeCustom([trimmed, ...readCustom()]);

        void onSave(trimmed);
      };

      // "change" fires on Enter or blur (commit), avoiding saving partial keystrokes.
      t.inputEl.addEventListener("change", () => commitValue(t.getValue()));
    });
  }

  private displayPreserveScroll() {
    const scroller = this.containerEl.closest(".vertical-tab-content");
    const scrollTop = scroller instanceof HTMLElement ? scroller.scrollTop : 0;
    this.display();
    window.requestAnimationFrame(() => {
      if (scroller instanceof HTMLElement) scroller.scrollTop = scrollTop;
    });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header Section
    const header = containerEl.createDiv("horme-settings-header");
    const iconWrap = header.createDiv("horme-settings-header-icon");
    setIcon(iconWrap, "cone");
    new Setting(header).setName("Overview").setHeading();

    // SYSTEM DIAGNOSTICS & INTELLIGENCE (TOP & EXPANDED)
    const diagSection = containerEl.createDiv("horme-settings-section horme-diag-section");
    new Setting(diagSection).setName("◈ Intelligence dashboard").setHeading();
    diagSection.addClass("horme-diag-title-header");

    // Dashboard Grid
    const grid = diagSection.createDiv("horme-diag-grid");

    // Create UI placeholders that the functions need to reference
    const logWrapper = diagSection.createDiv("horme-diag-logs-wrapper");
    const logHeaderTop = logWrapper.createDiv("horme-diag-logs-header");
    const logTitleContainer = logHeaderTop.createDiv({ cls: "horme-diag-logs-title-container" });
    logTitleContainer.createSpan({ text: "RECENT ACTIVITY LOG" });
    const summarySpan = logHeaderTop.createSpan();
    const logContent = logWrapper.createDiv("horme-diag-logs-content");

    // --- DEFINE FUNCTIONS FIRST ---
    const updateSummary = () => {
      const s = this.plugin.diagnosticService.getSummary();
      summarySpan.setText(`${s.errors} ERRORS | ${s.warnings} WARNINGS`);
    };

    const renderLogs = () => {
      logContent.empty();
      const logs = this.plugin.diagnosticService.getLogs();
      if (logs.length > 0) {
        logs.forEach((log) => {
          const entry = logContent.createDiv(`horme-diag-entry horme-diag-entry-${log.type}`);
          const dateStr = new Date(log.timestamp).toLocaleString([], {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
          entry.createSpan({ text: dateStr, cls: "horme-diag-entry-time" });
          entry.createSpan({ text: `[${log.source.toUpperCase()}]`, cls: "horme-diag-entry-source" });
          entry.createSpan({ text: log.message, cls: "horme-diag-entry-msg" });
        });
      } else {
        logContent
          .createDiv({ text: "> No issues detected. System healthy.", cls: "horme-diag-entry-msg" })
          .setCssProps({ opacity: "0.4" });
      }
      updateSummary();
    };

    const refreshHealth = async () => {
      try {
        const healthItems = await this.plugin.diagnosticService.getIndexHealth();
        grid.empty();
        healthItems.forEach((h) => {
          const card = grid.createDiv({ cls: `horme-diag-card is-${h.status || "missing"}` });
          const head = card.createDiv({ cls: "horme-diag-card-header" });
          const icon = h.id === "vault" ? "brain" : h.id === "tags" ? "tags" : "book-open";
          setIcon(head, icon);
          head.createSpan({ text: h.name });
          card.createDiv({
            cls: `horme-diag-status-badge horme-diag-status-${h.status || "missing"}`,
            text: (h.status || "missing").toUpperCase(),
          });

          const countText =
            h.status === "loading" ? "Loading..." : `${(h.entryCount || 0).toLocaleString()} entries`;
          card.createDiv({ cls: "horme-diag-stat", text: countText });

          const footer = card.createDiv({ cls: "horme-diag-footer" });
          if (h.lastUpdate && h.lastUpdate > 0) {
            footer.setText(
              `Updated ${new Date(h.lastUpdate).toLocaleDateString()} ${new Date(h.lastUpdate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            );
          } else {
            footer.setText("Never performed");
          }
        });
        renderLogs();
      } catch {
        grid.empty();
        grid.createEl("p", { text: "Failed to load health metrics.", cls: "horme-diag-empty" });
      }
    };

    // --- CREATE UI ELEMENTS THAT USE THE FUNCTIONS ---

    // Dedicated Refresh Button with Icon
    const refreshBtn = logTitleContainer.createEl("button", {
      cls: "horme-diag-refresh-btn",
      attr: { title: "Refresh dashboard" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => {
      refreshBtn.addClass("is-spinning");
      void refreshHealth().finally(() => {
        window.setTimeout(() => refreshBtn.removeClass("is-spinning"), 600);
      });
      new Notice("Dashboard refreshed.");
    });

    new Setting(diagSection)
      .setName("System health")
      .setDesc("Monitor integrity of your local intelligence.")
      .addButton((btn) =>
        btn.setButtonText("Verify integrity").onClick(() => {
          void refreshHealth().then(() => new Notice("Integrity scan complete."));
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Clear logs").onClick(() => {
          this.plugin.diagnosticService.clear();
          renderLogs();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Copy data").onClick(() => {
          void (async () => {
            const health = await this.plugin.diagnosticService.getIndexHealth();
            const logs = this.plugin.diagnosticService.getLogs();
            await navigator.clipboard.writeText(
              JSON.stringify({ timestamp: new Date().toISOString(), indexHealth: health, logs }, null, 2),
            );
            new Notice("Diagnostic bundle copied.");
          })().catch((e) => this.plugin.handleError(e, "Clipboard"));
        }),
      );

    // Ensure the log wrapper stays at the bottom
    diagSection.appendChild(logWrapper);

    // Initial load
    void refreshHealth();
    renderLogs();

    // AI PROVIDER
    const aiSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    aiSection.open = this.expandedSections["ai_providers"] ?? false;
    aiSection.ontoggle = () => (this.expandedSections["ai_providers"] = aiSection.open);
    aiSection.createEl("summary", { text: "◈ AI providers" });

    new Setting(aiSection).setName("Active provider").addDropdown((dd) => {
      dd.addOption("ollama", "Ollama (local)");
      dd.addOption("lmstudio", "LM Studio (local)");
      dd.addOption("claude", "Anthropic Claude (API)");
      dd.addOption("gemini", "Google Gemini (API)");
      dd.addOption("openai", "OpenAI GPT (API)");
      dd.addOption("groq", "Groq (high speed)");
      dd.addOption("openrouter", "OpenRouter (free/aggregator)");
      dd.addOption("mistral", "Mistral AI (API)");
      dd.setValue(this.plugin.settings.aiProvider);
      dd.onChange((v) => {
        void (async () => {
          if (!this.isAiProvider(v)) return;
          this.plugin.settings.aiProvider = v;
          await this.plugin.saveSettings();
          this.display();
        })();
      });
    });

    const providersContainer = aiSection.createDiv("horme-nested-settings");

    // OLLAMA
    const ollamaSection = providersContainer.createEl("details", { cls: "horme-settings-section" });
    ollamaSection.open = true;
    ollamaSection.createEl("summary", { text: "◈ Ollama (local)" });
    new Setting(ollamaSection).setName("Ollama URL").addText((t) =>
      t.setValue(this.plugin.settings.ollamaBaseUrl).onChange((v) => {
        void (async () => {
          this.plugin.settings.ollamaBaseUrl = v;
          await this.plugin.saveSettings();
        })();
      }),
    );
    this.buildModelCombo(
      new Setting(ollamaSection)
        .setName("Model")
        .setDesc("Select from running models or type a custom name."),
      "horme-ollama-models",
      async () => {
        const res = await requestUrl({ url: `${this.plugin.settings.ollamaBaseUrl}/api/tags` });
        const json: unknown = res.json;
        const models = asArray(getRecordProp(json, "models")) ?? [];
        return models.map((m) => getStringProp(m, "name")).filter((m): m is string => Boolean(m));
      },
      this.plugin.settings.defaultModel,
      async (v) => {
        this.plugin.settings.defaultModel = v;
        await this.plugin.saveSettings();
      },
    );

    // LM STUDIO (FIXED)
    const lmstudioSection = providersContainer.createEl("details", { cls: "horme-settings-section" });
    lmstudioSection.open = true;
    lmstudioSection.createEl("summary", { text: "◈ LM Studio (local)" });
    new Setting(lmstudioSection).setName("LM Studio URL").addText((t) =>
      t.setValue(this.plugin.settings.lmStudioUrl).onChange((v) => {
        void (async () => {
          this.plugin.settings.lmStudioUrl = v;
          await this.plugin.saveSettings();
        })();
      }),
    );
    this.buildModelCombo(
      new Setting(lmstudioSection)
        .setName("Model")
        .setDesc("Select from running models or type a custom name."),
      "horme-lmstudio-models",
      async () => {
        // Strip trailing slash here (provider constructor does it at runtime,
        // but the settings tab URL may still have one when building this request).
        const url = normalizeBaseUrl(this.plugin.settings.lmStudioUrl);
        // Use requestUrl (Obsidian's network layer) instead of fetch — avoids
        // CORS/policy blocks that affect fetch in Obsidian's desktop renderer.
        const res = await requestUrl({ url: `${url}/v1/models` });
        const json: unknown = res.json;
        const dataArr = asArray(getRecordProp(json, "data")) ?? [];
        return dataArr.map((m) => getStringProp(m, "id")).filter((m): m is string => Boolean(m));
      },
      this.plugin.settings.lmStudioModel,
      async (v) => {
        this.plugin.settings.lmStudioModel = v;
        await this.plugin.saveSettings();
      },
    );
    this.buildModelCombo(
      new Setting(lmstudioSection)
        .setName("Embedding model")
        .setDesc(
          "Embedding model for vault RAG (chat models cannot embed). Leave empty to autodetect a loaded embedding model.",
        ),
      "horme-lmstudio-embedding-models",
      async () => {
        const url = normalizeBaseUrl(this.plugin.settings.lmStudioUrl);
        const res = await requestUrl({ url: `${url}/v1/models` });
        const json: unknown = res.json;
        const dataArr = asArray(getRecordProp(json, "data")) ?? [];
        return dataArr
          .map((m) => getStringProp(m, "id"))
          .filter((m): m is string => Boolean(m))
          .filter((m) => /embed/i.test(m));
      },
      this.plugin.settings.lmStudioEmbeddingModel,
      async (v) => {
        this.plugin.settings.lmStudioEmbeddingModel = v;
        await this.plugin.saveSettings();
      },
    );

    // CLOUD PROVIDERS
    const cloudProviders: CloudProviderConfig[] = [
      { id: "claude", name: "Anthropic Claude", secretId: "claudeSecretId", model: "claudeModel" },
      { id: "gemini", name: "Google Gemini", secretId: "geminiSecretId", model: "geminiModel" },
      { id: "openai", name: "OpenAI GPT", secretId: "openaiSecretId", model: "openaiModel" },
      { id: "groq", name: "Groq", secretId: "groqSecretId", model: "groqModel" },
      { id: "openrouter", name: "OpenRouter", secretId: "openRouterSecretId", model: "openRouterModel" },
      { id: "mistral", name: "Mistral AI", secretId: "mistralSecretId", model: "mistralModel" },
    ];

    for (const cp of cloudProviders) {
      const section = providersContainer.createEl("details", { cls: "horme-settings-section" });
      section.open = true;
      section.createEl("summary", { text: `◈ ${cp.name}` });
      new Setting(section)
        .setName("API key")
        .setDesc("Stored in Obsidian secret storage (not in data.json).")
        .addComponent((el) => {
          const c = new SecretComponent(this.app, el);
          c.setValue(this.plugin.settings[cp.secretId]);
          c.onChange((v) => {
            void (async () => {
              this.plugin.settings[cp.secretId] = v.trim();
              await this.plugin.saveSettings();
            })();
          });
          return c;
        });
      this.buildModelCombo(
        new Setting(section).setName("Model").setDesc("Select a suggestion or type any custom model ID."),
        `horme-${cp.id}-models`,
        async () => HormeSettingTab.UPDATED_MODELS[cp.id] ?? PROVIDER_MODELS[cp.id] ?? [],
        this.plugin.settings[cp.model],
        async (v) => {
          this.plugin.settings[cp.model] = v;
          await this.plugin.saveSettings();
        },
      );
    }

    // GENERAL
    const generalSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    generalSection.open = this.expandedSections["general"] ?? false;
    generalSection.ontoggle = () => (this.expandedSections["general"] = generalSection.open);
    generalSection.createEl("summary", { text: "◈ General settings" });
    const tempSetting = new Setting(generalSection)
      .setName("Temperature")
      .setDesc(`Default: 0.3 | Current: ${this.plugin.settings.temperature}`);
    tempSetting.addSlider((sl) =>
      sl
        .setLimits(0, 1, 0.1)
        .setValue(this.plugin.settings.temperature)

        .onChange((v) => {
          void (async () => {
            this.plugin.settings.temperature = v;
            tempSetting.setDesc(`Default: 0.3 | Current: ${v}`);
            await this.plugin.saveSettings();
          })();
        }),
    );

    new Setting(generalSection)
      .setName("Max output tokens")
      .setDesc(
        "Maximum number of tokens the model can generate per response. Default: 8192. Raise this for long documents or complex writing tasks. Check your provider's documentation for model-specific limits.",
      )
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "256";
        t.inputEl.step = "256";
        t.setValue(String(this.plugin.settings.maxTokens));
        t.onChange((v) => {
          void (async () => {
            const parsed = parseInt(v, 10);
            if (!isNaN(parsed) && parsed >= 256) {
              this.plugin.settings.maxTokens = parsed;
              await this.plugin.saveSettings();
            }
          })();
        });
      });
    new Setting(generalSection)
      .setName("Folder context limit (characters)")
      .setDesc(
        'Maximum number of characters injected from "+ Add folders" per message (combined across selected folders). ' +
          'If exceeded, Horme truncates the folder context and you should use "+ Add notes" to pick specific files. ' +
          "Default: 40000.",
      )
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "1000";
        t.inputEl.step = "1000";
        t.setValue(String(this.plugin.settings.contextFoldersMaxChars));
        t.onChange((v) => {
          void (async () => {
            const parsed = parseInt(v, 10);
            if (!isNaN(parsed) && parsed >= 1000) {
              this.plugin.settings.contextFoldersMaxChars = parsed;
              await this.plugin.saveSettings();
            }
          })();
        });
      });
    new Setting(generalSection)
      .setName("Debug logging")
      .setDesc(
        "Enable extra logs in the developer console (may include file paths). Leave off for normal use.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugLoggingEnabled).onChange((v) => {
          void (async () => {
            this.plugin.settings.debugLoggingEnabled = v;
            await this.plugin.saveSettings();
          })();
        }),
      );
    new Setting(generalSection).setName("Export folder").addText((t) =>
      t.setValue(this.plugin.settings.exportFolder).onChange((v) => {
        void (async () => {
          this.plugin.settings.exportFolder = v.trim() || "HORME";
          await this.plugin.saveSettings();
        })();
      }),
    );

    // AGENT & TOOL CALLING
    const agentSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    agentSection.open = this.expandedSections["agent"] ?? false;
    agentSection.ontoggle = () => (this.expandedSections["agent"] = agentSection.open);
    agentSection.createEl("summary", { text: "◈ Agent & tool calling" });
    new Setting(agentSection)
      .setName("Native tool calling")
      .setDesc(
        "Offer skills as structured function schemas on LM Studio and Ollama — far more reliable with tool-trained models (gemma, qwen, llama 3). The XML skill prompt remains the fallback for other providers and unsupported models.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.nativeToolCalling).onChange((v) => {
          void (async () => {
            this.plugin.settings.nativeToolCalling = v;
            await this.plugin.saveSettings();
          })();
        }),
      );
    new Setting(agentSection)
      .setName("Agent mode")
      .setDesc(
        "Plan-first prompting and a larger skill budget for multi-step tasks. Skill calls appear as a step timeline in the chat.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.agentMode).onChange((v) => {
          void (async () => {
            this.plugin.settings.agentMode = v;
            await this.plugin.saveSettings();
          })();
        }),
      );
    new Setting(agentSection)
      .setName("Agent tool budget")
      .setDesc("Maximum skill calls per request in agent mode (1-50). Without agent mode the budget is 5.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.agentMaxRounds)).onChange((v) => {
          void (async () => {
            const parsed = parseInt(v, 10);
            this.plugin.settings.agentMaxRounds = Number.isFinite(parsed)
              ? Math.min(50, Math.max(1, parsed))
              : 25;
            await this.plugin.saveSettings();
          })();
        }),
      );

    // SYSTEM PROMPT & PRESETS
    const presetSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    presetSection.open = this.expandedSections["presets"] ?? false;
    presetSection.ontoggle = () => (this.expandedSections["presets"] = presetSection.open);
    presetSection.createEl("summary", { text: "◈ System prompt & presets" });

    new Setting(presetSection)
      .setName("System prompt note")
      .setDesc(
        "Select a note in your vault to use as the master system prompt. This note defines the AI's identity and rules.",
      )
      .addText((t) => {
        new FileSuggest(this.app, t.inputEl);
        t.setPlaceholder("path/to/note.md")
          .setValue(this.plugin.settings.systemPromptPath)
          .onChange((v) => {
            void (async () => {
              this.plugin.settings.systemPromptPath = v.trim();
              await this.plugin.saveSettings();
            })();
          });
      });

    // PRESETS DYNAMIC LIST
    const presetsContainer = presetSection.createDiv("horme-presets-container");
    this.plugin.settings.presetsPaths.forEach((path, i) => {
      new Setting(presetsContainer)
        .setName(`Preset Source ${i + 1}`)
        .setDesc("A note or folder path.")
        .addText((t) => {
          new FileOrFolderSuggest(this.app, t.inputEl);
          t.setPlaceholder("Path/to/note_or_folder")
            .setValue(path)
            .onChange((v) => {
              void (async () => {
                this.plugin.settings.presetsPaths[i] = v.trim();
                await this.plugin.saveSettings();
              })();
            });
        })
        .addButton((btn) => {
          btn.setIcon("trash").onClick(() => {
            void (async () => {
              this.plugin.settings.presetsPaths.splice(i, 1);
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          });
        });
    });

    new Setting(presetSection).addButton((btn) => {
      btn
        .setButtonText("Add more presets")
        .setCta()
        .onClick(() => {
          void (async () => {
            this.plugin.settings.presetsPaths.push("");
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          })();
        });
    });

    // PLATFORM OVERRIDES
    const platformSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    platformSection.open = this.expandedSections["platform"] ?? false;
    platformSection.ontoggle = () => (this.expandedSections["platform"] = platformSection.open);
    platformSection.createEl("summary", { text: "◈ Platform overrides" });

    new Setting(platformSection)
      .setName("Enable mobile override")
      .setDesc("Automatically switch to a specific provider/model when on a mobile device.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useMobileOverride).onChange((v) => {
          void (async () => {
            this.plugin.settings.useMobileOverride = v;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          })();
        }),
      );

    if (this.plugin.settings.useMobileOverride) {
      new Setting(platformSection).setName("Mobile provider").addDropdown((dd) => {
        dd.addOption("ollama", "Ollama (local)");
        dd.addOption("lmstudio", "LM Studio (local)");
        dd.addOption("claude", "Anthropic Claude (API)");
        dd.addOption("gemini", "Google Gemini (API)");
        dd.addOption("openai", "OpenAI GPT (API)");
        dd.addOption("groq", "Groq (high speed)");
        dd.addOption("openrouter", "OpenRouter (free/aggregator)");
        dd.addOption("mistral", "Mistral AI (API)");
        dd.setValue(this.plugin.settings.mobileProvider);
        dd.onChange((v) => {
          void (async () => {
            if (!this.isAiProvider(v)) return;
            this.plugin.settings.mobileProvider = v;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          })();
        });
      });

      this.buildModelCombo(
        new Setting(platformSection)
          .setName("Mobile model")
          .setDesc("Select a suggestion or type any custom model ID."),
        "horme-mobile-models",
        async () => {
          const provider = this.plugin.settings.mobileProvider;
          if (provider === "ollama") {
            const res = await requestUrl({
              url: `${this.plugin.settings.ollamaBaseUrl}/api/tags`,
              throw: false,
            });
            const json: unknown = res.json;
            const models = asArray(getRecordProp(json, "models")) ?? [];
            return models.map((m) => getStringProp(m, "name")).filter((m): m is string => Boolean(m));
          } else if (provider === "lmstudio") {
            const url = normalizeBaseUrl(this.plugin.settings.lmStudioUrl);
            const res = await requestUrl({ url: `${url}/v1/models` });
            const json: unknown = res.json;
            const dataArr = asArray(getRecordProp(json, "data")) ?? [];
            return dataArr.map((m) => getStringProp(m, "id")).filter((m): m is string => Boolean(m));
          } else {
            return HormeSettingTab.UPDATED_MODELS[provider] ?? PROVIDER_MODELS[provider] ?? [];
          }
        },
        this.plugin.settings.mobileModel,
        async (v) => {
          this.plugin.settings.mobileModel = v;
          await this.plugin.saveSettings();
        },
      );
    }

    // --- Grammar Scholar Index ---
    const grammarSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    grammarSection.open = this.expandedSections["grammar"] ?? false;
    grammarSection.ontoggle = () => (this.expandedSections["grammar"] = grammarSection.open);
    grammarSection.createEl("summary", { text: "◈ Grammar scholar index" });

    new Setting(grammarSection)
      .setName("Grammar manual folder")
      .setDesc("The folder in your vault containing grammar rules for your primary language.")
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setValue(this.plugin.settings.grammarFolderPath).onChange((v) => {
          void (async () => {
            this.plugin.settings.grammarFolderPath = v.trim() || "Gramática";
            await this.plugin.saveSettings();
          })();
        });
      });

    new Setting(grammarSection)
      .setName("Grammar language")
      .setDesc(
        "The language your grammar manuals cover. Proofreading will only consult grammar manuals when the text is in this language.",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.grammarLanguage).onChange((v) => {
          void (async () => {
            this.plugin.settings.grammarLanguage = v.trim() || "Español";
            await this.plugin.saveSettings();
          })();
        }),
      );

    new Setting(grammarSection)
      .setName("Rebuild grammar index")
      .setDesc("Synchronise the skill with the latest content in your grammar manuals folder.")
      .addButton((btn) => {
        btn.setButtonText("Rebuild now").onClick(() => {
          void (async () => {
            await this.plugin.grammarIndexer.rebuildIndex();
            new Notice("✅ Grammar index rebuilt");
          })();
        });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Delete index")
          .setWarning()
          .onClick(() => {
            new GenericConfirmModal(
              this.app,
              "Delete the Grammar Index from memory and disk? You can rebuild it later.",
              () => {
                void (async () => {
                  const result = await this.plugin.grammarIndexer.deleteIndex();
                  new Notice(result === "deleted" ? "Grammar Index deleted." : "No Grammar Index detected.");
                  this.displayPreserveScroll();
                })();
              },
            ).open();
          });
      });

    // --- Frontmatter Summary ---
    const summarySection = containerEl.createEl("details", { cls: "horme-settings-section" });
    summarySection.open = this.expandedSections["summary"] ?? false;
    summarySection.ontoggle = () => (this.expandedSections["summary"] = summarySection.open);
    summarySection.createEl("summary", { text: "◈ Frontmatter summary" });

    new Setting(summarySection)
      .setName("Summary field")
      .setDesc(
        "The frontmatter key where generated summaries are stored (e.g. 'summary', 'resumen', 'abstract').",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.summaryField).onChange((v) => {
          void (async () => {
            this.plugin.settings.summaryField = v.trim() || "summary";
            await this.plugin.saveSettings();
          })();
        }),
      );

    new Setting(summarySection)
      .setName("Summary language")
      .setDesc("The language summaries should be written in.")
      .addText((t) =>
        t.setValue(this.plugin.settings.summaryLanguage).onChange((v) => {
          void (async () => {
            this.plugin.settings.summaryLanguage = v.trim() || "Español";
            await this.plugin.saveSettings();
          })();
        }),
      );

    // --- Tag Taxonomy Index ---
    const tagSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    tagSection.open = this.expandedSections["tags"] ?? false;
    tagSection.ontoggle = () => (this.expandedSections["tags"] = tagSection.open);
    tagSection.createEl("summary", { text: "◈ Tag taxonomy index" });

    new Setting(tagSection)
      .setName("Tag list note")
      .setDesc("Optional: A note containing a list of allowed tags (one per line).")
      .addText((t) =>
        t.setValue(this.plugin.settings.tagsFilePath).onChange((v) => {
          void (async () => {
            this.plugin.settings.tagsFilePath = v.trim();
            await this.plugin.saveSettings();
          })();
        }),
      );

    new Setting(tagSection)
      .setName("Rebuild tag index")
      .setDesc("Index your vault's tag structure for semantic suggestions. (Global access enabled)")
      .addButton((btn) => {
        btn.setButtonText("Rebuild now").onClick(() => {
          void (async () => {
            await this.plugin.tagIndexer.rebuildTagIndex();
            new Notice("✅ Tag index ready");
          })();
        });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Delete index")
          .setWarning()
          .onClick(() => {
            new GenericConfirmModal(
              this.app,
              "Delete the Tag Index from memory and disk? You can rebuild it later.",
              () => {
                void (async () => {
                  const result = await this.plugin.tagIndexer.deleteIndex();
                  new Notice(result === "deleted" ? "Tag Index deleted." : "No Tag Index detected.");
                  this.displayPreserveScroll();
                })();
              },
            ).open();
          });
      });

    // --- Tag Generation Model Override ---
    {
      const allowCloud = this.plugin.settings.allowCloudRAG;
      const tagProviderSetting = new Setting(tagSection)
        .setName("Tag generation provider")
        .setDesc(
          allowCloud
            ? "Provider used exclusively for the Tags button and command. Changing this does not affect the chat. Leave the model below empty to use the current chat provider instead."
            : 'Provider used exclusively for the Tags button and command. Only local providers are available to protect your privacy. Enable "Allow Cloud Provider Access" in Vault Brain to unlock cloud providers.',
        )
        .addDropdown((drp) => {
          drp.addOption("ollama", "Ollama (local)");
          drp.addOption("lmstudio", "LM Studio (local)");
          if (allowCloud) {
            drp.addOption("claude", "Anthropic Claude");
            drp.addOption("gemini", "Google Gemini");
            drp.addOption("openai", "OpenAI");
            drp.addOption("groq", "Groq");
            drp.addOption("openrouter", "OpenRouter");
            drp.addOption("mistral", "Mistral AI");
          }
          // If the saved provider is a cloud one but cloud is now disabled,
          // silently clamp to "ollama" so the dropdown doesn't show a blank.
          const savedProvider = this.plugin.settings.tagsProvider;
          const cloudProviders = ["claude", "gemini", "openai", "groq", "openrouter", "mistral"];
          const effectiveProvider =
            !allowCloud && cloudProviders.includes(savedProvider) ? "ollama" : savedProvider;
          if (effectiveProvider !== savedProvider) {
            void (async () => {
              this.plugin.settings.tagsProvider = effectiveProvider;
              this.plugin.settings.tagsModel = "";
              await this.plugin.saveSettings();
            })();
          }
          drp.setValue(effectiveProvider);
          drp.onChange((v) => {
            void (async () => {
              this.plugin.settings.tagsProvider = v as AiProvider;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          });
          return drp;
        });
      void tagProviderSetting; // suppress unused-variable warning
    }

    this.buildModelCombo(
      new Setting(tagSection)
        .setName("Tag generation model")
        .setDesc(
          "The exact model used for tag generation. Leave blank to use the current chat model. For local providers, type the model name or pick from the dropdown. For cloud providers, type any valid model ID.",
        ),
      "horme-tags-gen-model",
      async () => {
        const p = this.plugin.settings.tagsProvider;
        try {
          if (p === "ollama") {
            const res = await requestUrl({
              url: `${this.plugin.settings.ollamaBaseUrl}/api/tags`,
              throw: false,
            });
            const json: unknown = res.json;
            const models = asArray(getRecordProp(json, "models")) ?? [];
            return models.map((m) => getStringProp(m, "name")).filter((m): m is string => Boolean(m));
          }
          if (p === "lmstudio") {
            const url = normalizeBaseUrl(this.plugin.settings.lmStudioUrl);
            const res = await requestUrl({ url: `${url}/v1/models`, throw: false });
            const json: unknown = res.json;
            const dataArr = asArray(getRecordProp(json, "data")) ?? [];
            return dataArr.map((m) => getStringProp(m, "id")).filter((m): m is string => Boolean(m));
          }
          return PROVIDER_MODELS[p] ?? [];
        } catch {
          return PROVIDER_MODELS[p] ?? [];
        }
      },
      this.plugin.settings.tagsModel,
      async (v) => {
        this.plugin.settings.tagsModel = v;
        await this.plugin.saveSettings();
      },
    );

    if (!this.plugin.settings.allowCloudRAG) {
      const tagsCloudNote = tagSection.createDiv("horme-settings-muted");
      tagsCloudNote.setText(
        'Cloud providers are locked. To unlock them, enable "allow cloud provider access" in the Vault Brain section.',
      );
    }

    // --- Connections Feature ---
    const connectionsSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    connectionsSection.open = this.expandedSections["connections"] ?? false;
    connectionsSection.ontoggle = () => (this.expandedSections["connections"] = connectionsSection.open);
    connectionsSection.createEl("summary", { text: "◈ Live connections" });

    new Setting(connectionsSection)
      .setName("Enable live connections")
      .setDesc(
        "Automatically surface related notes in a sidebar panel as you write. (Requires Vault Brain to be enabled and indexed).",
      )
      .addToggle((t) => {
        t.setValue(this.plugin.settings.connectionsEnabled).onChange((v) => {
          void (async () => {
            this.plugin.settings.connectionsEnabled = v;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          })();
        });
      });

    if (this.plugin.settings.connectionsEnabled) {
      const threshSetting = new Setting(connectionsSection)
        .setName("Similarity threshold")
        .setDesc(
          `Minimum similarity required to show a connection. (Current: ${this.plugin.settings.connectionsThreshold})`,
        );
      threshSetting.addSlider((sl) =>
        sl
          .setLimits(0.1, 0.9, 0.05)
          .setValue(this.plugin.settings.connectionsThreshold)

          .onChange((v) => {
            void (async () => {
              this.plugin.settings.connectionsThreshold = v;
              threshSetting.setDesc(`Minimum similarity required to show a connection. (Current: ${v})`);
              await this.plugin.saveSettings();
            })();
          }),
      );

      const maxResultsSetting = new Setting(connectionsSection)
        .setName("Max results limit")
        .setDesc(
          `Maximum number of connections to display. (Current: ${this.plugin.settings.connectionsMaxResults})`,
        );
      maxResultsSetting.addSlider((sl) =>
        sl
          .setLimits(5, 50, 1)
          .setValue(this.plugin.settings.connectionsMaxResults)

          .onChange((v) => {
            void (async () => {
              this.plugin.settings.connectionsMaxResults = v;
              maxResultsSetting.setDesc(`Maximum number of connections to display. (Current: ${v})`);
              await this.plugin.saveSettings();
            })();
          }),
      );

      new Setting(connectionsSection)
        .setName("Excluded folders")
        .setDesc("Comma-separated list of folder prefixes to ignore (e.g., 'templates, daily notes').")
        .addText((t) =>
          t
            .setPlaceholder("E.g. Templates, daily notes")
            .setValue(this.plugin.settings.connectionsExcludedFolders)
            .onChange((v) => {
              void (async () => {
                this.plugin.settings.connectionsExcludedFolders = v;
                await this.plugin.saveSettings();
              })();
            }),
        );

      new Setting(connectionsSection)
        .setName("Open in new tab")
        .setDesc("Clicking a connection opens it in a new split pane instead of replacing the active view.")
        .addToggle((t) =>
          t.setValue(this.plugin.settings.connectionsOpenInNewTab).onChange((v) => {
            void (async () => {
              this.plugin.settings.connectionsOpenInNewTab = v;
              await this.plugin.saveSettings();
            })();
          }),
        );

      new Setting(connectionsSection)
        .setName("Display style")
        .setDesc("Choose how connections are rendered in the sidebar.")
        .addDropdown((dd) =>
          dd
            .addOption("minimal", "Minimal (title only)")
            .addOption("detailed", "Detailed (title + path)")
            .setValue(this.plugin.settings.connectionsDisplayStyle)
            .onChange((v) => {
              void (async () => {
                this.plugin.settings.connectionsDisplayStyle = v as "minimal" | "detailed";
                await this.plugin.saveSettings();
              })();
            }),
        );
    }

    // --- Vault Brain (Local RAG) ---
    const ragSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    ragSection.open = this.expandedSections["vault_brain"] ?? false;
    ragSection.ontoggle = () => (this.expandedSections["vault_brain"] = ragSection.open);
    ragSection.createEl("summary", { text: "◈ Vault brain" });

    const isLocal =
      this.plugin.settings.aiProvider === "ollama" || this.plugin.settings.aiProvider === "lmstudio";

    if (!isLocal && !this.plugin.settings.allowCloudRAG) {
      const warning = ragSection.createDiv("horme-settings-warning");
      warning.setText("⚠️ Vault Brain is disabled for cloud providers to protect your privacy.");
      warning.setCssProps({
        color: "var(--text-error)",
        padding: "10px",
        marginBottom: "10px",
        border: "1px solid var(--background-modifier-border)",
        borderRadius: "var(--radius-s)",
      });
    }

    new Setting(ragSection)
      .setName("Enable local vault memory")
      .setDesc("Let Horme remember everything in your vault.")
      .addToggle((t) => {
        const canEnable = isLocal || this.plugin.settings.allowCloudRAG;
        t.setValue(this.plugin.settings.vaultBrainEnabled && canEnable)
          .setDisabled(!canEnable)
          .onChange((v) => {
            void (async () => {
              this.plugin.settings.vaultBrainEnabled = v;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          });
      });

    new Setting(ragSection)
      .setName("Allow cloud provider access")
      .setDesc(
        "Warning: If enabled, snippets from your notes will be sent to cloud servers. This reduces privacy.",
      )
      .addToggle((t) => {
        t.setValue(this.plugin.settings.allowCloudRAG).onChange((v) => {
          void (async () => {
            if (v) {
              new GenericConfirmModal(
                this.app,
                "Are you sure? This will send snippets from your notes to third-party cloud servers.",
                () => {
                  void (async () => {
                    this.plugin.settings.allowCloudRAG = true;
                    await this.plugin.saveSettings();
                    this.displayPreserveScroll();
                  })();
                },
              ).open();
              t.setValue(false); // reset toggle — modal will re-enable if confirmed
              return;
            }
            this.plugin.settings.allowCloudRAG = false;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          })();
        });
      });

    if (this.plugin.settings.vaultBrainEnabled && (isLocal || this.plugin.settings.allowCloudRAG)) {
      this.buildModelCombo(
        new Setting(ragSection)
          .setName("Embedding model")
          .setDesc(
            "Must be a specialized embedding model. Type a custom name or pick from those running in Ollama.",
          ),
        "horme-embed-models",
        async () => {
          const res = await requestUrl({ url: `${this.plugin.settings.ollamaBaseUrl}/api/tags` });
          const json: unknown = res.json;
          const models = asArray(getRecordProp(json, "models")) ?? [];
          const names = models.map((m) => getStringProp(m, "name")).filter((m): m is string => Boolean(m));
          return names.length > 0 ? names : ["nomic-embed-text", "mxbai-embed-large", "all-minilm"];
        },
        this.plugin.settings.ragEmbeddingModel,
        async (v) => {
          this.plugin.settings.ragEmbeddingModel = v;
          await this.plugin.saveSettings();
          this.displayPreserveScroll();
        },
      );

      new Setting(ragSection)
        .setName("Bilingual tag shadowing")
        .setDesc(
          "Automatically translates your tags into a second language during indexing. This 'shadows' your tags so that search queries in either language will find the note. (Note: This only affects the AI index; it will never modify your actual note files or tags.)",
        )
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.tagShadowingEnabled).onChange((v) => {
            void (async () => {
              this.plugin.settings.tagShadowingEnabled = v;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          }),
        );

      if (this.plugin.settings.tagShadowingEnabled) {
        // If cloud tag translation is disabled, ensure the selected provider cannot be cloud.
        const tagProviderIsCloud =
          this.plugin.settings.tagTranslationProvider !== "ollama" &&
          this.plugin.settings.tagTranslationProvider !== "lmstudio";
        if (tagProviderIsCloud && !this.plugin.settings.allowCloudTagTranslation) {
          this.plugin.settings.tagTranslationProvider = this.plugin.settings.tagTranslationFallbackProvider;
          void this.plugin.saveSettings();
        }

        new Setting(ragSection)
          .setName("Shadowing target language")
          .setDesc("The language that tags will be translated into.")
          .addDropdown((drp) =>
            drp
              .addOption("Spanish", "Spanish")
              .addOption("English", "English")
              .addOption("German", "German")
              .addOption("French", "French")
              .addOption("Italian", "Italian")
              .addOption("Portuguese", "Portuguese")
              .addOption("Chinese", "Chinese")
              .addOption("Japanese", "Japanese")
              .addOption("Korean", "Korean")
              .addOption("Russian", "Russian")
              .addOption("Dutch", "Dutch")
              .addOption("Arabic", "Arabic")
              .addOption("Turkish", "Turkish")
              .addOption("Hindi", "Hindi")
              .addOption("Polish", "Polish")
              .setValue(this.plugin.settings.tagShadowingLanguage)
              .onChange((v) => {
                void (async () => {
                  this.plugin.settings.tagShadowingLanguage = v;
                  await this.plugin.saveSettings();
                })();
              }),
          );

        new Setting(ragSection)
          .setName("Allow cloud tag translation")
          .setDesc(
            "If enabled, Horme may send tag strings (not note contents) to a cloud provider for higher-quality translation. Tag names may still contain sensitive information.",
          )
          .addToggle((t) =>
            t.setValue(this.plugin.settings.allowCloudTagTranslation).onChange((v) => {
              void (async () => {
                this.plugin.settings.allowCloudTagTranslation = v;
                // If disabling cloud translation, force the provider back to local fallback.
                if (!v) {
                  this.plugin.settings.tagTranslationProvider =
                    this.plugin.settings.tagTranslationFallbackProvider;
                }
                await this.plugin.saveSettings();
                this.displayPreserveScroll();
              })();
            }),
          );

        new Setting(ragSection)
          .setName("Tag translation provider")
          .setDesc(
            "Primary provider used for tag translation during indexing. This is independent of the chat provider.",
          )
          .addDropdown((drp) => {
            drp.addOption("ollama", "Ollama").addOption("lmstudio", "LM Studio");
            if (this.plugin.settings.allowCloudTagTranslation) {
              drp
                .addOption("openai", "OpenAI")
                .addOption("claude", "Claude")
                .addOption("gemini", "Gemini")
                .addOption("groq", "Groq")
                .addOption("openrouter", "OpenRouter")
                .addOption("mistral", "Mistral");
            }

            drp.setValue(this.plugin.settings.tagTranslationProvider).onChange((v) => {
              void (async () => {
                this.plugin.settings.tagTranslationProvider = v as AiProvider;
                await this.plugin.saveSettings();
                this.displayPreserveScroll();
              })();
            });
          });

        const tagProviderIsCloudNow =
          this.plugin.settings.tagTranslationProvider !== "ollama" &&
          this.plugin.settings.tagTranslationProvider !== "lmstudio";

        if (tagProviderIsCloudNow) {
          ragSection.createDiv({
            cls: "horme-settings-muted",
            text: "Privacy note: Only tag strings (frontmatter tags and inline #tags) are sent to the cloud for translation — never note content.",
          });

          const cloudProvider = this.plugin.settings.tagTranslationProvider as CloudProviderId;
          const cloudModelField: CloudModelField =
            cloudProvider === "claude"
              ? "claudeModel"
              : cloudProvider === "gemini"
                ? "geminiModel"
                : cloudProvider === "openai"
                  ? "openaiModel"
                  : cloudProvider === "groq"
                    ? "groqModel"
                    : cloudProvider === "openrouter"
                      ? "openRouterModel"
                      : "mistralModel";

          this.buildModelCombo(
            new Setting(ragSection)
              .setName("Tag translation model (cloud)")
              .setDesc(
                "Model used on the selected cloud provider for tag translation. Only tag strings are sent (not note contents).",
              ),
            `horme-tag-translation-${cloudProvider}-models`,
            async () => HormeSettingTab.UPDATED_MODELS[cloudProvider] ?? PROVIDER_MODELS[cloudProvider] ?? [],
            this.plugin.settings[cloudModelField],
            async (v) => {
              this.plugin.settings[cloudModelField] = v;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            },
          );

          new Setting(ragSection)
            .setName("Tag translation fallback (local)")
            .setDesc("Used if the cloud provider is unavailable (no internet, API error, etc).")
            .addDropdown((drp) =>
              drp
                .addOption("ollama", "Ollama")
                .addOption("lmstudio", "LM Studio")
                .setValue(this.plugin.settings.tagTranslationFallbackProvider)
                .onChange((v) => {
                  void (async () => {
                    this.plugin.settings.tagTranslationFallbackProvider = v as "ollama" | "lmstudio";
                    await this.plugin.saveSettings();
                    this.displayPreserveScroll();
                  })();
                }),
            );
        }

        this.buildModelCombo(
          new Setting(ragSection)
            .setName(
              tagProviderIsCloudNow ? "Tag Translation Model (Local Fallback)" : "Tag Translation Model",
            )
            .setDesc(
              tagProviderIsCloudNow
                ? "Local model used as a fallback if the cloud provider fails. (If empty, Horme will try to fall back to your local chat model, then skip translation.)"
                : "Local model used for tag translation during indexing (independent of your chat provider/model).",
            ),
          "horme-tag-trans-models",
          async () => {
            const localProvider =
              this.plugin.settings.tagTranslationProvider === "ollama" ||
              this.plugin.settings.tagTranslationProvider === "lmstudio"
                ? this.plugin.settings.tagTranslationProvider
                : this.plugin.settings.tagTranslationFallbackProvider;
            if (localProvider === "lmstudio") return [];
            try {
              const res = await requestUrl({
                url: `${this.plugin.settings.ollamaBaseUrl}/api/tags`,
                throw: false,
              });
              const json: unknown = res.json;
              const models = asArray(getRecordProp(json, "models")) ?? [];
              return models.map((m) => getStringProp(m, "name")).filter((m): m is string => Boolean(m));
            } catch {
              return [];
            }
          },
          this.plugin.settings.tagTranslationModel,
          async (v) => {
            this.plugin.settings.tagTranslationModel = v;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          },
        );

        const localFallbackProvider =
          this.plugin.settings.tagTranslationProvider === "ollama" ||
          this.plugin.settings.tagTranslationProvider === "lmstudio"
            ? this.plugin.settings.tagTranslationProvider
            : this.plugin.settings.tagTranslationFallbackProvider;
        const localFallbackModel =
          this.plugin.settings.tagTranslationModel.trim() ||
          (localFallbackProvider === "lmstudio"
            ? this.plugin.settings.lmStudioModel.trim()
            : this.plugin.settings.defaultModel.trim());

        if (!localFallbackModel) {
          const warn = ragSection.createDiv("horme-settings-warning");
          warn.textContent = tagProviderIsCloudNow
            ? "⚠️ Cloud tag translation is enabled, but no local fallback model is configured. If the cloud provider fails, tag translation will be skipped."
            : "⚠️ Tag shadowing is enabled but Tag Translation Model is empty. Tags will not be translated until you set a model.";
          warn.setCssProps({
            color: "var(--text-error)",
            padding: "10px",
            marginTop: "8px",
            border: "1px solid var(--background-modifier-border)",
            borderRadius: "var(--radius-s)",
          });
        }

        // --- Test Translation ---
        const testResultsEl = ragSection.createDiv({ cls: "horme-tag-test-results" });
        testResultsEl.setCssStyles({ display: "none" });

        new Setting(ragSection)
          .setName("Test translation")
          .setDesc(
            "Run a sample of your vault tags through the translation model " +
              "to verify output quality before rebuilding the index. " +
              "Uses the Tag Translation Provider and Model configured above.",
          )
          .addButton((btn) => {
            btn.setButtonText("Run test").onClick(async () => {
              btn.setButtonText("Testing...").setDisabled(true);
              testResultsEl.empty();
              testResultsEl.setCssStyles({ display: "block" });

              const loadingEl = testResultsEl.createEl("p", {
                text: "Contacting model — this may take 10–30 seconds on a local LLM...",
                cls: "horme-tag-test-loading",
              });

              try {
                const rows = await this.plugin.vaultIndexer.testTagTranslation();
                loadingEl.remove();

                if (rows.length === 0) {
                  testResultsEl.createEl("p", {
                    text:
                      "No tags found in the sampled vault files. " +
                      "Make sure you have notes with Obsidian tags and that the index has been built.",
                    cls: "horme-tag-test-empty",
                  });
                  return;
                }

                // Collect any warnings first
                const warnings = rows.filter((r) => r.warning !== null);
                if (warnings.length > 0) {
                  const warnBox = testResultsEl.createDiv({ cls: "horme-tag-test-warnings" });
                  warnBox.createEl("strong", { text: "⚠ Model output warnings:" });
                  warnings.forEach((w) => {
                    warnBox.createEl("p", { text: w.warning ?? "", cls: "horme-tag-test-warning-line" });
                  });
                }

                // Build results table
                const table = testResultsEl.createEl("table", { cls: "horme-tag-test-table" });
                const thead = table.createEl("thead");
                const headerRow = thead.createEl("tr");
                headerRow.createEl("th", { text: "Type" });
                headerRow.createEl("th", { text: "Spanish (original)" });
                headerRow.createEl("th", { text: "Translation" });
                headerRow.createEl("th", { text: "Status" });

                const tbody = table.createEl("tbody");

                // Show path rows first, then leaf rows
                const sorted = [...rows].sort((a, b) => (a.type === b.type ? 0 : a.type === "path" ? -1 : 1));

                for (const row of sorted) {
                  const tr = tbody.createEl("tr");
                  tr.createEl("td", {
                    text: row.type === "path" ? "Category label" : "Specific value",
                    cls: `horme-tag-test-type horme-tag-test-type-${row.type}`,
                  });
                  tr.createEl("td", { text: row.original, cls: "horme-tag-test-original" });
                  tr.createEl("td", {
                    text: row.translated ?? "(no output)",
                    cls: row.translated ? "horme-tag-test-translated" : "horme-tag-test-missing",
                  });

                  const statusCell = tr.createEl("td");
                  if (!row.translated) {
                    statusCell.createEl("span", { text: "✗ failed", cls: "horme-tag-test-fail" });
                  } else if (row.warning) {
                    statusCell.createEl("span", { text: "⚠ Check format", cls: "horme-tag-test-warn" });
                  } else {
                    statusCell.createEl("span", { text: "✓", cls: "horme-tag-test-ok" });
                  }
                }

                // Summary line
                const ok = rows.filter((r) => r.translated && !r.warning).length;
                const total = rows.length;
                testResultsEl.createEl("p", {
                  text:
                    `${ok} / ${total} translations look clean. ` +
                    (warnings.length > 0
                      ? `${warnings.length} format issue(s) detected — consider switching to a larger or more instruction-following model.`
                      : "Output format looks correct."),
                  cls: "horme-tag-test-summary",
                });
              } catch (e: unknown) {
                loadingEl.remove();
                testResultsEl.createEl("p", {
                  text: `Test failed: ${e instanceof Error ? e.message : String(e)}`,
                  cls: "horme-tag-test-error",
                });
              } finally {
                btn.setButtonText("Run test").setDisabled(false);
              }
            });
          });
      }

      new Setting(ragSection)
        .setName("Index highlights")
        .setDesc(
          "Adds a highlights-only embedding per note (detects ==highlights== and <mark>...</mark>) to improve retrieval toward your curated text. Requires a rebuild.",
        )
        .addToggle((t) =>
          t.setValue(this.plugin.settings.indexHighlightsEnabled).onChange((v) => {
            void (async () => {
              this.plugin.settings.indexHighlightsEnabled = v;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          }),
        );

      const highlightBoostSetting = new Setting(ragSection)
        .setName("Highlight boost")
        .setDesc(
          `Extra weight applied to highlights-only results. Current: ${Math.round(this.plugin.settings.highlightBoost * 100)}%`,
        );

      highlightBoostSetting.addSlider((sl) =>
        sl
          .setLimits(0.0, 1.0, 0.05)
          .setValue(this.plugin.settings.highlightBoost)

          .onChange((value) => {
            void (async () => {
              this.plugin.settings.highlightBoost = value;
              highlightBoostSetting.setDesc(
                `Extra weight applied to highlights-only results. Current: ${Math.round(value * 100)}%`,
              );
              await this.plugin.saveSettings();
            })();
          }),
      );

      new Setting(ragSection)
        .setName("Max highlights per note")
        .setDesc(
          "Caps how many highlight segments are indexed per note (prevents over-highlighted notes dominating cost).",
        )
        .addSlider((sl) =>
          sl
            .setLimits(0, 60, 1)
            .setValue(this.plugin.settings.maxHighlightsPerNote)

            .onChange((value) => {
              void (async () => {
                this.plugin.settings.maxHighlightsPerNote = value;
                await this.plugin.saveSettings();
              })();
            }),
        );

      new Setting(ragSection)
        .setName("Max highlight characters per note")
        .setDesc("Caps the total highlight text indexed per note (reduces embedding cost/time).")
        .addSlider((sl) =>
          sl
            .setLimits(0, 10_000, 250)
            .setValue(this.plugin.settings.maxHighlightCharsPerNote)

            .onChange((value) => {
              void (async () => {
                this.plugin.settings.maxHighlightCharsPerNote = value;
                await this.plugin.saveSettings();
              })();
            }),
        );

      new Setting(ragSection)
        .setName("Hybrid search fusion (RRF)")
        .setDesc(
          "Fuse embedding similarity + keyword matches via reciprocal rank fusion. Recommended for more robust retrieval across mixed note types.",
        )
        .addToggle((t) =>
          t.setValue(this.plugin.settings.vaultBrainUseRrfHybridSearch).onChange((v) => {
            void (async () => {
              this.plugin.settings.vaultBrainUseRrfHybridSearch = v;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          }),
        );

      if (this.plugin.settings.vaultBrainUseRrfHybridSearch) {
        new Setting(ragSection)
          .setName("RRF k")
          .setDesc("Smoothing constant for reciprocal rank fusion (default: 60).")
          .addSlider((sl) =>
            sl
              .setLimits(10, 200, 5)
              .setValue(this.plugin.settings.vaultBrainRrfK)

              .onChange((value) => {
                void (async () => {
                  this.plugin.settings.vaultBrainRrfK = value;
                  await this.plugin.saveSettings();
                })();
              }),
          );
      }

      new Setting(ragSection)
        .setName("Metadata keyword weight")
        .setDesc(
          "Maximum priority bonus given to exact keyword matches in titles, tags, and summaries (default: 0.25)",
        )
        .addSlider((slider) =>
          slider
            .setLimits(0.0, 1.0, 0.05)
            .setValue(this.plugin.settings.searchMetadataCap)

            .onChange(async (value) => {
              this.plugin.settings.searchMetadataCap = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(ragSection)
        .setName("Content keyword weight")
        .setDesc(
          "Maximum priority bonus given to exact keyword matches found deep inside the note body (default: 0.20)",
        )
        .addSlider((slider) =>
          slider
            .setLimits(0.0, 1.0, 0.05)
            .setValue(this.plugin.settings.searchContentCap)

            .onChange(async (value) => {
              this.plugin.settings.searchContentCap = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(ragSection)
        .setName("Reset search weights")
        .setDesc("Restore the mathematically optimal defaults (metadata: 0.25, Content: 0.20).")
        .addButton((btn) =>
          btn.setButtonText("Reset to defaults").onClick(() => {
            void (async () => {
              this.plugin.settings.searchMetadataCap = 0.25;
              this.plugin.settings.searchContentCap = 0.2;
              await this.plugin.saveSettings();
              this.displayPreserveScroll(); // Refresh the UI to update slider positions
              new Notice("Search weights restored to defaults.");
            })();
          }),
        );

      new Setting(ragSection)
        .setName("Index include patterns")
        .setDesc(
          "Optional comma or newline-separated globs for which files are indexed by Vault Brain. Leave blank to include all. Requires a rebuild.",
        )
        .addTextArea((t) =>
          t
            .setPlaceholder("e.g.\nMusic/**\nSources/**/*.md")
            .setValue(this.plugin.settings.vaultIndexIncludePatterns)
            .onChange((v) => {
              void (async () => {
                this.plugin.settings.vaultIndexIncludePatterns = v;
                await this.plugin.saveSettings();
              })();
            }),
        );

      new Setting(ragSection)
        .setName("Index exclude patterns")
        .setDesc(
          "Optional comma or newline-separated globs to exclude files from Vault Brain indexing. Requires a rebuild.",
        )
        .addTextArea((t) =>
          t
            .setPlaceholder("E.g.\nTemplates/**\narchive/**")
            .setValue(this.plugin.settings.vaultIndexExcludePatterns)
            .onChange((v) => {
              void (async () => {
                this.plugin.settings.vaultIndexExcludePatterns = v;
                await this.plugin.saveSettings();
              })();
            }),
        );

      new Setting(ragSection)
        .setName('Index PDFs (requires "Text Extractor")')
        .setDesc(
          'If enabled, Vault Brain will index PDFs by using extracted text from the community plugin "Text Extractor" (plugin ID: text-extractor). Requires a rebuild.',
        )
        .addToggle((t) =>
          t.setValue(this.plugin.settings.vaultIndexIndexPdf).onChange((v) => {
            void (async () => {
              this.plugin.settings.vaultIndexIndexPdf = v;
              await this.plugin.saveSettings();
              this.displayPreserveScroll();
            })();
          }),
        );

      if (this.plugin.settings.vaultIndexIndexPdf) {
        new Setting(ragSection)
          .setName("Max PDF extracted text (chars)")
          .setDesc("Caps extracted PDF text per file to limit embedding cost/time. Requires a rebuild.")
          .addSlider((sl) =>
            sl
              .setLimits(10_000, 2_000_000, 10_000)
              .setValue(this.plugin.settings.vaultIndexPdfMaxChars)

              .onChange((value) => {
                void (async () => {
                  this.plugin.settings.vaultIndexPdfMaxChars = value;
                  await this.plugin.saveSettings();
                })();
              }),
          );
      }

      new Setting(ragSection)
        .setName("Index control")
        .setDesc(`Vault Index: ${this.plugin.settings.indexStatus}`)
        .addButton((btn) => {
          btn.setButtonText("Rebuild vault index").onClick(() => {
            void (async () => {
              new Notice("Vault indexing started...");
              await this.plugin.vaultIndexer.rebuildIndex();
              this.displayPreserveScroll();
            })();
          });
        })
        .addButton((btn) => {
          btn
            .setButtonText("Delete vault index")
            .setWarning()
            .onClick(() => {
              new GenericConfirmModal(
                this.app,
                "Delete the Vault Index from memory and disk? This removes all index shards until you rebuild.",
                () => {
                  void (async () => {
                    const result = await this.plugin.vaultIndexer.deleteIndex();
                    if (result === "deleted") new Notice("Vault index deleted.");
                    else if (result === "missing") new Notice("No vault index detected.");
                    this.displayPreserveScroll();
                  })();
                },
              ).open();
            });
        });

      const rebuildNotice = ragSection.createDiv("horme-settings-muted");
      rebuildNotice.textContent =
        "Recommended: A full rebuild is required to enable bilingual tag support for existing notes.";
    } else {
      new Setting(ragSection)
        .setName("Index control")
        .setDesc(`Vault Index: ${this.plugin.settings.indexStatus}`)
        .addButton((btn) => {
          btn
            .setButtonText("Delete vault index")
            .setWarning()
            .onClick(() => {
              new GenericConfirmModal(
                this.app,
                "Delete the Vault Index from memory and disk? This removes all index shards until you rebuild.",
                () => {
                  void (async () => {
                    const result = await this.plugin.vaultIndexer.deleteIndex();
                    if (result === "deleted") new Notice("Vault index deleted.");
                    else if (result === "missing") new Notice("No vault index detected.");
                    this.displayPreserveScroll();
                  })();
                },
              ).open();
            });
        });
    }

    // --- Custom Skills ---
    const conceptSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    conceptSection.open = this.expandedSections["concept_notes"] ?? false;
    conceptSection.ontoggle = () => (this.expandedSections["concept_notes"] = conceptSection.open);
    conceptSection.createEl("summary", { text: "◈ Concept note creation" });

    new Setting(conceptSection)
      .setName("Concept folder path")
      .setDesc("Folder where concept notes will be created.")
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setValue(this.plugin.settings.conceptNoteFolder).onChange((v) => {
          void (async () => {
            this.plugin.settings.conceptNoteFolder = v.trim();
            await this.plugin.saveSettings();
          })().catch((e) => this.plugin.handleError(e, "Concept Notes"));
        });
      });

    new Setting(conceptSection)
      .setName("Source property name")
      .setDesc("Frontmatter key used for the research link (template: ${sourceField}).")
      .addText((t) => {
        t.setValue(this.plugin.settings.conceptNoteSourceField).onChange((v) => {
          void (async () => {
            this.plugin.settings.conceptNoteSourceField = v.trim() || "Source";
            await this.plugin.saveSettings();
          })().catch((e) => this.plugin.handleError(e, "Concept Notes"));
        });
      });

    new Setting(conceptSection)
      .setName("Note template")
      .setDesc("Placeholders: ${title}, ${tag}, ${sourceField}, ${source}, ${content}.")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.conceptNoteTemplate).onChange((v) => {
          void (async () => {
            this.plugin.settings.conceptNoteTemplate = v;
            await this.plugin.saveSettings();
          })().catch((e) => this.plugin.handleError(e, "Concept Notes"));
        });
        t.inputEl.rows = 8;
        t.inputEl.setCssProps({ width: "100%", resize: "vertical" });
      });

    const customSkillsSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    customSkillsSection.open = this.expandedSections["custom_skills"] ?? false;
    customSkillsSection.ontoggle = () => (this.expandedSections["custom_skills"] = customSkillsSection.open);
    customSkillsSection.createEl("summary", { text: "◈ Custom skills" });

    const renderCustomSkills = (container: HTMLElement) => {
      container.empty();
      const skills = this.plugin.settings.customSkills;

      if (skills.length === 0) {
        container.createEl("p", {
          cls: "horme-settings-muted",
          text: "No custom skills yet. Add one below.",
        });
      }

      for (const skill of skills) {
        new Setting(container)
          .setName(skill.name)
          .setDesc(skill.description)
          .addButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Delete skill")
              .onClick(() => {
                void (async () => {
                  this.plugin.settings.customSkills = this.plugin.settings.customSkills.filter(
                    (s) => s.id !== skill.id,
                  );
                  await this.plugin.saveSettings(); // triggers loadCustomSkills() via main.ts
                  renderCustomSkills(listContainer);
                })();
              }),
          );
      }
    };

    const listContainer = customSkillsSection.createDiv();
    renderCustomSkills(listContainer);

    new Setting(customSkillsSection).addButton((btn) =>
      btn.setButtonText("+ Add custom skill").onClick(() => {
        new CustomSkillModal(this.app, this.plugin, (def) => {
          void (async () => {
            this.plugin.settings.customSkills.push(def);
            await this.plugin.saveSettings(); // triggers loadCustomSkills() via main.ts
            renderCustomSkills(listContainer);
          })();
        }).open();
      }),
    );
  }
}
