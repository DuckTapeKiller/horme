import { App, PluginSettingTab, Setting, Notice, setIcon, requestUrl } from "obsidian";
import HormePlugin from "../../main";
import { DEFAULT_SETTINGS, PROVIDER_MODELS } from "../constants";
import { AiProvider } from "../types";
import { FileSuggest, FolderSuggest, FileOrFolderSuggest } from "../utils/Suggest";
import { GenericConfirmModal } from "../modals/GenericConfirmModal";

export class HormeSettingTab extends PluginSettingTab {
  plugin: HormePlugin;

  constructor(app: App, plugin: HormePlugin) {
    super(app, plugin);
    this.plugin = plugin;
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
      "gemini-2.5-pro",
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
  };

  /**
   * Renders a text input with an attached <datalist> for suggestions.
   * Unlike addDropdown, the user can type any value — the datalist only
   * suggests options, it does not constrain them.
   *
   * @param setting     The Setting instance to attach the control to.
   * @param listId      A unique DOM id for the <datalist> element.
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
    onSave: (v: string) => Promise<void>
  ): void {
    setting.addText(t => {
      t.setPlaceholder("Type or select a model…");
      t.inputEl.style.width = "100%";

      // Attach the datalist for browser-native suggestion dropdown
      const datalist = document.createElement("datalist");
      datalist.id = listId;
      t.inputEl.setAttribute("list", listId);
      t.inputEl.after(datalist);

      // Set saved value immediately — never wait on network for this
      t.setValue(currentValue);

      // Populate suggestions asynchronously; failures are silently ignored
      // because the user can always type a model name manually
      modelsFn().then(models => {
        models.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m;
          datalist.appendChild(opt);
        });
      }).catch(() => { /* silent — user types the model name */ });

      t.onChange(async v => {
        const trimmed = v.trim();
        if (trimmed) await onSave(trimmed);
      });
    });
  }

  private async displayPreserveScroll() {
    const scroller = this.containerEl.closest(".vertical-tab-content") as HTMLElement | null;
    const scrollTop = scroller?.scrollTop ?? 0;
    await this.display();
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scrollTop;
    });
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    
    // Header Section
    const header = containerEl.createDiv("horme-settings-header");
    const iconWrap = header.createDiv("horme-settings-header-icon");
    setIcon(iconWrap, "cone");
    header.createEl("h2", { text: "Horme Settings", cls: "horme-settings-title" });

    // SYSTEM DIAGNOSTICS & INTELLIGENCE (TOP & EXPANDED)
    const diagSection = containerEl.createDiv("horme-settings-section");
    diagSection.createEl("h3", { text: "◈ Intelligence Dashboard", cls: "horme-diag-title-header" });
    
    const summary = this.plugin.diagnosticService.getSummary();
    
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
        logs.forEach(log => {
          const entry = logContent.createDiv(`horme-diag-entry horme-diag-entry-${log.type}`);
          const dateStr = new Date(log.timestamp).toLocaleString([], { 
            month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
          });
          entry.createSpan({ text: dateStr, cls: "horme-diag-entry-time" });
          entry.createSpan({ text: `[${log.source.toUpperCase()}]`, cls: "horme-diag-entry-source" });
          entry.createSpan({ text: log.message, cls: "horme-diag-entry-msg" });
        });
      } else {
        logContent.createDiv({ text: "> No issues detected. System healthy.", cls: "horme-diag-entry-msg" }).style.opacity = "0.4";
      }
      updateSummary();
    };

    const refreshHealth = async () => {
      try {
        const healthItems = await this.plugin.diagnosticService.getIndexHealth();
        grid.empty();
        healthItems.forEach(h => {
          const card = grid.createDiv({ cls: `horme-diag-card is-${h.status || "missing"}` });
          const head = card.createDiv({ cls: "horme-diag-card-header" });
          const icon = h.id === "vault" ? "brain" : (h.id === "tags" ? "tags" : "book-open");
          setIcon(head, icon);
          head.createSpan({ text: h.name });
          card.createDiv({ cls: `horme-diag-status-badge horme-diag-status-${h.status || "missing"}`, text: (h.status || "missing").toUpperCase() });
          
          const countText = h.status === "loading" ? "Loading..." : `${(h.entryCount || 0).toLocaleString()} entries`;
          card.createDiv({ cls: "horme-diag-stat", text: countText });
          
          const footer = card.createDiv({ cls: "horme-diag-footer" });
          if (h.lastUpdate && h.lastUpdate > 0) {
            footer.setText(`Updated ${new Date(h.lastUpdate).toLocaleDateString()} ${new Date(h.lastUpdate).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`);
          } else {
            footer.setText("Never performed");
          }
        });
        renderLogs();
      } catch (e) {
        grid.empty();
        grid.createEl("p", { text: "Failed to load health metrics.", cls: "horme-diag-empty" });
      }
    };

    // --- CREATE UI ELEMENTS THAT USE THE FUNCTIONS ---
    
    // Dedicated Refresh Button with Icon
    const refreshBtn = logTitleContainer.createEl("button", { cls: "horme-diag-refresh-btn", attr: { title: "Refresh Dashboard" } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.addClass("is-spinning");
      await refreshHealth();
      setTimeout(() => refreshBtn.removeClass("is-spinning"), 600);
      new Notice("Dashboard refreshed.");
    });

    new Setting(diagSection)
      .setName("System Health")
      .setDesc("Monitor integrity of your local intelligence.")
      .addButton(btn => btn.setButtonText("Verify Integrity").onClick(async () => { 
        await refreshHealth(); 
        new Notice("Integrity scan complete."); 
      }))
      .addButton(btn => btn.setButtonText("Clear Logs").onClick(async () => { 
        this.plugin.diagnosticService.clear(); 
        renderLogs(); 
      }))
      .addButton(btn => btn.setButtonText("Copy Data").onClick(async () => {
        const health = await this.plugin.diagnosticService.getIndexHealth();
        const logs = this.plugin.diagnosticService.getLogs();
        await navigator.clipboard.writeText(JSON.stringify({ timestamp: new Date().toISOString(), indexHealth: health, logs }, null, 2));
        new Notice("Diagnostic bundle copied.");
      }));

    // Ensure the log wrapper stays at the bottom
    diagSection.appendChild(logWrapper);

    // Initial load
    refreshHealth();
    renderLogs();

    // AI PROVIDER
    const aiSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    aiSection.open = false;
    aiSection.createEl("summary", { text: "◈ AI Providers" });

    new Setting(aiSection)
      .setName("Active Provider")
      .addDropdown((dd) => {
        dd.addOption("ollama", "Ollama (local)");
        dd.addOption("lmstudio", "LM Studio (local)");
        dd.addOption("claude", "Anthropic Claude (API)");
        dd.addOption("gemini", "Google Gemini (API)");
        dd.addOption("openai", "OpenAI GPT (API)");
        dd.addOption("groq", "Groq (High Speed)");
        dd.addOption("openrouter", "OpenRouter (Free/Aggregator)");
        dd.setValue(this.plugin.settings.aiProvider);
        dd.onChange(async (v) => {
          this.plugin.settings.aiProvider = v as any;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const providersContainer = aiSection.createDiv("horme-nested-settings");

    // OLLAMA
    const ollamaSection = providersContainer.createEl("details", { cls: "horme-settings-section" });
    ollamaSection.open = true;
    ollamaSection.createEl("summary", { text: "◈ Ollama (Local)" });
    new Setting(ollamaSection).setName("Ollama URL").addText(t => t.setValue(this.plugin.settings.ollamaBaseUrl).onChange(async v => {
      this.plugin.settings.ollamaBaseUrl = v; await this.plugin.saveSettings();
    }));
    this.buildModelCombo(
      new Setting(ollamaSection).setName("Model")
        .setDesc("Select from running models or type a custom name."),
      "horme-ollama-models",
      async () => {
        const res = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
        const data = await res.json();
        return data.models?.map((m: any) => m.name) || [];
      },
      this.plugin.settings.defaultModel,
      async v => { this.plugin.settings.defaultModel = v; await this.plugin.saveSettings(); }
    );

    // LM STUDIO (FIXED)
    const lmstudioSection = providersContainer.createEl("details", { cls: "horme-settings-section" });
    lmstudioSection.open = true;
    lmstudioSection.createEl("summary", { text: "◈ LM Studio (Local)" });
    new Setting(lmstudioSection).setName("LM Studio URL").addText(t => t.setValue(this.plugin.settings.lmStudioUrl).onChange(async v => {
      this.plugin.settings.lmStudioUrl = v; await this.plugin.saveSettings();
    }));
    this.buildModelCombo(
      new Setting(lmstudioSection).setName("Model")
        .setDesc("Select from running models or type a custom name."),
      "horme-lmstudio-models",
      async () => {
        // Strip trailing slash here (provider constructor does it at runtime,
        // but the settings tab URL may still have one when building this request).
        const url = this.plugin.settings.lmStudioUrl.replace(/\/$/, "");
        // Use requestUrl (Obsidian's network layer) instead of fetch — avoids
        // CORS/policy blocks that affect fetch in Obsidian's desktop renderer.
        const res = await requestUrl({ url: `${url}/v1/models` });
        return res.json?.data?.map((m: any) => m.id) || [];
      },
      this.plugin.settings.lmStudioModel,
      async v => { this.plugin.settings.lmStudioModel = v; await this.plugin.saveSettings(); }
    );

    // CLOUD PROVIDERS
    const cloudProviders = [
      { id: "claude", name: "Anthropic Claude", key: "claudeApiKey", model: "claudeModel" },
      { id: "gemini", name: "Google Gemini", key: "geminiApiKey", model: "geminiModel" },
      { id: "openai", name: "OpenAI GPT", key: "openaiApiKey", model: "openaiModel" },
      { id: "groq", name: "Groq", key: "groqApiKey", model: "groqModel" },
      { id: "openrouter", name: "OpenRouter", key: "openRouterApiKey", model: "openRouterModel" }
    ];

    for (const cp of cloudProviders) {
      const section = providersContainer.createEl("details", { cls: "horme-settings-section" });
      section.open = true;
      section.createEl("summary", { text: `◈ ${cp.name}` });
      new Setting(section).setName("API Key").addText(t => {
        t.inputEl.type = "password";
        t.setValue((this.plugin.settings as any)[cp.key]).onChange(async v => {
          (this.plugin.settings as any)[cp.key] = v;
          await this.plugin.saveSettings();
        });
      });
      this.buildModelCombo(
        new Setting(section).setName("Model")
          .setDesc("Select a suggestion or type any custom model ID."),
        `horme-${cp.id}-models`,
        async () => HormeSettingTab.UPDATED_MODELS[cp.id] ?? PROVIDER_MODELS[cp.id] ?? [],
        (this.plugin.settings as any)[cp.model],
        async v => { (this.plugin.settings as any)[cp.model] = v; await this.plugin.saveSettings(); }
      );
    }

    // GENERAL
    const generalSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    generalSection.open = false;
    generalSection.createEl("summary", { text: "◈ General Settings" });
    const tempSetting = new Setting(generalSection).setName("Temperature")
      .setDesc(`Default: 0.3 | Current: ${this.plugin.settings.temperature}`);
    tempSetting.addSlider(sl => sl.setLimits(0, 1, 0.1).setValue(this.plugin.settings.temperature).setDynamicTooltip().onChange(async v => {
      this.plugin.settings.temperature = v;
      tempSetting.setDesc(`Default: 0.3 | Current: ${v}`);
      await this.plugin.saveSettings();
    }));
    new Setting(generalSection).setName("Export folder").addText(t => t.setValue(this.plugin.settings.exportFolder).onChange(async v => {
      this.plugin.settings.exportFolder = v.trim() || "HORME"; await this.plugin.saveSettings();
    }));

    // SYSTEM PROMPT & PRESETS
    const presetSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    presetSection.open = false;
    presetSection.createEl("summary", { text: "◈ System Prompt & Presets" });

    new Setting(presetSection)
      .setName("System Prompt Note")
      .setDesc("Select a note in your vault to use as the master system prompt. This note defines the AI's identity and rules.")
      .addText(t => {
        new FileSuggest(this.app, t.inputEl);
        t.setPlaceholder("path/to/note.md")
          .setValue(this.plugin.settings.systemPromptPath)
          .onChange(async v => {
            this.plugin.settings.systemPromptPath = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // PRESETS DYNAMIC LIST
    const presetsContainer = presetSection.createDiv("horme-presets-container");
    this.plugin.settings.presetsPaths.forEach((path, i) => {
      new Setting(presetsContainer)
        .setName(`Preset Source ${i + 1}`)
        .setDesc("A note or folder path.")
        .addText(t => {
          new FileOrFolderSuggest(this.app, t.inputEl);
          t.setPlaceholder("path/to/note_or_folder")
            .setValue(path)
            .onChange(async v => {
              this.plugin.settings.presetsPaths[i] = v.trim();
              await this.plugin.saveSettings();
            });
        })
        .addButton(btn => {
          btn.setIcon("trash")
             .onClick(async () => {
               this.plugin.settings.presetsPaths.splice(i, 1);
               await this.plugin.saveSettings();
               this.displayPreserveScroll();
             });
        });
    });

    new Setting(presetSection)
      .addButton(btn => {
        btn.setButtonText("Add more presets")
           .setCta()
           .onClick(async () => {
             this.plugin.settings.presetsPaths.push("");
             await this.plugin.saveSettings();
             this.displayPreserveScroll();
           });
      });

    // PLATFORM OVERRIDES
    const platformSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    platformSection.open = false;
    platformSection.createEl("summary", { text: "◈ Platform Overrides" });

    new Setting(platformSection)
      .setName("Enable Mobile Override")
      .setDesc("Automatically switch to a specific provider/model when on a mobile device.")
      .addToggle(t => t.setValue(this.plugin.settings.useMobileOverride).onChange(async v => {
        this.plugin.settings.useMobileOverride = v;
        await this.plugin.saveSettings();
        this.displayPreserveScroll();
      }));

    if (this.plugin.settings.useMobileOverride) {
      new Setting(platformSection)
        .setName("Mobile Provider")
        .addDropdown(dd => {
          dd.addOption("ollama", "Ollama (local)");
          dd.addOption("lmstudio", "LM Studio (local)");
          dd.addOption("claude", "Anthropic Claude (API)");
          dd.addOption("gemini", "Google Gemini (API)");
          dd.addOption("openai", "OpenAI GPT (API)");
          dd.addOption("groq", "Groq (High Speed)");
          dd.addOption("openrouter", "OpenRouter (Free/Aggregator)");
          dd.setValue(this.plugin.settings.mobileProvider);
          dd.onChange(async v => {
            this.plugin.settings.mobileProvider = v as any;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          });
        });

      this.buildModelCombo(
        new Setting(platformSection).setName("Mobile Model")
          .setDesc("Select a suggestion or type any custom model ID."),
        "horme-mobile-models",
        async () => {
          const provider = this.plugin.settings.mobileProvider;
          if (provider === "ollama") {
            const res = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
            const data = await res.json();
            return data.models?.map((m: any) => m.name) || [];
          } else if (provider === "lmstudio") {
            const url = this.plugin.settings.lmStudioUrl.replace(/\/$/, "");
            const res = await requestUrl({ url: `${url}/v1/models` });
            return res.json?.data?.map((m: any) => m.id) || [];
          } else {
            return HormeSettingTab.UPDATED_MODELS[provider] ?? PROVIDER_MODELS[provider] ?? [];
          }
        },
        this.plugin.settings.mobileModel,
        async v => { this.plugin.settings.mobileModel = v; await this.plugin.saveSettings(); }
      );
    }

    // --- Grammar Scholar Index ---
    const grammarSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    grammarSection.open = false;
    grammarSection.createEl("summary", { text: "◈ Grammar Scholar Index" });

    new Setting(grammarSection)
      .setName("Grammar Manual Folder")
      .setDesc("The folder in your vault containing grammar rules for your primary language.")
      .addText(t => {
        new FolderSuggest(this.app, t.inputEl);
        t.setValue(this.plugin.settings.grammarFolderPath).onChange(async v => {
          this.plugin.settings.grammarFolderPath = v.trim() || "Gramática";
          await this.plugin.saveSettings();
        });
      });

    new Setting(grammarSection)
      .setName("Grammar Language")
      .setDesc("The language your grammar manuals cover. Proofreading will only consult grammar manuals when the text is in this language.")
      .addText(t => t.setValue(this.plugin.settings.grammarLanguage).onChange(async v => {
        this.plugin.settings.grammarLanguage = v.trim() || "Español";
        await this.plugin.saveSettings();
      }));

    new Setting(grammarSection)
      .setName("Rebuild Grammar Index")
      .setDesc("Synchronise the skill with the latest content in your grammar manuals folder.")
      .addButton(btn => {
        btn.setButtonText("Rebuild Now")
           .onClick(async () => {
             await this.plugin.grammarIndexer.rebuildIndex();
             new Notice("✅ Grammar Index Rebuilt");
           });
      });

    // --- Frontmatter Summary ---
    const summarySection = containerEl.createEl("details", { cls: "horme-settings-section" });
    summarySection.open = false;
    summarySection.createEl("summary", { text: "◈ Frontmatter Summary" });

    new Setting(summarySection)
      .setName("Summary Field")
      .setDesc("The frontmatter key where generated summaries are stored (e.g. 'summary', 'resumen', 'abstract').")
      .addText(t => t.setValue(this.plugin.settings.summaryField).onChange(async v => {
        this.plugin.settings.summaryField = v.trim() || "summary";
        await this.plugin.saveSettings();
      }));

    new Setting(summarySection)
      .setName("Summary Language")
      .setDesc("The language summaries should be written in.")
      .addText(t => t.setValue(this.plugin.settings.summaryLanguage).onChange(async v => {
        this.plugin.settings.summaryLanguage = v.trim() || "Español";
        await this.plugin.saveSettings();
      }));

    // --- Tag Taxonomy Index ---
    const tagSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    tagSection.open = false;
    tagSection.createEl("summary", { text: "◈ Tag Taxonomy Index" });

    new Setting(tagSection)
      .setName("Tag List Note")
      .setDesc("Optional: A note containing a list of allowed tags (one per line).")
      .addText(t => t.setValue(this.plugin.settings.tagsFilePath).onChange(async v => {
        this.plugin.settings.tagsFilePath = v.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(tagSection)
      .setName("Rebuild Tag Index")
      .setDesc("Index your vault's tag structure for semantic suggestions. (Global access enabled)")
      .addButton(btn => {
        btn.setButtonText("Rebuild Now")
           .onClick(async () => {
             await this.plugin.tagIndexer.rebuildTagIndex();
             new Notice("✅ Tag Index Ready");
           });
      });

    // --- Vault Brain (Local RAG) ---
    const ragSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    ragSection.open = false;
    ragSection.createEl("summary", { text: "◈ Vault Brain" });
    
    const isLocal = this.plugin.settings.aiProvider === "ollama" || this.plugin.settings.aiProvider === "lmstudio";

    if (!isLocal && !this.plugin.settings.allowCloudRAG) {
      const warning = ragSection.createDiv("horme-settings-warning");
      warning.textContent = "⚠️ Vault Brain is disabled for cloud providers to protect your privacy.";
      warning.style.color = "var(--text-error)";
      warning.style.padding = "10px";
      warning.style.marginBottom = "10px";
      warning.style.border = "1px solid var(--background-modifier-border)";
      warning.style.borderRadius = "var(--radius-s)";
    }

    new Setting(ragSection)
      .setName("Enable Local Vault Memory")
      .setDesc("Let Horme remember everything in your vault.")
      .addToggle(t => {
        const canEnable = isLocal || this.plugin.settings.allowCloudRAG;
        t.setValue(this.plugin.settings.vaultBrainEnabled && canEnable)
         .setDisabled(!canEnable)
         .onChange(async v => {
           this.plugin.settings.vaultBrainEnabled = v;
           await this.plugin.saveSettings();
           this.displayPreserveScroll();
         });
      });

    new Setting(ragSection)
      .setName("Allow Cloud Provider Access")
      .setDesc("WARNING: If enabled, snippets from your notes will be sent to cloud servers. This reduces privacy.")
      .addToggle(t => {
        t.setValue(this.plugin.settings.allowCloudRAG)
         .onChange(async v => {
           if (v) {
             new GenericConfirmModal(
               this.app,
               "Are you sure? This will send snippets from your notes to third-party cloud servers.",
               async () => {
                 this.plugin.settings.allowCloudRAG = true;
                 await this.plugin.saveSettings();
                 this.displayPreserveScroll();
               }
             ).open();
             t.setValue(false); // reset toggle — modal will re-enable if confirmed
             return;
           }
           this.plugin.settings.allowCloudRAG = false;
           await this.plugin.saveSettings();
           this.displayPreserveScroll();
         });
      });

    if (this.plugin.settings.vaultBrainEnabled && (isLocal || this.plugin.settings.allowCloudRAG)) {
      this.buildModelCombo(
        new Setting(ragSection)
          .setName("Embedding Model")
          .setDesc("Must be a specialized embedding model. Type a custom name or pick from those running in Ollama."),
        "horme-embed-models",
        async () => {
          const res = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
          const data = await res.json();
          return data.models?.map((m: any) => m.name) || ["nomic-embed-text", "mxbai-embed-large", "all-minilm"];
        },
        this.plugin.settings.ragEmbeddingModel,
        async v => {
          this.plugin.settings.ragEmbeddingModel = v;
          await this.plugin.saveSettings();
          this.displayPreserveScroll();
        }
      );

      new Setting(ragSection)
        .setName("Index Control")
        .setDesc(`Vault Index: ${this.plugin.settings.indexStatus}`)
        .addButton(btn => {
          btn.setButtonText("Rebuild Vault Index")
             .onClick(async () => {
               new Notice("Vault indexing started...");
               await this.plugin.vaultIndexer.rebuildIndex();
               this.displayPreserveScroll();
             });
        });
    }
  }
}