import { Notice, Setting, setIcon, type SettingDefinitionRender } from "obsidian";
import type HormePlugin from "../../../main";
import { GenericConfirmModal } from "../../modals/GenericConfirmModal";
import { markDestructive } from "../../utils/destructiveButton";
import type { IndexHealth } from "../../services/DiagnosticService";
import { isLocalProvider, providerInfo, providerModel } from "./providers";
import type { SettingsHost } from "./types";

const KOFI_URL = "https://ko-fi.com/ducktapekiller";
export const ISSUES_URL = "https://github.com/DuckTapeKiller/horme/issues";

/* ── Connection state, shared by the header and the Models page ─────────── */

export type ConnectionState = "unknown" | "checking" | "ok" | "fail";

export class ConnectionChecker {
  private key = "";
  private state: ConnectionState = "unknown";
  private at = 0;
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(private plugin: HormePlugin) {}

  private currentKey(): string {
    const s = this.plugin.settings;
    const p = providerInfo(s.aiProvider);
    const url = p.urlKey ? String(s[p.urlKey]) : "";
    const secret = p.secretKey ? String(s[p.secretKey]) : "";
    return `${p.id}|${url}|${secret}|${providerModel(s, p.id)}`;
  }

  get(): ConnectionState {
    return this.key === this.currentKey() ? this.state : "unknown";
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Checks again when the settings changed or the last answer is older than 20 s. */
  ensure(force = false): void {
    const key = this.currentKey();
    const fresh = key === this.key && Date.now() - this.at < 20_000 && this.state !== "unknown";
    if (!force && (fresh || this.running)) return;
    this.key = key;
    this.state = "checking";
    this.emit();
    this.running = this.plugin
      .checkConnection()
      .catch(() => false)
      .then((ok) => {
        if (this.key !== key) return;
        this.state = ok ? "ok" : "fail";
        this.at = Date.now();
      })
      .finally(() => {
        this.running = null;
        this.emit();
      });
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }
}

export function connectionLabel(plugin: HormePlugin, state: ConnectionState): string {
  const s = plugin.settings;
  const p = providerInfo(s.aiProvider);
  if (state === "checking") return "Checking the connection…";
  if (state === "ok") return `Connected to ${p.name}.`;
  if (state === "fail") {
    if (!p.local && !plugin.getApiKeyForProvider(p.id)) return `No API key for ${p.name} yet.`;
    return p.local
      ? `Could not reach ${p.name} at ${String(s[p.urlKey ?? "ollamaBaseUrl"])}. Is it running?`
      : `${p.name} did not accept the API key.`;
  }
  return "Not checked yet.";
}

/* ── Small building blocks ──────────────────────────────────────────────── */

/** A full-width line of explanation or warning inside a group. */
export function noteItem(
  text: string | (() => string),
  kind: "info" | "warning" = "info",
  visible?: () => boolean,
): SettingDefinitionRender {
  const read = () => (typeof text === "function" ? text() : text);
  return {
    name: typeof text === "string" ? text : "Note",
    searchable: false,
    visible,
    render: (setting: Setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass("horme-note-row", kind === "warning" ? "is-warning" : "is-info");
      setIcon(
        setting.settingEl.createSpan({ cls: "horme-note-icon" }),
        kind === "warning" ? "alert-triangle" : "info",
      );
      setting.settingEl.createSpan({ cls: "horme-note-text", text: read() });
    },
  };
}

function formatWhen(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/* ── Header ─────────────────────────────────────────────────────────────── */

export function heroItem(host: SettingsHost, checker: ConnectionChecker): SettingDefinitionRender {
  return {
    name: "Horme",
    searchable: false,
    render: (setting: Setting) => {
      const plugin = host.plugin;
      const s = plugin.settings;
      const el = setting.settingEl;
      el.empty();
      el.addClass("horme-hero");

      setIcon(el.createDiv({ cls: "horme-hero-mark" }), "cone");
      const body = el.createDiv({ cls: "horme-hero-body" });
      const title = body.createDiv({ cls: "horme-hero-title" });
      title.createSpan({ text: plugin.manifest.name });
      title.createSpan({ cls: "horme-hero-version", text: `v${plugin.manifest.version}` });
      body.createDiv({
        cls: "horme-hero-tagline",
        text: "Chat with your notes, check and rewrite text, and search your vault by meaning.",
      });

      const chips = body.createDiv({ cls: "horme-hero-chips" });
      const p = providerInfo(s.aiProvider);
      const model = providerModel(s, p.id);

      const providerChip = chips.createDiv({ cls: "horme-chip" });
      const dot = providerChip.createSpan({ cls: "horme-chip-dot" });
      providerChip.createSpan({ text: `${p.name} · ${model || (p.local ? "automatic model" : "no model")}` });

      const paint = () => {
        const state = checker.get();
        dot.className = `horme-chip-dot is-${state}`;
        providerChip.setAttr("aria-label", connectionLabel(plugin, state));
      };
      paint();
      const off = checker.onChange(paint);
      checker.ensure();

      const vb = plugin.vaultIndexer;
      const brainChip = chips.createDiv({ cls: "horme-chip" });
      setIcon(brainChip.createSpan({ cls: "horme-chip-icon" }), "brain");
      const blocked = !isLocalProvider(s.aiProvider) && !s.allowCloudRAG;
      if (!s.vaultBrainEnabled) brainChip.createSpan({ text: "Vault Brain off" });
      else if (blocked) {
        brainChip.addClass("is-warn");
        brainChip.createSpan({ text: "Vault Brain paused" });
      } else if (!vb.isLoaded) brainChip.createSpan({ text: "Vault Brain loading" });
      else brainChip.createSpan({ text: `${vb.index.length.toLocaleString()} passages indexed` });

      const privacyChip = chips.createDiv({ cls: "horme-chip" });
      if (!p.local || s.allowCloudRAG) {
        privacyChip.addClass("is-warn");
        setIcon(privacyChip.createSpan({ cls: "horme-chip-icon" }), "cloud");
        privacyChip.createSpan({
          text: s.allowCloudRAG ? "Notes may reach the cloud" : `Chat goes to ${p.name}`,
        });
      } else {
        setIcon(privacyChip.createSpan({ cls: "horme-chip-icon" }), "shield-check");
        privacyChip.createSpan({ text: "Everything stays on this computer" });
      }
      return off;
    },
  };
}

/** The Connection row on the Models page. */
export function connectionItem(host: SettingsHost, checker: ConnectionChecker): SettingDefinitionRender {
  return {
    name: "Connection",
    desc: "Check that Horme can reach the active provider.",
    render: (setting: Setting) => {
      setting.setName("Connection");
      const paint = () => {
        const state = checker.get();
        setting.descEl.empty();
        const line = setting.descEl.createDiv({ cls: `horme-conn-line is-${state}` });
        line.createSpan({ cls: `horme-chip-dot is-${state}` });
        line.createSpan({ text: connectionLabel(host.plugin, state) });
      };
      setting.addButton((b) =>
        b.setButtonText("Check now").onClick(() => {
          checker.ensure(true);
        }),
      );
      paint();
      const off = checker.onChange(paint);
      checker.ensure();
      return off;
    },
  };
}

/* ── Index rows: status, rebuild, delete ───────────────────────────────── */

type IndexKind = "vault" | "tags" | "grammar";

const INDEX_LABEL: Record<IndexKind, string> = {
  vault: "Vault index",
  tags: "Tag index",
  grammar: "Grammar index",
};

function indexSummary(plugin: HormePlugin, kind: IndexKind): string {
  if (kind === "vault") {
    const vb = plugin.vaultIndexer;
    if (vb.isIndexing || vb.isProcessingQueue) return plugin.settings.indexStatus || "Indexing…";
    if (!vb.isLoaded) return "Loading the index…";
    if (vb.index.length === 0) return "Not built yet.";
    if (!vb.isSpaceCompatible()) {
      return `Built with another embedding set-up (${vb.indexedModel}), so it is not searched. Switch back, or rebuild.`;
    }
    const notes = new Set(vb.index.map((e) => e.path)).size;
    return `${vb.index.length.toLocaleString()} passages from ${notes.toLocaleString()} notes`;
  }
  if (kind === "tags") {
    const n = plugin.tagIndexer.entryCount;
    return n > 0 ? `${n.toLocaleString()} tags indexed` : "Not built yet.";
  }
  const n = plugin.grammarIndexer.chunks.length;
  return n > 0 ? `${n.toLocaleString()} passages from your grammar notes` : "Not built yet.";
}

export function indexItem(
  host: SettingsHost,
  kind: IndexKind,
  opts: { canRebuild?: () => boolean; rebuildHint?: string } = {},
): SettingDefinitionRender {
  const label = INDEX_LABEL[kind];
  return {
    name: label,
    desc: "Rebuild or delete the index.",
    render: (setting: Setting) => {
      const plugin = host.plugin;
      setting.setName(label);
      setting.descEl.empty();
      const summaryEl = setting.descEl.createDiv();
      const whenEl = setting.descEl.createDiv({ cls: "horme-index-when" });
      const paint = () => summaryEl.setText(indexSummary(plugin, kind));
      paint();

      void plugin.diagnosticService
        .getIndexHealth()
        .then((all: IndexHealth[]) => {
          const h = all.find((x) => x.id === kind);
          if (h?.lastUpdate && whenEl.isConnected) whenEl.setText(`Last saved ${formatWhen(h.lastUpdate)}`);
        })
        .catch(() => undefined);

      // While a vault rebuild runs, keep the progress line current.
      const timer = kind === "vault" ? window.setInterval(paint, 1000) : null;

      const allowed = opts.canRebuild?.() ?? true;
      setting.addButton((b) => {
        b.setButtonText("Rebuild")
          .setDisabled(!allowed)
          .onClick(() => {
            b.setDisabled(true);
            const run =
              kind === "vault"
                ? plugin.vaultIndexer.rebuildIndex()
                : kind === "tags"
                  ? plugin.tagIndexer.rebuildTagIndex()
                  : plugin.grammarIndexer.rebuildIndex();
            void run.catch((e: unknown) => plugin.handleError(e, label)).finally(() => host.refresh(true));
            window.setTimeout(paint, 300);
          });
        if (!allowed && opts.rebuildHint) b.setTooltip(opts.rebuildHint);
      });
      setting.addButton((b) =>
        markDestructive(b.setButtonText("Delete")).onClick(() => {
          new GenericConfirmModal(
            host.app,
            `Delete the ${label.toLowerCase()} from memory and disk? You can rebuild it later.`,
            () => {
              const del =
                kind === "vault"
                  ? plugin.vaultIndexer.deleteIndex()
                  : kind === "tags"
                    ? plugin.tagIndexer.deleteIndex()
                    : plugin.grammarIndexer.deleteIndex();
              void del
                .then((r) => {
                  new Notice(
                    r === "deleted"
                      ? `${label} deleted.`
                      : r === "missing"
                        ? `There was no ${label.toLowerCase()} to delete.`
                        : `${label} is busy; try again when indexing ends.`,
                  );
                })
                .catch((e: unknown) => plugin.handleError(e, label))
                .finally(() => host.refresh(true));
            },
          ).open();
        }),
      );
      return () => {
        if (timer !== null) window.clearInterval(timer);
      };
    },
  };
}

/* ── Diagnostics ───────────────────────────────────────────────────────── */

export function healthItem(host: SettingsHost): SettingDefinitionRender {
  return {
    name: "Index health",
    searchable: false,
    render: (setting: Setting) => {
      const el = setting.settingEl;
      el.empty();
      el.addClass("horme-health");
      const grid = el.createDiv({ cls: "horme-health-grid" });
      const draw = (items: IndexHealth[]) => {
        grid.empty();
        for (const h of items) {
          const card = grid.createDiv({ cls: `horme-health-card is-${h.status}` });
          const head = card.createDiv({ cls: "horme-health-head" });
          setIcon(
            head.createSpan({ cls: "horme-health-icon" }),
            h.id === "vault" ? "brain" : h.id === "tags" ? "tags" : "book-open",
          );
          head.createSpan({ cls: "horme-health-name", text: h.name });
          head.createSpan({ cls: "horme-health-badge", text: h.status });
          card.createDiv({
            cls: "horme-health-count",
            text: h.status === "loading" ? "Loading…" : `${(h.entryCount || 0).toLocaleString()} entries`,
          });
          card.createDiv({
            cls: "horme-health-when",
            text: h.lastUpdate ? `Saved ${formatWhen(h.lastUpdate)}` : "Never built",
          });
        }
      };
      grid.createDiv({ cls: "horme-health-loading", text: "Reading the indexes…" });
      void host.plugin.diagnosticService
        .getIndexHealth()
        .then((items) => {
          if (grid.isConnected) draw(items);
        })
        .catch(() => {
          if (grid.isConnected) grid.setText("Could not read the indexes.");
        });
    },
  };
}

export function activityLogItem(host: SettingsHost): SettingDefinitionRender {
  return {
    name: "Activity log",
    searchable: false,
    render: (setting: Setting) => {
      const plugin = host.plugin;
      const el = setting.settingEl;
      el.empty();
      el.addClass("horme-log");
      const bar = el.createDiv({ cls: "horme-log-bar" });
      const summary = bar.createSpan({ cls: "horme-log-summary" });
      const actions = bar.createDiv({ cls: "horme-log-actions" });
      const list = el.createDiv({ cls: "horme-log-list" });

      const draw = () => {
        const s = plugin.diagnosticService.getSummary();
        summary.setText(
          s.total === 0
            ? "Nothing to report."
            : `${s.errors} error${s.errors === 1 ? "" : "s"}, ${s.warnings} warning${s.warnings === 1 ? "" : "s"}`,
        );
        list.empty();
        const logs = plugin.diagnosticService.getLogs();
        if (logs.length === 0) {
          list.createDiv({ cls: "horme-log-empty", text: "No problems recorded since Obsidian started." });
          return;
        }
        for (const log of logs) {
          const row = list.createDiv({ cls: `horme-log-row is-${log.type}` });
          row.createSpan({ cls: "horme-log-time", text: formatWhen(log.timestamp) });
          row.createSpan({ cls: "horme-log-source", text: log.source });
          row.createSpan({ cls: "horme-log-msg", text: log.message });
        }
      };

      const button = (icon: string, label: string, onClick: () => void) => {
        const b = actions.createEl("button", {
          cls: "clickable-icon horme-log-button",
          attr: { "aria-label": label },
        });
        setIcon(b, icon);
        b.addEventListener("click", onClick);
      };
      button("refresh-cw", "Refresh", draw);
      button("copy", "Copy a diagnostic report", () => {
        void (async () => {
          const health = await plugin.diagnosticService.getIndexHealth();
          await navigator.clipboard.writeText(
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                version: plugin.manifest.version,
                indexHealth: health,
                logs: plugin.diagnosticService.getLogs(),
              },
              null,
              2,
            ),
          );
          new Notice("Diagnostic report copied.");
        })().catch((e: unknown) => plugin.handleError(e, "Clipboard"));
      });
      button("trash-2", "Clear the log", () => {
        plugin.diagnosticService.clear();
        draw();
      });
      draw();
    },
  };
}

