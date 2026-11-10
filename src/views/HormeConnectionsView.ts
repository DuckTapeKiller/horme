import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import HormePlugin from "../../main";
import { CONNECTIONS_VIEW_TYPE } from "../constants";

export class HormeConnectionsView extends ItemView {
  plugin: HormePlugin;
  private connectionsListEl: HTMLElement;
  private activeFilePath: string | null = null;
  private isPaused = false;
  private debounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HormePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CONNECTIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Horme connections";
  }

  getIcon(): string {
    return "cable";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("horme-connections-view");

    const headerEl = this.contentEl.createDiv({ cls: "horme-connections-header" });
    headerEl.createEl("h4", { text: "Connections" });

    const controlsEl = headerEl.createDiv({ cls: "horme-connections-controls" });
    const pauseBtn = controlsEl.createEl("button", { text: "▣ Pause", cls: "horme-connections-pause-btn" });
    pauseBtn.onclick = () => {
      this.isPaused = !this.isPaused;
      pauseBtn.textContent = this.isPaused ? "▻ Resume" : "▣ Pause";
      // On resume, show the note opened last, even if it was opened while paused.
      const latest = this.latestRequestedPath ?? this.activeFilePath;
      if (!this.isPaused && latest) {
        void this.updateConnections(latest, true);
      }
    };

    this.connectionsListEl = this.contentEl.createDiv({ cls: "horme-connections-list" });

    // Initial render
    this.renderEmptyState();
  }

  async onClose() {
    this.contentEl.empty();
  }

  private renderEmptyState() {
    this.connectionsListEl.empty();
    const emptyEl = this.connectionsListEl.createDiv({ cls: "horme-connections-empty" });
    emptyEl.createEl("p", { text: "Open a note to see related connections." });
  }

  /** The last note asked for, kept while paused so Resume can catch up. */
  private latestRequestedPath: string | null = null;

  public async updateConnections(filePath: string, force = false) {
    this.latestRequestedPath = filePath;
    if (this.isPaused) return;
    if (!force && filePath === this.activeFilePath) return;

    this.activeFilePath = filePath;

    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this._doUpdateConnections(filePath);
    }, 400);
  }

  private async _doUpdateConnections(filePath: string) {
    this.connectionsListEl.empty();

    const loadingEl = this.connectionsListEl.createDiv({ cls: "horme-connections-loading" });
    loadingEl.createEl("p", { text: "Finding connections..." });

    try {
      const connections = await this.plugin.vaultIndexer.getConnections(filePath);

      this.connectionsListEl.empty();

      if (connections === null) {
        const emptyEl = this.connectionsListEl.createDiv({ cls: "horme-connections-empty" });
        emptyEl.createEl("p", { text: "Index is still loading..." });
        return;
      }

      if (connections === undefined) {
        const emptyEl = this.connectionsListEl.createDiv({ cls: "horme-connections-empty" });
        emptyEl.createEl("p", { text: "This note has not been indexed yet." });
        return;
      }

      if (connections.length === 0) {
        const emptyEl = this.connectionsListEl.createDiv({ cls: "horme-connections-empty" });
        emptyEl.createEl("p", { text: "No strong connections found." });
        return;
      }

      for (const conn of connections) {
        const itemEl = this.connectionsListEl.createDiv({ cls: "horme-connection-item" });

        const titleContainer = itemEl.createDiv({ cls: "horme-connection-title-container" });

        const titleEl = titleContainer.createEl("a", {
          text: conn.path.split("/").pop()?.replace(".md", "") || conn.path,
          cls: "horme-connection-title internal-link",
        });

        if (this.plugin.settings.connectionsDisplayStyle === "detailed") {
          const folderParts = conn.path.split("/");
          if (folderParts.length > 1) {
            folderParts.pop(); // remove file name
            titleContainer.createDiv({
              text: folderParts.join("/"),
              cls: "horme-connection-path",
            });
          }
        }

        titleEl.onclick = (e) => {
          e.preventDefault();
          void (async () => {
            const targetFile = this.plugin.app.vault.getAbstractFileByPath(conn.path);
            if (targetFile instanceof TFile) {
              const leaf = this.plugin.app.workspace.getLeaf(
                this.plugin.settings.connectionsOpenInNewTab ? "tab" : false,
              );
              await leaf.openFile(targetFile);
            }
          })();
        };

        itemEl.createSpan({
          text: `${Math.round(conn.score * 100)}%`,
          cls: "horme-connection-score",
        });
      }
    } catch (e: unknown) {
      this.connectionsListEl.empty();
      const errorEl = this.connectionsListEl.createDiv({ cls: "horme-connections-error" });
      errorEl.createEl("p", { text: "Failed to load connections." });
      console.error(e);
      this.plugin.diagnosticService.report(
        "Connections",
        `Failed to load connections: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
