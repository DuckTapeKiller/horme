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
    return "Horme Connections";
  }

  getIcon(): string {
    return "cable";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("horme-connections-view");

    const headerEl = this.contentEl.createEl("div", { cls: "horme-connections-header" });
    headerEl.createEl("h4", { text: "Connections" });
    
    const controlsEl = headerEl.createEl("div", { cls: "horme-connections-controls" });
    const pauseBtn = controlsEl.createEl("button", { text: "▣ Pause", cls: "horme-connections-pause-btn" });
    pauseBtn.onclick = () => {
      this.isPaused = !this.isPaused;
      pauseBtn.textContent = this.isPaused ? "▻ Resume" : "▣ Pause";
      if (!this.isPaused && this.activeFilePath) {
        this.updateConnections(this.activeFilePath);
      }
    };

    this.connectionsListEl = this.contentEl.createEl("div", { cls: "horme-connections-list" });

    // Initial render
    this.renderEmptyState();
  }

  async onClose() {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.activeFilePath = null;
    this.contentEl.empty();
  }

  private renderEmptyState() {
    this.connectionsListEl.empty();
    const emptyEl = this.connectionsListEl.createEl("div", { cls: "horme-connections-empty" });
    emptyEl.createEl("p", { text: "Open a note to see related connections." });
  }

  public async updateConnections(filePath: string) {
    if (this.isPaused) return;
    if (filePath === this.activeFilePath) return;

    this.activeFilePath = filePath;

    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(async () => {
      this.debounceTimer = null;
      await this._doUpdateConnections(filePath);
    }, 400);
  }

  private async _doUpdateConnections(filePath: string) {
    this.connectionsListEl.empty();
    
    const loadingEl = this.connectionsListEl.createEl("div", { cls: "horme-connections-loading" });
    loadingEl.createEl("p", { text: "Finding connections..." });

    try {
      const connections = await this.plugin.vaultIndexer.getConnections(filePath);
      
      this.connectionsListEl.empty();

      if (connections === null) {
        const emptyEl = this.connectionsListEl.createEl("div", { cls: "horme-connections-empty" });
        emptyEl.createEl("p", { text: "Index is still loading..." });
        return;
      }

      if (connections === undefined) {
        const emptyEl = this.connectionsListEl.createEl("div", { cls: "horme-connections-empty" });
        emptyEl.createEl("p", { text: "This note has not been indexed yet." });
        return;
      }

      if (connections.length === 0) {
        const emptyEl = this.connectionsListEl.createEl("div", { cls: "horme-connections-empty" });
        emptyEl.createEl("p", { text: "No strong connections found." });
        return;
      }

      for (const conn of connections) {
        const itemEl = this.connectionsListEl.createEl("div", { cls: "horme-connection-item" });
        
        const titleContainer = itemEl.createEl("div", { cls: "horme-connection-title-container" });
        
        const titleEl = titleContainer.createEl("a", { 
          text: conn.path.split("/").pop()?.replace(".md", "") || conn.path,
          cls: "horme-connection-title internal-link"
        });
        
        if (this.plugin.settings.connectionsDisplayStyle === "detailed") {
          const folderParts = conn.path.split("/");
          if (folderParts.length > 1) {
             folderParts.pop(); // remove file name
             titleContainer.createEl("div", { 
               text: folderParts.join("/"),
               cls: "horme-connection-path"
             });
          }
        }
        
        titleEl.onclick = async (e) => {
          e.preventDefault();
          const targetFile = this.plugin.app.vault.getAbstractFileByPath(conn.path);
          if (targetFile instanceof TFile) {
            const leaf = this.plugin.app.workspace.getLeaf(this.plugin.settings.connectionsOpenInNewTab ? "tab" : false);
            await leaf.openFile(targetFile);
          }
        };

        const scoreEl = itemEl.createEl("span", { 
          text: `${Math.round(conn.score * 100)}%`,
          cls: "horme-connection-score"
        });
      }
    } catch (e) {
      this.connectionsListEl.empty();
      const errorEl = this.connectionsListEl.createEl("div", { cls: "horme-connections-error" });
      errorEl.createEl("p", { text: "Failed to load connections." });
      this.plugin.diagnosticService.report("Connections", `Failed to load connections: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
