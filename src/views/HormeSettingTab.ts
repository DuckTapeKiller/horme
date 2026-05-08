import { App, PluginSettingTab, Setting, Notice, setIcon, requestUrl } from "obsidian";
import HormePlugin from "../../main";
import { DEFAULT_SETTINGS, PROVIDER_MODELS } from "../constants";
import { AiProvider } from "../types";

export class HormeSettingTab extends PluginSettingTab {
  plugin: HormePlugin;

  constructor(app: App, plugin: HormePlugin) {
    super(app, plugin);
    this.plugin = plugin;
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

    // AI PROVIDER
    const aiSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    aiSection.open = true;
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

    // Sub-container for provider details to keep them nested
    const providersContainer = aiSection.createDiv("horme-nested-settings");

    // OLLAMA
    const ollamaSection = providersContainer.createEl("details", { cls: "horme-settings-section" });
    ollamaSection.open = true;
    ollamaSection.createEl("summary", { text: "◈ Ollama (Local)" });
    new Setting(ollamaSection).setName("Ollama URL").addText(t => t.setValue(this.plugin.settings.ollamaBaseUrl).onChange(async v => {
      this.plugin.settings.ollamaBaseUrl = v; await this.plugin.saveSettings();
    }));
    new Setting(ollamaSection)
      .setName("Model")
      .setDesc("The model to use with Ollama")
      .addDropdown(async (dd) => {
        try {
          const res = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
          const data = await res.json();
          const models: string[] = data.models?.map((m: any) => m.name) || [];
          if (!models.length) dd.addOption("", "No models found");
          models.forEach((m) => dd.addOption(m, m));
          dd.setValue(this.plugin.settings.defaultModel);
          dd.onChange(async (v) => {
            this.plugin.settings.defaultModel = v;
            await this.plugin.saveSettings();
          });
        } catch {
          dd.addOption("", "Ollama unreachable");
        }
      });

    // LM STUDIO
    const lmstudioSection = providersContainer.createEl("details", { cls: "horme-settings-section" });
    lmstudioSection.open = true;
    lmstudioSection.createEl("summary", { text: "◈ LM Studio (Local)" });
    new Setting(lmstudioSection).setName("LM Studio URL").addText(t => t.setValue(this.plugin.settings.lmStudioUrl).onChange(async v => {
      this.plugin.settings.lmStudioUrl = v; await this.plugin.saveSettings();
    }));
    new Setting(lmstudioSection)
      .setName("Model")
      .setDesc("The model to use with LM Studio")
      .addDropdown(async (dd) => {
        try {
          const res = await requestUrl({ url: `${this.plugin.settings.lmStudioUrl}/v1/models` });
          const models: string[] = res.json?.data?.map((m: any) => m.id) || [];
          if (!models.length) dd.addOption("", "No models found");
          models.forEach((m) => dd.addOption(m, m));
          dd.setValue(this.plugin.settings.lmStudioModel);
          dd.onChange(async (v) => {
            this.plugin.settings.lmStudioModel = v;
            await this.plugin.saveSettings();
          });
        } catch {
          dd.addOption("", "LM Studio unreachable");
        }
      });

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

      new Setting(section).setName("Model").addDropdown(dd => {
        const models = PROVIDER_MODELS[cp.id] || [];
        models.forEach(m => dd.addOption(m, m));
        dd.setValue((this.plugin.settings as any)[cp.model]);
        dd.onChange(async v => {
          (this.plugin.settings as any)[cp.model] = v;
          await this.plugin.saveSettings();
        });
      });
    }

    // GENERAL
    const generalSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    generalSection.open = true;
    generalSection.createEl("summary", { text: "◈ General & Tagging" });

    new Setting(generalSection).setName("Custom system prompt").addTextArea(ta => ta.setValue(this.plugin.settings.systemPrompt).onChange(async v => {
      this.plugin.settings.systemPrompt = v; await this.plugin.saveSettings();
    }));

    const tempSetting = new Setting(generalSection)
      .setName("Temperature")
      .setDesc(`Higher values make output more random, lower values more deterministic. (Default: 0.7) Current: ${this.plugin.settings.temperature}`);
    
    tempSetting.addSlider(sl => sl
      .setLimits(0, 1, 0.1)
      .setValue(this.plugin.settings.temperature)
      .setDynamicTooltip()
      .onChange(async v => {
        this.plugin.settings.temperature = v;
        tempSetting.setDesc(`Higher values make output more random, lower values more deterministic. (Default: 0.7) Current: ${v}`);
        await this.plugin.saveSettings();
      }));

