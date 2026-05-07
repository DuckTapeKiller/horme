import {
  App,
  Editor,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  MenuItem,
  Notice,
  Plugin,
  WorkspaceLeaf,
  TFile,
  TAbstractFile,
  requestUrl,
  Platform,
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

// Modals
import { TranslateModal } from "./src/modals/TranslateModal";
import { ConfirmReplaceModal } from "./src/modals/ConfirmReplaceModal";
import { ConversionModal } from "./src/modals/ConversionModal";

// Services
import { PdfService } from "./src/services/PdfService";
import { DocxService } from "./src/services/DocxService";
import { HistoryManager } from "./src/services/HistoryManager";
import { TagService } from "./src/services/TagService";
import { EmbeddingService } from "./src/services/EmbeddingService";
import { VaultIndexer } from "./src/services/VaultIndexer";
import { TagIndexer } from "./src/services/TagIndexer";

// Providers
import { AiGateway } from "./src/providers/AiGateway";

// Views
import { HormeChatView } from "./src/views/HormeChatView";
import { HormeSettingTab } from "./src/views/HormeSettingTab";

// Constants & Types
import { DEFAULT_SETTINGS, VIEW_TYPE, ACTIONS, PROVIDER_MODELS, DEFAULT_SYSTEM_PROMPT } from "./src/constants";
import { HormeSettings, SavedConversation } from "./src/types";

declare var __PDF_WORKER_CODE__: string;

export default class HormePlugin extends Plugin {
  settings: HormeSettings;
  models: string[] = [];
  lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;
  mobileModel: string;
  contextCloudWarningShown: boolean;
  workerUrl: string;
  
  pdfService: PdfService;
  docxService: DocxService;
  historyManager: HistoryManager;
  tagService: TagService;
  embeddingService: EmbeddingService;
  vaultIndexer: VaultIndexer;
  tagIndexer: TagIndexer;
  aiGateway: AiGateway;

  private statusBarItem: HTMLElement | null = null;
  private settingsChangeListeners = new Set<() => void>();
  private tagsCache: { path: string; mtime: number; tags: string[] } | null = null;
  private _mobileProviderOverrideActive = false;
  private _originalProvider: string | null = null;

  onSettingsChange(cb: () => void): () => void {
    this.settingsChangeListeners.add(cb);
    return () => this.settingsChangeListeners.delete(cb);
  }

  async onload() {
    await this.loadSettings();
    
    // Apply Mobile Overrides on startup
    if (Platform.isMobile && this.settings.useMobileOverride) {
      this._originalProvider = this.settings.aiProvider;
      this._mobileProviderOverrideActive = true;
      this.settings.aiProvider = this.settings.mobileProvider;
      const p = this.settings.mobileProvider;
      const m = this.settings.mobileModel;
      if (p === "claude")          this.settings.claudeModel = m;
      else if (p === "gemini")     this.settings.geminiModel = m;
      else if (p === "openai")     this.settings.openaiModel = m;
      else if (p === "groq")       this.settings.groqModel = m;
      else if (p === "openrouter") this.settings.openRouterModel = m;
      else if (p === "lmstudio")   this.settings.lmStudioModel = m;
      else                         this.settings.defaultModel = m;
    }
    
    // PDF extraction worker setup
    const workerBlob = new Blob([__PDF_WORKER_CODE__], { type: 'application/javascript' });
    this.workerUrl = URL.createObjectURL(workerBlob);
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = this.workerUrl;

    // Initialize Services
    this.pdfService = new PdfService(this.app);
    this.docxService = new DocxService();
    this.historyManager = new HistoryManager(this.app);
    this.tagService = new TagService(this.app);
    this.embeddingService = new EmbeddingService(this);
    this.vaultIndexer = new VaultIndexer(this);
    this.tagIndexer = new TagIndexer(this);
    this.aiGateway = new AiGateway(this.settings);

    this.registerView(VIEW_TYPE, (leaf) => new HormeChatView(leaf, this));

    this.addRibbonIcon("cone", "Open Horme chat", () => this.activateChat());

    this.addCommand({
      id: "open-chat",
      name: "Open chat panel",
      callback: () => this.activateChat(),
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


    // --- Vault Brain Auto-Pilot ---
    const indexDebounceMap = new Map<string, number>();
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || !file.path.endsWith(".md")) return;
        
        // Debounce 2 seconds per file
        if (indexDebounceMap.has(file.path)) window.clearTimeout(indexDebounceMap.get(file.path));
        const timeout = window.setTimeout(async () => {
          await this.vaultIndexer.enqueueIndex(file);
          indexDebounceMap.delete(file.path);
        }, 2000);
        indexDebounceMap.set(file.path, timeout);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.path.endsWith(".md")) {
          this.vaultIndexer.enqueueIndex(file);
        }
      })
    );

    this.addSettingTab(new HormeSettingTab(this.app, this));
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.style.display = "none";

    this.models = await this.fetchModels();

    // Initialize lastActiveMarkdownLeaf if a note is already open
    const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    if (activeLeaf) this.lastActiveMarkdownLeaf = activeLeaf;

    this.addCommand({
      id: "suggest-frontmatter-tags",
      name: "Suggest frontmatter tags",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView) || 
                     (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView ? this.lastActiveMarkdownLeaf.view : null);
        const hasFile = Boolean(view?.file);
        if (checking) return hasFile;
        if (hasFile) this.suggestTagsForActiveNote();
        return true;
      },
    });

    this.addCommand({
      id: "convert-note-to-docx",
      name: "Convert active note to DOCX",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView) || 
                     (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView ? this.lastActiveMarkdownLeaf.view : null);
        if (view) {
          if (!checking) this.convertActiveNoteToDocx(view);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "convert-note-to-pdf",
      name: "Convert active note to PDF",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView) || 
                     (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView ? this.lastActiveMarkdownLeaf.view : null);
        if (view) {
          if (!checking) this.convertActiveNoteToPdf(view);
          return true;
        }
        return false;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFile && (file.extension === "md" || file.extension === "pdf")) {
          menu.addItem((item) => {
            item.setTitle("Horme: Convert document format").setIcon("refresh-cw")
              .onClick(() => this.startFileConversion(file));
          });
        }
      })
    );
  }

  onunload() {
    URL.revokeObjectURL(this.workerUrl);
  }

  /* ── Conversion Handlers ── */

  private async convertActiveNoteToDocx(view: MarkdownView) {
    const file = view.file;
    if (!file) return;
    try {
      const buffer = await this.docxService.generateBuffer(view.getViewData());
      await this.saveBinaryFile(file.name.replace(/\.md$/, ".docx"), buffer);
      new Notice(`Note converted to DOCX successfully.`);
    } catch (err: any) {
      this.handleError(err);
    }
  }

  private async convertActiveNoteToPdf(view: MarkdownView) {
    const file = view.file;
    if (!file) return;
    try {
      await this.saveAsPdf(view.getViewData(), file.name);
      new Notice(`Note converted to PDF successfully.`);
    } catch (err: any) {
      this.handleError(err);
    }
  }

  async startFileConversion(file: TFile | File) {
    const fileName = file.name;
    const extension = file instanceof TFile ? file.extension : fileName.split(".").pop()?.toLowerCase();

    const modal = new ConversionModal(this.app, fileName, extension === "md" ? "md" : "pdf", async (targetFormat) => {
      modal.setStarted();
      try {
        if (extension === "pdf") {
          const rawText = await this.pdfService.extractText(file, (p, s) => modal.updateProgress(p, s));
          if (rawText) {
            modal.updateProgress(0.9, "AI is reconstructing document structure...");
            const prompt = `You are a world-class document reconstruction assistant, similar to 'Marker'. 
I will provide you with structural text extracted from a PDF. 
- Coordinates [x, y] are normalized to a 0-1000 scale (0,0 is top-left).
- Font sizes and styles (bold, italic) are provided.
- Pages are marked with '--- PAGE X ---'.

Your Goal: Reconstruct the document into clean, professional Markdown.
- Merge paragraphs and tables that are split across page breaks.
- Identify the logical heading hierarchy (#, ##, ###) based on font size and positioning (e.g., centered large text is likely a Title).
- Format tables using standard Markdown pipe syntax.
- Extract math/equations into LaTeX blocks ($$ ... $$) if they appear in the text.
- REMOVE all coordinate metadata [x:..., y:...] from the final output.
- Return ONLY the clean markdown content.`;

            const reconstructedMd = await this.aiGateway.generate(rawText, prompt);
            
            if (targetFormat === "markdown") {
              await this.saveTextFile(fileName.replace(/\.pdf$/, ".md"), reconstructedMd);
            } else if (targetFormat === "docx") {
              modal.updateProgress(0.95, "Compiling DOCX...");
              const buffer = await this.docxService.generateBuffer(reconstructedMd);
              await this.saveBinaryFile(fileName.replace(/\.pdf$/, ".docx"), buffer);
            }
          }
        } else if (extension === "md") {
          const content = file instanceof TFile ? await this.app.vault.read(file) : await (file as File).text();
          if (targetFormat === "pdf") {
            modal.updateProgress(0.5, "Generating PDF...");
            await this.saveAsPdf(content, fileName);
          } else if (targetFormat === "docx") {
            modal.updateProgress(0.5, "Compiling DOCX...");
            const buffer = await this.docxService.generateBuffer(content);
            await this.saveBinaryFile(fileName.replace(/\.md$/, ".docx"), buffer);
          }
        }
        new Notice(`${fileName} converted successfully.`);
        modal.close();
      } catch (err: any) {
        this.handleError(err);
        modal.close();
      }
    });
    modal.open();
  }

  private async saveTextFile(name: string, content: string) {
    const folder = this.settings.exportFolder.trim() || "HORME";
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
    let path = `${folder}/${name}`;
    if (await this.app.vault.adapter.exists(path)) path = `${folder}/${new Date().getTime()}_${name}`;
    await this.app.vault.create(path, content);
  }

  private async saveBinaryFile(name: string, buffer: Buffer | ArrayBuffer) {
    const folder = this.settings.exportFolder.trim() || "HORME";
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
    let path = `${folder}/${name}`;
    if (await this.app.vault.adapter.exists(path)) path = `${folder}/${new Date().getTime()}_${name}`;
    await this.app.vault.createBinary(path, buffer);
  }

  private async saveAsPdf(markdown: string, originalName: string) {
    const html2pdf = (await import("html2pdf.js")).default;
    const div = document.createElement("div");
    div.style.cssText = `font-family: Inter, sans-serif; font-size: 11pt; padding: 20mm; width: 210mm; background: #fff;`;
    await MarkdownRenderer.render(this.app, markdown, div, "", this);
    document.body.appendChild(div);
    try {
      const blob: Blob = await (html2pdf() as any).from(div).set({
        margin: 10, filename: originalName.replace(/\.md$/, ".pdf"),
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
      }).output("blob");
      await this.saveBinaryFile(originalName.replace(/\.md$/, ".pdf"), await blob.arrayBuffer());
    } finally {
      document.body.removeChild(div);
    }
  }

  /* ── Tagging ── */

  async suggestTagsForActiveNote() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const view = activeView || (this.lastActiveMarkdownLeaf?.view instanceof MarkdownView ? this.lastActiveMarkdownLeaf.view : null);
    const file = view?.file;
    if (!file) { new Notice("Horme: Open a note first."); return; }

    const tags = await this.loadAllowedTags();
    if (!tags.length) { new Notice("Horme: No tags found in vault."); return; }

    const raw = view.getViewData();
    const body = this.tagService.stripFrontmatter(raw);
    const context = `${file.basename}\n\n${body}`;

    // HYBRID APPROACH: Combine Keyword ranking and Semantic ranking
    const keywordCandidates = this.tagService.rankCandidates(context, tags).slice(0, 60);
    const semanticCandidates = await this.tagIndexer.getSemanticCandidates(context, 60);
    
    // Merge and de-duplicate
    const candidates = Array.from(new Set([...keywordCandidates, ...semanticCandidates]));

    const prompt = `You are a professional tagging assistant. 
Return a newline-separated list of tags for the provided note content. 
Prioritize tags from the "Allowed" list below if they fit, but you may suggest new, relevant tags if necessary to accurately describe the note. 
Limit yourself to at most ${this.settings.maxSuggestedTags} tags.

Allowed Tags:
${candidates.map(t => `- ${t}`).join("\n")}`;

    new Notice("Horme: Generating tags…");
    try {
      const response = await this.aiGateway.generate(body, prompt);
      const suggested = response.split("\n")
        .map(t => t.trim().replace(/^#/, ""))
        .filter(t => t.length > 0 && !t.includes(" "));
      
      if (!suggested.length) { new Notice("Horme: No valid tags generated."); return; }

      new ConfirmReplaceModal(this.app, "Add these tags?", suggested.map(t => `#${t}`).join("\n"), async (edited) => {
        const finalTags = edited.split("\n").map(t => t.trim().replace(/^#/, "")).filter(Boolean);
        await this.tagService.applyTags(file, finalTags);
        new Notice("Horme: Tags updated ✓");
      }).open();
    } catch (e) {
      this.handleError(e);
    }
  }

  async loadAllowedTags(): Promise<string[]> {
    const path = this.settings.tagsFilePath.trim();
    if (!path) {
      const tagMap = (this.app.metadataCache as any).getTags?.() || {};
      return Object.keys(tagMap).map(t => t.replace(/^#/, "").toLowerCase());
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        return content
          .split("\n")
          .map(l => l.trim().replace(/^#+/, "").toLowerCase())
          .filter(l => l.length > 0 && !l.startsWith("//"));
    }
    return [];
  }

  /* ── Actions ── */

  private async runAction(editor: Editor, sel: string, sysPrompt: string) {
    new Notice("Horme: Processing…");
    try {
      const result = await this.aiGateway.generate(sel, sysPrompt);
      new ConfirmReplaceModal(this.app, sel, result, (edited) => {
        editor.replaceSelection(edited);
        new Notice("Horme: Done ✓");
      }).open();
    } catch (e) {
      this.handleError(e);
    }
  }

  private buildSubmenu(menu: Menu, editor: Editor, sel: string) {
    for (const a of ACTIONS) {
      menu.addItem(item => {
        item.setTitle(a.title).onClick(() => this.runAction(editor, sel, a.prompt));
      });
    }
    menu.addItem(item => {
      item.setTitle("Translate").onClick(() => {
        new TranslateModal(this.app, (lang) => this.runAction(editor, sel, `Translate to ${lang}:`)).open();
      });
    });
  }

  isLocalProviderActive(): boolean {
    const p = this.settings.aiProvider;
    return p === "ollama" || p === "lmstudio";
  }

  /* ── Core ── */

  async activateChat() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
        // Explicitly try to get the right sidebar leaf
        leaf = this.app.workspace.getRightLeaf(false);
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
    
    this.app.workspace.revealLeaf(leaf);
  }

  async fetchModels(): Promise<string[]> {
    const provider = this.settings.aiProvider;
    try {
      if (provider === "ollama") {
        const res = await fetch(`${this.settings.ollamaBaseUrl}/api/tags`);
        const data = await res.json();
        if (!data.response && data.error) throw new Error(`Ollama: ${data.error}`);
        return data.models?.map((m: any) => m.name) || [];
      } else if (provider === "lmstudio") {
        const res = await requestUrl({ url: `${this.settings.lmStudioUrl}/v1/models` });
        return res.json?.data?.map((m: any) => m.id) || [];
      }
      return PROVIDER_MODELS[provider] || [];
    } catch (e) {
      console.error("Horme: Failed to fetch models", e);
      return [];
    }
  }

  async checkConnection(): Promise<boolean> {
    const p = this.settings.aiProvider;
    try {
      if (p === "ollama") return (await fetch(`${this.settings.ollamaBaseUrl}/api/tags`)).ok;
      if (p === "lmstudio") return (await requestUrl({ url: `${this.settings.lmStudioUrl}/v1/models` })).status === 200;
      
      // Live Cloud Provider Check
      if (p === "openai" && this.settings.openaiApiKey) {
        const res = await requestUrl({
          url: "https://api.openai.com/v1/models",
          headers: { "Authorization": `Bearer ${this.settings.openaiApiKey}` }
        });
        return res.status === 200;
      }
      if (p === "gemini" && this.settings.geminiApiKey) {
        const res = await requestUrl({
          url: `https://generativelanguage.googleapis.com/v1beta/models?key=${this.settings.geminiApiKey}`
        });
        return res.status === 200;
      }
      if (p === "claude" && this.settings.claudeApiKey) {
        const res = await requestUrl({
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: {
            "x-api-key": this.settings.claudeApiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ 
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1, 
            messages: [{ role: "user", content: "hi" }] 
          })
        });
        // We accept 200 or even a 400 (if it's a model mismatch) as "connected" if it's not a 401/403
        return res.status >= 200 && res.status < 401;
      }
      if (p === "groq" && this.settings.groqApiKey) {
        const res = await requestUrl({
          url: "https://api.groq.com/openai/v1/models",
          headers: { "Authorization": `Bearer ${this.settings.groqApiKey}` }
        });
        return res.status === 200;
      }
      if (p === "openrouter" && this.settings.openRouterApiKey) {
        const res = await requestUrl({
          url: "https://openrouter.ai/api/v1/models",
          headers: { "Authorization": `Bearer ${this.settings.openRouterApiKey}` }
        });
        return res.status === 200;
      }

      return false; // No key or failed check
    } catch { return false; }
  }

  handleError(e: any) {
    console.error("Horme Error:", e);
    new Notice(`Horme: ${e.message || "Unknown error"}`);
  }

  getEffectiveSystemPrompt() {
    return this.settings.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  }

  setIndexingStatus(text: string | null) {
    if (!this.statusBarItem) return;
    if (text === null) {
      this.statusBarItem.style.display = "none";
      this.statusBarItem.textContent = "";
    } else {
      this.statusBarItem.style.display = "";
      this.statusBarItem.textContent = `● ${text}`;
      this.statusBarItem.style.color = "var(--text-success)";
    }
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() {
    // If mobile override is active, temporarily restore the original provider
    // before persisting so the override never contaminates saved data.
    if (this._mobileProviderOverrideActive && this._originalProvider !== null) {
      const overriddenProvider = this.settings.aiProvider;
      this.settings.aiProvider = this._originalProvider;
      await this.saveData(this.settings);
      this.settings.aiProvider = overriddenProvider;
    } else {
      await this.saveData(this.settings);
    }
    this.settingsChangeListeners.forEach(cb => cb());
  }
}
