import { App, FuzzySuggestModal, TFile } from "obsidian";

export class NotePickerModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Search notes to add as context…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles()
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}
