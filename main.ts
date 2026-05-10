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
  TFolder,
  requestUrl,
  Platform,
} from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

// Modals
import { TranslateModal } from "./src/modals/TranslateModal";
import { RewriteModal } from "./src/modals/RewriteModal";
import { ConfirmReplaceModal } from "./src/modals/ConfirmReplaceModal";
import { ConversionModal } from "./src/modals/ConversionModal";
import { HormeErrorModal } from "./src/modals/HormeErrorModal";
import { GenericConfirmModal } from "./src/modals/GenericConfirmModal";

// Services
import { PdfService } from "./src/services/PdfService";
import { DocxService } from "./src/services/DocxService";
import { HistoryManager } from "./src/services/HistoryManager";
import { TagService } from "./src/services/TagService";
import { EmbeddingService } from "./src/services/EmbeddingService";
import { VaultIndexer } from "./src/services/VaultIndexer";
import { TagIndexer } from "./src/services/TagIndexer";
import { SkillManager } from "./src/services/SkillManager";
import { GrammarIndexer } from "./src/services/GrammarIndexer";
import { DiagnosticService } from "./src/services/DiagnosticService";

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
  skillManager: SkillManager;
  grammarIndexer: GrammarIndexer;
  diagnosticService: DiagnosticService;

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
    this.diagnosticService = new DiagnosticService(this);
    this.pdfService = new PdfService(this.app);
    this.docxService = new DocxService();
    this.historyManager = new HistoryManager(this);
    this.tagService = new TagService(this.app);
    this.embeddingService = new EmbeddingService(this);
    this.grammarIndexer = new GrammarIndexer(this);
    this.vaultIndexer = new VaultIndexer(this);
    this.tagIndexer = new TagIndexer(this);
    this.skillManager = new SkillManager(this);
    this.aiGateway = new AiGateway(this);

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
          this.runAction(editor, sel, a.prompt, a.id);
        },
      });
    }

    // Rewrite (with tone picker)
    this.addCommand({
      id: "rewrite",
      name: "Rewrite",
      editorCallback: (editor: Editor) => {
        const sel = editor.getSelection();
        if (!sel) { new Notice("Horme: Select some text first."); return; }
        new RewriteModal(this.app, (tone) => {
          const prompt = `Rewrite the following text in a ${tone} tone. Preserve the original meaning. Return only the rewritten text.`;
          this.runAction(editor, sel, prompt, "rewrite");
        }).open();
      },
    });

    // Generate frontmatter summary
    this.addCommand({
      id: "generate-summary",
      name: "Generate frontmatter summary",
      callback: () => this.generateFrontmatterSummary(),
    });

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
    
    // Load indexes
    await this.grammarIndexer.loadIndex();
    
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

    // LIVE NOTE TRACKING: Ensure Horme always knows which note is active for Tagging/Context
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastActiveMarkdownLeaf = leaf;
        }
      })
    );
  }

  onunload() {
    URL.revokeObjectURL(this.workerUrl);
    this.vaultIndexer?.flush();
    this.historyManager?.flush();
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

    // Use editor.getValue() to support Editing/Live Preview unsaved content
    const raw = view.editor ? view.editor.getValue() : view.getViewData();
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

  private async runAction(editor: Editor, sel: string, sysPrompt: string, actionId?: string) {
    new Notice("Horme: Thinking…");
    try {
      let messages = [
        { role: "user", content: sel }
      ];

      // Skill Bypass: These actions should never use skills and should be fast.
      const skipSkills = actionId === "summarize" || actionId === "beautify" || actionId === "translate";

      if (skipSkills) {
        // Robust prompt for translate to ensure clean results
        const finalPrompt = actionId === "translate" ? 
          `${sysPrompt} Return ONLY the translated text with no preamble or explanation.` : 
          sysPrompt;
          
        const response = await this.aiGateway.generate(messages, finalPrompt);
        new ConfirmReplaceModal(this.app, sel, response, (edited) => {
          editor.replaceSelection(edited);
          new Notice("Horme: Done ✓");
        }).open();
        return;
      }

      // Language-aware grammar injection: tell the model when to use grammar manuals
      let effectivePrompt = sysPrompt;
      if ((actionId === "proofread" || actionId === "rewrite") && this.grammarIndexer.chunks.length > 0) {
        const lang = this.settings.grammarLanguage || "Español";
        effectivePrompt += `\n\nCRITICAL: You have access to the user's ${lang} grammar manuals via the "spanish_scholar" skill. `
          + `If the text below is written in ${lang}, you MUST call the spanish_scholar skill with any non-obvious constructions, `
          + `false cognates, or orthotypographic details before making corrections. `
          + `If the text is written in a different language, do NOT use the grammar skill — rely on your general knowledge.`;
      }

      // Fact-check injection: force Wikipedia verification for every claim
      if (actionId === "fact-check") {
        effectivePrompt += `\n\nCRITICAL INSTRUCTIONS FOR FACT-CHECKING:`
          + `\n1. Extract EACH verifiable factual claim from the text (dates, names, events, statistics, scientific facts).`
          + `\n2. For EACH claim, you MUST call the wikipedia skill to verify it. Do NOT rely on your training data alone.`
          + `\n3. If the text is in Spanish, use {"language": "es"} for better coverage. Use "en" for English text.`
          + `\n4. You may call the wikipedia skill MULTIPLE TIMES — once per claim or group of related claims.`
          + `\n5. Format your final response as:`
          + `\n\n**Claim:** [the exact claim from the text]`
          + `\n**Verdict:** ✅ Accurate / ❌ Inaccurate / ⚠️ Unverifiable`
          + `\n**Source:** [relevant Wikipedia excerpt]`
          + `\n**Note:** [brief explanation of match or discrepancy]`
          + `\n\nRepeat for each claim. End with an overall assessment.`;
      }

      let skillIterations = 0;
      const MAX_SKILL_ITERATIONS = 5;
      while (true) {
        if (skillIterations++ >= MAX_SKILL_ITERATIONS) {
          new Notice("Horme: Maximum skill iterations reached.");
          break;
        }

        // Use non-streaming generation for context-menu actions
        // PASS THE ENTIRE HISTORY so the model doesn't lose context after a skill call
        const response = await this.aiGateway.generate(
          messages, 
          effectivePrompt
        );

        const skillCalls = this.skillManager.parseSkillCalls(response);
        if (skillCalls.length === 0) {
          // Final result
          new ConfirmReplaceModal(this.app, sel, response, (edited) => {
            editor.replaceSelection(edited);
            new Notice("Horme: Done ✓");
          }).open();
          break;
        }

        // Execute skills
        messages.push({ role: "assistant", content: response });
        for (const call of skillCalls) {
          new Notice(`Horme Skill: ${call.skillId}...`);
          const result = await this.skillManager.executeSkill(call);
          messages.push({ 
            role: "system", 
            content: `RESULT FROM SKILL "${call.skillId}":\n\n${result}\n\nBased on this, finish your task.` 
          });
        }
        
        // Loop continues to feed the result back to the model
        new Notice("Horme: Processing skill results...");
      }
    } catch (e) {
      this.handleError(e);
    }
  }

  async generateFrontmatterSummary() {
    const file = this.app.workspace.getActiveFile();
    if (!file || !file.path.endsWith(".md")) {
      new Notice("Horme: Open a markdown note first.");
      return;
    }

    const field = this.settings.summaryField || "summary";
    const lang = this.settings.summaryLanguage || "Español";

    new Notice("Horme: Generating summary...");

    try {
      const fullContent = await this.app.vault.read(file);

      // Strip frontmatter for the AI prompt.
      // \r?\n matches both LF and CRLF so the YAML block is always removed before
      // the text is sent to the AI, even on Windows or with CRLF-synced vaults.
      const bodyContent = fullContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (bodyContent.length < 50) {
        new Notice("Horme: Note is too short to summarise.");
        return;
      }

      const prompt = `Summarise the following note in ${lang}. Write a concise 1-2 sentence summary that captures the core topic and key points. Return ONLY the summary text — no quotes, no formatting, no explanation.`;
      const summary = (await this.aiGateway.generate(bodyContent.slice(0, 6000), prompt)).trim();

      if (!summary) {
        new Notice("Horme: AI returned an empty summary.");
        return;
      }

      // Parse existing frontmatter.
      // \r?\n handles both LF (Mac/Linux) and CRLF (Windows / some sync tools).
      const fmMatch = fullContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

      // The literal field value we will write (e.g. `Resumen: "..."`)
      const fieldValue = `${field}: "${summary.replace(/"/g, '\\"')}"`;

      let newContent: string;

      if (fmMatch) {
        const fmBlock = fmMatch[1];
        // Escape regex special chars in the user-chosen field name (e.g. "my.field")
        const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const fieldRegex = new RegExp(`^${escapedField}:.*$`, "m");
        const existingMatch = fmBlock.match(fieldRegex);

        // Use slice instead of String.replace() for the outer substitution to avoid
        // $& / $1 / $` interpolation corrupting content that contains a "$".
        const fmEndIndex = fmMatch[0].length;
        const afterFm = fullContent.slice(fmEndIndex);

        if (existingMatch) {
          const oldSummary = existingMatch[0].replace(`${field}:`, "").trim().replace(/^["'']|["'']$/g, "");
          new GenericConfirmModal(this.app, `Overwrite existing ${field}?\n\nOld: ${oldSummary}\n\nNew: ${summary}`, async () => {
            const updatedFm = fmBlock.replace(fieldRegex, () => fieldValue);
            const finalContent = `---\n${updatedFm}\n---\n${afterFm}`;
            await this.app.vault.modify(file, finalContent);
            new Notice(`Horme: Summary updated in "${field}" field.`);
          }).open();
          return;
        } else {
          // Field doesn't exist yet — append it to the existing frontmatter block
          const updatedFm = fmBlock + `\n${fieldValue}`;
          newContent = `---\n${updatedFm}\n---\n${afterFm}`;
        }
      } else {
        // No frontmatter at all — create one with the user's chosen field name
        newContent = `---\n${fieldValue}\n---\n${fullContent}`;
      }

      await this.app.vault.modify(file, newContent);
      new Notice(`Horme: Summary added to "${field}" field.`);
    } catch (e) {
      console.error("Horme: Summary generation error", e);
      this.diagnosticService.report("Summary", `Generation failed: ${e.message}`);
      new Notice("Horme: Failed to generate summary.");
    }
  }

  private buildSubmenu(menu: Menu, editor: Editor, sel: string) {
    for (const a of ACTIONS) {
      menu.addItem(item => {
        item.setTitle(a.title).onClick(() => this.runAction(editor, sel, a.prompt, a.id));
      });
    }
    menu.addItem(item => {
      item.setTitle("Rewrite").onClick(() => {
        new RewriteModal(this.app, (tone) => {
          const prompt = `Rewrite the following text in a ${tone} tone. Preserve the original meaning. Return only the rewritten text.`;
          this.runAction(editor, sel, prompt, "rewrite");
        }).open();
      });
    });
    menu.addItem(item => {
      item.setTitle("Translate").onClick(() => {
        new TranslateModal(this.app, (lang) => this.runAction(editor, sel, `Translate to ${lang}:`, "translate")).open();
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
      const fetchedModels = provider === "ollama" ? 
        (await (await fetch(`${this.settings.ollamaBaseUrl}/api/tags`)).json()).models?.map((m: any) => m.name) || [] :
        provider === "lmstudio" ?
        (await requestUrl({ url: `${this.settings.lmStudioUrl}/v1/models` })).json?.data?.map((m: any) => m.id) || [] :
        PROVIDER_MODELS[provider] || [];
      
      this.models = fetchedModels;
      return fetchedModels;
    } catch (e) {
      console.error("Horme: Failed to fetch models", e);
      this.diagnosticService.report("Provider", `Failed to fetch models: ${e.message}`, "warning");
      this.models = PROVIDER_MODELS[provider] || [];
      return this.models;
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
            model: this.settings.claudeModel,
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

  handleError(e: any, context?: string) {
    console.error("Horme Error:", e);
    const title = context || "Something went wrong";
    const message = e.message || "An unknown error occurred.";
    new HormeErrorModal(this.app, title, message).open();
  }

  async getEffectiveSystemPrompt(): Promise<string> {
    const path = this.settings.systemPromptPath.trim();
    if (path) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          const content = await this.app.vault.read(file);
          if (content.trim()) return content;
        } catch (e) {
          console.error("Horme: Failed to read system prompt note", e);
        }
      }
    }
    return DEFAULT_SYSTEM_PROMPT;
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

  private async addPresetFromFile(file: TFile, presets: Array<{ name: string; prompt: string }>, seenPaths: Set<string>) {
    if (seenPaths.has(file.path)) return;
    try {
      const content = await this.app.vault.read(file);
      presets.push({
        name: file.basename,
        prompt: content.trim()
      });
      seenPaths.add(file.path);
    } catch (e) {
      console.error(`Horme: Failed to read preset note ${file.path}`, e);
    }
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
