import { ChatPictures } from "./chat/ChatPictures";
import { replyLanguage } from "../utils/replyLanguage";
import { VAULT_NOTHING, VAULT_NOTHING_ES, normaliseVaultNotice } from "../utils/vaultNotice";
import { fitPassages, fitText, passageBudget, roundBudget } from "../utils/contextBudget";
import { explainContextOverflow } from "../utils/contextOverflow";
import { ChatContextSelection } from "./chat/ChatContextSelection";
import {
  ToolCallAssembler,
  cleanAndConsolidateMsgs,
  formatSkillSummary,
  stepSummary,
  pastCall,
  repeatsEarlierCall,
  repeatsEarlierResult,
  unwrapQuotedAnswer,
  type PastCall,
  skillFailed,
  processChunk,
  streamError,
  stripSkillCallXml,
  throttledRender,
} from "../utils/chatStream";
import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  normalizePath,
  MarkdownView,
  setIcon,
  Notice,
  TFile,
  TFolder,
  Menu,
  Platform,
  setTooltip,
} from "obsidian";
import HormePlugin from "../../main";
import { providerInfo, providerModel } from "../providers/registry";
import { chatProviderChoices, type ProviderChoice } from "./settings/providers";
import { VIEW_TYPE } from "../constants";
import { ChatMessage, SavedConversation } from "../types";
import { SkillCall } from "../skills/types";
import { NotePickerModal } from "../modals/NotePickerModal";
import { FolderPickerModal } from "../modals/FolderPickerModal";
import { GenericConfirmModal } from "../modals/GenericConfirmModal";
import { ensureVaultFolder } from "../utils/vaultFolder";
import { passageNotePath } from "../utils/passages";
import { groundedShare, namesOutsideSource, notesUsed, titleNamesQuestion } from "../utils/grounding";
import {
  CitedSource,
  SourcePill,
  linkCitations,
  mergePills,
  parseResearchSources,
  dropDanglingCitations,
  pillsForAnswer,
  pillsFromSkillResult,
} from "../utils/citations";
import { imagesSummary, imagesToMarkdown, imagesFromSkillResult, withoutImageData } from "../utils/images";
import { sourceReady } from "../services/ImageSearch";
import { onlyAsksForPictures, pictureRequest } from "../utils/pictureRequest";

const SKILL_PLACEHOLDERS: Record<string, string> = {
  fetch_and_summarise: "Paste URL to summarise...",
  wikipedia: "Type name, concept, or historical event to look up...",
  ddg_search: "Type search query or claim to verify live...",
  wiktionary: "Type a specific word to inspect layout or definition...",
  vault_links: "Type topic or content snippet to map related notes...",
  find_image: "Type what to show, e.g. Roman Colosseum...",
};

/**
 * Skills that answer from the vault: their sources are notes, listed as such.
 * An address inside a note they return (a JSTOR link in a property) is not a
 * source of the answer, so it gives no pill.
 */
const VAULT_SKILLS = new Set(["vault_query", "vault_links", "grammar_scholar"]);

export class HormeChatView extends ItemView {
  /** Picture cards and saving pictures to the vault. */
  private readonly pictures: ChatPictures;
  /** Notes and folders picked to go with the next questions. */
  private readonly context: ChatContextSelection;

  plugin: HormePlugin;
  private history: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private providerButton!: HTMLButtonElement;
  private modelButton!: HTMLButtonElement;
  private contextToggle!: HTMLInputElement;
  private contextNoteLabel!: HTMLElement;
  private connectionDot!: HTMLElement;
  private presetButton!: HTMLButtonElement;
  private isGenerating = false;
  private generationEpoch = 0;
  /** Pictures already drawn for the current message, so a second skill does not repeat one. */
  private shownImageUrls = new Set<string>();
  /** Set when this message's Vault Brain search found nothing; the answer opens by saying so. */
  private turnVaultNothing = false;
  /** The vault passages sent with this message; skill follow-up rounds are not given them again. */
  private turnPassages = "";
  private lastTurnPassages = "";
  /** The notes listed for this message; a skill round after it is not given them again. */
  private turnSources: string[] = [];
  private lastTurnSources: string[] = [];
  /** turnVaultNothing of the request kept for Regenerate. */
  private lastVaultNothing = false;
  /** False once the user scrolls up during a reply, so the view stops pulling them down. */
  private followOutput = true;
  /** Latest Markdown render per element (see renderMarkdownInto). */
  private renderSeq = new WeakMap<HTMLElement, number>();
  private showingHistory = false;
  private unregisterSettingsListener: (() => void) | null = null;
  private documentClickHandler: (() => void) | null = null;
  private sessionSystemPromptOverride: string | null = null;
  private availableModels: string[] = [];
  /** The provider the model menu was last filled for. */
  private modelsProvider: string | null = null;
  private availablePresets: Array<{ name: string; prompt: string }> = [];

  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private activeAbortController: AbortController | null = null;
  private lastMsgs: ChatMessage[] | null = null;
  private lastModel: string | null = null;
  /** The provider the last request went to; Regenerate is refused after a switch. */
  private lastProvider: string | null = null;
  /** True while a message is being prepared (context, consent, RAG) before streaming starts. */
  private sendInFlight = false;
  private conversationId: string = this.generateId();
  private uploadedDocContent: string | null = null;
  private uploadedDocName: string | null = null;
  private uploadedImages: string[] = [];
  private uploadedAudio: string | null = null;
  private rollingRAGContext: string[] = [];
  /** Exact RAG passages injected on the most recent turn (reused on Regenerate). */
  private lastInjectedPassages = "";
  private contextNotesLabel!: HTMLElement;
  private vaultBrainToggle!: HTMLInputElement;
  /** The user unticked "Use Vault Brain" themself; it stays off until they tick it again. */
  private vaultBrainOffByUser = false;
  private vaultBrainLabel!: HTMLElement;
  private forcedSkillId: string | null = null;
  private skillsMenuEl: HTMLElement | null = null;
  private activeLoadingIntervals: Set<number> = new Set();
  private connectionPollId: number | null = null;