    new Setting(generalSection).setName("Export folder").addText(t => t.setValue(this.plugin.settings.exportFolder).onChange(async v => {
      this.plugin.settings.exportFolder = v.trim() || "HORME"; await this.plugin.saveSettings();
    }));

    // PRESETS
    const presetSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    presetSection.open = true;
    presetSection.createEl("summary", { text: "◈ System Prompt Presets" });

    const presets = this.plugin.settings.promptPresets;
    presets.forEach((p, i) => {
        new Setting(presetSection)
            .setName(p.name || `Preset ${i + 1}`)
            .addText(t => t.setPlaceholder("Name").setValue(p.name).onChange(async v => { presets[i].name = v; await this.plugin.saveSettings(); }))
            .addTextArea(ta => ta.setPlaceholder("Prompt").setValue(p.prompt).onChange(async v => { presets[i].prompt = v; await this.plugin.saveSettings(); }))
            .addButton(btn => btn.setButtonText("Delete").onClick(async () => {
                presets.splice(i, 1); await this.plugin.saveSettings(); this.displayPreserveScroll();
            }));
    });

    new Setting(presetSection).addButton(btn => btn.setButtonText("Add preset").setCta().onClick(async () => {
        presets.push({ name: "", prompt: "" }); await this.plugin.saveSettings(); this.displayPreserveScroll();
    }));

    // PLATFORM OVERRIDES
    const platformSection = containerEl.createEl("details", { cls: "horme-settings-section" });
    platformSection.open = true;
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

      new Setting(platformSection)
        .setName("Mobile Model")
        .addDropdown(async dd => {
          const provider = this.plugin.settings.mobileProvider;
          if (provider === "ollama") {
            try {
              const res = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
              const data = await res.json();
              data.models?.forEach((m: any) => dd.addOption(m.name, m.name));
            } catch { dd.addOption("", "Ollama unreachable"); }
          } else if (provider === "lmstudio") {
             try {
              const res = await requestUrl({ url: `${this.plugin.settings.lmStudioUrl}/v1/models` });
              res.json?.data?.forEach((m: any) => dd.addOption(m.id, m.id));
            } catch { dd.addOption("", "LM Studio unreachable"); }
          } else {
            const models = PROVIDER_MODELS[provider] || [];
            models.forEach(m => dd.addOption(m, m));
          }
          dd.setValue(this.plugin.settings.mobileModel);
          dd.onChange(async v => {
            this.plugin.settings.mobileModel = v;
            await this.plugin.saveSettings();
          });
        });
    }

    // --- Grammar Scholar Index ---
    containerEl.createEl("h3", { text: "Grammar Scholar Index" });
    const grammarSection = containerEl.createDiv("horme-settings-section");
    grammarSection.style.display = "block";

    new Setting(grammarSection)
      .setName("Grammar Manual Folder")
      .setDesc("The folder in your vault containing grammar rules for your primary language.")
      .addText(t => t.setValue(this.plugin.settings.grammarFolderPath).onChange(async v => {
        this.plugin.settings.grammarFolderPath = v.trim() || "Gramática";
        await this.plugin.saveSettings();
      }));

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
    containerEl.createEl("h3", { text: "Frontmatter Summary" });
    const summarySection = containerEl.createDiv("horme-settings-section");
    summarySection.style.display = "block";

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
    containerEl.createEl("h3", { text: "Tag Taxonomy Index" });
    const tagSection = containerEl.createDiv("horme-settings-section");
    tagSection.style.display = "block";

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
    containerEl.createEl("h3", { text: "Vault Brain" });
    const ragSection = containerEl.createDiv("horme-settings-section");
    ragSection.style.display = "block";
    
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
             if (!confirm("Are you sure? This sends your note snippets to third-party cloud servers.")) {
               t.setValue(false); return;
             }
           }
           this.plugin.settings.allowCloudRAG = v;
           await this.plugin.saveSettings();
           this.displayPreserveScroll();
         });
      });

    if (this.plugin.settings.vaultBrainEnabled && (isLocal || this.plugin.settings.allowCloudRAG)) {
      const modelSetting = new Setting(ragSection)
        .setName("Embedding Model")
        .setDesc("Must be a specialized embedding model (e.g. nomic-embed-text).")
        .addDropdown(async dd => {
          try {
            const res = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
            const data = await res.json();
            data.models?.forEach((m: any) => dd.addOption(m.name, m.name));
          } catch {
            dd.addOption("nomic-embed-text", "nomic-embed-text (default)");
          }
          dd.setValue(this.plugin.settings.ragEmbeddingModel);
          dd.onChange(async v => {
            this.plugin.settings.ragEmbeddingModel = v;
            await this.plugin.saveSettings();
            this.displayPreserveScroll();
          });
        });

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
