import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, setIcon, Notice, TFile } from "obsidian";
import HormePlugin from "../../main";
import { VIEW_TYPE } from "../constants";
import { ChatMessage, SavedConversation } from "../types";
import { NotePickerModal } from "../modals/NotePickerModal";

export class HormeChatView extends ItemView {
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
  private unregisterSettingsListener: (() => void) | null = null;
  private sessionSystemPromptOverride: string | null = null;

  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private activeAbortController: AbortController | null = null;
  private lastMsgs: Array<{ role: string; content: string }> | null = null;
  private lastModel: string | null = null;
  private conversationId: string = this.generateId();
  private uploadedDocContent: string | null = null;
  private uploadedDocName: string | null = null;
  private uploadedImages: string[] = [];
  private uploadedAudio: string | null = null;
  private leafChangeRef: any | null = null;
  private rollingRAGContext: string[] = [];
  private selectedContextNotes: TFile[] = [];
  private contextNotesLabel!: HTMLElement;
  private vaultBrainToggle!: HTMLInputElement;
  private vaultBrainLabel!: HTMLElement;
 
  private async pickImage() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    const cleanup = () => {
      fileInput.remove();
      window.removeEventListener("focus", onWindowFocus);
    };
    const onWindowFocus = () => setTimeout(cleanup, 500);
    window.addEventListener("focus", onWindowFocus, { once: true });

    fileInput.addEventListener("change", async () => {
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

  async onOpen() {
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
      this.plugin.saveSettings();
    });

    this.presetSelect = selectsWrap.createEl("select", { cls: "horme-select horme-preset-select" });
    this.presetSelect.addEventListener("change", () => {
      this.sessionSystemPromptOverride = this.presetSelect.value || null;
    });
    this.refreshPresets();

    const refreshBtn = row0.createEl("button", { cls: "horme-header-btn" });
    refreshBtn.classList.add("horme-icon-btn");
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refreshModels());

    const row1 = header.createDiv("horme-header-row horme-header-row-actions");
    const row1Left = row1.createDiv("horme-header-actions-left");
    const row1Right = row1.createDiv("horme-header-actions-right");

    const clearBtn = row1Left.createEl("button", { cls: "horme-header-btn mod-cta", text: "Clear" });
    clearBtn.addEventListener("click", () => this.clearChat());

    const tagBtn = row1Left.createEl("button", { cls: "horme-header-btn mod-cta", text: "Tags" });
    tagBtn.addEventListener("click", () => this.plugin.suggestTagsForActiveNote());

    const summaryBtn = row1Left.createEl("button", { cls: "horme-header-btn mod-cta", text: "Summary" });
    summaryBtn.addEventListener("click", () => this.plugin.generateFrontmatterSummary());

    const historyBtn = row1Right.createEl("button", { cls: "horme-header-btn horme-icon-btn" });
    setIcon(historyBtn, "history");
    historyBtn.addEventListener("click", () => this.toggleHistoryPanel());

    const exportBtn = row1Right.createEl("button", { cls: "horme-header-btn horme-icon-btn" });
    setIcon(exportBtn, "download");
    exportBtn.addEventListener("click", () => this.exportConversation());

    const row2 = header.createDiv("horme-header-row");
    const label = row2.createEl("label", { cls: "horme-context-toggle" });
    this.contextToggle = label.createEl("input", { type: "checkbox" });
    label.createSpan({ text: "Use current note as context" });