  private pickImage(): void {
    const fileInput = activeDocument.body.createEl("input", { type: "file" });
    fileInput.accept = "image/*";
    fileInput.hide();

    const cleanup = () => {
      fileInput.remove();
      window.removeEventListener("focus", onWindowFocus);
    };
    const onWindowFocus = () => window.setTimeout(cleanup, 500);
    window.addEventListener("focus", onWindowFocus, { once: true });

    fileInput.addEventListener("change", () => {
      window.removeEventListener("focus", onWindowFocus);
      const file = fileInput.files?.[0];
      if (!file) {
        fileInput.remove();
        return;
      }

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
          this.uploadedImages = this.uploadedImages.filter((i) => i !== base64);
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
    this.pictures = new ChatPictures(plugin, () => this.scrollToBottom());
    this.context = new ChatContextSelection(plugin.app, plugin);
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

  // Lucide icon for each built-in skill (used in menu, loading, and result box)
  private static readonly SKILL_ICONS: Record<string, string> = {
    wikipedia: "book-marked",
    ddg_search: "binoculars",
    wiktionary: "book-a",
    vault_links: "cable",
    vault_query: "folder-search",
    grammar_scholar: "signature",
    date_calc: "calendar",
    find_image: "image",
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
      "find_image",
      "fetch_and_summarise", // ◈ Forces the skill to run in Direct Mode and bypass Vault Brain entirely
    ]);

    for (const skill of allSkills) {
      const isForced = FORCED_EXECUTION_IDS.has(skill.id) || skill.id.startsWith("custom_");

      const item = this.skillsMenuEl.createDiv({ cls: "horme-skills-menu-item" });

      const iconEl = item.createSpan({ cls: "horme-skills-menu-item-icon" });
      setIcon(iconEl, this.getSkillIcon(skill.id));

      item.createSpan({ cls: "horme-skills-menu-item-name", text: skill.name });
      item.createSpan({ cls: "horme-skills-menu-item-desc", text: skill.description });

      // Visual badge: forced skills show "Direct" (bypasses model), template skills show "Template"
      item.createSpan({
        cls: `horme-skills-menu-item-badge ${isForced ? "is-direct" : "is-template"}`,
        text: isForced ? "Direct" : "Template",
      });

      item.addEventListener("click", () => {
        if (this.isGenerating) {
          new Notice("Horme: Cannot change skill mode while generating.");
          return;
        }
        this.skillsMenuEl!.classList.add("horme-skills-menu-hidden");

        // 🟢 Clear any existing skill state to ensure mutual exclusivity before applying new selection
        this.forcedSkillId = null;
        this.inputEl.value = "";
        this.inputEl.placeholder = "Ask Horme…";
        this.containerEl.querySelector(".horme-skill-pill")?.remove();
        this.autoGrow?.();

        if (isForced) {
          // ARM the skill for direct execution on next send.
          this.forcedSkillId = skill.id;
          this.showArmedSkillPill(skill.name, skill.id);

          // Update placeholder text dynamically
          this.inputEl.placeholder = SKILL_PLACEHOLDERS[skill.id] || "Type required input for this skill...";
          this.inputEl.focus();
        } else {
          // TEMPLATE mode: insert a starter phrase; the model handles the skill call normally.
          const templates: Record<string, string> = {
            date_calc: "Calculate the time between ",
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
        text: "No skills available.",
      });
    }
  }

  private showArmedSkillPill(skillName: string, skillId: string) {
    // Remove any existing pill first
    this.containerEl.querySelector(".horme-skill-pill")?.remove();

    const inputWrapper = this.inputEl.parentElement!;
    const pill = inputWrapper.createDiv({ cls: "horme-skill-pill" });

    const iconEl = pill.createSpan({ cls: "horme-skill-pill-icon" });
    setIcon(iconEl, this.getSkillIcon(skillId));

    pill.createSpan({ text: skillName });

    const dismiss = pill.createEl("button", { cls: "horme-skill-pill-dismiss", text: "×" });
    dismiss.title = "Disarm skill";
    dismiss.addEventListener("click", () => {
      this.forcedSkillId = null;
      this.inputEl.placeholder = "Ask Horme…"; // Revert placeholder text
      pill.remove();
    });

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

      /* Header: what answers, then the chat's own tools, then what it reads. */
      const header = content.createDiv("horme-header");

      // Row 1: the provider and its model.
      const row0 = header.createDiv("horme-header-row");
      this.connectionDot = row0.createDiv("horme-connection-icon");
      setIcon(this.connectionDot, "cone");
      const selectsWrap = row0.createDiv("horme-header-selects");

      this.providerButton = selectsWrap.createEl("button", { cls: "horme-select horme-provider-select" });
      this.providerButton.type = "button";
      this.providerButton.addEventListener("click", () => {
        if (this.isGenerating) {
          new Notice("Horme: Cannot change provider while generating.");
          return;
        }
        this.openProviderMenu();
      });

      this.modelButton = selectsWrap.createEl("button", { cls: "horme-select horme-model-select" });
      this.modelButton.type = "button";
      this.modelButton.addEventListener("click", () => {
        if (this.isGenerating) {
          new Notice("Horme: Cannot change model while generating.");
          return;
        }
        this.openModelMenu();
      });

      const refreshBtn = row0.createEl("button", {
        cls: "horme-header-btn horme-icon-btn",
        attr: { "aria-label": "Refresh the model list" },
      });
      setIcon(refreshBtn, "refresh-cw");
      refreshBtn.addEventListener("click", () => {
        void this.refreshModels().catch((e) => this.plugin.handleError(e, "Models"));
      });

      // Row 2: the chat's own tools.
      const row1 = header.createDiv("horme-header-row horme-header-row-actions");
      const row1Left = row1.createDiv("horme-header-actions-left");
      const row1Right = row1.createDiv("horme-header-actions-right");

      this.presetButton = row1Left.createEl("button", { cls: "horme-select horme-preset-select" });
      this.presetButton.type = "button";
      this.presetButton.addEventListener("click", () => {
        if (this.isGenerating) {
          new Notice("Horme: Cannot change preset while generating.");
          return;
        }
        this.openPresetMenu();
      });
      await this.refreshPresets();

      // Skills dropdown trigger button
      const skillsBtn = row1Left.createEl("button", { cls: "horme-select horme-skills-select" });
      skillsBtn.type = "button";
      this.setSelectLabel(skillsBtn, "Skills");

      // Build the floating menu attached to the view container (hidden by default)
      this.skillsMenuEl = this.containerEl.createDiv({ cls: "horme-skills-menu horme-skills-menu-hidden" });
      this.buildSkillsMenu();

      skillsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.isGenerating) {
          new Notice("Horme: Cannot change skill mode while generating.");
          return;
        }
        const isHidden = this.skillsMenuEl!.classList.contains("horme-skills-menu-hidden");
        if (isHidden) {
          this.skillsMenuEl!.classList.remove("horme-skills-menu-hidden");
          const rect = skillsBtn.getBoundingClientRect();
          const containerRect = this.containerEl.getBoundingClientRect();
          const menuWidth = 300;

          let left = rect.left - containerRect.left;
          // If menu would overflow container on the right, align its right edge to the button's right edge
          if (left + menuWidth > containerRect.width) {
            left = rect.right - containerRect.left - menuWidth;
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

      const newChatBtn = row1Right.createEl("button", {
        cls: "horme-header-btn horme-icon-btn",
        attr: { "aria-label": "New chat" },
      });
      setIcon(newChatBtn, "message-square-plus");
      newChatBtn.addEventListener("click", () => {
        void this.clearChat().catch((e) => this.plugin.handleError(e));
      });

      const historyBtn = row1Right.createEl("button", {
        cls: "horme-header-btn horme-icon-btn",
        attr: { "aria-label": "Chat history" },
      });
      setIcon(historyBtn, "history");
      historyBtn.addEventListener("click", () => {
        void this.toggleHistoryPanel().catch((e) => this.plugin.handleError(e));
      });

      const exportBtn = row1Right.createEl("button", {
        cls: "horme-header-btn horme-icon-btn",
        attr: { "aria-label": "Save the whole chat as a note" },
      });
      setIcon(exportBtn, "download");
      exportBtn.addEventListener("click", () => {
        void this.exportConversation().catch((e) => this.plugin.handleError(e));
      });

      // Tags and Summary work on the open note, not on the chat.
      const moreBtn = row1Right.createEl("button", {
        cls: "horme-header-btn horme-icon-btn",
        attr: { "aria-label": "More actions" },
      });
      setIcon(moreBtn, "more-horizontal");
      moreBtn.addEventListener("click", () => this.openMoreMenu(moreBtn));

      // Row 3: what the chat reads besides the question.
      const row2 = header.createDiv("horme-header-row horme-header-row-context");
      row2.createSpan({ cls: "horme-header-label", text: "Context" });

      const label = row2.createEl("label", { cls: "horme-context-toggle" });
      setTooltip(label, "Send the open note with each message");
      this.contextToggle = label.createEl("input", { type: "checkbox" });
      label.createSpan({ text: "Open note" });

      const vbLabel = row2.createEl("label", { cls: "horme-context-toggle" });
      setTooltip(vbLabel, "Look up passages in the whole vault for each question");
      this.vaultBrainToggle = vbLabel.createEl("input", { type: "checkbox" });
      this.vaultBrainToggle.checked = true;
      this.vaultBrainToggle.addEventListener("change", () => {
        this.vaultBrainOffByUser = !this.vaultBrainToggle.checked;
      });
      vbLabel.createSpan({ text: "Vault Brain" });
      this.vaultBrainLabel = vbLabel;
      await this.updateVaultBrainToggle();

      const addNotesBtn = row2.createEl("button", {
        cls: "horme-header-btn",
        text: "+ Notes",
        attr: { "aria-label": "Add up to 5 notes as context" },
      });
      addNotesBtn.addEventListener("click", () => {
        if (this.context.notes.length >= 5) {
          new Notice("Horme: Maximum 5 context notes.");
          return;
        }
        new NotePickerModal(this.app, (file) => {
          if (this.context.notes.some((f) => f.path === file.path)) {
            new Notice(`Already added: ${file.basename}`);
            return;
          }
          if (this.context.notes.length >= 5) {
            new Notice("Horme: Maximum 5 context notes.");
            return;
          }
          this.context.notes.push(file);
          this.updateContextNotesLabel();
        }).open();
      });
      const addFoldersBtn = row2.createEl("button", {
        cls: "horme-header-btn",
        text: "+ Folders",
        attr: { "aria-label": "Add a folder's notes as context" },
      });
      addFoldersBtn.addEventListener("click", () => {
        new FolderPickerModal(this.app, (folder: TFolder) => {
          try {
            this.addContextFolder(folder);
          } catch (e: unknown) {
            this.plugin.handleError(e, "Folders");
          }
        }).open();
      });

      this.contextNoteLabel = header.createDiv("horme-context-note-label");
      this.contextNotesLabel = header.createDiv("horme-context-note-label");
      this.contextToggle.addEventListener("change", () => {
        if (
          this.contextToggle.checked &&
          !this.plugin.isLocalProviderActive() &&
          !this.plugin.settings.contextCloudWarningShown
        ) {
          const provider = providerInfo(this.plugin.settings.aiProvider).name;
          new GenericConfirmModal(
            this.app,
            `Privacy notice: Your current note's full text will be sent to ${provider}, a cloud provider. The content will leave your device. Do you want to continue?`,
            () => {
              this.plugin.settings.contextCloudWarningShown = true;
              this.updateContextNoteLabel();
              void this.plugin.saveSettings().catch((e) => this.plugin.handleError(e));
            },
            () => {
              this.contextToggle.checked = false;
              this.updateContextNoteLabel();
            },
          ).open();
        } else {
          this.updateContextNoteLabel();
        }
      });

      this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContextNoteLabel()));

      /* Messages */
      this.loadingOverlay = this.containerEl.createDiv("horme-loading-overlay");
      this.loadingOverlay.hide();

      this.loadingOverlay.createDiv("horme-spinner");
      this.messagesEl = content.createDiv("horme-messages");
      // Scrolling up while a reply streams stops the view following it; coming
      // back to the bottom resumes. Wheel and touch catch the intent at once.
      const messagesEl = this.messagesEl;
      this.registerDomEvent(messagesEl, "scroll", () => {
        this.followOutput = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
      });
      this.registerDomEvent(messagesEl, "wheel", (e: WheelEvent) => {
        if (e.deltaY < 0) this.followOutput = false;
      });
      this.registerDomEvent(messagesEl, "touchmove", () => {
        if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight >= 40)
          this.followOutput = false;
      });
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
        // isComposing: the Enter that confirms a Japanese, Chinese or Korean
        // candidate must not send a half-typed message.
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          void this.sendMessage().catch((err) => this.plugin.handleError(err, "Chat"));
        }
      });

      const actionRow = inputContainer.createDiv("horme-input-actions");

      const uploadBtn = actionRow.createEl("button", { cls: "horme-upload-btn" });
      setIcon(uploadBtn, "paperclip");
      uploadBtn.title = "Upload document";
      uploadBtn.addEventListener("click", () => {
        try {
          this.pickDocument();
        } catch (err: unknown) {
          this.plugin.handleError(err, "Upload");
        }
      });

      const imageBtn = actionRow.createEl("button", { cls: "horme-image-btn" });
      setIcon(imageBtn, "image");
      imageBtn.title = "Upload image";
      imageBtn.addEventListener("click", () => {
        try {
          this.pickImage();
        } catch (err: unknown) {
          this.plugin.handleError(err, "Upload");
        }
      });

      actionRow.createDiv("horme-input-spacer");

      this.sendBtn = actionRow.createEl("button", { cls: "horme-send-btn" });
      setIcon(this.sendBtn, "send");
      this.sendBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (this.isGenerating) void this.stopGeneration();
        else void this.sendMessage().catch((err) => this.plugin.handleError(err, "Chat"));
      });

      this.unregisterSettingsListener = this.plugin.onSettingsChange(() => {
        void (async () => {
          if (this.presetButton) await this.refreshPresets();
          // A model or provider changed in the settings (or by sync) showed here
          // only after the chat was reopened.
          if (this.plugin.settings.aiProvider !== this.modelsProvider) await this.refreshModels();
          else this.showModelLabel();
          await this.updateVaultBrainToggle();
        })();
      });

      await this.refreshModels();

      // Mobile keyboard fix: anchor input to keyboard
      const getDrawer = () => this.containerEl.closest(".workspace-drawer");
      this.inputEl.addEventListener("focus", () => {
        getDrawer()?.classList.add("horme-keyboard-open");
        window.setTimeout(() => {
          this.inputEl.scrollIntoView({ behavior: "smooth", block: "end" });
          this.scrollToBottom();
        }, 300);
      });
      this.inputEl.addEventListener("blur", () => {
        window.setTimeout(() => {
          getDrawer()?.classList.remove("horme-keyboard-open");
        }, 100);
      });

      await this.updateConnectionStatus();
      this.connectionPollId = window.setInterval(() => {
        void this.updateConnectionStatus();
      }, 15000);
    } catch (e: unknown) {
      this.plugin.handleError(e, "Chat Interface");
    }
  }

  async onClose() {
    this.generationEpoch++;
    void this.stopGeneration();
    if (this.connectionPollId !== null) {
      window.clearInterval(this.connectionPollId);
      this.connectionPollId = null;
    }
    // Flush any pending history write before the view is destroyed
    await this.plugin.historyManager.flush();
    this.unregisterSettingsListener?.();
    // Clean up global listener to prevent leak on repeated open/close
    if (this.documentClickHandler) {
      activeDocument.removeEventListener("click", this.documentClickHandler);
      this.documentClickHandler = null;
    }
    // Deterministically clear all loading chronometer intervals.
    // The old MutationObserver approach leaked because contentEl.empty()
    // removes the parent, not the child, so the observer never fired.
    for (const id of this.activeLoadingIntervals) {
      window.clearInterval(id);
    }
    this.activeLoadingIntervals.clear();
    this.contentEl.empty();
  }

  private updateContextNoteLabel() {
    if (!this.contextToggle.checked) {
      this.contextNoteLabel.empty();
      this.contextNoteLabel.hide();
      return;
    }
    this.contextNoteLabel.show();
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
      this.plugin.settings.vaultBrainEnabled &&
      (this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG);
    const hasIndex = canUseBySettings ? await this.plugin.vaultIndexer.hasBuiltIndex() : false;
    const canUse = canUseBySettings && hasIndex;
    this.vaultBrainLabel.setCssProps({ display: canUse ? "" : "none" });
    // Off while it cannot be used (a cloud provider without consent, no
    // index); back on as soon as it can, unless the user turned it off.
    this.vaultBrainToggle.checked = canUse && !this.vaultBrainOffByUser;
  }

  private addContextFolder(folder: TFolder): void {
    this.context.addFolder(folder);
    this.updateContextNotesLabel();
  }

  private updateContextNotesLabel() {
    this.contextNotesLabel.empty();
    if (this.context.notes.length === 0 && this.context.folders.length === 0) {
      this.contextNotesLabel.removeClass("horme-context-notes-shown");
      return;
    }
    this.contextNotesLabel.addClass("horme-context-notes-shown");

    for (const folder of this.context.folders) {
      const row = this.contextNotesLabel.createDiv("horme-context-notes-row");

      const removeBtn = row.createSpan({ text: "\u00d7", cls: "horme-context-notes-remove" });
      removeBtn.addEventListener("click", () => {
        this.context.folders = this.context.folders.filter((f) => f.path !== folder.path);
        this.context.truncationNoticeShown = false;
        this.updateContextNotesLabel();
      });

      row.createSpan({
        text: `Folder: ${folder.path} (${folder.noteCount} note${folder.noteCount === 1 ? "" : "s"})`,
      });
    }

    for (const file of this.context.notes) {
      const row = this.contextNotesLabel.createDiv("horme-context-notes-row");

      const removeBtn = row.createSpan({ text: "\u00d7", cls: "horme-context-notes-remove" });
      removeBtn.addEventListener("click", () => {
        this.context.notes = this.context.notes.filter((f) => f.path !== file.path);
        this.updateContextNotesLabel();
      });

      row.createSpan({ text: file.basename });
    }
  }

  // The model field of the active provider. llama.cpp was missing here, so the
  // chat read and wrote Ollama's model while llama.cpp was the provider.
  private getCurrentProviderModel(): string {
    return providerModel(this.plugin.settings, this.plugin.settings.aiProvider);
  }

  private async setCurrentProviderModel(model: string): Promise<void> {
    const key = providerInfo(this.plugin.settings.aiProvider).modelKey;
    (this.plugin.settings as unknown as Record<string, string>)[key] = model.trim();
    await this.plugin.saveSettings();
  }

  /**
   * Sets a header dropdown's label. The text sits in its own span so a long
   * one ends in an ellipsis and the arrow stays visible in a narrow sidebar.
   */
  private setSelectLabel(button: HTMLButtonElement, text: string, arrow = true) {
    button.empty();
    button.createSpan({ cls: "horme-select-text", text });
    if (arrow) button.createSpan({ cls: "horme-select-arrow", text: "▾" });
  }

  /** Opens a menu under the button that asked for it. */
  private showMenuBelow(menu: Menu, button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 }, button.ownerDocument);
  }

  /** The providers, local ones first; one that is not set up yet opens the settings instead. */
  private openProviderMenu() {
    const s = this.plugin.settings;
    const choices = chatProviderChoices(s, (p) => this.plugin.getApiKeyForProvider(p), Platform.isMobile);
    const menu = new Menu();
    menu.setUseNativeMenu(false);

    const section = (heading: string, list: ProviderChoice[]) => {
      if (list.length === 0) return;
      menu.addItem((item) => {
        item.setTitle(heading).setIsLabel(true);
      });
      for (const c of list) {
        menu.addItem((item) => {
          // Greyed, with what it lacks; no icons, so every name lines up.
          const title = c.missing
            ? createFragment((f) => {
                const unready = f.createSpan({ cls: "horme-menu-unready", text: c.name });
                unready.createSpan({ cls: "horme-menu-note", text: c.missing });
              })
            : c.name;
          item.setTitle(title).setChecked(c.id === s.aiProvider);
          item.onClick(() => {
            void this.chooseProvider(c).catch((e) => this.plugin.handleError(e, "Provider"));
          });
        });
      }
    };
    section(
      "Local",
      choices.filter((c) => c.own),
    );
    menu.addSeparator();
    section(
      "Cloud",
      choices.filter((c) => !c.own),
    );
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle("Provider settings").onClick(() => this.openHormeSettings());
    });

    this.showMenuBelow(menu, this.providerButton);
  }

  /**
   * Makes a provider the active one, as the Provider setting under Models does.
   * Saving tells the chat, which loads that provider's models.
   */
  private async chooseProvider(c: ProviderChoice): Promise<void> {
    if (this.isGenerating) {
      new Notice("Horme: Cannot change provider while generating.");
      return;
    }
    if (c.missing) {
      const what = c.missing === "no key" ? "an API key" : "an address";
      new Notice(`Horme: ${c.name} needs ${what}. Add it on the Models page of Horme's settings.`, 8000);
      this.openHormeSettings();
      return;
    }
    if (c.id === this.plugin.settings.aiProvider) return;
    this.plugin.settings.aiProvider = c.id;
    // The buttons show the new provider and its saved model at once; its list
    // of models follows when the save reaches the chat.
    this.availableModels = [];
    this.showModelLabel();
    await this.plugin.saveSettings();
  }

  /** Opens Horme's tab in Obsidian's settings. */
  private openHormeSettings() {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): unknown } })
      .setting;
    if (!setting) {
      new Notice("Horme: Open Obsidian's settings and choose Horme.");
      return;
    }
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  /** Actions on the open note, and the settings. */
  private openMoreMenu(button: HTMLElement) {
    const menu = new Menu();
    menu.setUseNativeMenu(false);
    menu.addItem((item) => {
      item
        .setTitle("Suggest frontmatter tags")
        .setIcon("tags")
        .onClick(() => {
          void this.plugin.noteActions
            .suggestTagsForActiveNote()
            .catch((e) => this.plugin.handleError(e, "Tags"));
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Generate frontmatter summary")
        .setIcon("file-text")
        .onClick(() => {
          void this.plugin.noteActions
            .generateFrontmatterSummary()
            .catch((e) => this.plugin.handleError(e, "Summary"));
        });
    });
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Horme settings")
        .setIcon("settings")
        .onClick(() => this.openHormeSettings());
    });
    this.showMenuBelow(menu, button);
  }

  private openModelMenu() {
    const current = this.getCurrentProviderModel().trim();
    const models = this.availableModels.length ? this.availableModels : current ? [current] : [];

    const menu = new Menu();
    menu.setUseNativeMenu(false);

    if (models.length === 0) {
      menu.addItem((item) => {
        item.setTitle("No models found").setDisabled(true);
      });
    } else {
      for (const model of models) {
        menu.addItem((item) => {
          item
            .setTitle(model)
            .setChecked(model === current)
            .onClick(() => {
              void (async () => {
                await this.setCurrentProviderModel(model);
                await this.refreshModels();
              })();
            });
        });
      }
    }

    this.showMenuBelow(menu, this.modelButton);
  }

  private openPresetMenu() {
    const currentPrompt = this.sessionSystemPromptOverride;
    const menu = new Menu();
    menu.setUseNativeMenu(false);

    menu.addItem((item) => {
      item
        .setTitle("Default prompt")
        .setChecked(!currentPrompt)
        .onClick(() => {
          this.sessionSystemPromptOverride = null;
          void this.refreshPresets();
        });
    });

    if (this.availablePresets.length > 0) {
      menu.addSeparator();
      for (const p of this.availablePresets) {
        const isActive = currentPrompt === p.prompt;
        menu.addItem((item) => {
          item
            .setTitle(p.name || "Preset")
            .setChecked(isActive)
            .onClick(() => {
              this.sessionSystemPromptOverride = p.prompt;
              void this.refreshPresets();
            });
        });
      }
    }

    this.showMenuBelow(menu, this.presetButton);
  }

  private async refreshModels() {
    const provider = this.plugin.settings.aiProvider;
    this.modelsProvider = provider;
    await this.plugin.fetchModels();
    // Models typed by hand on the Models page are offered here too.
    const typed = this.plugin.settings.customModelSuggestions?.[`horme-${provider}-models`] ?? [];
    this.availableModels = Array.from(
      new Set([...(this.plugin.models || []), ...typed].map((m) => m.trim()).filter(Boolean)),
    );
    this.showModelLabel();
    await this.updateConnectionStatus();
    await this.updateVaultBrainToggle();
  }

  /** Shows the active provider and its saved model on their buttons. */
  private showModelLabel() {
    const info = providerInfo(this.plugin.settings.aiProvider);
    this.setSelectLabel(this.providerButton, info.shortName ?? info.name);
    this.providerButton.title = `Provider: ${info.name}`;

    const savedModel = this.getCurrentProviderModel().trim();
    // The saved model is offered even when the list no longer has it.
    if (savedModel && !this.availableModels.includes(savedModel)) this.availableModels.unshift(savedModel);

    if (this.availableModels.length === 0) {
      this.setSelectLabel(this.modelButton, "No models found", false);
      this.modelButton.title = "No models found";
      this.modelButton.disabled = true;
      return;
    }

    // With no model saved, showing the first in the list looked like a choice,
    // but sending then refused: "No model chosen".
    const label =
      savedModel || (this.plugin.settings.aiProvider === "llamacpp" ? "Automatic" : "Choose a model");
    this.setSelectLabel(this.modelButton, label);
    this.modelButton.title = label;
    this.modelButton.disabled = false;
  }

  private async refreshPresets() {
    const presets = await this.plugin.getChatPresets();
    this.availablePresets = presets;

    const selectedPrompt = this.sessionSystemPromptOverride;
    if (!selectedPrompt) {
      this.setSelectLabel(this.presetButton, "Default prompt");
      this.presetButton.title = "Default prompt";
      this.presetButton.disabled = false;
      return;
    }

    const match = presets.find((p) => p.prompt === selectedPrompt);
    const label = match?.name || "Custom preset";
    this.setSelectLabel(this.presetButton, label);
    this.presetButton.title = label;
    this.presetButton.disabled = false;
  }

  private async updateConnectionStatus() {
    const ok = await this.plugin.checkConnection();
    const name = providerInfo(this.plugin.settings.aiProvider).name;
    this.connectionDot.className = `horme-connection-icon ${ok ? "horme-online" : "horme-offline"}`;
    this.connectionDot.title = `${name}: ${ok ? "connected" : "unreachable"}`;
  }

  private async stopGeneration() {
    this.generationEpoch++;
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    if (this.activeReader) {
      try {
        await this.activeReader.cancel();
      } catch {
        /* ignore */
      }
      this.activeReader = null;
    }
    this.isGenerating = false;
    setIcon(this.sendBtn, "send");
    this.sendBtn.classList.remove("horme-stop-btn");
  }

  private pickDocument(): void {
    const fileInput = activeDocument.body.createEl("input", { type: "file" });
    fileInput.accept = ".txt,.md";
    fileInput.hide();

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
        if (!file) {
          fileInput.remove();
          return;
        }

        try {
          const text = await file.text();

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
        () => resolve(false),
      ).open();
    });
  }

  /**
   * Sends the message in the input (or regenerates the last reply). A second
   * call while one is being prepared is ignored, so a double Enter cannot send
   * twice before streaming starts.
   */
  private async sendMessage(regenerate = false) {
    if (this.isGenerating || this.sendInFlight) return;
    this.sendInFlight = true;
    try {
      await this.sendMessageInner(regenerate);
    } finally {
      this.sendInFlight = false;
    }
  }

  /**
   * A skill armed from the Skills menu, or a picture request, runs on its own
   * for this turn: the skill owns the context, so neither Vault Brain nor a
   * model round comes before it, and the model then writes the reply from
   * what the skill found.
   */
  private async runArmedSkill(quickParams: Record<string, string | number | boolean> | null): Promise<void> {
    const skillId = this.forcedSkillId;
    if (!skillId) return;
    const query = this.inputEl.value.trim();
    if (!query) return;

    // Step 4.1: Lock the generation state at the start of forced execution
    this.isGenerating = true;
    this.sendBtn.addClass("horme-stop-btn");
    setIcon(this.sendBtn, "horme-shell");

    // Step 4.3: Store a new AbortController
    this.activeAbortController = new AbortController();

    // Disarm immediately — pill, flag, and placeholder cleared before any async work
    this.forcedSkillId = null;
    this.inputEl.placeholder = "Ask Horme…"; // Revert placeholder text
    this.containerEl.querySelector(".horme-skill-pill")?.remove();

    // Render the user's message in the chat; the first one replaces the empty-chat greeting.
    if (!this.history.length) this.messagesEl.empty();
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
      const primaryParam = skill.primaryParam ?? skill.parameters[0]?.name;
      if (!primaryParam) {
        this.plugin.diagnosticService.report(
          "Skills",
          `Skill configuration error: no primary parameter defined for skill "${skillId}".`,
          "warning",
        );
        new Notice("Skill configuration error: no primary parameter defined.");
        throw new Error("Skill configuration error: no primary parameter defined.");
      }

      const forcedParams: Record<string, string | number | boolean> = quickParams ?? {
        [primaryParam]: query,
      };

      // Verify and inject required parameters that are not the primary one
      for (const param of skill.parameters) {
        if (param.required && !(param.name in forcedParams)) {
          if (param.name === "language") {
            const langSetting = (
              this.plugin.settings.grammarLanguage ||
              this.plugin.settings.summaryLanguage ||
              "en"
            ).toLowerCase();
            forcedParams.language = langSetting.includes("es") || langSetting.includes("spa") ? "es" : "en";
          } else {
            if (param.type === "number") {
              forcedParams[param.name] = 0;
            } else if (param.type === "boolean") {
              forcedParams[param.name] = false;
            } else {
              forcedParams[param.name] = "";
            }
          }
        }
      }

      // TODO: For skills whose execute() does not accept a signal, the abort signal
      // cannot cancel the underlying network request — document this limitation.
      const result = await skill.execute(forcedParams);

      if (this.activeAbortController?.signal.aborted) {
        throw new DOMException("Generation stopped.", "AbortError");
      }

      loadingEl.remove();
      await this.renderSkillResultBox(skill.id, skill.name, forcedParams, result);
      const forcedSkillLinks = pillsFromSkillResult(result);
      if (!this.contentEl.isConnected) return; // Connectivity guard from Fix 2
      // Pictures stay with the skill result, which is drawn again when the chat is
      // reopened; the reply carries only the text.
      const pictures = skill.id === "find_image" ? imagesFromSkillResult(result) : [];
      if (pictures.length) {
        // The cards are the whole reply: each shows its title and credit and links
        // to its page. The titles and credits are kept for the model and for notes.
        this.history.push({ role: "tool_result", content: `[SKILL RESULT: ${skill.id}]\n\n${result}` });
        this.history.push({ role: "assistant", content: imagesSummary(pictures), picturesOnly: true });
        this.pillsUnderPictures(forcedSkillLinks);
      } else {
        const shownText = withoutImageData(result);
        const resultBubble = this.addMessageBubble("assistant", "");
        const contentArea = resultBubble.querySelector(".horme-content-area") as HTMLElement;
        if (contentArea) {
          contentArea.empty();
          await MarkdownRenderer.render(this.app, shownText, contentArea, "", this);
        }
        this.addAssistantActions(resultBubble, shownText);
        this.renderSkillSourceLinks(resultBubble, forcedSkillLinks);
        if (shownText !== result) {
          this.history.push({ role: "tool_result", content: `[SKILL RESULT: ${skill.id}]\n\n${result}` });
        }
        this.history.push({ role: "assistant", content: shownText });
      }
      // Regenerate would replay an older turn's request; a skill run is repeated by running it again.
      this.lastMsgs = null;
      this.plugin.historyManager.append({
        id: this.conversationId,
        title: this.history.find((m) => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
        timestamp: Date.now(),
        messages: this.history,
      });
      this.scrollToBottom();
    } catch (e: unknown) {
      loadingEl.remove();
      if (e instanceof DOMException && e.name === "AbortError") {
        new Notice("Generation stopped.");
      } else {
        this.plugin.handleError(e);
      }
    } finally {
      // Step 4.2 & 4.3: Reset generating state and controller inside finally block
      this.isGenerating = false;
      setIcon(this.sendBtn, "send");
      this.sendBtn.classList.remove("horme-stop-btn");
      this.activeAbortController = null;
    }
  }

  /** The open note's text for the next question, after its privacy question; null when not sent. */
  private async currentNoteContext(
    mdLeaf: WorkspaceLeaf | null,
    providerIsLocal: boolean,
    providerLabel: string,
  ): Promise<string | null> {
    if (!this.contextToggle.checked) return null;
    if (!providerIsLocal && !this.plugin.settings.contextCloudWarningShown) {
      const ok = await this.confirmCloudSend(
        `Privacy notice: Your current note's full text will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`,
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
      return `The user's current note:\n\n${mdLeaf.view.editor.getValue()}`;
    }
    return null;
  }

  /** The notes picked with "+ Add notes" (excerpts), after their privacy question; null when none are sent. */
  private async pickedNotesContext(providerIsLocal: boolean, providerLabel: string): Promise<string | null> {
    if (this.context.notes.length === 0) return null;
    let includeContextNotes = true;

    if (!providerIsLocal && !this.plugin.settings.contextNotesCloudWarningShown) {
      const ok = await this.confirmCloudSend(
        `Privacy notice: Up to 5 notes (excerpts) will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`,
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
      for (const file of this.context.notes) {
        try {
          const content = await this.app.vault.read(file);
          noteParts.push(`--- Note: ${file.basename} ---\n${content.slice(0, 4000)}`);
        } catch {
          noteParts.push(`--- Note: ${file.basename} ---\n[Error reading file]`);
        }
      }
      return `The user has provided the following notes as additional context:\n\n` + noteParts.join("\n\n");
    }
    return null;
  }

  /**
   * The notes of the picked folders, up to the folder context limit, after
   * their own privacy question; `truncated` when the limit cut them.
   */
  private async folderContext(
    providerIsLocal: boolean,
    providerLabel: string,
  ): Promise<{ part: string | null; truncated: boolean }> {
    let part: string | null = null;
    let wasTruncated = false;
    if (this.context.folders.length === 0) return { part, truncated: wasTruncated };
    let includeFolderContext = true;

    // Its own consent: agreeing to send up to five picked notes is not
    // agreeing to send whole folders.
    if (!providerIsLocal && !this.plugin.settings.contextFoldersCloudWarningShown) {
      const ok = await this.confirmCloudSend(
        `Privacy notice: Notes from your selected folders will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`,
      );
      if (ok) {
        this.plugin.settings.contextFoldersCloudWarningShown = true;
        await this.plugin.saveSettings();
      } else {
        includeFolderContext = false;
        new Notice("Horme: Folder context not sent.");
      }
    }

    if (includeFolderContext) {
      const limit = Math.max(1000, this.plugin.settings.contextFoldersMaxChars || 0);
      const { text, truncated, included, total } = await this.context.buildFolderContext(limit);
      wasTruncated = truncated;
      if (text) {
        const selectedFoldersLabel = this.context.folders.map((f) => f.path).join(", ");
        part =
          `FOLDER CONTEXT (highest priority): The user selected folder(s): ${selectedFoldersLabel}\n` +
          `Use the notes inside this folder context to answer the user's next message. ` +
          `Ignore the currently open note. ` +
          `If any additional "LOCAL VAULT CONTEXT" is provided, it is scoped to these same folder(s).\n\n` +
          `--- BEGIN FOLDER CONTEXT ---\n` +
          text +
          `\n--- END FOLDER CONTEXT ---`;
      }
      if (truncated && !this.context.truncationNoticeShown) {
        this.context.truncationNoticeShown = true;
        new Notice(
          `Horme: Folder context truncated (${included}/${total} notes) due to the ${limit.toLocaleString()} character limit.`,
        );
      }
    }
    return { part, truncated: wasTruncated };
  }

  private async sendMessageInner(regenerate: boolean) {
    if (this.isGenerating) return;
    this.followOutput = true;
    this.turnVaultNothing = false;
    this.turnPassages = "";
    this.turnSources = [];
    // Stop, Clear or opening another chat bump the epoch; preparation that was
    // overtaken must not start a stream.
    const startEpoch = this.generationEpoch;
    const startConversation = this.conversationId;

    // ── Picture requests ────────────────────────────────────────────────────
    // "Show me a photo of …" is answered by Find image directly, like a skill run
    // from the menu: no model round, so a second or two instead of two rounds.
    let quickParams: Record<string, string | number | boolean> | null = null;
    if (
      !regenerate &&
      !this.forcedSkillId &&
      this.plugin.settings.imageQuickRequests &&
      this.uploadedImages.length === 0
    ) {
      const ask = pictureRequest(this.inputEl.value);
      if (ask && this.plugin.settings.imageSources.some((src) => sourceReady(this.plugin, src.id))) {
        this.forcedSkillId = "find_image";
        quickParams = { query: ask.query, count: ask.count };
        // English is the skill's default; another language picks that Wikipedia's article picture.
        if (ask.language !== "en") quickParams.language = ask.language;
      }
    }

    // ── Forced skill execution ──────────────────────────────────────────────
    // When a skill is armed from the dropdown, we bypass both the normal
    // send flow AND Vault Brain RAG. The skill owns the context for this turn.
    if (this.forcedSkillId) {
      await this.runArmedSkill(quickParams);
      return;
    }
    // ── End forced skill execution ───────────────────────────────────────────

    let msgs: ChatMessage[];
    let model: string;
    let ragWasInjected = false;
    let injectedPassages = "";

    // Capture context at start to prevent desync
    const mdLeaf = this.plugin.lastActiveMarkdownLeaf;
    const initialSourcePath = (mdLeaf?.view instanceof MarkdownView ? mdLeaf.view.file?.path : null) ?? null;
    let currentSources: string[] = [];

    if (regenerate && !this.canRegenerate()) {
      new Notice("Horme: Only the latest reply can be regenerated, with the provider it came from.");
      return;
    }
    if (regenerate && this.lastMsgs && this.lastModel !== null) {
      if (this.history.length && this.history[this.history.length - 1].role === "assistant") {
        this.history.pop();
      }
      msgs = this.lastMsgs;
      // The vault was not searched again: keep what the first search found.
      this.turnVaultNothing = this.lastVaultNothing;
      this.turnPassages = this.lastTurnPassages;
      this.turnSources = this.lastTurnSources;
      model = this.lastModel;
      injectedPassages = this.lastInjectedPassages;
    } else {
      const text = this.inputEl.value.trim();
      if (!text) return;

      model = this.getCurrentProviderModel().trim();
      // llama.cpp resolves an empty model to the one the server has loaded.
      if (!model && this.plugin.settings.aiProvider !== "llamacpp") {
        // An empty model list from a local server usually means it is not running.
        const info = providerInfo(this.plugin.settings.aiProvider);
        const url = info.urlKey ? String(this.plugin.settings[info.urlKey] ?? "") : "";
        new Notice(
          info.urlKey
            ? `Horme: No ${info.name} model chosen. If ${info.name} is running${url ? ` at ${url}` : ""}, pick a model in the chat's model menu; if not, start it or choose another provider.`
            : `Horme: No ${info.name} model chosen. Pick one in the chat's model menu.`,
          8000,
        );
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
      this.messagesEl.querySelectorAll(".horme-image-preview-container").forEach((el) => el.remove());

      const systemParts: string[] = [];
      const effectivePrompt =
        this.sessionSystemPromptOverride ?? (await this.plugin.getEffectiveSystemPrompt());
      if (effectivePrompt) systemParts.push(effectivePrompt);

      const providerIsLocal = this.plugin.isLocalProviderActive();
      const providerLabel = providerInfo(this.plugin.settings.aiProvider).name;
      const folderContextActive = this.context.folders.length > 0;
      let folderContextWasTruncated = false;

      // The open note, with its privacy question. Folder context leaves it out:
      // a note wanted besides a folder is added with "+ Add notes".
      if (!folderContextActive) {
        const note = await this.currentNoteContext(mdLeaf, providerIsLocal, providerLabel);
        if (note) systemParts.push(note);
      }
      const pickedNotes = await this.pickedNotesContext(providerIsLocal, providerLabel);
      if (pickedNotes) systemParts.push(pickedNotes);
      const folders = await this.folderContext(providerIsLocal, providerLabel);
      if (folders.part) systemParts.push(folders.part);
      folderContextWasTruncated = folders.truncated;

      // --- Vault Brain (RAG) Injection ---
      const canUseRAG = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
      const hasBuiltVaultIndex = canUseRAG ? await this.plugin.vaultIndexer.hasBuiltIndex() : false;
      const sessionRAGEnabled = this.vaultBrainToggle ? this.vaultBrainToggle.checked : true;
      let relevantChunks: string[] = [];

      if (
        this.plugin.settings.vaultBrainEnabled &&
        canUseRAG &&
        hasBuiltVaultIndex &&
        sessionRAGEnabled &&
        // If folder context was truncated, allow Vault Brain to supplement
        // but scope it to the same selected folders.
        (!folderContextActive || folderContextWasTruncated)
      ) {
        this.plugin.setIndexingStatus("Searching vault brain...");
        try {
          const scope =
            this.context.folders.length > 0
              ? { folders: this.context.folders.map((f) => f.path) }
              : undefined;
          relevantChunks = await this.plugin.vaultSearch.search(text, 20, scope ? { scope } : undefined);
        } finally {
          this.plugin.setIndexingStatus(null);
        }
        // No passage at all: the answer opens with the notice, set here. When
        // passages come back the model judges whether they answer (scores alone
        // cannot tell "about the topic" from "holds the answer") and says so.
        if (relevantChunks.length === 0) this.turnVaultNothing = true;

        if (relevantChunks.length > 0) {
          // search() returns chunks sorted best-first (highest score first).
          // We must preserve that ordering when merging into the rolling context,
          // otherwise slice() discards the most relevant results and keeps the worst.
          //
          // Strategy: current query's results go first (score-ordered), then
          // fill remaining slots with previous context for multi-turn coherence.
          const prevContext = folderContextActive
            ? []
            : this.rollingRAGContext.filter((c) => !relevantChunks.includes(c));
          this.rollingRAGContext = [...relevantChunks, ...prevContext].slice(0, 20);

          // Extract unique paths for the "Sources" UI
          currentSources = relevantChunks.map((c) => passageNotePath(c)).filter(Boolean);
          currentSources = [...new Set(currentSources)];
          this.turnSources = currentSources;
        }

        // As many of the best passages as fit the model's window beside the
        // rest of the request, when its provider knows the window (Apple's is
        // 8,192 tokens; twenty passages alone took about 5,000).
        let fitted = this.rollingRAGContext;
        const window = fitted.length ? await this.plugin.aiGateway.contextWindow(model) : null;
        if (window) {
          const rest =
            systemParts.join("\n\n").length +
            this.history.reduce((n, m) => n + m.content.length, 0) +
            text.length +
            (this.uploadedDocContent?.length ?? 0) +
            this.plugin.aiGateway.skillsChars(true, text) +
            2500; // the vault rules around the passages and the language line
          fitted = fitPassages(fitted, passageBudget(window, rest));
        }

        if (fitted.length > 0) {
          ragWasInjected = true;
          injectedPassages = fitted.join("\n\n---\n\n");
          this.lastInjectedPassages = injectedPassages;
          this.turnPassages = injectedPassages;
          if (relevantChunks.length > 0) {
            new Notice(`● Vault Brain: Consulting ${relevantChunks.length} notes...`);
          }
          systemParts.push(
            (relevantChunks.length === 0
              ? `LOCAL VAULT CONTEXT — The vault search for this message found nothing; the user has been told. ` +
                `The notes below came up earlier in this conversation: use them only if this message follows up on them.\n`
              : `LOCAL VAULT CONTEXT — The closest notes from the user's vault are provided below.\n` +
                `VAULT CHECK: the search returns the closest notes even when none of them answers the question. ` +
                `First decide whether these notes contain the answer. If they do not, your reply must begin with this exact line: ` +
                `"${VAULT_NOTHING}" Then answer another way (a skill, or what you know, saying which) and do not present the notes as the source. ` +
                `If they do contain it, answer from them and do not write that line.\n`) +
              `LANGUAGE RULE: Respond exclusively in the same language the user used in their question. ` +
              `If the context is in a different language, translate the facts accurately — do not switch your response language.\n` +
              `CONTEXT PRIORITY: Base your answer on the vault context above. ` +
              `If the context contains specific facts (dates, names, events), treat them as ground truth ` +
              `and do not substitute your training data for them.\n` +
              `Do NOT call vault_links: the search has already been done.\n` +
              `QUESTIONS ABOUT THE VAULT ITSELF — how many notes, which notes, notes in a folder, with a tag or a property, ` +
              `or from a period, or reading a whole note — cannot be answered from these passages: call vault_query for them, ` +
              `and do not begin that answer with "${VAULT_NOTHING}"\n\n` +
              injectedPassages,
          );
        }
      }

      if (this.uploadedDocContent) {
        let includeDocument = true;

        if (!providerIsLocal && !this.plugin.settings.documentCloudWarningShown) {
          const ok = await this.confirmCloudSend(
            `Privacy notice: Your uploaded document's extracted text will be sent to ${providerLabel}, a cloud provider. The content will leave your device. Do you want to continue?`,
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
          systemParts.push(`The user has uploaded a document. Its content is:\n\n${this.uploadedDocContent}`);
        }
      }

      msgs = [];
      const isFirstMessage = this.history.length === 1;
      const currentMsg: ChatMessage = { role: "user", content: text };

      if (this.uploadedImages.length > 0) {
        if (!this.plugin.isLocalProviderActive()) {
          // Cloud providers don't support Ollama-style base64 images.
          // Clear the data so it never leaves the device.
          new Notice(
            "⚠ Image upload is only supported with local providers (Ollama / LM Studio). Images have been removed from this message.",
          );
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

      // Last, where a small model weighs it most: the language to answer in.
      const language = replyLanguage(text);
      if (language)
        systemParts.push(
          `Reply in ${language}, the language of the user's message, whatever the language of the notes, passages or skill results.`,
        );

      if (isFirstMessage) {
        if (systemParts.length) msgs.push({ role: "system", content: systemParts.join("\n\n") });
        msgs.push(currentMsg);
      } else {
        if (systemParts.length) msgs.push({ role: "system", content: systemParts.join("\n\n") });

        // Consolidate tool result messages from history (Fix 3)
        const filteredHistory: ChatMessage[] = [];
        const toolResults: ChatMessage[] = [];
        for (const m of this.history) {
          if (m.role === "tool_result" || (m.role === "system" && m.content.startsWith("[SKILL RESULT:"))) {
            toolResults.push(m);
          } else {
            filteredHistory.push(m);
          }
        }

        let consolidatedToolResult: ChatMessage | null = null;
        if (toolResults.length > 0) {
          consolidatedToolResult = {
            role: "user",
            content: toolResults.map((r) => withoutImageData(r.content)).join("\n\n"),
          };
        }

        // Inject immediately before the most recent assistant turn
        let lastAssistantIdx = -1;
        for (let i = filteredHistory.length - 1; i >= 0; i--) {
          if (filteredHistory[i].role === "assistant") {
            lastAssistantIdx = i;
            break;
          }
        }

        if (consolidatedToolResult) {
          if (lastAssistantIdx !== -1) {
            filteredHistory.splice(lastAssistantIdx, 0, consolidatedToolResult);
          } else {
            filteredHistory.push(consolidatedToolResult);
          }
        }

        for (const m of filteredHistory) {
          msgs.push({ role: m.role, content: m.content });
        }

        // Consolidate consecutive roles to prevent API errors
        msgs = cleanAndConsolidateMsgs(msgs);

        // Attach media to the latest user message in the payload
        const lastMsg = msgs[msgs.length - 1];
        if (currentMsg.images) lastMsg.images = currentMsg.images;
        if (currentMsg.audio) lastMsg.audio = currentMsg.audio;
      }
    }

    if (this.generationEpoch !== startEpoch || this.conversationId !== startConversation) return;
    this.lastMsgs = msgs;
    this.lastVaultNothing = this.turnVaultNothing;
    this.lastTurnPassages = this.turnPassages;
    this.lastTurnSources = this.turnSources;
    this.lastModel = model;
    this.lastProvider = this.plugin.settings.aiProvider;
    const epoch = ++this.generationEpoch;
    const loadingEl = this.showLoading();
    await this.handleStreamingResponse(
      msgs,
      model,
      loadingEl,
      initialSourcePath,
      ragWasInjected,
      0,
      currentSources,
      [],
      injectedPassages,
      epoch,
    ).catch((e) => this.plugin.handleError(e));
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
    skillSourceLinks: SourcePill[] = [],
    passages: string,
    epoch: number,
    extras: {
      /** Repeated-call guard shared across the whole skill chain. */
      pastCalls?: PastCall[];
      /** Step timeline element shared across the whole skill chain. */
      timelineEl?: HTMLElement | null;
      /** Final budget-exhausted round: no skills offered or parsed. */
      skillsSuppressed?: boolean;
      /** This round already asks again for an answer that came back empty. */
      answerRetried?: boolean;
    } = {},
  ) {
    if (this.generationEpoch !== epoch || !this.contentEl.isConnected) {
      return;
    }
    this.isGenerating = true;
    this.sendBtn.addClass("horme-stop-btn");
    setIcon(this.sendBtn, "horme-shell");
    // The chat this reply belongs to: after Stop the partial reply is kept here;
    // after Clear or opening another chat it is dropped, never added to that chat.
    const convoAtStart = this.conversationId;
    const historyAtStart = this.history;
    let partialKept = false;
    /** After Stop: the text received so far stays in this chat's history, once. */
    const keepPartialReply = (): void => {
      if (partialKept || !(fullContent || fullReasoning)) return;
      if (this.conversationId !== convoAtStart || this.history !== historyAtStart) return;
      partialKept = true;
      this.history.push({
        role: "assistant",
        content: fullContent,
        reasoning: fullReasoning || undefined,
        context: passages || undefined,
        sources: sources.length ? sources : undefined,
      });
      this.plugin.historyManager.append({
        id: this.conversationId,
        title: this.history.find((m) => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
        timestamp: Date.now(),
        messages: this.history,
      });
    };

    let bubbleEl: HTMLElement | null = null;
    let fullContent = "";
    let fullReasoning = "";
    let reasoningEl: HTMLDetailsElement | null = null;
    const pastCalls = extras.pastCalls ?? [];
    let timelineEl = extras.timelineEl ?? null;
    const skillsSuppressed = extras.skillsSuppressed === true;
    // Native tool calls, assembled from the fragments the stream sends.
    const nativeCalls = new ToolCallAssembler();

    this.activeAbortController = new AbortController();

    // Content and reasoning render as formatted Markdown while they stream,
    // at most every 200 ms each, never bare.
    const renderMarkdown = (text: string, target: HTMLElement) =>
      this.renderMarkdownInto(target, text, initialSourcePath || "").then(() => this.scrollToBottom());
    const renderProgressiveMarkdown = throttledRender(renderMarkdown);
    const renderProgressiveReasoning = throttledRender(renderMarkdown);

    try {
      // The rounds after a skill only write the reply from text already found;
      // a local thinking model skipping its thinking there answers much sooner.
      const reader = await this.plugin.aiGateway.stream(
        msgs,
        model,
        this.activeAbortController.signal,
        suppressVaultSkill,
        skillsSuppressed,
        skillDepth > 0 && !this.plugin.settings.thinkAfterSkills ? { noThinking: true } : undefined,
        this.lastUserText(),
      );
      if (!this.contentEl.isConnected) return;
      this.activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let hasReceivedFirstChunk = false;

      const isEscaped = (s: string, idx: number): boolean => {
        let count = 0;
        let j = idx - 1;
        while (j >= 0 && s[j] === "\\") {
          count++;
          j--;
        }
        return count % 2 !== 0;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (!this.contentEl.isConnected) return;
        if (this.generationEpoch !== epoch) break; // Stale stream guard
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
            if (char === "{") {
              if (braceCount === 0) start = i;
              braceCount++;
            } else if (char === "}") {
              braceCount--;
              if (braceCount === 0) {
                const jsonStr = buffer.slice(start, i + 1);
                // A failure the server reports inside the stream ends the reply with that error.
                const failed = streamError(jsonStr);
                if (failed) throw new Error(failed);
                processChunk(
                  jsonStr,
                  (fragments) => nativeCalls.add(fragments),
                  (content, reasoning) => {
                    if (!hasReceivedFirstChunk && (content || reasoning)) {
                      hasReceivedFirstChunk = true;
                      if (loadingEl) {
                        loadingEl.remove();
                        loadingEl = null;
                      }
                      if (!this.contentEl.isConnected) return;
                      bubbleEl = this.addMessageBubble("assistant", "");
                    }

                    // Capture in a local const so TypeScript's narrowing works correctly
                    // across the closure boundary. Without this, TypeScript cannot track
                    // that bubbleEl was assigned above and types it as `never` after the guard.
                    const el = bubbleEl;
                    if (!el) return;

                    if (reasoning) {
                      if (!reasoningEl) {
                        reasoningEl = el.createEl("details", {
                          cls: "horme-thinking-details horme-thinking-active",
                        });
                        reasoningEl.createEl("summary", {
                          text: "Reasoning process",
                          cls: "horme-thinking-summary",
                        });
                        // Pin the thinking bubble to the top of the response.
                        const contentArea = el.querySelector(".horme-content-area");
                        if (contentArea) el.insertBefore(reasoningEl, contentArea);
                      }
                      fullReasoning += reasoning;
                      let reasoningBody = reasoningEl.querySelector(".horme-thinking-body");
                      if (!reasoningBody) reasoningBody = reasoningEl.createDiv("horme-thinking-body");
                      renderProgressiveReasoning(fullReasoning, reasoningBody as HTMLElement);
                    }

                    if (content) {
                      fullContent += content;
                      // If there was reasoning, ensure the content is outside/after it
                      let contentArea = el.querySelector(".horme-content-area") as HTMLElement;
                      if (!contentArea) contentArea = el.createDiv("horme-content-area");
                      renderProgressiveMarkdown(this.withVaultNotice(fullContent), contentArea);
                    }
                    this.scrollToBottom();
                  },
                );
                start = i + 1;
              }
            }
          }
        }
        buffer = buffer.slice(start);
      }

      this.activeReader = null;
      // This round has finished arriving. A round that only called a skill
      // never showed text, so its "Thinking" row was left running beside the
      // next round's until the whole turn ended.
      if (loadingEl) {
        loadingEl.remove();
        loadingEl = null;
      }

      if (this.generationEpoch !== epoch) {
        // Stopped, or overtaken by Clear or another chat: run no skills.
        keepPartialReply();
        return;
      }

      // The final answer of a turn that ran Deep Research: its [n] citations
      // become links to the sources, which are listed at the end, in the chat
      // and in what is saved.
      if (fullContent && nativeCalls.isEmpty && !/<call:/.test(fullContent)) {
        // The answer is always in the language of the question: one written in
        // the language of the notes or results instead is rewritten.
        fullContent = this.plugin.skillManager.readableSkillNames(unwrapQuotedAnswer(fullContent));
        const asked = replyLanguage(this.lastUserText());
        const written = replyLanguage(fullContent);
        if (asked && written && asked !== written)
          fullContent = await this.inLanguage(fullContent, asked, model);
        // A note made this turn is always named in the answer: qwen 3.5 2B
        // wrote about the subject and never said the note existed.
        for (const title of this.notesCreatedThisTurn()) {
          if (!fullContent.includes(`[[${title}`))
            fullContent = `${asked === "Spanish" ? `Nota creada: [[${title}]].` : `Created the note [[${title}]].`}\n\n${fullContent}`;
        }
        // Every [n] links to its source; one that cites nothing is removed.
        // Without a numbered research list, [n] is the n-th source listed under
        // the answer. Only after a skill ran: "[1]" in other answers is text.
        const research = this.researchSourcesForTurn();
        if (research.size) {
          fullContent = linkCitations(dropDanglingCitations(fullContent, new Set(research.keys())), research);
        } else if (this.skillsThisTurn().length) {
          const listed = new Map<number, CitedSource>(
            skillSourceLinks
              .filter((p) => p.n === undefined)
              .map((p, i) => [i + 1, { n: i + 1, title: p.label, url: p.url }]),
          );
          fullContent = linkCitations(dropDanglingCitations(fullContent, new Set(listed.keys())), listed);
        }
        // Notes were sent but the answer came from an outside skill and few of
        // its facts are in them: the vault did not answer. (Small models rarely
        // say so themselves; tested on 48 questions with gemma E2B.)
        if (
          this.turnPassages &&
          !fullContent.trimStart().startsWith(VAULT_NOTHING) &&
          this.outsideSkillThisTurn()
        ) {
          const share = groundedShare(fullContent, this.turnPassages);
          if (share === null || share < 0.8) this.turnVaultNothing = true;
        }
        // A count or list from vault_query is the vault answering: no notice, even
        // when the passages sent with the message held nothing on it (they cannot
        // hold a count) and the model wrote the line before calling the skill.
        // Nor when the user named an outside source (the notice is clutter) or a
        // note sent with the question is named after its subject (it is false).
        // Nor after a skill that does something rather than answer (a note made,
        // a picture found), or one that answered from the vault itself (the
        // grammar notes, related notes).
        // A vault skill that found nothing does not count: the notice is then
        // the honest answer (qwen searched a tag that does not exist and said
        // so, and removing the line left the answer empty).
        const question = this.lastUserText();
        if (
          this.vaultSkillFound(["vault_query", "vault_links", "grammar_scholar"]) ||
          this.skillsThisTurn().some((id) => id === "create_concept_note" || id === "find_image") ||
          namesOutsideSource(question) ||
          titleNamesQuestion(question, this.turnSources)
        ) {
          this.turnVaultNothing = false;
          fullContent = normaliseVaultNotice(fullContent).replace(/^Nothing in your vault on this\.\s*/, "");
        }
        fullContent = this.withVaultNotice(normaliseVaultNotice(fullContent));
        if (asked === "Spanish" && fullContent.startsWith(VAULT_NOTHING))
          fullContent = VAULT_NOTHING_ES + fullContent.slice(VAULT_NOTHING.length);
      }

      // A round after a skill that wrote nothing (qwen 3.5 2B did once its tools
      // were taken away), or only the vault notice that a vault_query answer
      // drops, never ends the turn with an empty bubble: the model is asked
      // once more, then the reader is told plainly.
      if (skillDepth > 0 && !fullContent.trim() && nativeCalls.isEmpty) {
        if (!extras.answerRetried) {
          (bubbleEl as HTMLElement | null)?.remove();
          const nextLoading = this.showLoading();
          await this.handleStreamingResponse(
            [
              ...msgs,
              {
                role: "user",
                content:
                  "Write your answer to the user's question now, in plain text, from the results above.",
              },
            ],
            model,
            nextLoading,
            initialSourcePath,
            suppressVaultSkill,
            skillDepth + 1,
            sources,
            skillSourceLinks,
            passages,
            epoch,
            { pastCalls, timelineEl, skillsSuppressed: true, answerRetried: true },
          );
          return;
        }
        // The notes Vault Brain found named after the question's subject are
        // listed: a true answer, where the model's own was a wrong "nothing".
        const spanish = replyLanguage(this.lastUserText()) === "Spanish";
        const named = this.turnSources
          .filter((path) => titleNamesQuestion(this.lastUserText(), [path]))
          .slice(0, 5)
          .map((path) => {
            const link = path.replace(/\.md$/i, "");
            return `- [[${link}|${link.split("/").pop() ?? link}]]`;
          });
        fullContent = named.length
          ? `${spanish ? "El modelo no ha escrito ninguna respuesta. Notas de tu bóveda sobre esto:" : "The model wrote no answer. Notes in your vault on this:"}\n\n${named.join("\n")}`
          : spanish
            ? "El modelo no ha escrito ninguna respuesta. Los resultados están en los recuadros de arriba."
            : "The model wrote no answer. The results are in the boxes above.";
        if (!bubbleEl) bubbleEl = this.addMessageBubble("assistant", "");
      }

      if (bubbleEl) {
        const el = bubbleEl;
        // Re-render the final content with Markdown
        const contentArea = el.querySelector(".horme-content-area") as HTMLElement;
        if (contentArea) {
          await this.renderMarkdownInto(contentArea, fullContent, initialSourcePath || "");
        } else {
          // Fallback if only content was received without special area
          el.empty();
          if (reasoningEl) el.appendChild(reasoningEl);
          const finalArea = el.createDiv("horme-content-area");
          await MarkdownRenderer.render(this.app, fullContent, finalArea, initialSourcePath || "", this);
        }
        // Re-render the streamed reasoning as formatted Markdown (it was plain
        // text during streaming); keep the bubble collapsed by default.
        if (fullReasoning.trim()) {
          const reasoningDetails = el.querySelector<HTMLDetailsElement>(".horme-thinking-details");
          const reasoningBody = reasoningDetails?.querySelector<HTMLElement>(".horme-thinking-body");
          if (reasoningDetails && reasoningBody) {
            reasoningDetails.removeClass("horme-thinking-active");
            reasoningDetails.open = false;
            await this.renderMarkdownInto(reasoningBody, fullReasoning, initialSourcePath || "");
          }
        }
        // A thinking model can spend the whole answer budget reasoning and never
        // answer; say so instead of leaving an empty bubble.
        if (!fullContent.trim() && fullReasoning.trim() && nativeCalls.isEmpty) {
          const area =
            el.querySelector<HTMLElement>(".horme-content-area") ?? el.createDiv("horme-content-area");
          area.empty();
          area.createEl("p", {
            cls: "horme-empty-answer",
            text: `The model wrote only its reasoning and no answer. Usually its thinking used the whole answer budget (Max tokens: ${this.plugin.settings.maxTokens.toLocaleString()}). Raise Max tokens in Horme's settings or turn the model's thinking off, then regenerate.`,
          });
        }
        // Passages bubble: exactly what RAG context was sent to the model this turn.
        await this.appendPassagesBubble(el, passages, initialSourcePath || "");
        this.addAssistantActions(el, fullContent);
        // Notes the answer says it could not use, or that a skill's answer does
        // not draw on, are not listed as its sources.
        const noteSources = this.vaultSourcesOf(fullContent, sources.length ? sources : this.turnSources);
        this.renderSources(el, noteSources);
      }

      // Assemble native tool calls (if any) from the streamed fragments.
      const nativeSkillCalls: SkillCall[] = [];
      if (!skillsSuppressed) {
        for (const part of nativeCalls.calls()) {
          if (!part.name) continue;
          let parameters: unknown = part.argsObj ?? {};
          if (part.argsObj === undefined && part.args) {
            try {
              parameters = JSON.parse(part.args);
            } catch {
              parameters = {};
            }
          }
          nativeSkillCalls.push({ skillId: part.name, parameters });
        }
      }

      if (!this.contentEl.isConnected) return;
      if (fullContent || fullReasoning || nativeSkillCalls.length) {
        // --- Skill Execution Agent Loop ---
        // Native calls (structured, from tool-trained models) take priority;
        // the prompt-taught XML syntax is parsed as the fallback.
        const skillCalls = skillsSuppressed
          ? []
          : nativeSkillCalls.length
            ? nativeSkillCalls
            : this.plugin.skillManager.parseSkillCalls(fullContent);
        if (skillCalls.length > 0) {
          // Clean the assistant bubble: strip raw <call:...> XML and leave
          // only the model's natural language text (if any).
          if (bubbleEl) {
            const bEl = bubbleEl;
            const contentArea = bEl.querySelector(".horme-content-area") as HTMLElement;
            if (contentArea) {
              // Text written in a round that ended in tool calls is interim
              // (plan, notes) — it never belongs in the reply bubble.
              const cleanedContent = nativeSkillCalls.length ? "" : stripSkillCallXml(fullContent);
              contentArea.empty();
              if (cleanedContent) {
                await MarkdownRenderer.render(
                  this.app,
                  cleanedContent,
                  contentArea,
                  initialSourcePath || "",
                  this,
                );
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
          const roundResults: string[] = [];
          const question = this.lastUserText();
          let ranSomething = false;
          for (const call of skillCalls) {
            const skillName = call.skillId;
            const skill = this.plugin.skillManager.getSkillById(skillName);
            const displayName = skill?.name || skillName;
            // A repeated call (the same skill on the same words, reworded or not;
            // a common small-model failure), or a vault-changing skill the user
            // did not ask for: the model is told why, and the reader sees no new box.
            const refusal = repeatsEarlierCall(skillName, call.parameters, pastCalls)
              ? `You already ran ${skillName} for this and have its results above. Do not call it again. Answer the user's question now using what you already found.`
              : !this.plugin.skillManager.askedFor(skillName, question)
                ? `${skillName} was not run: it writes in the user's vault, and the user did not ask for that. Answer the question with the other skills or what you already found.`
                : null;
            if (refusal) {
              this.history.push({
                role: "tool_result",
                // Its own label: a refusal is not a result (the citation links,
                // sources and vault notice read "[SKILL RESULT: …]" as a run).
                content: `[SKILL NOT RUN: ${skillName}]\n\n${refusal}`,
              });
              continue;
            }

            const skillLoading = this.showLoading(displayName);
            const loadingSpan = skillLoading.querySelector("span");
            if (loadingSpan) {
              const iconEl = loadingSpan.createSpan({ cls: "horme-skill-loading-icon" });
              setIcon(iconEl, this.getSkillIcon(skillName));
              loadingSpan.prepend(iconEl);
            }
            timelineEl = this.ensureAgentTimeline(timelineEl);
            const stepRow = this.addTimelineStep(timelineEl, displayName, call.parameters);
            // Stop pressed (or another chat opened) while earlier skills ran:
            // run no more of them and record nothing.
            if (this.generationEpoch !== epoch) {
              skillLoading.remove();
              return;
            }
            // "With every lookup": a picture of the subject is fetched while the lookup runs.
            const pictureTask = this.pictureAlongside(call);
            const result = await this.plugin.skillManager.executeSkill(call);
            // Asked in other words but brought back the same: no second box,
            // and the model is told it already has this.
            if (repeatsEarlierResult(skillName, result, pastCalls)) {
              pastCalls.push(pastCall(skillName, call.parameters, result));
              stepRow.remove();
              skillLoading.remove();
              pictureTask?.catch(() => null);
              this.history.push({
                role: "tool_result",
                content: `[SKILL NOT RUN: ${skillName}]\n\nThis call brought back the same as your earlier ${skillName} call, whose results are above. Do not call it again. Answer the user's question now.`,
              });
              continue;
            }
            ranSomething = true;
            pastCalls.push(pastCall(skillName, call.parameters, result));
            this.completeTimelineStep(stepRow, /^Error:/i.test(result));
            if (!this.contentEl.isConnected) return;
            skillLoading.remove();
            if (this.generationEpoch !== epoch) return;
            if (!VAULT_SKILLS.has(skillName)) mergePills(aggregatedSkillLinks, pillsFromSkillResult(result));

            this.history.push({
              role: "tool_result",
              content: `[SKILL RESULT: ${skillName}]\n\n${result}`,
            });
            await this.renderSkillResultBox(skillName, displayName, call.parameters, result);
            if (!this.contentEl.isConnected) return;
            roundResults.push(result);

            const picture = await (pictureTask ?? this.pictureAfterLookup(call, result));
            if (picture && this.generationEpoch === epoch && this.contentEl.isConnected) {
              this.history.push({
                role: "tool_result",
                content: `[SKILL RESULT: find_image]\n\n${picture.result}`,
              });
              await this.renderSkillResultBox(
                "find_image",
                "Find image",
                { query: picture.query },
                picture.result,
              );
            }
          }

          // A round that only showed pictures for a message that only asked for
          // pictures is finished: the cards carry title and credit, so another
          // model round would only repeat them, slowly.
          if (
            skillDepth === 0 &&
            skillCalls.every((c) => c.skillId === "find_image") &&
            roundResults.length > 0 &&
            roundResults.every((r) => imagesFromSkillResult(r).length > 0) &&
            onlyAsksForPictures(this.lastUserText())
          ) {
            this.finishWithPictures(roundResults, aggregatedSkillLinks);
            return;
          }

          // Always continue the loop — the model needs a chance to
          // synthesize results and call further skills for multi-part
          // questions.  The `terminal` flag only matters for the forced
          // skill dropdown path (handled in sendMessage), never here.
          let nextMsgs: ChatMessage[] = [];
          // The first round's system message carries the context the user chose
          // (current note, picked notes, folders, Vault Brain passages, document);
          // rebuilding it from the bare prompt dropped all of that after a skill call.
          let turnSystem = msgs[0]?.role === "system" ? msgs[0].content : undefined;
          // Once vault_query has answered from the whole vault, the passages are
          // noise: they cannot hold a count, and in a vault with notes in another
          // language they pulled a small model into that language. They also make
          // the round slower.
          if (turnSystem && this.turnPassages && this.vaultSkillFound(["vault_query"]))
            turnSystem = turnSystem.replace(
              this.turnPassages,
              "(The passages are left out here: vault_query has answered from the whole vault.)",
            );
          // The round must fit the model's window with the skill results in it:
          // the passages make way first (the results answer now), then the
          // results are cut. (Apple's 8,192 tokens overflowed after a page fetch.)
          const window = await this.plugin.aiGateway.contextWindow(model);
          let resultsRoom = Infinity;
          if (window) {
            const question = this.lastUserText();
            const resultsChars = this.history
              .filter((m) => m.role === "tool_result")
              .reduce((n, m) => n + withoutImageData(m.content).length, 0);
            const others = this.history
              .filter((m) => m.role !== "tool_result")
              .reduce((n, m) => n + m.content.length, 0);
            const skillsChars = this.plugin.aiGateway.skillsChars(suppressVaultSkill, question) + 600;
            const total = () => (turnSystem?.length ?? 0) + others + resultsChars + skillsChars;
            if (
              turnSystem &&
              this.turnPassages &&
              turnSystem.includes(this.turnPassages) &&
              total() > roundBudget(window)
            )
              turnSystem = turnSystem.replace(
                this.turnPassages,
                "(The passages are left out here to make room for the skill results.)",
              );
            resultsRoom = roundBudget(window) - (total() - resultsChars);
          }
          const effectivePrompt =
            turnSystem ?? this.sessionSystemPromptOverride ?? (await this.plugin.getEffectiveSystemPrompt());
          if (effectivePrompt) nextMsgs.push({ role: "system", content: effectivePrompt });

          const filteredHistory: ChatMessage[] = [];
          const toolResults: ChatMessage[] = [];
          for (const m of this.history) {
            if (m.role === "tool_result" || (m.role === "system" && m.content.startsWith("[SKILL RESULT:"))) {
              toolResults.push(m);
            } else {
              filteredHistory.push(m);
            }
          }

          for (const m of filteredHistory) {
            nextMsgs.push({ role: m.role, content: m.content });
          }

          if (toolResults.length > 0) {
            const consolidated = fitText(
              toolResults.map((r) => withoutImageData(r.content)).join("\n\n---\n\n"),
              Math.max(1500, resultsRoom),
            );
            // These results arrive as a message of their own, so "the user's last
            // message" no longer named the question. (Quoting the question instead
            // made a small model repeat it as its answer.)
            // The language named, last thing before the answer: "the user's
            // language" alone let qwen 3.5 2B answer an English question in the
            // Spanish of the notes.
            const language = replyLanguage(this.lastUserText());
            nextMsgs.push({
              role: "user",
              content:
                consolidated +
                "\n\n[SKILL RESULTS ABOVE] If the user's request is fully answered, write your final answer now, " +
                (language
                  ? `in ${language}, the language of the user's question, whatever the language of the results or the notes. `
                  : "in the same language as the user's question, whatever the language of the results or the notes. ") +
                "If you still need more information, call the next skill immediately — do not narrate or explain, just call it.",
            });
          }

          nextMsgs = cleanAndConsolidateMsgs(nextMsgs);

          const maxDepth = this.plugin.settings.agentMode
            ? Math.min(50, Math.max(1, this.plugin.settings.agentMaxRounds))
            : HormeChatView.MAX_SKILL_DEPTH;
          if (skillDepth >= maxDepth) {
            nextMsgs.push({
              role: "user",
              content:
                "[TOOL BUDGET EXHAUSTED] You have used every allowed skill call for this request. Do not call any more skills. Write your complete final answer now from everything you already found.",
            });
            const nextLoading = this.showLoading();
            await this.handleStreamingResponse(
              nextMsgs,
              model,
              nextLoading,
              initialSourcePath,
              false,
              skillDepth + 1,
              [],
              aggregatedSkillLinks,
              "",
              epoch,
              { pastCalls, timelineEl, skillsSuppressed: true },
            );
          } else {
            const nextLoading = this.showLoading();
            // The same tools as the first round: a tool list that changes between
            // rounds changes the top of the prompt, and the server then reads the
            // whole prompt again instead of reusing its cache (a minute on Ollama).
            await this.handleStreamingResponse(
              nextMsgs,
              model,
              nextLoading,
              initialSourcePath,
              suppressVaultSkill,
              skillDepth + 1,
              [],
              aggregatedSkillLinks,
              "",
              epoch,
              // Nothing new ran (every call repeated or was refused): no more
              // tools, so the model answers instead of calling again.
              { pastCalls, timelineEl, skillsSuppressed: !ranSomething },
            );
          }
          return;
        }
        // No skill calls — this is the final answer. Save it to history.
        if (fullContent || fullReasoning) {
          this.history.push({
            role: "assistant",
            content: fullContent,
            reasoning: fullReasoning || undefined,
            context: passages || undefined,
            sources: this.vaultSourcesOf(fullContent, sources.length ? sources : this.turnSources),
          });
        }
        if (bubbleEl && skillSourceLinks.length > 0) {
          this.renderSkillSourceLinks(bubbleEl, pillsForAnswer(skillSourceLinks, fullContent));
        }

        if (!this.contentEl.isConnected) return;
        this.plugin.historyManager.append({
          id: this.conversationId,
          title: this.history.find((m) => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
          timestamp: Date.now(),
          messages: this.history,
        });
      }
    } catch (e: unknown) {
      // Stop aborts the request, which usually surfaces here rather than as the
      // end of the stream; whatever arrived before it is kept.
      if (this.generationEpoch !== epoch) {
        try {
          keepPartialReply();
        } catch {
          // The reply already failed; keeping its first part is a courtesy.
        }
        new Notice("Generation stopped.");
      } else if (e instanceof DOMException && e.name === "AbortError") {
        new Notice("Generation stopped.");
      } else {
        // A request too long for the model is explained, with what to do.
        const provider = this.plugin.settings.aiProvider;
        const explained = explainContextOverflow(
          e instanceof Error ? e.message : String(e),
          provider,
          providerInfo(provider).name,
        );
        this.plugin.handleError(explained ? new Error(explained) : e);
      }
    } finally {
      if (loadingEl) loadingEl.remove();
      // After Stop, a new request may already be running; its state is not ours to reset.
      if (this.generationEpoch === epoch) {
        this.isGenerating = false;
        setIcon(this.sendBtn, "send");
        this.sendBtn.classList.remove("horme-stop-btn");
        this.activeAbortController = null;
        this.activeReader = null;
      }
    }
  }

  /** Regenerate needs the request that produced the latest reply, sent to the same provider. */
  private canRegenerate(): boolean {
    const last = this.history[this.history.length - 1];
    return (
      Boolean(this.lastMsgs) &&
      this.lastModel !== null &&
      this.lastProvider === this.plugin.settings.aiProvider &&
      last?.role === "assistant"
    );
  }

  private addAssistantActions(bubbleEl: HTMLElement, content: string) {
    const wrapper = this.messagesEl.createDiv("horme-save-wrapper");
    const copyBtn = wrapper.createEl("button", { cls: "horme-save-btn", attr: { "aria-label": "Copy" } });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(content)
        .then(() => new Notice("Copied to clipboard"))
        .catch((e) => this.plugin.handleError(e, "Clipboard"));
    });

    const regenBtn = wrapper.createEl("button", {
      cls: "horme-save-btn",
      attr: { "aria-label": "Regenerate" },
    });
    setIcon(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      if (this.isGenerating || this.sendInFlight) return;
      // Only the latest reply: an older one would be removed from view while
      // the newest was replaced in the history.
      const last = this.history[this.history.length - 1];
      if (!this.canRegenerate() || last.content !== content) {
        new Notice("Horme: Only the latest reply can be regenerated, with the provider it came from.");
        return;
      }
      bubbleEl.remove();
      wrapper.remove();
      void this.sendMessage(true).catch((e) => this.plugin.handleError(e, "Chat"));
    });

    const saveBtn = wrapper.createEl("button", {
      cls: "horme-save-btn",
      attr: { "aria-label": "Save as note" },
    });
    setIcon(saveBtn, "file-plus");
    saveBtn.addEventListener("click", () => {
      // The conversation up to and including this reply: the questions belong
      // with the answers. A reply no longer in the history (another chat was
      // opened) is saved on its own.
      let end = -1;
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].content === content) {
          end = i;
          break;
        }
      }
      const messages = end >= 0 ? this.history.slice(0, end + 1) : [{ role: "assistant" as const, content }];
      void this.saveMessagesAsNote(messages, "Saved").catch((e) => this.plugin.handleError(e));
    });
  }

  private addUserActions(content: string) {
    const wrapper = this.messagesEl.createDiv("horme-save-wrapper horme-save-wrapper-user");
    const copyBtn = wrapper.createEl("button", { cls: "horme-save-btn", attr: { "aria-label": "Copy" } });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(content)
        .then(() => new Notice("Copied to clipboard"))
        .catch((e) => this.plugin.handleError(e, "Clipboard"));
    });
  }

  /** Moves a meta bubble (thinking/passages) above the answer content. */
  private pinToTop(container: HTMLElement, el: HTMLElement): void {
    const contentArea = container.querySelector(".horme-content-area");
    if (contentArea) container.insertBefore(el, contentArea);
  }

  /**
   * Renders the model's reasoning/thinking trace as a collapsed, Markdown-formatted
   * bubble pinned to the top of the response. Used when restoring from history.
   */
  private async appendReasoningBubble(
    container: HTMLElement,
    reasoning: string,
    sourcePath: string,
  ): Promise<void> {
    if (!reasoning.trim()) return;
    const details = container.createEl("details", { cls: "horme-thinking-details" });
    details.createEl("summary", { text: "Reasoning process", cls: "horme-thinking-summary" });
    const body = details.createDiv("horme-thinking-body");
    this.pinToTop(container, details);
    await MarkdownRenderer.render(this.app, reasoning, body, sourcePath, this);
  }

  /**
   * Renders the exact RAG passages that were sent to the model as a collapsed,
   * Markdown-formatted bubble shown beneath the reasoning bubble, pinned to the top.
   */
  private async appendPassagesBubble(
    container: HTMLElement,
    passages: string,
    sourcePath: string,
  ): Promise<void> {
    if (!passages.trim()) return;
    if (container.querySelector(".horme-passages-details")) return;
    const count = passages.split("\n\n---\n\n").filter((p) => p.trim()).length;
    const details = container.createEl("details", { cls: "horme-passages-details" });
    const label = count > 1 ? `Passages sent to the model (${count})` : "Passage sent to the model";
    details.createEl("summary", { text: label, cls: "horme-passages-summary" });
    const body = details.createDiv("horme-passages-body");
    this.pinToTop(container, details);
    await MarkdownRenderer.render(this.app, passages, body, sourcePath, this);
  }

  private async renderSkillResultBox(skillId: string, displayName: string, params: unknown, result: string) {
    const summaryText = formatSkillSummary(displayName, params);
    const resultBubble = this.messagesEl.createDiv("horme-msg horme-msg-assistant horme-skill-only");
    const details = resultBubble.createEl("details", { cls: "horme-reasoning-details" });
    const summaryEl = details.createEl("summary", { cls: "horme-reasoning-summary" });
    const summaryIcon = summaryEl.createSpan({ cls: "horme-skill-summary-icon" });
    setIcon(summaryIcon, this.getSkillIcon(skillId));
    summaryEl.appendText(` ${summaryText}`);
    const body = details.createDiv("horme-reasoning-body");
    await MarkdownRenderer.render(this.app, result, body, "", this);
    // A picture already shown for this message (say by a Wikipedia lookup) is not repeated.
    const images = imagesFromSkillResult(result).filter((img) => !this.shownImageUrls.has(img.thumbUrl));
    for (const img of images) this.shownImageUrls.add(img.thumbUrl);
    if (images.length > 0) this.pictures.renderImageGallery(resultBubble, images);
    this.scrollToBottom();
  }

  /** The latest message the user sent. */
  private lastUserText(): string {
    for (let i = this.history.length - 1; i >= 0; i--)
      if (this.history[i].role === "user") return this.history[i].content;
    return "";
  }

  /** Lookups that come with a picture of their subject in "With every lookup" mode. */
  private static readonly PICTURE_LOOKUPS = new Set(["britannica", "ddg_search", "deep_research"]);

  /** Starts Find image for a lookup's subject, when answers come with a picture of it. */
  private pictureAlongside(call: SkillCall): Promise<{ query: string; result: string } | null> | null {
    if (this.plugin.settings.imagesInAnswers !== "always") return null;
    if (!HormeChatView.PICTURE_LOOKUPS.has(call.skillId)) return null;
    return this.pictureFor(call);
  }

  /** A Wikipedia lookup whose article has no picture gets one from Find image ("With every lookup"). */
  private async pictureAfterLookup(
    call: SkillCall,
    result: string,
  ): Promise<{ query: string; result: string } | null> {
    if (this.plugin.settings.imagesInAnswers !== "always" || call.skillId !== "wikipedia") return null;
    if (imagesFromSkillResult(result).length > 0 || /^Error:|^No Wikipedia/i.test(result)) return null;
    return this.pictureFor(call);
  }

  private async pictureFor(call: SkillCall): Promise<{ query: string; result: string } | null> {
    // One picture per message is enough; the first lookup's subject is the one asked about.
    if (this.shownImageUrls.size > 0) return null;
    const skill = this.plugin.skillManager.getSkillById(call.skillId);
    const raw = call.parameters as Record<string, unknown> | null;
    const value = raw?.[skill?.primaryParam ?? "query"] ?? raw?.query;
    const query = typeof value === "string" ? value.trim() : "";
    if (!query || query.length > 120) return null;
    if (!this.plugin.settings.imageSources.some((src) => sourceReady(this.plugin, src.id))) return null;
    const result = await this.plugin.skillManager
      .executeSkill({ skillId: "find_image", parameters: { query, count: 1 } })
      .catch(() => "");
    return imagesFromSkillResult(result).length > 0 ? { query, result } : null;
  }

  /** The source pills of a pictures-only reply, under the last picture cards. */
  private pillsUnderPictures(pills: SourcePill[]): void {
    const boxes = this.messagesEl.querySelectorAll<HTMLElement>(".horme-msg.horme-skill-only");
    const host = boxes[boxes.length - 1];
    if (host) this.renderSkillSourceLinks(host, pills);
  }

  /**
   * Ends a turn that only showed pictures. The cards are the reply (title, credit,
   * link); the titles and credits are kept in the history for the model and notes.
   */
  private finishWithPictures(results: string[], pills: SourcePill[]): void {
    const text = imagesSummary(results.flatMap((r) => imagesFromSkillResult(r)));
    this.history.push({ role: "assistant", content: text, picturesOnly: true });
    this.pillsUnderPictures(pills);
    // Regenerate would replay a request whose answer was never the model's.
    this.lastMsgs = null;
    if (!this.contentEl.isConnected) return;
    this.plugin.historyManager.append({
      id: this.conversationId,
      title: this.history.find((m) => m.role === "user")?.content.slice(0, 60) || "Untitled chat",
      timestamp: Date.now(),
      messages: this.history,
    });
    this.followAndScroll();
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

  /** The pills under an answer: numbered like the answer's [n] citations, named by what the source is. */
  private renderSkillSourceLinks(bubbleEl: HTMLElement, pills: SourcePill[]) {
    if (pills.length === 0) return;
    const sourcesEl = bubbleEl.createDiv("horme-sources-container horme-skill-sources-container");
    sourcesEl.createSpan({ text: "Skill sources:", cls: "horme-sources-label" });

    const listEl = sourcesEl.createDiv("horme-sources-list");
    for (const pill of pills) {
      const anchor = listEl.createEl("a", {
        href: pill.url,
        cls: "horme-source-pill horme-source-link-pill",
      });
      if (pill.n !== undefined) anchor.createSpan({ cls: "horme-source-num", text: String(pill.n) });
      anchor.createSpan({ cls: "horme-source-name", text: pill.label });
      anchor.setAttr("target", "_blank");
      anchor.setAttr("rel", "noopener noreferrer");
      anchor.title = `${pill.n !== undefined ? `[${pill.n}] ` : ""}${pill.label}\n${pill.url}`;
    }
  }

  private renderSources(bubbleEl: HTMLElement, paths: string[]) {
    if (paths.length === 0) return;

    const sourcesEl = bubbleEl.createDiv("horme-sources-container");
    sourcesEl.createSpan({ text: "Sources:", cls: "horme-sources-label" });

    const listEl = sourcesEl.createDiv("horme-sources-list");
    paths.forEach((path) => {
      const filename = path.split("/").pop() || path;
      const pill = listEl.createSpan({ text: filename, cls: "horme-source-pill" });
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
    if (!this.history.length) {
      new Notice("Horme: This chat is empty.");
      return;
    }
    await this.saveMessagesAsNote(this.history, "Exported");
  }

  /** Writes messages as a Markdown note named after the first question. */
  private async saveMessagesAsNote(messages: ChatMessage[], verb: string): Promise<void> {
    const folder = await ensureVaultFolder(this.app, this.plugin.settings.exportFolder.trim() || "HORME");
    const body = messages
      .map((m) => {
        if (m.role === "user") return `**You**:\n${m.content}\n`;
        if (m.role === "tool_result" || (m.role === "system" && m.content.startsWith("[SKILL RESULT:"))) {
          const callout = `> [!info]- Skill result\n> ${withoutImageData(m.content).trim().replace(/\n/g, "\n> ")}\n`;
          const pictures = imagesToMarkdown(imagesFromSkillResult(m.content));
          return pictures ? `${callout}\n${pictures}\n` : callout;
        }
        if (m.role === "system") return "";
        if (m.picturesOnly) return "";
        const thought = m.reasoning?.trim()
          ? `> [!thought]- Reasoning\n> ${m.reasoning.trim().replace(/\n/g, "\n> ")}\n\n`
          : "";
        return `**Horme**:\n${thought}${m.content}\n`;
      })
      .filter(Boolean)
      .join("\n---\n\n");
    const firstQuestion = messages.find((m) => m.role === "user")?.content ?? "";
    const title =
      firstQuestion
        .replace(/[\\/:*?"<>|#^[\]{}\n\r\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60)
        .trim() || (this.uploadedDocName ? this.uploadedDocName.replace(/\.[^.]+$/, "") : "Horme chat");
    let fileName = normalizePath(`${folder}/${title}.md`);
    for (let n = 2; await this.app.vault.adapter.exists(fileName); n++) {
      fileName = normalizePath(`${folder}/${title} ${n}.md`);
    }
    await this.app.vault.create(fileName, body);
    new Notice(`${verb} to ${fileName}`);
  }

  private addMessageBubble(role: "user" | "assistant", content: string, images?: string[]): HTMLElement {
    if (role === "user") this.shownImageUrls.clear();
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

    // Chronometer: counts up in whole seconds from 0
    const timerEl = el.createSpan({ cls: "horme-loading-timer", text: "0s" });
    let seconds = 0;
    const intervalId = window.setInterval(() => {
      seconds++;
      timerEl.textContent = `${seconds}s`;
    }, 1000);

    // Track the interval so onClose() can clear it deterministically.
    // The previous MutationObserver approach leaked because contentEl.empty()
    // detaches the parent (messagesEl), not the child (el), so the observer
    // callback never fired and the interval ran forever.
    this.activeLoadingIntervals.add(intervalId);

    // Self-cleanup when the element is removed during normal operation
    // (e.g., loadingEl.remove() after generation completes).
    const origRemove = el.remove.bind(el);
    el.remove = () => {
      window.clearInterval(intervalId);
      this.activeLoadingIntervals.delete(intervalId);
      origRemove();
    };

    const dots = el.createSpan({ cls: "horme-dot-pulse" });
    dots.createSpan();
    dots.createSpan();
    dots.createSpan();
    this.scrollToBottom();
    return el;
  }

  private renderEmpty() {
    const empty = this.messagesEl.createDiv("horme-empty");
    const iconWrap = empty.createDiv("horme-empty-icon");
    setIcon(iconWrap, "cone");
    const svg = iconWrap.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "72");
      svg.setAttribute("height", "72");
    }
    empty.createDiv({ cls: "horme-empty-text", text: "Start a conversation with Horme." });
  }

  /** Per-chat state that must not carry over to another chat. */
  private resetChatState() {
    this.uploadedDocContent = null;
    this.uploadedDocName = null;
    this.uploadedImages = [];
    this.uploadedAudio = null;
    this.lastMsgs = null;
    this.lastModel = null;
    this.lastProvider = null;
    this.rollingRAGContext = [];
    this.lastInjectedPassages = "";
    this.context.clear();
    this.updateContextNotesLabel();
  }

  private async clearChat() {
    // A reply still streaming belongs to the chat being left.
    if (this.isGenerating || this.sendInFlight) await this.stopGeneration();
    this.resetChatState();
    this.history = [];
    this.conversationId = this.generateId();
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
    if (!this.history.length) {
      this.renderEmpty();
      return;
    }
    const aggregatedSkillLinks: SourcePill[] = [];
    for (const m of this.history) {
      if (m.role === "tool_result") {
        const match = m.content.match(/^\[SKILL RESULT: ([a-zA-Z0-9_]+)\]\n\n([\s\S]*)$/);
        if (match) {
          const skill = this.plugin.skillManager.getSkillById(match[1]);
          await this.renderSkillResultBox(match[1], skill?.name ?? match[1], {}, match[2]);
          if (!VAULT_SKILLS.has(match[1])) mergePills(aggregatedSkillLinks, pillsFromSkillResult(match[2]));
        }
        continue;
      }
      if (m.role === "assistant" && m.picturesOnly) {
        this.pillsUnderPictures([...aggregatedSkillLinks]);
        aggregatedSkillLinks.length = 0;
        continue;
      }
      if (m.role === "user" || m.role === "assistant") {
        const bubble = this.addMessageBubble(m.role, "", m.images);
        if (m.role === "assistant") {
          const displayContent = stripSkillCallXml(m.content);
          const contentArea = bubble.querySelector(".horme-content-area") as HTMLElement;
          if (contentArea) {
            contentArea.empty();
            if (displayContent) {
              await MarkdownRenderer.render(this.app, displayContent, contentArea, "", this);
            }
          } else if (displayContent) {
            await MarkdownRenderer.render(this.app, displayContent, bubble, "", this);
          }
          await this.appendReasoningBubble(bubble, m.reasoning ?? "", "");
          await this.appendPassagesBubble(bubble, m.context ?? "", "");
          this.addAssistantActions(bubble, m.content);
          this.renderSources(bubble, m.sources ?? []);
          if (aggregatedSkillLinks.length > 0) {
            this.renderSkillSourceLinks(bubble, pillsForAnswer(aggregatedSkillLinks, m.content));
            aggregatedSkillLinks.length = 0;
          }
        } else {
          const contentArea = bubble.querySelector(".horme-content-area") as HTMLElement;
          if (contentArea) contentArea.textContent = m.content;
          this.addUserActions(m.content);
        }
      }
    }
    this.followAndScroll();
  }

  private async renderHistoryView() {
    this.messagesEl.empty();
    const panel = this.messagesEl.createDiv("horme-history-panel");
    const header = panel.createDiv("horme-history-header");
    header.createEl("h4", { text: "Chat history" });

    const backBtn = header.createEl("button", { text: "Close", cls: "horme-history-back" });
    backBtn.addEventListener("click", () => {
      this.showingHistory = false;
      void this.renderChatView().catch((e) => this.plugin.handleError(e));
    });

    const deleteAllBtn = header.createEl("button", {
      text: "Delete all",
      cls: "horme-history-delete-all mod-warning",
    });
    deleteAllBtn.addEventListener("click", () => {
      new GenericConfirmModal(
        this.app,
        "Are you sure you want to delete ALL chat history? This cannot be undone.",
        () => {
          void (async () => {
            await this.plugin.historyManager.deleteAll();
            await this.renderHistoryView();
          })().catch((e) => this.plugin.handleError(e));
        },
      ).open();
    });

    const list = panel.createDiv("horme-history-list");
    const convos = await this.plugin.historyManager.load();
    if (!convos.length) {
      list.createDiv({ cls: "horme-history-empty", text: "No saved conversations" });
      return;
    }
    for (const c of convos) {
      const item = list.createDiv("horme-history-item");
      const info = item.createDiv("horme-history-item-info");
      info.createDiv({ cls: "horme-history-item-title", text: c.title });
      info.createDiv({ cls: "horme-history-item-date", text: new Date(c.timestamp).toLocaleString() });
      info.addEventListener("click", () => {
        void this.loadConversation(c).catch((e) => this.plugin.handleError(e));
      });

      const delBtn = item.createDiv("horme-history-item-delete");
      setIcon(delBtn, "trash-2");
      delBtn.title = "Delete conversation";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        new GenericConfirmModal(this.app, "Delete this conversation?", () => {
          void (async () => {
            await this.plugin.historyManager.delete(c.id);
            await this.renderHistoryView();
          })().catch((err) => this.plugin.handleError(err));
        }).open();
      });
    }
  }

  private async loadConversation(convo: SavedConversation) {
    if (this.isGenerating || this.sendInFlight) await this.stopGeneration();
    this.resetChatState();
    this.showingHistory = false;
    this.conversationId = convo.id;
    this.history = convo.messages.map((m) => ({
      role: m.role,
      content: m.content,
      images: m.images,
      audio: m.audio,
      reasoning: m.reasoning,
      context: m.context,
      sources: m.sources,
      picturesOnly: m.picturesOnly,
    }));
    this.lastMsgs = null;
    this.lastModel = null;
    await this.renderChatView();
  }

  /** Follows new output only while the reader is at the bottom; scrolling up pauses it. */
  private scrollToBottom() {
    if (!this.followOutput) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * The answer rewritten in the question's language by the same model, links,
   * citations and note links kept. Kept only when it came back in that
   * language; otherwise the answer stays as written.
   */
  private async inLanguage(text: string, language: "English" | "Spanish", model: string): Promise<string> {
    try {
      const out = await this.plugin.aiGateway.generate(
        text,
        `Rewrite the user's text in ${language}. Translate the prose only: keep the Markdown, every link, ` +
          `every [n] citation, every [[note link]], names, numbers and quotations from sources exactly as they are. ` +
          `Reply with the rewritten text and nothing else.`,
        model,
        true,
      );
      const clean = out.trim();
      return clean && replyLanguage(clean) === language ? clean : text;
    } catch {
      return text;
    }
  }

  /** "Nothing in your vault on this." first, when this message's vault search found nothing. */
  private withVaultNotice(text: string): string {
    if (
      !this.turnVaultNothing ||
      !text ||
      text.startsWith(VAULT_NOTHING) ||
      this.vaultSkillFound(["vault_query", "vault_links", "grammar_scholar"])
    )
      return text;
    return `${VAULT_NOTHING}\n\n${text}`;
  }

  /** The notes this answer drew on, out of those sent with the message (see notesUsed). */
  private notesBehind(answer: string, sent: string[]): string[] {
    if (!sent.length || !this.turnPassages) return sent;
    const byNote = new Map<string, string>();
    for (const chunk of this.turnPassages.split("\n\n---\n\n")) {
      const path = passageNotePath(chunk);
      if (path && sent.includes(path)) byNote.set(path, `${byNote.get(path) ?? ""}\n${chunk}`);
    }
    return notesUsed(answer, byNote, sent, this.lastUserText());
  }

  /** Whether one of these skills ran since the user's last message and found something. */
  private vaultSkillFound(ids: string[]): boolean {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === "user") break;
      if (m.role !== "tool_result" && m.role !== "system") continue;
      const hit = /^\[SKILL RESULT: ([a-zA-Z0-9_]+)\]\n\n([\s\S]*)$/.exec(m.content);
      if (hit && ids.includes(hit[1]) && !skillFailed(hit[2])) return true;
    }
    return false;
  }

  /** Titles of the notes Create Concept Note made since the user's last message. */
  private notesCreatedThisTurn(): string[] {
    const titles: string[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === "user") break;
      if (m.role !== "tool_result" || !m.content.startsWith("[SKILL RESULT: create_concept_note]")) continue;
      const title = /Created concept note \[\[([^\]|]+)\]\]/.exec(m.content)?.[1];
      if (title && !titles.includes(title)) titles.push(title);
    }
    return titles;
  }

  /** The skills that ran since the user's last message. */
  private skillsThisTurn(): string[] {
    const ids: string[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === "user") break;
      const id = /^\[SKILL RESULT: ([a-zA-Z0-9_]+)\]/.exec(m.content)?.[1];
      if ((m.role === "tool_result" || m.role === "system") && id) ids.push(id);
    }
    return ids;
  }

  /**
   * The vault notes to list under an answer as its sources: none when the
   * answer says the vault had nothing, and none when a skill other than the
   * vault's own answered (the date calculator, grammar notes, the web): that
   * answer lists the skill's own sources. (A grounding score let a date
   * answer list unrelated notes that happen to mention 1914.)
   */
  private vaultSourcesOf(answer: string, candidates: string[]): string[] {
    if (answer.startsWith(VAULT_NOTHING) || answer.startsWith(VAULT_NOTHING_ES)) return [];
    const skills = this.skillsThisTurn();
    if (skills.some((id) => id !== "vault_links" && id !== "vault_query")) return [];
    const notes = this.notesBehind(answer, candidates);
    // The vault's own skills answer with notes they name: of the passages sent
    // with the question, only the notes the answer names are its sources.
    if (skills.length === 0) return notes;
    const said = answer.toLowerCase();
    return notes.filter((path) => {
      const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "").toLowerCase();
      return title.length > 2 && said.includes(title);
    });
  }

  /** Whether a skill that looks outside the vault (web, encyclopaedias…) ran since the user's last message. */
  private outsideSkillThisTurn(): boolean {
    const local = new Set(["vault_links", "vault_query", "grammar_scholar", "date_calc"]);
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === "user") break;
      const id = /^\[SKILL RESULT: ([a-zA-Z0-9_]+)\]/.exec(m.content)?.[1];
      if ((m.role === "tool_result" || m.role === "system") && id && !local.has(id)) return true;
    }
    return false;
  }

  /** The numbered sources of the latest Deep Research result since the user's last message. */
  private researchSourcesForTurn(): Map<number, CitedSource> {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === "user") break;
      if (
        (m.role === "tool_result" || m.role === "system") &&
        m.content.includes("[SKILL RESULT: deep_research]")
      ) {
        const found = parseResearchSources(m.content);
        if (found.size) return found;
      }
    }
    return new Map();
  }

  /** Back to following the output (a new message, another chat). */
  private followAndScroll() {
    this.followOutput = true;
    this.scrollToBottom();
  }

  /**
   * Renders Markdown off-screen and swaps it in whole. Emptying the bubble
   * first made it collapse and redraw on every update (flicker, scroll jumps),
   * and a slow earlier render could land after the final one.
   */
  private async renderMarkdownInto(target: HTMLElement, text: string, sourcePath: string): Promise<void> {
    const seq = (this.renderSeq.get(target) ?? 0) + 1;
    this.renderSeq.set(target, seq);
    const staging = createDiv();
    await MarkdownRenderer.render(this.app, text, staging, sourcePath, this);
    if (this.renderSeq.get(target) !== seq) return;
    // Citation numbers read as footnote markers, [3][4], without Obsidian's
    // external-link arrow after each one.
    staging.querySelectorAll("a.external-link").forEach((a) => {
      if (/^\[\d{1,3}\]$/.test(a.textContent ?? "")) a.addClass("horme-citation");
    });
    target.replaceChildren(...Array.from(staging.childNodes));
  }
  private autoGrow() {
    // Without a height of its own the box takes the height of its rows (no rule sets
    // one), so its scrollHeight is the height its text needs.
    this.inputEl.setCssProps({ height: "" });
    this.inputEl.setCssProps({ height: `${Math.min(this.inputEl.scrollHeight, 140)}px` });
  }

  /**
   * Step timeline: one visible numbered row per skill call for the whole
   * chain (Dive-style), instead of transient loading spinners only.
   */
  private ensureAgentTimeline(timelineEl: HTMLElement | null): HTMLElement {
    if (timelineEl && timelineEl.isConnected) return timelineEl;
    const el = this.messagesEl.createDiv("horme-agent-timeline");
    el.createDiv({ cls: "horme-agent-timeline-title", text: "Steps" });
    this.scrollToBottom();
    return el;
  }

  private addTimelineStep(timelineEl: HTMLElement, displayName: string, params: unknown): HTMLElement {
    const stepNumber = timelineEl.querySelectorAll(".horme-agent-step").length + 1;
    const row = timelineEl.createDiv("horme-agent-step horme-agent-step-pending");
    row.createSpan({ cls: "horme-agent-step-num", text: `${stepNumber}.` });
    const summary = stepSummary(params);
    const label = row.createSpan({
      cls: "horme-agent-step-label",
      text: summary ? `${displayName} — ${summary}` : displayName,
    });
    const full =
      params && typeof params === "object" ? Object.values(params).find((v) => typeof v === "string") : "";
    label.title = typeof full === "string" && full ? `${displayName} — ${full}` : displayName;
    row.createSpan({ cls: "horme-agent-step-status", text: "…" });
    this.scrollToBottom();
    return row;
  }

  private completeTimelineStep(stepRow: HTMLElement, isError: boolean) {
    stepRow.removeClass("horme-agent-step-pending");
    stepRow.addClass(isError ? "horme-agent-step-fail" : "horme-agent-step-ok");
    const status = stepRow.querySelector(".horme-agent-step-status");
    if (status) status.textContent = isError ? "✗" : "✓";
  }
}
