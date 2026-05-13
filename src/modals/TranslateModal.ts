import { App, Modal } from "obsidian";

export class TranslateModal extends Modal {
  private onSubmit: (lang: string) => void;

  constructor(app: App, onSubmit: (lang: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Translate to…" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "e.g. Spanish, French, Japanese",
    });
    input.addClass("horme-input");
    input.setCssProps({
      width: "100%",
      marginBottom: "12px"
    });
    input.focus();

    const btn = contentEl.createEl("button", { text: "Translate" });
    btn.addClass("mod-cta");
    btn.addEventListener("click", () => {
      const lang = input.value.trim();
      if (lang) {
        this.onSubmit(lang);
        this.close();
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btn.click();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
