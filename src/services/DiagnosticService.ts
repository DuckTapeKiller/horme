import { App, normalizePath } from "obsidian";
import HormePlugin from "../../main";

export interface DiagnosticError {
  source: string;
  message: string;
  timestamp: number;
  type: "error" | "warning" | "info";
}

export interface IndexHealth {
  name: string;
  id: string;
  status: "healthy" | "stale" | "missing" | "error" | "loading";
  lastUpdate: number;
  entryCount: number;
  path: string;
}

export class DiagnosticService {
  private plugin: HormePlugin;
  private app: App;
  private errors: DiagnosticError[] = [];
  private readonly MAX_LOGS = 50;
  private readonly MAX_MESSAGE_LEN = 4000;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  report(source: string, message: string, type: "error" | "warning" | "info" = "error") {
    const safeSource = (source || "Unknown").slice(0, 80);
    const safeMessage = this.sanitizeText(message || ""); // always sanitize before persisting
    const error: DiagnosticError = {
      source: safeSource,
      message: safeMessage,
      timestamp: Date.now(),
      type
    };
    this.errors.unshift(error);
    if (this.errors.length > this.MAX_LOGS) this.errors.pop();
  }

  getLogs(): DiagnosticError[] { return this.errors; }
  clear() { this.errors = []; }
  getSummary() {
    return {
      total: this.errors.length,
      errors: this.errors.filter(e => e.type === "error").length,
      warnings: this.errors.filter(e => e.type === "warning").length
    };
  }

  /**
   * Redacts secrets (API keys / tokens) and caps length so the dashboard
   * can't become a covert data sink for sensitive content.
   */
  sanitizeText(input: string): string {
    let text = String(input ?? "");

    // Cap length early to avoid expensive regex work on huge blobs
    if (text.length > this.MAX_MESSAGE_LEN) {
      text = text.slice(0, this.MAX_MESSAGE_LEN) + "…[TRUNCATED]";
    }

    // Replace any exact configured secrets first (most reliable)
    const secrets = [
      this.plugin.settings?.claudeApiKey,
      this.plugin.settings?.geminiApiKey,
      this.plugin.settings?.openaiApiKey,
      this.plugin.settings?.groqApiKey,
      this.plugin.settings?.openRouterApiKey,
    ].filter((s): s is string => typeof s === "string" && s.trim().length >= 8);

    for (const secret of secrets) {
      if (!secret) continue;
      // split/join avoids regex special chars and is fast for exact matches
      text = text.split(secret).join("[REDACTED]");
    }

    // Generic token redactions (best-effort)
    text = text
      // Authorization headers / Bearer tokens
      .replace(/Authorization\s*[:=]\s*Bearer\s+[^\s,"]+/gi, "Authorization: Bearer [REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/g, "Bearer [REDACTED]")
      // Common API-key header formats
      .replace(/\b(x-api-key|x-goog-api-key)\s*[:=]\s*[^\s,"]+/gi, "$1: [REDACTED]")
      // Query-string secrets
      .replace(/([?&](?:key|api_key|apikey|token)=)[^&\s]+/gi, "$1[REDACTED]")
      // Common key formats (best-effort, avoid over-matching short strings)
      .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
      .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]");

    return text;
  }

  async getIndexHealth(): Promise<IndexHealth[]> {
    const health: IndexHealth[] = [];
    const configDir = this.app.vault.configDir;
    const pluginDir = `${configDir}/plugins/${this.plugin.manifest.id}`;

    // 1. Vault Index (Folder check for multi-shard)
    const vaultPath = normalizePath(`${pluginDir}/Vault Index`);
    health.push(await this.checkFolderStatus("Vault Brain", "vault", vaultPath, this.plugin.vaultIndexer.index.length, this.plugin.vaultIndexer.isLoaded));

    // 2. Tags Index
    const tagsPath = normalizePath(`${pluginDir}/Tags Index/tag-index.json`);
    health.push(await this.checkIndexStatus("Tags", "tags", tagsPath, this.plugin.tagIndexer.entryCount, true));

    // 3. Grammar Index
    const grammarPath = normalizePath(`${pluginDir}/Grammar Index/grammar_index.json`);
    health.push(await this.checkIndexStatus("Grammar", "grammar", grammarPath, this.plugin.grammarIndexer.chunks.length, true));

    return health;
  }

  private async checkFolderStatus(name: string, id: string, folderPath: string, inMemoryCount: number, isLoaded: boolean): Promise<IndexHealth> {
    try {
      const exists = await this.app.vault.adapter.exists(folderPath);
      if (!exists) return { name, id, status: "missing", lastUpdate: 0, entryCount: 0, path: folderPath };
      
      const files = await this.app.vault.adapter.list(folderPath);
      let latestMtime = 0;
      for (const f of files.files) {
        const s = await this.app.vault.adapter.stat(f);
        if (s && s.mtime > latestMtime) latestMtime = s.mtime;
      }

      if (!isLoaded) return { name, id, status: "loading", lastUpdate: latestMtime, entryCount: 0, path: folderPath };

      const isStale = (latestMtime > 0 && inMemoryCount === 0);
      return { name, id, status: isStale ? "stale" : "healthy", lastUpdate: latestMtime, entryCount: inMemoryCount, path: folderPath };
    } catch (e) {
      return { name, id, status: "error", lastUpdate: 0, entryCount: 0, path: folderPath };
    }
  }

  private async checkIndexStatus(name: string, id: string, path: string, inMemoryCount: number, isLoaded: boolean): Promise<IndexHealth> {
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return { name, id, status: "missing", lastUpdate: 0, entryCount: 0, path };

      const stat = await this.app.vault.adapter.stat(path);
      const mtime = stat?.mtime || 0;
      
      if (!isLoaded) return { name, id, status: "loading", lastUpdate: mtime, entryCount: 0, path };

      const isStale = (mtime > 0 && inMemoryCount === 0);
      return { name, id, status: isStale ? "stale" : "healthy", lastUpdate: mtime, entryCount: inMemoryCount, path };
    } catch (e) {
      return { name, id, status: "error", lastUpdate: 0, entryCount: 0, path };
    }
  }
}
