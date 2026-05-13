import { App, Modal } from "obsidian";

export class ConversionModal extends Modal {
  private fileName: string;
  private extension: string;
  private onConvert: (format: string) => void;
  private statusEl: HTMLElement;
  private progressBar: HTMLElement;
  private configEl: HTMLElement;
  private progressEl: HTMLElement;

  constructor(app: App, fileName: string, extension: string, onConvert: (format: string) => void) {
    super(app);
    this.fileName = fileName;
    this.extension = extension;
    this.onConvert = onConvert;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("horme-pdf-modal");

    contentEl.createEl("h3", { text: "Convert Document" });
    contentEl.createEl("p", { text: `Source: ${this.fileName}`, cls: "horme-pdf-filename" });

    this.configEl = contentEl.createDiv("horme-modal-config");
    this.configEl.createEl("label", { text: "Output Format:", cls: "horme-label" });
    const formatSelect = this.configEl.createEl("select", { cls: "horme-select" });
    
    if (this.extension === "pdf") {
      formatSelect.createEl("option", { text: "Markdown (.md)", value: "markdown" });
      formatSelect.createEl("option", { text: "Word (.docx)", value: "docx" });
    } else if (this.extension === "md") {
      formatSelect.createEl("option", { text: "Word (.docx)", value: "docx" });
      formatSelect.createEl("option", { text: "PDF (.pdf)", value: "pdf" });
    }

    const btnRow = contentEl.createDiv("horme-modal-buttons");
    const convertBtn = btnRow.createEl("button", { text: "Convert", cls: "mod-cta" });
    convertBtn.addEventListener("click", () => {
      this.onConvert(formatSelect.value);
    });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    // Progress section (hidden initially)
    this.progressEl = contentEl.createDiv("horme-progress-section");
    this.progressEl.setCssProps({ display: "none" });

    const progressContainer = this.progressEl.createDiv("horme-progress-container");
    this.progressBar = progressContainer.createDiv("horme-progress-bar");
    this.progressBar.setCssProps({ width: "0%" });

    this.statusEl = this.progressEl.createDiv("horme-progress-status");
    this.statusEl.textContent = "Initializing...";
  }

  setStarted() {
    this.configEl.setCssProps({ display: "none" });
    this.progressEl.setCssProps({ display: "flex" });
    const btns = this.contentEl.querySelectorAll("button");
    btns.forEach(b => (b.disabled = true));
  }

  updateProgress(percent: number, status: string) {
    this.progressBar.setCssProps({ width: `${percent * 100}%` });
    this.statusEl.textContent = status;
  }

  onClose() {
    this.contentEl.empty();
  }
}
