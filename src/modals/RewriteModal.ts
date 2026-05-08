import { App, Modal } from "obsidian";

const TONES = [
  { label: "◆ Formal", value: "formal" },
  { label: "○ Friendly", value: "friendly" },
  { label: "▲ Academic", value: "academic" },
  { label: "◇ Sarcastic", value: "sarcastic" },
  { label: "■ Aggressive", value: "aggressive" },
  { label: "● Humanise", value: "humanise" },
];

export class RewriteModal extends Modal {
  private onSubmit: (tone: string) => void;

  constructor(app: App, onSubmit: (tone: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Rewrite in what tone?" });

    const grid = contentEl.createDiv();
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "1fr 1fr";
    grid.style.gap = "8px";
    grid.style.marginTop = "8px";

    for (const tone of TONES) {
      const btn = grid.createEl("button", { text: tone.label });
      btn.addClass("mod-cta");
      btn.style.padding = "10px 16px";
      btn.style.fontSize = "14px";
      btn.style.cursor = "pointer";
      btn.addEventListener("click", () => {
        this.onSubmit(tone.value);
        this.close();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
