import { App, Modal } from "obsidian";

export class ConfirmReplaceModal extends Modal {
  private original: string;
  private replacement: string;
  private onAccept: (edited: string) => void;

  constructor(app: App, original: string, replacement: string, onAccept: (edited: string) => void) {
    super(app);
    this.original = original;
    this.replacement = replacement;
    this.onAccept = onAccept;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("horme-diff-modal");
    contentEl.createEl("h3", { text: "Review changes" });

    const container = contentEl.createDiv("horme-diff-container");

    const origCol = container.createDiv("horme-diff-col");
    origCol.createEl("div", { text: "Original", cls: "horme-diff-label horme-diff-label-old" });
    origCol.createEl("pre", { text: this.original, cls: "horme-diff-text" });

    const newCol = container.createDiv("horme-diff-col");
    newCol.createEl("div", { text: "Replacement (Editable)", cls: "horme-diff-label horme-diff-label-new" });
    const editArea = newCol.createEl("textarea", { cls: "horme-diff-text horme-diff-textarea" });
    editArea.value = this.replacement;

    const btnRow = contentEl.createDiv("horme-diff-buttons");
    const acceptBtn = btnRow.createEl("button", { text: "Accept", cls: "mod-cta" });
    acceptBtn.addEventListener("click", () => {
      this.onAccept(editArea.value);
      this.close();
    });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
