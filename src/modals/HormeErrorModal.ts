import { App, Modal } from "obsidian";

export class HormeErrorModal extends Modal {
  private title: string;
  private message: string;
  private detail: string | null;

  constructor(app: App, title: string, message: string, detail?: string) {
    super(app);
    this.title = title;
    this.message = message;
    this.detail = detail || null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("horme-error-modal");

    contentEl.createEl("h2", {
      text: `⚠️ ${this.title}`,
      cls: "horme-error-modal-title"
    });

    contentEl.createEl("p", {
      text: this.message,
      cls: "horme-error-modal-message"
    });

    if (this.detail) {
      const details = contentEl.createEl("details", {
        cls: "horme-error-modal-details"
      });
      details.createEl("summary", { text: "Technical detail" });
      details.createEl("code", { text: this.detail });
    }

    const btnRow = contentEl.createDiv("horme-error-modal-btn-row");
    const closeBtn = btnRow.createEl("button", {
      text: "OK",
      cls: "mod-cta"
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
