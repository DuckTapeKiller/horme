import { AbstractInputSuggest, App, TAbstractFile, TFile, TFolder } from "obsidian";

export class StringSuggest extends AbstractInputSuggest<string> {
  inputEl: HTMLInputElement;
  private itemsFn: () => string[];

  constructor(app: App, inputEl: HTMLInputElement, itemsFn: () => string[]) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.itemsFn = itemsFn;
  }

  getSuggestions(inputStr: string): string[] {
    const query = inputStr.toLowerCase();
    const items = this.itemsFn() || [];

    // If the user hasn't typed anything yet, show the first few suggestions.
    if (!query) return items.slice(0, 100);

    const out: string[] = [];
    for (const item of items) {
      if (!item) continue;
      if (item.toLowerCase().includes(query)) out.push(item);
      if (out.length >= 100) break;
    }
    return out;
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.inputEl.value = value;
    this.inputEl.trigger("input");
    this.close();
  }
}

export class FileSuggest extends AbstractInputSuggest<TFile> {
  inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  getSuggestions(inputStr: string): TFile[] {
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    const files: TFile[] = [];
    const lowerCaseInputStr = inputStr.toLowerCase();

    abstractFiles.forEach((file: TAbstractFile) => {
      if (
        file instanceof TFile &&
        file.extension === "md" &&
        file.path.toLowerCase().contains(lowerCaseInputStr)
      ) {
        files.push(file);
      }
    });

    return files.slice(0, 100);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.inputEl.trigger("input");
    this.close();
  }
}

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  getSuggestions(inputStr: string): TFolder[] {
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    const folders: TFolder[] = [];
    const lowerCaseInputStr = inputStr.toLowerCase();

    abstractFiles.forEach((file: TAbstractFile) => {
      if (file instanceof TFolder && file.path.toLowerCase().contains(lowerCaseInputStr)) {
        folders.push(file);
      }
    });

    return folders.slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.close();
  }
}

export class FileOrFolderSuggest extends AbstractInputSuggest<TAbstractFile> {
  inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  getSuggestions(inputStr: string): TAbstractFile[] {
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    const suggestions: TAbstractFile[] = [];
    const lowerCaseInputStr = inputStr.toLowerCase();

    abstractFiles.forEach((file: TAbstractFile) => {
      if (
        (file instanceof TFolder || (file instanceof TFile && file.extension === "md")) &&
        file.path.toLowerCase().contains(lowerCaseInputStr)
      ) {
        suggestions.push(file);
      }
    });

    return suggestions.slice(0, 100);
  }

  renderSuggestion(file: TAbstractFile, el: HTMLElement): void {
    el.setText(file.path);
    if (file instanceof TFolder) {
      el.addClass("horme-suggest-folder");
    }
  }

  selectSuggestion(file: TAbstractFile): void {
    this.inputEl.value = file.path;
    this.inputEl.trigger("input");
    this.close();
  }
}