/* ── Support ───────────────────────────────────────────────────────────── */

export function supportItem(host: SettingsHost): SettingDefinitionRender {
  return {
    name: "Support Horme",
    desc: "Ko-fi",
    render: (setting: Setting) => {
      const name = host.plugin.manifest.name;
      const el = setting.settingEl;
      el.empty();
      el.addClass("horme-support");
      setIcon(el.createDiv({ cls: "horme-support-icon" }), "heart");
      const text = el.createDiv({ cls: "horme-support-text" });
      text.createDiv({ cls: "horme-support-title", text: `Enjoying ${name}?` });
      const about = text.createEl("p", {
        text: `${name} is free and open source, made and maintained by DuckTapeKiller. If it is useful to you, you can support its development on `,
      });
      // The name stays on one line, so a narrow screen never breaks it at its hyphen.
      about.createSpan({ cls: "horme-support-nowrap", text: "Ko-fi" });
      about.appendText(".");
      const kofi = el.createEl("a", {
        cls: "horme-support-button",
        href: KOFI_URL,
        attr: { "aria-label": "Support DuckTapeKiller on Ko-fi" },
      });
      setIcon(kofi.createSpan({ cls: "horme-support-button-icon" }), "coffee");
      kofi.createSpan({ text: "Support on Ko-fi" });
    },
  };
}

