import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, setIcon, Notice, TFile, type EventRef } from "obsidian";
import HormePlugin from "../../main";
import { VIEW_TYPE } from "../constants";
import { ChatMessage, SavedConversation } from "../types";
import { NotePickerModal } from "../modals/NotePickerModal";
import { GenericConfirmModal } from "../modals/GenericConfirmModal";

export class HormeChatView extends ItemView {
  plugin: HormePlugin;
  private history: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private contextToggle!: HTMLInputElement;
  private contextNoteLabel!: HTMLElement;
  private connectionDot!: HTMLElement;
  private presetSelect!: HTMLSelectElement;
  private isGenerating = false;
  private showingHistory = false;
  private unregisterSettingsListener: (() => void) | null = null;
  private documentClickHandler: (() => void) | null = null;
  private sessionSystemPromptOverride: string | null = null;

  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private activeAbortController: AbortController | null = null;
  private lastMsgs: ChatMessage[] | null = null;
  private lastModel: string | null = null;
  private conversationId: string = this.generateId();
  private uploadedDocContent: string | null = null;
  private uploadedDocName: string | null = null;
  private uploadedImages: string[] = [];
  private uploadedAudio: string | null = null;
  private leafChangeRef: EventRef | null = null;
  private rollingRAGContext: string[] = [];
  private selectedContextNotes: TFile[] = [];
  private contextNotesLabel!: HTMLElement;
  private vaultBrainToggle!: HTMLInputElement;
  private vaultBrainLabel!: HTMLElement;
  private forcedSkillId: string | null = null;
  private skillsMenuEl: HTMLElement | null = null;
 
