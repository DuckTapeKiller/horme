import { App, TFolder, normalizePath } from "obsidian";

/**
 * Returns the vault path of `folder`, matching existing folders in any letter
 * case and creating what is missing. On macOS and Windows "HORME" and "Horme"
 * are one folder on disk, but Obsidian tracks a note created under each
 * spelling as two files, so it was listed and indexed twice.
 */
export async function ensureVaultFolder(app: App, folder: string): Promise<string> {
  const segments = normalizePath(folder)
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== ".");
  let current: TFolder = app.vault.getRoot();
  let path = "";
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const match = current.children.find(
      (c): c is TFolder => c instanceof TFolder && c.name.toLowerCase() === lower,
    );
    path = path ? `${path}/${match ? match.name : segment}` : match ? match.name : segment;
    if (match) {
      current = match;
      continue;
    }
    if (!(await app.vault.adapter.exists(path))) await app.vault.createFolder(path);
    const created = app.vault.getAbstractFileByPath(path);
    if (!(created instanceof TFolder)) return normalizePath(path);
    current = created;
  }
  return path ? normalizePath(path) : "/";
}
