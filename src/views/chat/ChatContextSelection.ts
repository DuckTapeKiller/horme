import { Notice, TFile, TFolder, type App } from "obsidian";
import type HormePlugin from "../../../main";

export type ContextFolderSelection = { path: string; noteCount: number; totalChars: number };

/**
 * The notes and folders the user picked to go with the next questions, and
 * the text they become: folder notes are gathered once each, up to the
 * folder context limit, with a notice when that limit cuts them.
 */
export class ChatContextSelection {
  constructor(
    private app: App,
    private plugin: HormePlugin,
  ) {}

  notes: TFile[] = [];

  folders: ContextFolderSelection[] = [];

  truncationNoticeShown = false;

  filesUnder(folderPath: string): TFile[] {
    const normalized = folderPath === "/" ? "/" : folderPath.replace(/\/+$/, "");
    const allMd = this.app.vault.getMarkdownFiles();
    if (normalized === "/" || normalized === "") return allMd;
    const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
    return allMd.filter((f) => f.path.startsWith(prefix));
  }

  addFolder(folder: TFolder): void {
    const folderPath = folder.path || "/";
    const normalized = folderPath === "/" ? "/" : folderPath.replace(/\/+$/, "");

    if (this.folders.some((f) => f.path === normalized)) {
      new Notice(`Already added: ${normalized}`);
      return;
    }

    const files = this.filesUnder(normalized);
    if (files.length === 0) {
      new Notice("Horme: No notes found in that folder.");
      return;
    }

    const totalChars = files.reduce((sum, f) => sum + (f.stat?.size ?? 0), 0);
    this.folders.push({ path: normalized, noteCount: files.length, totalChars });
    this.folders.sort((a, b) => a.path.localeCompare(b.path));
    this.truncationNoticeShown = false;

    const limit = Math.max(1000, this.plugin.settings.contextFoldersMaxChars || 0);
    const totalSelectedChars = this.folders.reduce((sum, f) => sum + (f.totalChars || 0), 0);

    if (totalSelectedChars > limit) {
      new Notice(
        `Horme: Selected folder context is ~${totalSelectedChars.toLocaleString()} chars. ` +
          `Limit is ${limit.toLocaleString()} chars — context will be truncated. ` +
          `Use "+ Add notes" for manual selection.`,
      );
    } else if (totalChars > limit) {
      new Notice(
        `Horme: Folder is ~${totalChars.toLocaleString()} chars across ${files.length} notes. ` +
          `Limit is ${limit.toLocaleString()} chars — context will be truncated. ` +
          `Use "+ Add notes" for manual selection.`,
      );
    }
  }

  filesInFolders(): TFile[] {
    const folderPaths = this.folders.map((f) => f.path);
    if (folderPaths.length === 0) return [];

    // Fast path: root folder selected → include everything.
    if (folderPaths.some((p) => p === "/" || p === "")) {
      return this.app.vault
        .getMarkdownFiles()
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path));
    }

    const prefixes = folderPaths.map((p) => (p.endsWith("/") ? p : `${p}/`));
    const matched = new Map<string, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      for (const pref of prefixes) {
        if (f.path.startsWith(pref)) {
          matched.set(f.path, f);
          break;
        }
      }
    }
    return Array.from(matched.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  async buildFolderContext(
    limitChars: number,
  ): Promise<{ text: string; truncated: boolean; included: number; total: number }> {
    const files = this.filesInFolders();
    const total = files.length;
    if (total === 0) return { text: "", truncated: false, included: 0, total: 0 };

    const parts: string[] = [];
    let used = 0;
    let included = 0;
    let truncated = false;

    for (const file of files) {
      const header = `--- Note: ${file.path} ---\n`;
      let body = "";
      try {
        body = await this.app.vault.read(file);
      } catch {
        body = "[Error reading file]";
      }

      const piece = header + body + "\n\n";
      if (used + piece.length > limitChars) {
        truncated = true;
        break;
      }
      parts.push(piece);
      used += piece.length;
      included++;
    }

    // Edge case: single note larger than budget — include a truncated excerpt of the first note.
    if (included === 0 && files.length > 0 && limitChars > 0) {
      truncated = true;
      const file = files[0];
      let body = "";
      try {
        body = await this.app.vault.read(file);
      } catch {
        body = "[Error reading file]";
      }
      const piece = `--- Note: ${file.path} (truncated) ---\n${body}`;
      parts.push(piece.slice(0, limitChars));
      included = 1;
    }

    if (truncated) {
      const marker =
        `\n[Folder context truncated: included ${included}/${total} notes ` +
        `due to the ${limitChars.toLocaleString()} character limit. ` +
        `Use "+ Add notes" to add specific files.]\n`;
      const current = parts.join("");
      const remaining = limitChars - current.length;
      if (remaining > 0) parts.push(marker.slice(0, remaining));
    }

    return { text: parts.join(""), truncated, included, total };
  }

  /** Forgets every pick (a new chat). */
  clear(): void {
    this.notes = [];
    this.folders = [];
    this.truncationNoticeShown = false;
  }
}
