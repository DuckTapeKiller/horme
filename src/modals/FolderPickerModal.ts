import { App, FuzzySuggestModal, TFolder } from "obsidian";

export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  private onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Search folders to add as context…");
  }

  getItems(): TFolder[] {
    const configDir = this.app.vault.configDir;
    return this.app.vault
      .getAllFolders(true)
      .filter((f) => f.path !== configDir)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(item: TFolder): string {
    return item.path;
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}