  private async pickImage() {
    const fileInput = activeDocument.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.setCssProps({ display: "none" });
    activeDocument.body.appendChild(fileInput);

    const cleanup = () => {
      fileInput.remove();
      window.removeEventListener("focus", onWindowFocus);
    };
    const onWindowFocus = () => window.setTimeout(cleanup, 500);
    window.addEventListener("focus", onWindowFocus, { once: true });

    fileInput.addEventListener("change", () => {
      window.removeEventListener("focus", onWindowFocus);
      const file = fileInput.files?.[0];
      if (!file) { fileInput.remove(); return; }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        this.uploadedImages.push(base64);
        
        if (!this.history.length) this.messagesEl.empty();
        
        const previewWrap = this.messagesEl.createDiv("horme-image-preview-container");
        const img = previewWrap.createEl("img", { cls: "horme-image-preview" });
        img.src = reader.result as string;
        
        const removeBtn = previewWrap.createDiv("horme-image-preview-remove");
        setIcon(removeBtn, "x");
        removeBtn.addEventListener("click", () => {
          this.uploadedImages = this.uploadedImages.filter(i => i !== base64);
          previewWrap.remove();
        });

        this.scrollToBottom();
        fileInput.remove();
      };
      reader.onerror = () => fileInput.remove();
      reader.readAsDataURL(file);
    });
    fileInput.click();
  }


  constructor(leaf: WorkspaceLeaf, plugin: HormePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Horme"; }
  getIcon(): string { return "cone"; }

  // Lucide icon for each built-in skill (used in menu, loading, and result box)
  private static readonly SKILL_ICONS: Record<string, string> = {
    wikipedia: "book-marked",
    ddg_search: "binoculars",
    wiktionary: "book-a",
    vault_links: "cable",
    grammar_scholar: "signature",
    taxonomy: "list-tree",
    date_calc: "calendar",
  };

  /** Returns the Lucide icon name for a skill. Custom skills use "bot". */
  private getSkillIcon(skillId: string): string {
    if (skillId.startsWith("custom_")) return "bot";
    return HormeChatView.SKILL_ICONS[skillId] || "zap";
  }

  private buildSkillsMenu() {
    if (!this.skillsMenuEl) return;
    this.skillsMenuEl.empty();

    const allSkills = this.plugin.skillManager.getSkills();

    // Skills that support forced direct execution:
    // these have a single primary string input and bypass the LLM's skill selection.
    // Verify these IDs against each skill file's `id` field before deploying.
    // Custom skills (prefix "custom_") are always forced-execution.
    const FORCED_EXECUTION_IDS = new Set([
      "wikipedia",
      "ddg_search",
      "wiktionary",
      "vault_links",
      "grammar_scholar",
      "taxonomy",
    ]);

    for (const skill of allSkills) {
      const isForced = FORCED_EXECUTION_IDS.has(skill.id) || skill.id.startsWith("custom_");

      const item = this.skillsMenuEl.createDiv({ cls: "horme-skills-menu-item" });

      const iconEl = item.createSpan({ cls: "horme-skills-menu-item-icon" });
      setIcon(iconEl, this.getSkillIcon(skill.id));

      item.createEl("span", { cls: "horme-skills-menu-item-name", text: skill.name });
      item.createEl("span", { cls: "horme-skills-menu-item-desc", text: skill.description });

      // Visual badge: forced skills show "Direct" (bypasses model), template skills show "Template"
      item.createEl("span", {
        cls: `horme-skills-menu-item-badge ${isForced ? "is-direct" : "is-template"}`,
        text: isForced ? "Direct" : "Template"
      });

      item.addEventListener("click", () => {
        this.skillsMenuEl!.classList.add("horme-skills-menu-hidden");

        if (isForced) {
          // ARM the skill for direct execution on next send.
          // Vault Brain will be suppressed for that turn (see sendMessage intercept).
          this.forcedSkillId = skill.id;
          this.showArmedSkillPill(skill.name, skill.id);
          this.inputEl.focus();
        } else {
          // TEMPLATE mode: insert a starter phrase; the model handles the skill call normally.
          const templates: Record<string, string> = {
            "date_calc": "Calculate the time between ",
          };
          const template = templates[skill.id] ?? `Use the ${skill.name} skill: `;
          this.inputEl.value = template;
          this.inputEl.focus();
          this.inputEl.setSelectionRange(template.length, template.length);
          this.autoGrow?.();
        }
      });
    }

    if (allSkills.length === 0) {
      this.skillsMenuEl.createEl("p", {
        cls: "horme-skills-menu-empty",
        text: "No skills available."
      });
    }
  }

  private showArmedSkillPill(skillName: string, skillId: string) {
    // Remove any existing pill first
    this.containerEl.querySelector(".horme-skill-pill")?.remove();

    const inputWrapper = this.inputEl.parentElement!;
    const pill = activeDocument.createElement("div");
    pill.className = "horme-skill-pill";

    const iconEl = activeDocument.createElement("span");
    iconEl.className = "horme-skill-pill-icon";
    setIcon(iconEl, this.getSkillIcon(skillId));
    pill.appendChild(iconEl);

    const label = activeDocument.createElement("span");
    label.textContent = skillName;
    pill.appendChild(label);

    const dismiss = activeDocument.createElement("button");
    dismiss.className = "horme-skill-pill-dismiss";
    dismiss.textContent = "×";
    dismiss.title = "Disarm skill";
    dismiss.addEventListener("click", () => {
      this.forcedSkillId = null;
      pill.remove();
    });
    pill.appendChild(dismiss);

    // Insert before the textarea
    inputWrapper.insertBefore(pill, this.inputEl);
  }

  async onOpen() {
    try {
      const root = this.contentEl;
      root.empty();
      root.addClass("horme-chat-container");

      this.sessionSystemPromptOverride = null;
      const content = root.createDiv("horme-chat-content");

      /* Header */
      const header = content.createDiv("horme-header");
      const row0 = header.createDiv("horme-header-row");
      this.connectionDot = row0.createDiv("horme-connection-icon");
      setIcon(this.connectionDot, "cone");
      const selectsWrap = row0.createDiv("horme-header-selects");

      this.modelSelect = selectsWrap.createEl("select", { cls: "horme-select horme-model-select" });
      this.modelSelect.addEventListener("change", () => {
        const v = this.modelSelect.value;
        const p = this.plugin.settings.aiProvider;
        if (p === "claude")          this.plugin.settings.claudeModel = v;
        else if (p === "gemini")     this.plugin.settings.geminiModel = v;
        else if (p === "openai")     this.plugin.settings.openaiModel = v;
        else if (p === "groq")       this.plugin.settings.groqModel = v;
        else if (p === "openrouter") this.plugin.settings.openRouterModel = v;
        else if (p === "lmstudio")   this.plugin.settings.lmStudioModel = v;
        else                         this.plugin.settings.defaultModel = v;
        void this.plugin.saveSettings().catch(e => this.plugin.handleError(e, "Settings"));
      });

      this.presetSelect = selectsWrap.createEl("select", { cls: "horme-select horme-preset-select" });
      this.presetSelect.addEventListener("change", () => {
        this.sessionSystemPromptOverride = this.presetSelect.value || null;
      });
      await this.refreshPresets();

      const refreshBtn = row0.createEl("button", { cls: "horme-header-btn" });
      refreshBtn.classList.add("horme-icon-btn");
      setIcon(refreshBtn, "refresh-cw");
      refreshBtn.addEventListener("click", () => {
        void this.refreshModels().catch(e => this.plugin.handleError(e, "Models"));
      });

      const row1 = header.createDiv("horme-header-row horme-header-row-actions");
      const row1Left = row1.createDiv("horme-header-actions-left");
      const row1Right = row1.createDiv("horme-header-actions-right");


      const tagBtn = row1Left.createEl("button", { cls: "horme-header-btn", text: "Tags" });
      tagBtn.addEventListener("click", () => {
        void this.plugin.suggestTagsForActiveNote().catch(e => this.plugin.handleError(e, "Tags"));
      });

      const summaryBtn = row1Left.createEl("button", { cls: "horme-header-btn", text: "Summary" });
      summaryBtn.addEventListener("click", () => {
        void this.plugin.generateFrontmatterSummary().catch(e => this.plugin.handleError(e, "Summary"));
      });

      // Skills dropdown trigger button
      const skillsBtn = row1Left.createEl("button", {
        cls: "horme-header-btn",
        text: "Skills ▾"
      });

      // Build the floating menu attached to the view container (hidden by default)
      this.skillsMenuEl = this.containerEl.createDiv({ cls: "horme-skills-menu horme-skills-menu-hidden" });
      this.buildSkillsMenu();

      skillsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = this.skillsMenuEl!.classList.contains("horme-skills-menu-hidden");
        if (isHidden) {
          this.skillsMenuEl!.classList.remove("horme-skills-menu-hidden");
          const rect = skillsBtn.getBoundingClientRect();
          const containerRect = this.containerEl.getBoundingClientRect();
          const menuWidth = 300; 

          let left = rect.left - containerRect.left;
          // If menu would overflow container on the right, align its right edge to the button's right edge
          if (left + menuWidth > containerRect.width) {
            left = (rect.right - containerRect.left) - menuWidth;
          }
          // Ensure it doesn't overflow the left edge
          left = Math.max(4, left); // 4px margin

          this.skillsMenuEl!.setCssProps({
            top: `${rect.bottom - containerRect.top + 4}px`,
            left: `${left}px`,
          });
        } else {
          this.skillsMenuEl!.classList.add("horme-skills-menu-hidden");
        }
      });

      // Close the menu when clicking anywhere outside it
      this.documentClickHandler = () => {
        this.skillsMenuEl?.classList.add("horme-skills-menu-hidden");
      };
      activeDocument.addEventListener("click", this.documentClickHandler);

      const historyBtn = row1Right.createEl("button", { cls: "horme-header-btn horme-icon-btn" });
      setIcon(historyBtn, "history");
      historyBtn.addEventListener("click", () => {
        void this.toggleHistoryPanel().catch(e => this.plugin.handleError(e));
      });

      const exportBtn = row1Right.createEl("button", { cls: "horme-header-btn horme-icon-btn" });
      setIcon(exportBtn, "download");
      exportBtn.addEventListener("click", () => {
        void this.exportConversation().catch(e => this.plugin.handleError(e));
      });

      const row2 = header.createDiv("horme-header-row");
      const label = row2.createEl("label", { cls: "horme-context-toggle" });
      this.contextToggle = label.createEl("input", { type: "checkbox" });
      label.createSpan({ text: "Use current note as context" });

      const vbLabel = row2.createEl("label", { cls: "horme-context-toggle" });
      vbLabel.setCssProps({ marginLeft: "12px" });
      this.vaultBrainToggle = vbLabel.createEl("input", { type: "checkbox" });
      this.vaultBrainToggle.checked = true;
      vbLabel.createSpan({ text: "Use Vault Brain" });
      this.vaultBrainLabel = vbLabel;
      await this.updateVaultBrainToggle();

      this.contextNoteLabel = header.createDiv("horme-context-note-label");

      // Multi-note context
      const row3 = header.createDiv("horme-header-row");
      const addNotesBtn = row3.createEl("button", { cls: "horme-header-btn", text: "+ Add notes" });
      addNotesBtn.addEventListener("click", () => {
        if (this.selectedContextNotes.length >= 5) {
          new Notice("Horme: Maximum 5 context notes.");
          return;
        }
        new NotePickerModal(this.app, (file) => {
          if (this.selectedContextNotes.some(f => f.path === file.path)) {
            new Notice(`Already added: ${file.basename}`);
            return;
          }
          if (this.selectedContextNotes.length >= 5) {
            new Notice("Horme: Maximum 5 context notes.");
            return;
          }
          this.selectedContextNotes.push(file);
          this.updateContextNotesLabel();
        }).open();
      });
      const clearBtn = row3.createEl("button", { cls: "horme-header-btn", text: "Clear" });
      clearBtn.addEventListener("click", () => {
        void this.clearChat().catch(e => this.plugin.handleError(e));
      });
      this.contextNotesLabel = header.createDiv("horme-context-note-label");
      this.contextToggle.addEventListener("change", () => {
        void (async () => {
          if (
            this.contextToggle.checked &&
            !this.plugin.isLocalProviderActive() &&
            !this.plugin.settings.contextCloudWarningShown
          ) {
            const provider = this.plugin.settings.aiProvider.toUpperCase();
            new GenericConfirmModal(
              this.app,
              `Privacy notice: Your current note's full text will be sent to ${provider}, a cloud provider. The content will leave your device. Do you want to continue?`,
              () => {
                void (async () => {
                  this.plugin.settings.contextCloudWarningShown = true;
                  await this.plugin.saveSettings();
                  this.updateContextNoteLabel();
                })();
              },
              () => {
                this.contextToggle.checked = false;
                this.updateContextNoteLabel();
              }
            ).open();
          } else {
            this.updateContextNoteLabel();
          }
        })().catch(e => this.plugin.handleError(e));
      });

      this.leafChangeRef = this.app.workspace.on("active-leaf-change", () => this.updateContextNoteLabel());
      this.registerEvent(this.leafChangeRef);

      /* Messages */
      this.loadingOverlay = this.containerEl.createDiv("horme-loading-overlay");
      this.loadingOverlay.setCssProps({ display: "none" });

      this.loadingOverlay.createDiv("horme-spinner");
      this.messagesEl = content.createDiv("horme-messages");
      this.renderEmpty();

      /* Input Area */
      const inputArea = content.createDiv("horme-input-area");
      const inputContainer = inputArea.createDiv("horme-input-container");

      this.inputEl = inputContainer.createEl("textarea", {
        cls: "horme-input",
        attr: { placeholder: "Ask Horme…", rows: "1" },
      });
      this.inputEl.addEventListener("input", () => this.autoGrow());
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void this.sendMessage().catch(err => this.plugin.handleError(err, "Chat"));
        }
      });

      const actionRow = inputContainer.createDiv("horme-input-actions");
      
      const uploadBtn = actionRow.createEl("button", { cls: "horme-upload-btn" });
      setIcon(uploadBtn, "paperclip");
      uploadBtn.title = "Upload document";
      uploadBtn.addEventListener("click", () => {
        void this.pickDocument().catch(err => this.plugin.handleError(err, "Upload"));
      });

      const imageBtn = actionRow.createEl("button", { cls: "horme-image-btn" });
      setIcon(imageBtn, "image");
      imageBtn.title = "Upload image";
      imageBtn.addEventListener("click", () => {
        void this.pickImage().catch(err => this.plugin.handleError(err, "Upload"));
      });

      actionRow.createDiv("horme-input-spacer");

      this.sendBtn = actionRow.createEl("button", { cls: "horme-send-btn" });
      setIcon(this.sendBtn, "send");
      this.sendBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (this.isGenerating) void this.stopGeneration();
        else void this.sendMessage().catch(err => this.plugin.handleError(err, "Chat"));
      });

      this.unregisterSettingsListener = this.plugin.onSettingsChange(() => {
        void (async () => {
          if (this.presetSelect) await this.refreshPresets();
          await this.updateVaultBrainToggle();
        })();
      });

      await this.refreshModels();
      
      // Mobile keyboard fix: anchor input to keyboard
      const getDrawer = () => this.containerEl.closest(".workspace-drawer");
      this.inputEl.addEventListener("focus", () => {
        getDrawer()?.classList.add('horme-keyboard-open');
        window.setTimeout(() => {
          this.inputEl.scrollIntoView({ behavior: "smooth", block: "end" });
          this.scrollToBottom();
        }, 300);
      });
      this.inputEl.addEventListener("blur", () => {
        window.setTimeout(() => {
          getDrawer()?.classList.remove('horme-keyboard-open');
        }, 100);
      });

      this.updateConnectionStatus();
    } catch (e: unknown) {
      this.plugin.handleError(e, "Chat Interface");
    }
  }

  async onClose() {
    // Flush any pending history write before the view is destroyed
    await this.plugin.historyManager.flush();
    this.unregisterSettingsListener?.();
    // Clean up global listener to prevent leak on repeated open/close
    if (this.documentClickHandler) {
      activeDocument.removeEventListener("click", this.documentClickHandler);
      this.documentClickHandler = null;
    }
    this.contentEl.empty();
  }

  private updateContextNoteLabel() {
    if (!this.contextToggle.checked) {
      this.contextNoteLabel.empty();
      this.contextNoteLabel.setCssProps({ display: "none" });
      return;
    }
    this.contextNoteLabel.setCssProps({ display: "" });
    const mdLeaf = this.plugin.lastActiveMarkdownLeaf;
    const mdView = mdLeaf?.view instanceof MarkdownView ? mdLeaf.view : null;
    if (mdView && mdView.file) {
      this.contextNoteLabel.textContent = `${mdView.file.basename}`;
    } else {
      this.contextNoteLabel.textContent = "No note open";
    }
  }

  private async updateVaultBrainToggle() {
    const canUseBySettings =
      this.plugin.settings.vaultBrainEnabled
      && (this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG);
    const hasIndex = canUseBySettings ? await this.plugin.vaultIndexer.hasBuiltIndex() : false;
    const canUse = canUseBySettings && hasIndex;
    this.vaultBrainLabel.setCssProps({ display: canUse ? "" : "none" });
    if (!canUse) this.vaultBrainToggle.checked = false;
  }

  private updateContextNotesLabel() {
    this.contextNotesLabel.empty();
    if (this.selectedContextNotes.length === 0) {
      this.contextNotesLabel.setCssProps({ display: "none" });
      return;
    }
    this.contextNotesLabel.setCssProps({ display: "block" });
    this.contextNotesLabel.setCssProps({
      fontSize: "11px",
      lineHeight: "1.6",
      opacity: "0.8"
    });

    for (const file of this.selectedContextNotes) {
      const row = this.contextNotesLabel.createDiv();
      row.setCssProps({
        display: "flex",
        alignItems: "center",
        gap: "4px"
      });

      const removeBtn = row.createEl("span", { text: "\u00d7" });
      removeBtn.setCssProps({
        cursor: "pointer",
        opacity: "0.6",
        fontWeight: "bold",
      });
      removeBtn.addEventListener("click", () => {
        this.selectedContextNotes = this.selectedContextNotes.filter(f => f.path !== file.path);
        this.updateContextNotesLabel();
      });

      row.createEl("span", { text: file.basename });
    }
  }

  private getCurrentProviderModel(): string {
    const p = this.plugin.settings.aiProvider;
    if (p === "claude")      return this.plugin.settings.claudeModel;
    if (p === "gemini")      return this.plugin.settings.geminiModel;
    if (p === "openai")      return this.plugin.settings.openaiModel;
    if (p === "groq")        return this.plugin.settings.groqModel;
    if (p === "openrouter")  return this.plugin.settings.openRouterModel;
    if (p === "lmstudio")    return this.plugin.settings.lmStudioModel;
    return this.plugin.settings.defaultModel;
  }

  private async refreshModels() {
    await this.plugin.fetchModels();
    this.modelSelect.empty();
    if (!this.plugin.models || !this.plugin.models.length) {
      this.modelSelect.createEl("option", { text: "No models found", value: "" });
      await this.updateConnectionStatus();
      return;
    }
    this.plugin.models.forEach((m) => {
      const opt = this.modelSelect.createEl("option", { text: m, value: m });
      if (m === this.getCurrentProviderModel()) opt.selected = true;
    });
    await this.updateConnectionStatus();
    await this.updateVaultBrainToggle();
  }

  private async refreshPresets() {
    const current = this.presetSelect.value;
    this.presetSelect.empty();
    this.presetSelect.createEl("option", { text: "Default prompt", value: "" });
    const presets = await this.plugin.getChatPresets();
    for (const p of presets) {
      this.presetSelect.createEl("option", { text: p.name || "Preset", value: p.prompt });
    }
    this.presetSelect.disabled = presets.length === 0;
    this.presetSelect.value = Array.from(this.presetSelect.options).some(o => o.value === current) ? current : "";
  }

  private async updateConnectionStatus() {
    const ok = await this.plugin.checkConnection();
    const provider = this.plugin.settings.aiProvider;
    this.connectionDot.className = `horme-connection-icon ${ok ? "horme-online" : "horme-offline"}`;
    this.connectionDot.title = `${provider} ${ok ? "connected" : "unreachable"}`;
  }

  private async stopGeneration() {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    if (this.activeReader) {
      try { await this.activeReader.cancel(); } catch { /* ignore */ }
      this.activeReader = null;
    }
    this.isGenerating = false;
    setIcon(this.sendBtn, "send");
    this.sendBtn.classList.remove("horme-stop-btn");
  }

  private async pickDocument() {
    const fileInput = activeDocument.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf,.txt,.md";
    fileInput.setCssProps({ display: "none" });
    activeDocument.body.appendChild(fileInput);

    const cleanup = () => {
      fileInput.remove();
      window.removeEventListener("focus", onWindowFocus);
    };
    const onWindowFocus = () => window.setTimeout(cleanup, 500);
    window.addEventListener("focus", onWindowFocus, { once: true });

    fileInput.addEventListener("change", () => {
      void (async () => {
        window.removeEventListener("focus", onWindowFocus);
        const file = fileInput.files?.[0];
        if (!file) { fileInput.remove(); return; }

        try {
          const text = file.name.toLowerCase().endsWith(".pdf")
            ? await this.plugin.pdfService.extractText(file)
            : await file.text();

          this.uploadedDocContent = text;
          this.uploadedDocName = file.name;

          if (!this.history.length) this.messagesEl.empty();
          const notice = this.messagesEl.createDiv("horme-doc-notice");
          notice.textContent = `📎 ${file.name} loaded as context`;
          this.scrollToBottom();
          new Notice(`📎 ${file.name} loaded as context`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Error loading document: ${msg}`);
        } finally {
          fileInput.remove();
        }
      })();
    });
    fileInput.click();
  }

  private async confirmCloudSend(message: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      new GenericConfirmModal(
        this.app,
        message,
        () => resolve(true),
        () => resolve(false)
      ).open();
    });
  }

  private async sendMessage(regenerate = false) {
    if (this.isGenerating) return;

    const suppressRAG = !!this.forcedSkillId;

    // ── Forced skill execution ──────────────────────────────────────────────
    // When a skill is armed from the dropdown, we bypass both the normal
    // send flow AND Vault Brain RAG. The skill owns the context for this turn.
    if (this.forcedSkillId) {
      const skillId = this.forcedSkillId;
      const query = this.inputEl.value.trim();
      if (!query) return;

      // Disarm immediately — pill and flag cleared before any async work
      this.forcedSkillId = null;
      this.containerEl.querySelector(".horme-skill-pill")?.remove();

      // Render the user's message in the chat
      this.addMessageBubble("user", query);
      this.addUserActions(query);
      this.history.push({ role: "user", content: query });
      this.inputEl.value = "";
      this.autoGrow?.();

      const loadingEl = this.showLoading(`Running skill...`);

      try {
        const skill = this.plugin.skillManager.getSkillById(skillId);
        if (!skill) throw new Error(`Skill "${skillId}" not found.`);

        // Map the user's raw input to the skill's primary parameter.
        // All forced-execution skills have a single primary string param.
        const primaryParam = skill.parameters[0]?.name ?? "query";
        const forcedParams = { [primaryParam]: query };
        const result = await skill.execute(forcedParams);

        loadingEl.remove();
        await this.renderSkillResultBox(skill.id, skill.name, forcedParams, result);
        const forcedSkillLinks = this.extractSourceLinks(result);
        const resultBubble = this.addMessageBubble("assistant", "");
        const contentArea = resultBubble.querySelector(".horme-content-area") as HTMLElement;
        if (contentArea) {
          contentArea.empty();
          await MarkdownRenderer.render(this.app, result, contentArea, "", this);
        }
        this.addAssistantActions(resultBubble, result);
        this.renderSkillSourceLinks(resultBubble, forcedSkillLinks);
        this.history.push({ role: "assistant", content: result });
        await this.plugin.historyManager.append({
          id: this.conversationId,
          title: this.history.find(m => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
          timestamp: Date.now(),
          messages: this.history
        });
        this.scrollToBottom();

      } catch (e: unknown) {
        loadingEl.remove();
        this.plugin.handleError(e);
      }

      return; // Skip the rest of sendMessage()
    }
    // ── End forced skill execution ───────────────────────────────────────────

    let msgs: ChatMessage[];
    let model: string;
    let ragWasInjected = false;
    
    // Capture context at start to prevent desync
    const mdLeaf = this.plugin.lastActiveMarkdownLeaf;
    const initialSourcePath = (mdLeaf?.view instanceof MarkdownView ? mdLeaf.view.file?.path : null) ?? null;
    let currentSources: string[] = [];

    if (regenerate && this.lastMsgs && this.lastModel) {
      if (this.history.length && this.history[this.history.length - 1].role === "assistant") {
        this.history.pop();
      }
      msgs = this.lastMsgs;
      model = this.lastModel;
    } else {
      const text = this.inputEl.value.trim();
      if (!text) return;

      model = this.modelSelect.value;
      if (!model) {
        new Notice("Horme: No model selected.");
        return;
      }

      if (!this.history.length) this.messagesEl.empty();
	      this.inputEl.value = "";
	      this.autoGrow();
	      
	      const imagesToSave = [...this.uploadedImages];
	      this.addMessageBubble("user", text, imagesToSave);
	      this.addUserActions(text);
	      this.history.push({ role: "user", content: text, images: imagesToSave });

      // Clear previews
      this.messagesEl.querySelectorAll(".horme-image-preview-container").forEach(el => el.remove());

      const systemParts: string[] = [];
      const effectivePrompt = this.sessionSystemPromptOverride ?? await this.plugin.getEffectiveSystemPrompt();
      if (effectivePrompt) systemParts.push(effectivePrompt);

      const providerIsLocal = this.plugin.isLocalProviderActive();
      const providerLabel = this.plugin.settings.aiProvider.toUpperCase();

      // --- Current Note Context (privacy guarded) ---
      if (this.contextToggle.checked) {
        if (!providerIsLocal && !this.plugin.settings.contextCloudWarningShown) {
          const ok = await this.confirmCloudSend(
            `Privacy notice: Your current note's full text will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`
          );
          if (ok) {
            this.plugin.settings.contextCloudWarningShown = true;
            await this.plugin.saveSettings();
          } else {
            this.contextToggle.checked = false;
            this.updateContextNoteLabel();
            new Notice("Horme: Current note context not sent.");
          }
        }

        if (this.contextToggle.checked && mdLeaf?.view instanceof MarkdownView) {
          systemParts.push(`The user's current note:\n\n${mdLeaf.view.editor.getValue()}`);
        }
      }

      // --- Multi-Note Context Injection ---
      if (this.selectedContextNotes.length > 0) {
        let includeContextNotes = true;

        if (!providerIsLocal && !this.plugin.settings.contextNotesCloudWarningShown) {
          const ok = await this.confirmCloudSend(
            `Privacy notice: Up to 5 notes (excerpts) will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`
          );
          if (ok) {
            this.plugin.settings.contextNotesCloudWarningShown = true;
            await this.plugin.saveSettings();
          } else {
            includeContextNotes = false;
            new Notice("Horme: Context notes not sent.");
          }
        }

        if (includeContextNotes) {
          const noteParts: string[] = [];
          for (const file of this.selectedContextNotes) {
            try {
              const content = await this.app.vault.read(file);
              noteParts.push(`--- Note: ${file.basename} ---\n${content.slice(0, 4000)}`);
            } catch {
              noteParts.push(`--- Note: ${file.basename} ---\n[Error reading file]`);
            }
          }
          systemParts.push(
            `The user has provided the following notes as additional context:\n\n`
            + noteParts.join("\n\n")
          );
        }
      }

      // --- Vault Brain (RAG) Injection ---
      const canUseRAG = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
      const hasBuiltVaultIndex = canUseRAG ? await this.plugin.vaultIndexer.hasBuiltIndex() : false;
      const sessionRAGEnabled = this.vaultBrainToggle ? this.vaultBrainToggle.checked : true;
      let relevantChunks: string[] = [];

      if (!suppressRAG && this.plugin.settings.vaultBrainEnabled && canUseRAG && hasBuiltVaultIndex && sessionRAGEnabled) {
        relevantChunks = await this.plugin.vaultIndexer.search(text);
        if (relevantChunks.length > 0) {
          // search() returns chunks sorted best-first (highest score first).
          // We must preserve that ordering when merging into the rolling context,
          // otherwise slice() discards the most relevant results and keeps the worst.
          //
          // Strategy: current query's results go first (score-ordered), then
          // fill remaining slots with previous context for multi-turn coherence.
          const prevContext = this.rollingRAGContext.filter(c => !relevantChunks.includes(c));
          this.rollingRAGContext = [...relevantChunks, ...prevContext].slice(0, 20);

          // Extract unique paths for the "Sources" UI
          currentSources = relevantChunks.map(c => {
            const match = c.match(/^\[From (.*?)(?:\s\(.*\))?\]:/);
            return match ? match[1] : "";
          }).filter(Boolean);
          currentSources = [...new Set(currentSources)];
        }

        if (this.rollingRAGContext.length > 0) {
          ragWasInjected = true;
          if (relevantChunks.length > 0) {
            new Notice(`● Vault Brain: Consulting ${relevantChunks.length} notes...`);
          }
          systemParts.push(
            `LOCAL VAULT CONTEXT — Relevant notes from your vault are provided below.\n` +
            `Answer the user's question directly using this context.\n` +
            `Do NOT call vault_links or any other vault search skill — the search has already been done.\n\n` +
            this.rollingRAGContext.join("\n\n---\n\n")
          );
        }
      }

      if (this.uploadedDocContent) {
        let includeDocument = true;

        if (!providerIsLocal && !this.plugin.settings.documentCloudWarningShown) {
          const ok = await this.confirmCloudSend(
            `Privacy notice: Your uploaded document's extracted text will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`
          );
          if (ok) {
            this.plugin.settings.documentCloudWarningShown = true;
            await this.plugin.saveSettings();
          } else {
            includeDocument = false;
            new Notice("Horme: Uploaded document not sent.");
          }
        }

        if (includeDocument) {
          const formatInfo = this.uploadedDocName?.toLowerCase().endsWith(".pdf") 
            ? "The user has uploaded a PDF. The text below contains structural metadata: [x, y] are normalized coordinates (0-1000), 'size' is font size, and 'bold/italic' are styles.\n\n"
            : "The user has uploaded a document. Its content is:\n\n";
          systemParts.push(`${formatInfo}${this.uploadedDocContent}`);
        }
      }

      msgs = [];
      const isFirstMessage = this.history.length === 1;
      const currentMsg: ChatMessage = { role: "user", content: text };
      
      if (this.uploadedImages.length > 0) {
        if (!this.plugin.isLocalProviderActive()) {
          // Cloud providers don't support Ollama-style base64 images.
          // Clear the data so it never leaves the device.
          new Notice("⚠ Image upload is only supported with local providers (Ollama / LM Studio). Images have been removed from this message.");
          this.uploadedImages = [];
        } else {
          currentMsg.images = [...this.uploadedImages];
          this.uploadedImages = [];
        }
      }
      if (this.uploadedAudio) {
        currentMsg.audio = this.uploadedAudio;
        this.uploadedAudio = null;
      }

      if (isFirstMessage) {
        const combined = systemParts.length 
          ? `${systemParts.join("\n\n")}\n\n---\n\nUSER MESSAGE: ${text}`
          : text;
        currentMsg.content = combined;
        msgs.push(currentMsg);
      } else {
        if (systemParts.length) msgs.push({ role: "system", content: systemParts.join("\n\n") });
        for (const m of this.history) {
          msgs.push({ role: m.role, content: m.content });
        }
        // Attach media to the latest user message in the payload
        const lastMsg = msgs[msgs.length - 1];
        if (currentMsg.images) lastMsg.images = currentMsg.images;
        if (currentMsg.audio) lastMsg.audio = currentMsg.audio;
      }
    }

    this.lastMsgs = msgs;
    this.lastModel = model;
    this.isGenerating = true;
    setIcon(this.sendBtn, "square");
    this.sendBtn.classList.add("horme-stop-btn");
    const loadingEl = this.showLoading();
    this.handleStreamingResponse(msgs, model, loadingEl, initialSourcePath, ragWasInjected, 0, currentSources, [])
      .catch(e => this.plugin.handleError(e));
  }

  private static readonly MAX_SKILL_DEPTH = 5;

  private async handleStreamingResponse(
    msgs: ChatMessage[],
    model: string,
    loadingEl: HTMLElement | null,
    initialSourcePath: string | null,
    suppressVaultSkill: boolean,
    skillDepth: number,
    sources: string[] = [],
    skillSourceLinks: string[] = []
  ) {
    let bubbleEl: HTMLElement | null = null;
    let fullContent = "";
    let fullReasoning = "";
    let reasoningEl: HTMLDetailsElement | null = null;

    this.activeAbortController = new AbortController();

    try {
      const reader = await this.plugin.aiGateway.stream(msgs, model, this.activeAbortController.signal, suppressVaultSkill);
      this.activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let hasReceivedFirstChunk = false;

      const isEscaped = (s: string, idx: number): boolean => {
        let count = 0;
        let j = idx - 1;
        while (j >= 0 && s[j] === '\\') { count++; j--; }
        return count % 2 !== 0;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // Robust parser for concatenated JSON (handles Gemini/Ollama high-throughput)
        let braceCount = 0;
        let start = 0;
        let inString = false;

        for (let i = 0; i < buffer.length; i++) {
            const char = buffer[i];
            if (char === '"' && !isEscaped(buffer, i)) inString = !inString;
            if (!inString) {
                if (char === '{') {
                    if (braceCount === 0) start = i;
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        const jsonStr = buffer.slice(start, i + 1);
                        this.processChunk(jsonStr, (content, reasoning) => {
                            if (!hasReceivedFirstChunk && (content || reasoning)) {
                                hasReceivedFirstChunk = true;
                                if (loadingEl) loadingEl.remove();
                                bubbleEl = this.addMessageBubble("assistant", "");
                            }
                            
                            // Capture in a local const so TypeScript's narrowing works correctly
                            // across the closure boundary. Without this, TypeScript cannot track
                            // that bubbleEl was assigned above and types it as `never` after the guard.
                            const el = bubbleEl;
                            if (!el) return;
                            
                            if (reasoning) {
                                if (!reasoningEl) {
                                    reasoningEl = el.createEl("details", { cls: "horme-reasoning-details" });
                                    reasoningEl.createEl("summary", { text: "Reasoning Process", cls: "horme-reasoning-summary" });
                                }
                                fullReasoning += reasoning;
                                let reasoningBody = reasoningEl.querySelector(".horme-reasoning-body");
                                if (!reasoningBody) reasoningBody = reasoningEl.createDiv("horme-reasoning-body");
                                (reasoningBody as HTMLElement).textContent = fullReasoning;
                            }

                            if (content) {
                                fullContent += content;
                                // If there was reasoning, ensure the content is outside/after it
                                let contentArea = el.querySelector(".horme-content-area");
                                if (!contentArea) contentArea = el.createDiv("horme-content-area");
                                (contentArea as HTMLElement).textContent = fullContent;
                            }
                            this.scrollToBottom();
                        });
                        start = i + 1;
                    }
                }
            }
        }
        buffer = buffer.slice(start);
      }

      this.activeReader = null;
      
      if (bubbleEl) {
          const el = bubbleEl as HTMLElement;
          // Re-render the final content with Markdown
          const contentArea = el.querySelector(".horme-content-area") as HTMLElement;
          if (contentArea) {
              contentArea.empty();
              await MarkdownRenderer.render(this.app, fullContent, contentArea, initialSourcePath || "", this);
          } else {
              // Fallback if only content was received without special area
              el.empty();
              if (reasoningEl) el.appendChild(reasoningEl);
              const finalArea = el.createDiv("horme-content-area");
              await MarkdownRenderer.render(this.app, fullContent, finalArea, initialSourcePath || "", this);
          }
          this.addAssistantActions(el, fullContent);
          this.renderSources(el, sources);
      }

      const finalMsg = fullReasoning ? `> [!thought]\n> ${fullReasoning.replace(/\n/g, "\n> ")}\n\n${fullContent}` : fullContent;
      if (fullContent || fullReasoning) {
          this.history.push({ role: "assistant", content: finalMsg });
          
          // --- Skill Execution Agent Loop ---
          const skillCalls = this.plugin.skillManager.parseSkillCalls(fullContent);
          if (skillCalls.length > 0) {
            // Clean the assistant bubble: strip raw <call:...> XML and leave
            // only the model's natural language text (if any).
            if (bubbleEl) {
              const bEl = bubbleEl as HTMLElement;
              const contentArea = bEl.querySelector(".horme-content-area") as HTMLElement;
              if (contentArea) {
                const cleanedContent = this.stripSkillCallXml(fullContent);
                contentArea.empty();
                if (cleanedContent) {
                  await MarkdownRenderer.render(this.app, cleanedContent, contentArea, initialSourcePath || "", this);
                } else {
                  // Nothing left after stripping — remove the empty bubble entirely
                  bEl.remove();
                  // Also remove the actions row (Copy/Regen/Save) that was appended after it
                  const actionsRow = this.messagesEl.querySelector(".horme-save-wrapper:last-child");
                  actionsRow?.remove();
                }
              }
            }

            const aggregatedSkillLinks = [...skillSourceLinks];
            for (const call of skillCalls) {
              const skillName = call.skillId;
              const skill = this.plugin.skillManager.getSkillById(skillName);
              const displayName = skill?.name || skillName;

              const skillLoading = this.showLoading(displayName);
              const loadingSpan = skillLoading.querySelector("span");
              if (loadingSpan) {
                const iconEl = activeDocument.createElement("span");
                iconEl.className = "horme-skill-loading-icon";
                setIcon(iconEl, this.getSkillIcon(skillName));
                loadingSpan.insertBefore(iconEl, loadingSpan.firstChild);
              }
              const result = await this.plugin.skillManager.executeSkill(call);
              skillLoading.remove();
              const skillLinks = this.extractSourceLinks(result);
              for (const link of skillLinks) {
                if (!aggregatedSkillLinks.includes(link)) aggregatedSkillLinks.push(link);
              }

              // Add the result to history
              this.history.push({ 
                role: "system", 
                content: `RESULT FROM SKILL "${skillName}":\n\n${result}\n\nBased on this result, please continue your response to the user.` 
              });
              await this.renderSkillResultBox(skillName, displayName, call.parameters, result);

              const isTerminal = skill?.terminal === true;
              const shouldPromote = this.shouldPromoteSkillFailure(result);

              if (isTerminal || shouldPromote) {
                // Render result as a proper assistant bubble — same as the forced execution path
                const resultBubble = this.addMessageBubble("assistant", "");
                const resultArea = resultBubble.querySelector(".horme-content-area") as HTMLElement;
                if (resultArea) {
                  resultArea.empty();
                  await MarkdownRenderer.render(this.app, result, resultArea, initialSourcePath || "", this);
                }
                this.addAssistantActions(resultBubble, result);
                this.renderSkillSourceLinks(resultBubble, skillLinks);
                this.history.push({ role: "assistant", content: result });
              }
            }

            const hasTerminalSkill = skillCalls.some(c => {
              const s = this.plugin.skillManager.getSkillById(c.skillId);
              return s?.terminal === true;
            });

            if (!hasTerminalSkill) {
              // Prepare the next turn in the loop
              const nextMsgs: ChatMessage[] = [];
              const effectivePrompt = this.sessionSystemPromptOverride ?? await this.plugin.getEffectiveSystemPrompt();
              if (effectivePrompt) nextMsgs.push({ role: "system", content: effectivePrompt });
              
              for (const m of this.history) {
                nextMsgs.push({ role: m.role, content: m.content });
              }

              // Recurse with depth guard
              if (skillDepth >= HormeChatView.MAX_SKILL_DEPTH) {
                new Notice("Horme: Maximum skill depth reached. Stopping skill loop.");
              } else {
                const nextLoading = this.showLoading();
                await this.handleStreamingResponse(nextMsgs, model, nextLoading, initialSourcePath, false, skillDepth + 1, [], aggregatedSkillLinks);
              }
            } else {
              // Terminal skills: save history and stop — no LLM synthesis needed
              if (bubbleEl && aggregatedSkillLinks.length > 0) {
                this.renderSkillSourceLinks(bubbleEl as HTMLElement, aggregatedSkillLinks);
              }
              await this.plugin.historyManager.append({
                id: this.conversationId,
                title: this.history.find(m => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
                timestamp: Date.now(),
                messages: this.history
              });
            }
            return;
          }
          if (bubbleEl && skillSourceLinks.length > 0) {
            this.renderSkillSourceLinks(bubbleEl as HTMLElement, skillSourceLinks);
          }

          await this.plugin.historyManager.append({
            id: this.conversationId,
            title: this.history.find(m => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
            timestamp: Date.now(),
            messages: this.history
          });
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") {
        new Notice("Generation stopped.");
      } else {
        if (loadingEl) loadingEl.remove();
        this.plugin.handleError(e);
      }
    } finally {
      if (loadingEl) loadingEl.remove();
      this.isGenerating = false;
      setIcon(this.sendBtn, "send");
      this.sendBtn.classList.remove("horme-stop-btn");
      this.activeAbortController = null;
      this.activeReader = null;
    }
  }

  private addAssistantActions(bubbleEl: HTMLElement, content: string) {
    const wrapper = this.messagesEl.createDiv("horme-save-wrapper");
    const copyBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Copy" });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(content)
        .then(() => new Notice("Copied to clipboard"))
        .catch(e => this.plugin.handleError(e, "Clipboard"));
    });

    const regenBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Regenerate" });
    setIcon(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      bubbleEl.remove();
      wrapper.remove();
      void this.sendMessage(true).catch(e => this.plugin.handleError(e, "Chat"));
    });

    const saveBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Save as note" });
    setIcon(saveBtn, "file-plus");
    saveBtn.addEventListener("click", () => {
      void (async () => {
        const folder = this.plugin.settings.exportFolder.trim() || "HORME";
        if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
        const baseName = this.uploadedDocName ? this.uploadedDocName.replace(/\.[^.]+$/, "") : "Horme response";
        let fileName = `${folder}/${baseName}.md`;
        if (await this.app.vault.adapter.exists(fileName)) {
          fileName = `${folder}/${baseName} ${new Date().getTime()}.md`;
        }
        await this.app.vault.create(fileName, content);
        new Notice(`Saved as ${fileName}`);
      })().catch(e => this.plugin.handleError(e));
    });
  }

  private addUserActions(content: string) {
    const wrapper = this.messagesEl.createDiv("horme-save-wrapper horme-save-wrapper-user");
    const copyBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Copy" });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(content)
        .then(() => new Notice("Copied to clipboard"))
        .catch(e => this.plugin.handleError(e, "Clipboard"));
    });
  }

  private async renderSkillResultBox(skillId: string, displayName: string, params: unknown, result: string) {
    const summaryText = this.formatSkillSummary(displayName, params);
    const resultBubble = this.messagesEl.createDiv("horme-msg horme-msg-assistant");
    const details = resultBubble.createEl("details", { cls: "horme-reasoning-details" });
    const summaryEl = details.createEl("summary", { cls: "horme-reasoning-summary" });
    const summaryIcon = summaryEl.createSpan({ cls: "horme-skill-summary-icon" });
    setIcon(summaryIcon, this.getSkillIcon(skillId));
    summaryEl.appendText(` ${summaryText}`);
    const body = details.createDiv("horme-reasoning-body");
    await MarkdownRenderer.render(this.app, result, body, "", this);
    this.scrollToBottom();
  }

  private extractSourceLinks(text: string): string[] {
    const links = new Set<string>();
    const add = (raw: string) => {
      const cleaned = raw.trim().replace(/[)\].,;:!?]+$/g, "");
      if (!/^https?:\/\//i.test(cleaned)) return;
      links.add(cleaned);
    };

    const markdownLinkRegex = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = markdownLinkRegex.exec(text)) !== null) {
      add(match[1]);
    }

    const rawUrlRegex = /(https?:\/\/[^\s<>"']+)/gi;
    while ((match = rawUrlRegex.exec(text)) !== null) {
      add(match[1]);
    }

    return Array.from(links);
  }

  private shouldPromoteSkillFailure(result: string): boolean {
    const t = result.trim().toLowerCase();
    if (!t) return false;
    return (
      t.startsWith("no ") ||
      t.includes("no exact") ||
      t.includes("no results found") ||
      t.includes("returned no") ||
      t.includes("not found") ||
      t.includes("did you mean") ||
      t.includes("failed") ||
      t.includes("error:")
    );
  }

  private renderSkillSourceLinks(bubbleEl: HTMLElement, links: string[]) {
    if (links.length === 0) return;
    const uniqueLinks = Array.from(new Set(links));
    const sourcesEl = bubbleEl.createDiv("horme-sources-container horme-skill-sources-container");
    sourcesEl.createSpan({ text: "Skill Sources:", cls: "horme-sources-label" });

    const listEl = sourcesEl.createDiv("horme-sources-list");
    for (const link of uniqueLinks) {
      let label = link;
      try {
        label = new URL(link).hostname.replace(/^www\./, "");
      } catch {
        // Keep full URL if parsing fails.
      }
      const anchor = listEl.createEl("a", {
        text: label,
        href: link,
        cls: "horme-source-pill horme-source-link-pill"
      });
      anchor.setAttr("target", "_blank");
      anchor.setAttr("rel", "noopener noreferrer");
      anchor.title = link;
    }
  }

  private renderSources(bubbleEl: HTMLElement, paths: string[]) {
    if (paths.length === 0) return;
    
    const sourcesEl = bubbleEl.createDiv("horme-sources-container");
    sourcesEl.createSpan({ text: "Sources:", cls: "horme-sources-label" });
    
    const listEl = sourcesEl.createDiv("horme-sources-list");
    paths.forEach(path => {
      const filename = path.split("/").pop() || path;
      const pill = listEl.createEl("span", { text: filename, cls: "horme-source-pill" });
      pill.title = path;
      pill.addEventListener("click", () => {
        void (async () => {
          const abstractFile = this.app.vault.getAbstractFileByPath(path);
          if (abstractFile instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(abstractFile);
          } else {
            new Notice(`Source not found: ${path}`);
          }
        })();
      });
    });
  }

  private async exportConversation() {
    if (!this.history.length) return;
    const folder = this.plugin.settings.exportFolder.trim() || "HORME";
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
    const content = this.history.filter(m => m.role !== "system")
      .map(m => `**${m.role === "user" ? "You" : "Horme"}**:\n${m.content}\n`)
      .join("\n---\n\n");
    const fileName = `${folder}/Horme chat ${new Date().getTime()}.md`;
    await this.app.vault.create(fileName, content);
    new Notice(`Exported to ${fileName}`);
  }

  private addMessageBubble(role: "user" | "assistant", content: string, images?: string[]): HTMLElement {
    const el = this.messagesEl.createDiv(`horme-msg horme-msg-${role}`);
    
    if (images && images.length > 0) {
      const imagesWrap = el.createDiv("horme-msg-images");
      for (const b64 of images) {
        const img = imagesWrap.createEl("img", { cls: "horme-msg-image" });
        img.src = b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
      }
    }

    const contentArea = el.createDiv("horme-content-area");
    if (content) {
      contentArea.textContent = content;
    }

    this.scrollToBottom();
    return el;
  }

  private showLoading(label: string = "Thinking"): HTMLElement {
    const el = this.messagesEl.createDiv("horme-loading");
    el.createSpan({ text: label });
    const dots = el.createSpan({ cls: "horme-dot-pulse" });
    dots.createEl("span"); dots.createEl("span"); dots.createEl("span");
    this.scrollToBottom();
    return el;
  }

  private renderEmpty() {
    const empty = this.messagesEl.createDiv("horme-empty");
    const iconWrap = empty.createDiv("horme-empty-icon");
    setIcon(iconWrap, "cone");
    const svg = iconWrap.querySelector("svg");
    if (svg) { svg.setAttribute("width", "72"); svg.setAttribute("height", "72"); }
    empty.createDiv({ cls: "horme-empty-text", text: "Start a conversation with Horme." });
  }

  private async clearChat() {
    this.history = [];
    this.conversationId = this.generateId();
    this.uploadedDocContent = null;
    this.uploadedDocName = null;
    this.lastMsgs = null;
    this.lastModel = null;
    this.rollingRAGContext = [];
    this.selectedContextNotes = [];
    this.updateContextNotesLabel();
    this.showingHistory = false;
    await this.renderChatView();
  }

  private async toggleHistoryPanel() {
    this.showingHistory = !this.showingHistory;
    if (this.showingHistory) await this.renderHistoryView();
    else await this.renderChatView();
  }

  private async renderChatView() {
    this.messagesEl.empty();
    if (!this.history.length) { this.renderEmpty(); return; }
    for (const m of this.history) {
      if (m.role === "user" || m.role === "assistant") {
        const bubble = this.addMessageBubble(m.role, "", m.images);
        if (m.role === "assistant") {
          // Render into the .horme-content-area div (created by addMessageBubble)
          // to match the structure used by the streaming path.
          // Strip any raw <call:...> skill XML that was stored in history.
          const displayContent = this.stripSkillCallXml(m.content);
          const contentArea = bubble.querySelector(".horme-content-area") as HTMLElement;
          if (contentArea) {
            contentArea.empty();
            if (displayContent) {
              await MarkdownRenderer.render(this.app, displayContent, contentArea, "", this);
            }
          } else if (displayContent) {
            await MarkdownRenderer.render(this.app, displayContent, bubble, "", this);
          }
          this.addAssistantActions(bubble, m.content);
	        } else {
	          const contentArea = bubble.querySelector(".horme-content-area") as HTMLElement;
	          if (contentArea) contentArea.textContent = m.content;
	          this.addUserActions(m.content);
	        }
	      }
	    }
    this.scrollToBottom();
  }

  private async renderHistoryView() {
    this.messagesEl.empty();
    const panel = this.messagesEl.createDiv("horme-history-panel");
    const header = panel.createDiv("horme-history-header");
    header.createEl("h4", { text: "Chat History" });
    
    const backBtn = header.createEl("button", { text: "Close", cls: "horme-history-back" });
    backBtn.addEventListener("click", () => {
      this.showingHistory = false;
      void this.renderChatView().catch(e => this.plugin.handleError(e));
    });

    const deleteAllBtn = header.createEl("button", { text: "Delete all", cls: "horme-history-delete-all mod-warning" });
    deleteAllBtn.addEventListener("click", () => {
      new GenericConfirmModal(
        this.app,
        "Are you sure you want to delete ALL chat history? This cannot be undone.",
        () => {
          void (async () => {
            await this.plugin.historyManager.deleteAll();
            await this.renderHistoryView();
          })().catch(e => this.plugin.handleError(e));
        }
      ).open();
    });

    const list = panel.createDiv("horme-history-list");
    const convos = await this.plugin.historyManager.load();
    if (!convos.length) { list.createDiv({ cls: "horme-history-empty", text: "No saved conversations" }); return; }
    for (const c of convos) {
      const item = list.createDiv("horme-history-item");
      const info = item.createDiv("horme-history-item-info");
      info.createDiv({ cls: "horme-history-item-title", text: c.title });
      info.createDiv({ cls: "horme-history-item-date", text: new Date(c.timestamp).toLocaleString() });
      info.addEventListener("click", () => {
        void this.loadConversation(c).catch(e => this.plugin.handleError(e));
      });

      const delBtn = item.createDiv("horme-history-item-delete");
      setIcon(delBtn, "trash-2");
      delBtn.title = "Delete conversation";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        new GenericConfirmModal(
          this.app,
          "Delete this conversation?",
          () => {
            void (async () => {
              await this.plugin.historyManager.delete(c.id);
              await this.renderHistoryView();
            })().catch(err => this.plugin.handleError(err));
          }
        ).open();
      });
    }
  }

  private async loadConversation(convo: SavedConversation) {
    this.showingHistory = false;
    this.conversationId = convo.id;
    this.history = convo.messages.map(m => ({ role: m.role, content: m.content, images: m.images, audio: m.audio }));
    this.lastMsgs = null;
    this.lastModel = null;
    await this.renderChatView();
  }

  private scrollToBottom() { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }
  private autoGrow() {
    this.inputEl.setCssProps({ height: "auto" });
    this.inputEl.setCssProps({ height: `${Math.min(this.inputEl.scrollHeight, 140)}px` });
  }

  /**
   * Strips raw skill call XML (e.g. `<call:wikipedia>{...}</call>`) from content
   * so the user sees clean text instead of the model's internal tool invocations.
   */
  private stripSkillCallXml(content: string): string {
    return content.replace(/<call:[^>]+>[\s\S]*?<\/call>/g, "").trim();
  }

  /**
   * Builds a human-readable summary for the skill result box.
   * Adds contextual details like language names where applicable.
   */
  private static readonly LANG_NAMES: Record<string, string> = {
    en: "English", es: "Spanish", fr: "French", de: "German",
    it: "Italian", pt: "Portuguese", zh: "Chinese", ja: "Japanese",
    ko: "Korean", ru: "Russian", nl: "Dutch", ar: "Arabic",
    tr: "Turkish", hi: "Hindi", pl: "Polish", sv: "Swedish",
    da: "Danish", fi: "Finnish", no: "Norwegian", cs: "Czech",
    el: "Greek", he: "Hebrew", th: "Thai", vi: "Vietnamese",
    uk: "Ukrainian", ro: "Romanian", hu: "Hungarian", ca: "Catalan",
  };

  private formatSkillSummary(skillName: string, params: unknown): string {
    // Add language detail for skills that use it (Wikipedia, Wiktionary)
    const language =
      (typeof params === "object" && params !== null && typeof (params as Record<string, unknown>)["language"] === "string")
        ? ((params as Record<string, unknown>)["language"] as string)
        : null;
    if (language) {
      const code = language.toLowerCase().slice(0, 2);
      const langName = HormeChatView.LANG_NAMES[code] || language.toUpperCase();
      return `Skill used: ${skillName} (${langName})`;
    }
    return `Skill used: ${skillName}`;
  }

  private processChunk(line: string, onContent: (c: string, r?: string) => void) {
    const raw = line.trim();
    if (!raw || raw === "data: [DONE]") return;
    try {
      // The upstream brace-counting parser already extracts clean JSON objects,
      // so no SSE "data: " prefix stripping is needed here.
      const data: unknown = JSON.parse(raw);

      const content =
        this.getStringAtPath(data, ["message", "content"]) ??
        this.getStringAtPath(data, ["choices", 0, "delta", "content"]) ??
        this.getStringAtPath(data, ["delta", "text"]) ??
        this.getStringAtPath(data, ["candidates", 0, "content", "parts", 0, "text"]) ??
        "";

      const reasoning =
        this.getStringAtPath(data, ["choices", 0, "delta", "reasoning_content"]) ??
        this.getStringAtPath(data, ["message", "reasoning"]) ??
        "";

      if (content || reasoning) onContent(content, reasoning);
    } catch {
      // Ignore malformed partial chunks.
    }
  }

  private getStringAtPath(obj: unknown, path: Array<string | number>): string | undefined {
    let cur: unknown = obj;
    for (const key of path) {
      if (typeof key === "number") {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[key];
        continue;
      }
      if (typeof cur !== "object" || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return typeof cur === "string" ? cur : undefined;
  }
}
