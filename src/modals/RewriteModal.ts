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
    grid.setCssProps({
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "8px",
      marginTop: "8px"
    });

    for (const tone of TONES) {
      const btn = grid.createEl("button", { text: tone.label });
      btn.addClass("mod-cta");
      btn.setCssProps({
        padding: "10px 16px",
        fontSize: "14px",
        cursor: "pointer"
      });
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