    const vbLabel = row2.createEl("label", { cls: "horme-context-toggle" });
    vbLabel.style.marginLeft = "12px";
    this.vaultBrainToggle = vbLabel.createEl("input", { type: "checkbox" });
    this.vaultBrainToggle.checked = true;
    vbLabel.createSpan({ text: "Use Vault Brain" });
    this.vaultBrainLabel = vbLabel;
    this.updateVaultBrainToggle();

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
    const clearNotesBtn = row3.createEl("button", { cls: "horme-header-btn", text: "Clear" });
    clearNotesBtn.addEventListener("click", () => {
      this.selectedContextNotes = [];
      this.updateContextNotesLabel();
    });
    this.contextNotesLabel = header.createDiv("horme-context-note-label");
    this.contextToggle.addEventListener("change", async () => {
      if (
        this.contextToggle.checked &&
        !this.plugin.isLocalProviderActive() &&
        !this.plugin.settings.contextCloudWarningShown
      ) {
        const provider = this.plugin.settings.aiProvider.toUpperCase();
        const confirmed = confirm(
          `Privacy notice\n\n` +
          `Your current note's full text will be sent to ${provider}, a cloud provider. ` +
          `The content will leave your device.\n\n` +
          `Do you want to continue?`
        );
        if (!confirmed) {
          this.contextToggle.checked = false;
          this.updateContextNoteLabel();
          return;
        }
        this.plugin.settings.contextCloudWarningShown = true;
        await this.plugin.saveSettings();
      }
      this.updateContextNoteLabel();
    });

    this.leafChangeRef = this.app.workspace.on("active-leaf-change", () => this.updateContextNoteLabel());
    this.registerEvent(this.leafChangeRef);

