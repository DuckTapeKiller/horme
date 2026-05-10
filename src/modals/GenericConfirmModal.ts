import { App, Modal, Setting } from "obsidian";

export class GenericConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;
  private onCancel?: () => void;

  constructor(app: App, message: string, onConfirm: () => void, onCancel?: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Confirm Action" });
    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Confirm")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Cancel")
          .onClick(() => {
            this.close();
            if (this.onCancel) this.onCancel();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