export function linkItem(name: string, desc: string, label: string, href: string): SettingDefinitionRender {
  return {
    name,
    desc,
    render: (setting: Setting) => {
      setting.setName(name).setDesc(desc);
      setting.controlEl.createEl("a", { cls: "horme-link-button", text: label, href });
    },
  };
}

/* ── Tag translation test ──────────────────────────────────────────────── */

export function tagTranslationTestItem(host: SettingsHost, visible: () => boolean): SettingDefinitionRender {
  return {
    name: "Test translation",
    desc: "Translate a sample of your tags with the settings above, before you rebuild the index.",
    visible,
    render: (setting: Setting) => {
      const plugin = host.plugin;
      setting
        .setName("Test translation")
        .setDesc("Translate a sample of your tags with the settings above, before you rebuild the index.");
      const results = setting.settingEl.createDiv({ cls: "horme-tag-test-results" });
      results.hide();
      setting.addButton((btn) =>
        btn.setButtonText("Run test").onClick(async () => {
          btn.setButtonText("Testing…").setDisabled(true);
          results.empty();
          results.show();
          const loading = results.createEl("p", {
            text: "Asking the model. A local model can take 10 to 30 seconds…",
            cls: "horme-tag-test-loading",
          });
          try {
            const rows = await plugin.vaultIndexer.testTagTranslation();
            loading.remove();
            if (rows.length === 0) {
              results.createEl("p", {
                text: "No tags found in the sampled notes. Add tags to some notes and try again.",
                cls: "horme-tag-test-empty",
              });
              return;
            }
            const warnings = rows.filter((r) => r.warning !== null);
            if (warnings.length > 0) {
              const box = results.createDiv({ cls: "horme-tag-test-warnings" });
              box.createEl("strong", { text: "The model's answers need checking:" });
              for (const w of warnings)
                box.createEl("p", { text: w.warning ?? "", cls: "horme-tag-test-warning-line" });
            }
            const table = results.createEl("table", { cls: "horme-tag-test-table" });
            const head = table.createEl("thead").createEl("tr");
            for (const h of ["Kind", "Original", "Translation", ""]) head.createEl("th", { text: h });
            const body = table.createEl("tbody");
            const sorted = [...rows].sort((a, b) => (a.type === b.type ? 0 : a.type === "path" ? -1 : 1));
            for (const row of sorted) {
              const tr = body.createEl("tr");
              tr.createEl("td", {
                text: row.type === "path" ? "Category" : "Tag",
                cls: "horme-tag-test-type",
              });
              tr.createEl("td", { text: row.original });
              tr.createEl("td", {
                text: row.translated ?? "(no answer)",
                cls: row.translated ? "" : "horme-tag-test-missing",
              });
              const status = tr.createEl("td");
              if (!row.translated) status.createSpan({ text: "Failed", cls: "horme-tag-test-fail" });
              else if (row.warning) status.createSpan({ text: "Check", cls: "horme-tag-test-warn" });
              else status.createSpan({ text: "OK", cls: "horme-tag-test-ok" });
            }
            const ok = rows.filter((r) => r.translated && !r.warning).length;
            results.createEl("p", {
              cls: "horme-tag-test-summary",
              text:
                `${ok} of ${rows.length} translations look clean. ` +
                (warnings.length > 0
                  ? "A larger model, or one that follows instructions more closely, may do better."
                  : "The format looks right."),
            });
          } catch (e: unknown) {
            loading.remove();
            results.createEl("p", {
              text: `The test failed: ${e instanceof Error ? e.message : String(e)}`,
              cls: "horme-tag-test-error",
            });
          } finally {
            btn.setButtonText("Run test").setDisabled(false);
          }
        }),
      );
    },
  };
}
