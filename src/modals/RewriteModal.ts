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

    const grid = contentEl.createDiv("horme-tone-grid");

    for (const tone of TONES) {
      const btn = grid.createEl("button", { text: tone.label });
      btn.addClasses(["mod-cta", "horme-tone-btn"]);
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