    /* Messages */
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
        this.sendMessage();
      }
    });

    const actionRow = inputContainer.createDiv("horme-input-actions");
    
    const uploadBtn = actionRow.createEl("button", { cls: "horme-upload-btn" });
    setIcon(uploadBtn, "paperclip");
    uploadBtn.title = "Upload document";
    uploadBtn.addEventListener("click", (e) => {
      this.pickDocument();
    });

    const imageBtn = actionRow.createEl("button", { cls: "horme-image-btn" });
    setIcon(imageBtn, "image");
    imageBtn.title = "Upload image";
    imageBtn.addEventListener("click", (e) => {
      this.pickImage();
    });

    actionRow.createDiv("horme-input-spacer");

    this.sendBtn = actionRow.createEl("button", { cls: "horme-send-btn" });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.isGenerating) this.stopGeneration();
      else this.sendMessage();
    });

    this.unregisterSettingsListener = this.plugin.onSettingsChange(() => {
      if (this.presetSelect) this.refreshPresets();
    });

    await this.refreshModels();
    
    // Mobile keyboard fix: anchor input to keyboard
    const getDrawer = () => this.containerEl.closest('.workspace-drawer') as HTMLElement | null;
    this.inputEl.addEventListener("focus", () => {
      getDrawer()?.classList.add('horme-keyboard-open');
      setTimeout(() => {
        this.inputEl.scrollIntoView({ behavior: "smooth", block: "end" });
        this.scrollToBottom();
      }, 300);
    });
    this.inputEl.addEventListener("blur", () => {
      setTimeout(() => {
        getDrawer()?.classList.remove('horme-keyboard-open');
      }, 100);
    });

    this.updateConnectionStatus();
  }

  async onClose() {
    // Flush any pending history write before the view is destroyed
    await this.plugin.historyManager.flush();
    this.unregisterSettingsListener?.();
    this.contentEl.empty();
  }

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
      this.contextNoteLabel.textContent = `${mdView.file.basename}`;
    } else {
      this.contextNoteLabel.textContent = "No note open";
    }
  }

  private updateVaultBrainToggle() {
    const canUse = this.plugin.settings.vaultBrainEnabled
      && (this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG);
    this.vaultBrainLabel.style.display = canUse ? "" : "none";
    if (!canUse) this.vaultBrainToggle.checked = false;
  }

  private updateContextNotesLabel() {
    this.contextNotesLabel.empty();
    if (this.selectedContextNotes.length === 0) {
      this.contextNotesLabel.style.display = "none";
      return;
    }
    this.contextNotesLabel.style.display = "block";
    this.contextNotesLabel.style.fontSize = "11px";
    this.contextNotesLabel.style.lineHeight = "1.6";
    this.contextNotesLabel.style.opacity = "0.8";

    for (const file of this.selectedContextNotes) {
      const row = this.contextNotesLabel.createDiv();
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "4px";

      const removeBtn = row.createEl("span", { text: "\u00d7" });
      removeBtn.style.cursor = "pointer";
      removeBtn.style.opacity = "0.6";
      removeBtn.style.fontWeight = "bold";
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
      this.updateConnectionStatus();
      return;
    }
    this.plugin.models.forEach((m) => {
      const opt = this.modelSelect.createEl("option", { text: m, value: m });
      if (m === this.getCurrentProviderModel()) opt.selected = true;
    });
    this.updateConnectionStatus();
    this.updateVaultBrainToggle();
  }

  private refreshPresets() {
    const current = this.presetSelect.value;
    this.presetSelect.empty();
    this.presetSelect.createEl("option", { text: "Default prompt", value: "" });
    const presets = this.plugin.settings.promptPresets || [];
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
      try { await this.activeReader.cancel(); } catch { }
      this.activeReader = null;
    }
    this.isGenerating = false;
    setIcon(this.sendBtn, "send");
    this.sendBtn.classList.remove("horme-stop-btn");
  }

  private async pickDocument() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf,.txt,.md";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    const cleanup = () => {
      fileInput.remove();
      window.removeEventListener("focus", onWindowFocus);
    };
    const onWindowFocus = () => setTimeout(cleanup, 500);
    window.addEventListener("focus", onWindowFocus, { once: true });

    fileInput.addEventListener("change", async () => {
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
      } catch (err: any) {
        new Notice(`Error loading document: ${err.message || err}`);
      } finally {
        fileInput.remove();
      }
    });
    fileInput.click();
  }

  private async sendMessage(regenerate = false) {
    if (this.isGenerating) return;

    let msgs: Array<{ role: string; content: string }>;
    let model: string;
    let ragWasInjected = false;
    
    // Capture context at start to prevent desync
    const mdLeaf = this.plugin.lastActiveMarkdownLeaf;
    const initialSourcePath = mdLeaf?.view instanceof MarkdownView ? mdLeaf.view.file?.path : "";

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
      this.history.push({ role: "user", content: text, images: imagesToSave });

      // Clear previews
      this.messagesEl.querySelectorAll(".horme-image-preview-container").forEach(el => el.remove());

      const systemParts: string[] = [];
      const effectivePrompt = this.sessionSystemPromptOverride ?? this.plugin.getEffectiveSystemPrompt();
      if (effectivePrompt) systemParts.push(effectivePrompt);

      if (this.contextToggle.checked) {
        if (mdLeaf?.view instanceof MarkdownView) {
          systemParts.push(`The user's current note:\n\n${mdLeaf.view.editor.getValue()}`);
        }
      }

      // --- Multi-Note Context Injection ---
      if (this.selectedContextNotes.length > 0) {
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

      // --- Vault Brain (RAG) Injection ---
      const canUseRAG = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
      const sessionRAGEnabled = this.vaultBrainToggle ? this.vaultBrainToggle.checked : true;

      if (this.plugin.settings.vaultBrainEnabled && canUseRAG && sessionRAGEnabled) {
        const relevantChunks = await this.plugin.vaultIndexer.search(text);
        if (relevantChunks.length > 0) {
          // Add new chunks to rolling context, avoiding duplicates
          for (const chunk of relevantChunks) {
            if (!this.rollingRAGContext.includes(chunk)) {
              this.rollingRAGContext.push(chunk);
            }
          }
          // Limit buffer size to 12 chunks (keep context manageable but useful)
          if (this.rollingRAGContext.length > 12) {
            this.rollingRAGContext = this.rollingRAGContext.slice(-12);
          }
        }

        if (this.rollingRAGContext.length > 0) {
          ragWasInjected = true;
          if (relevantChunks.length > 0) {
            new Notice(`● Vault Brain: Found ${relevantChunks.length} relevant notes.`);
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
        const formatInfo = this.uploadedDocName?.toLowerCase().endsWith(".pdf") 
          ? "The user has uploaded a PDF. The text below contains structural metadata: [x, y] are normalized coordinates (0-1000), 'size' is font size, and 'bold/italic' are styles.\n\n"
          : "The user has uploaded a document. Its content is:\n\n";
        systemParts.push(`${formatInfo}${this.uploadedDocContent}`);
      }

      msgs = [];
      const isFirstMessage = this.history.length === 1;
      const currentMsg: any = { role: "user", content: text };
      
      if (this.uploadedImages.length > 0) {
        currentMsg.images = [...this.uploadedImages];
        this.uploadedImages = [];
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
    this.handleStreamingResponse(msgs, model, loadingEl, initialSourcePath, ragWasInjected, 0);
  }

  private static readonly MAX_SKILL_DEPTH = 5;

  private async handleStreamingResponse(msgs: any[], model: string, loadingEl: HTMLElement, initialSourcePath: string, suppressVaultSkill = false, skillDepth = 0) {
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
                            
                            if (!bubbleEl) return;
                            
                            if (reasoning) {
                                if (!reasoningEl) {
                                    reasoningEl = bubbleEl.createEl("details", { cls: "horme-reasoning-details" });
                                    reasoningEl.createEl("summary", { text: "Reasoning Process", cls: "horme-reasoning-summary" });
                                }
                                fullReasoning += reasoning;
                                let reasoningBody = reasoningEl.querySelector(".horme-reasoning-body");
                                if (!reasoningBody) reasoningBody = reasoningEl.createDiv("horme-reasoning-body");
                                reasoningBody.textContent = fullReasoning;
                            }

                            if (content) {
                                fullContent += content;
                                // If there was reasoning, ensure the content is outside/after it
                                let contentArea = bubbleEl.querySelector(".horme-content-area");
                                if (!contentArea) contentArea = bubbleEl.createDiv("horme-content-area");
                                contentArea.textContent = fullContent;
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
          // Re-render the final content with Markdown
          const contentArea = bubbleEl.querySelector(".horme-content-area") as HTMLElement;
          if (contentArea) {
              contentArea.empty();
              await MarkdownRenderer.render(this.app, fullContent, contentArea, initialSourcePath || "", this);
          } else {
              // Fallback if only content was received without special area
              bubbleEl.empty();
              if (reasoningEl) bubbleEl.appendChild(reasoningEl);
              const finalArea = bubbleEl.createDiv("horme-content-area");
              await MarkdownRenderer.render(this.app, fullContent, finalArea, initialSourcePath || "", this);
          }
          this.addAssistantActions(bubbleEl, fullContent);
      }

      const finalMsg = fullReasoning ? `> [!thought]\n> ${fullReasoning.replace(/\n/g, "\n> ")}\n\n${fullContent}` : fullContent;
      if (fullContent || fullReasoning) {
          this.history.push({ role: "assistant", content: finalMsg });
          
          // --- Skill Execution Agent Loop ---
          const skillCalls = this.plugin.skillManager.parseSkillCalls(fullContent);
          if (skillCalls.length > 0) {
            for (const call of skillCalls) {
              const skillName = call.skillId;
              const skillLoading = this.showLoading(`Skill: ${skillName}...`);
              const result = await this.plugin.skillManager.executeSkill(call);
              skillLoading.remove();

              // Add the result to history
              this.history.push({ 
                role: "system", 
                content: `RESULT FROM SKILL "${skillName}":\n\n${result}\n\nBased on this result, please continue your response to the user.` 
              });

              // Re-render the "system" message for the user to see what happened (as a technical detail)
              const resultBubble = this.messagesEl.createDiv("horme-msg horme-msg-assistant");
              const details = resultBubble.createEl("details", { cls: "horme-reasoning-details" });
              details.createEl("summary", { text: `Used Skill: ${skillName}`, cls: "horme-reasoning-summary" });
              const body = details.createDiv("horme-reasoning-body");
              body.textContent = result;
              this.scrollToBottom();
            }

            // Prepare the next turn in the loop
            const nextMsgs: any[] = [];
            const effectivePrompt = this.sessionSystemPromptOverride ?? this.plugin.getEffectiveSystemPrompt();
            if (effectivePrompt) nextMsgs.push({ role: "system", content: effectivePrompt });
            
            for (const m of this.history) {
              nextMsgs.push({ role: m.role, content: m.content });
            }

            // Recurse with depth guard
            if (skillDepth >= HormeChatView.MAX_SKILL_DEPTH) {
              new Notice("Horme: Maximum skill depth reached. Stopping skill loop.");
            } else {
              const nextLoading = this.showLoading();
              await this.handleStreamingResponse(nextMsgs, model, nextLoading, initialSourcePath, false, skillDepth + 1);
            }
            return;
          }

          await this.plugin.historyManager.append({
            id: this.conversationId,
            title: this.history.find(m => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
            timestamp: Date.now(),
            messages: this.history
          });
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
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
      navigator.clipboard.writeText(content);
      new Notice("Copied to clipboard");
    });

    const regenBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Regenerate" });
    setIcon(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      bubbleEl.remove();
      wrapper.remove();
      this.sendMessage(true);
    });

    const saveBtn = wrapper.createEl("button", { cls: "horme-save-btn", text: "Save as note" });
    setIcon(saveBtn, "file-plus");
    saveBtn.addEventListener("click", async () => {
      const folder = this.plugin.settings.exportFolder.trim() || "HORME";
      if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
      const baseName = this.uploadedDocName ? this.uploadedDocName.replace(/\.[^.]+$/, "") : "Horme response";
      let fileName = `${folder}/${baseName}.md`;
      if (await this.app.vault.adapter.exists(fileName)) {
        fileName = `${folder}/${baseName} ${new Date().getTime()}.md`;
      }
      await this.app.vault.create(fileName, content);
      new Notice(`Saved as ${fileName}`);
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
  this.messagesEl.empty();
  this.renderEmpty();
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
          await MarkdownRenderer.render(this.app, m.content, bubble, "", this);
          this.addAssistantActions(bubble, m.content);
        } else {
          const contentArea = bubble.querySelector(".horme-content-area") as HTMLElement;
          if (contentArea) contentArea.textContent = m.content;
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
    const actions = header.createDiv("horme-history-actions");
    const backBtn = actions.createEl("button", { cls: "horme-header-btn", text: "Back" });
    backBtn.addEventListener("click", () => this.toggleHistoryPanel());

    const list = panel.createDiv("horme-history-list");
    const convos = await this.plugin.historyManager.load();
    if (!convos.length) { list.createDiv({ cls: "horme-history-empty", text: "No saved conversations" }); return; }
    for (const c of convos) {
      const item = list.createDiv("horme-history-item");
      const info = item.createDiv("horme-history-item-info");
      info.createDiv({ cls: "horme-history-item-title", text: c.title });
      info.createDiv({ cls: "horme-history-item-date", text: new Date(c.timestamp).toLocaleString() });
      info.addEventListener("click", () => this.loadConversation(c));

      const delBtn = item.createDiv("horme-history-item-delete");
      setIcon(delBtn, "trash-2");
      delBtn.title = "Delete conversation";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm("Delete this conversation?")) {
          await this.plugin.historyManager.delete(c.id);
          await this.renderHistoryView();
        }
      });
    }
  }

  private async loadConversation(convo: SavedConversation) {
    this.showingHistory = false;
    this.conversationId = convo.id;
    this.history = convo.messages.map(m => ({ role: m.role as any, content: m.content }));
    this.lastMsgs = null;
    this.lastModel = null;
    await this.renderChatView();
  }

  private scrollToBottom() { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }
  private autoGrow() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 140) + "px";
  }

  private processChunk(line: string, onContent: (c: string, r?: string) => void) {
    const raw = line.trim();
    if (!raw || raw === "data: [DONE]") return;
    try {
      const data = JSON.parse(raw.startsWith("data: ") ? raw.slice(6) : raw);
      const content = data.message?.content || 
                    data.choices?.[0]?.delta?.content || 
                    data.delta?.text || 
                    data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      const reasoning = data.choices?.[0]?.delta?.reasoning_content || 
                        data.message?.reasoning || "";

      if (content || reasoning) onContent(content, reasoning);
    } catch { }
  }
}
