import { AbstractInputSuggest, App, Setting, type SettingDefinitionRender } from "obsidian";
import type { AiProvider } from "../../types";
import { listModels, type ModelListResult, type ModelPurpose } from "./providers";
import type { SettingsHost, StringKey } from "./types";

/** Suggestion popover for a free-text model field. */
class ModelSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private input: HTMLInputElement,
    private items: () => string[],
    private onPick: (value: string) => void,
  ) {
    super(app, input);
  }

  getSuggestions(query: string): string[] {
    const items = this.items();
    const q = query.trim().toLowerCase();
    // When the field already holds a listed model, show the whole list rather than
    // only that one entry, so the user can see the alternatives.
    if (!q || items.some((i) => i.toLowerCase() === q)) return items.slice(0, 200);
    return items.filter((i) => i.toLowerCase().includes(q)).slice(0, 200);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.input.value = value;
    this.onPick(value);
    this.close();
  }
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; result: ModelListResult }>();

export interface ModelFieldOptions {
  name: string;
  desc: string;
  key: StringKey;
  /** Remembers models the user typed by hand, so they are offered again. */
  listId: string;
  provider: () => AiProvider;
  purpose: ModelPurpose;
  placeholder?: string;
  visible?: () => boolean;
  /** Settings that change where the list comes from (URLs), for the cache key. */
  sourceKey?: () => string;
}

/**
 * A model field: free text with suggestions from the provider. The list is
 * fetched only when the field is focused, never when the page is drawn.
 */
export function modelField(host: SettingsHost, o: ModelFieldOptions): SettingDefinitionRender {
  return {
    name: o.name,
    desc: o.desc,
    visible: o.visible,
    render: (setting: Setting) => {
      const plugin = host.plugin;
      setting.setName(o.name);
      const descEl = setting.descEl;
      descEl.empty();
      descEl.createDiv({ text: o.desc });
      const statusEl = descEl.createDiv({ cls: "horme-model-status" });

      const cacheKey = () => `${o.provider()}|${o.purpose}|${o.sourceKey?.() ?? ""}`;
      let fetched: string[] = cache.get(cacheKey())?.result.models ?? [];
      const remembered = (): string[] => plugin.settings.customModelSuggestions?.[o.listId] ?? [];
      const allModels = (): string[] => {
        const current = String(plugin.settings[o.key] ?? "").trim();
        return Array.from(new Set([...fetched, ...remembered(), ...(current ? [current] : [])]));
      };

      let input: HTMLInputElement | null = null;
      let loading: Promise<void> | null = null;

      const showStatus = (text: string, kind: "muted" | "ok" | "warn") => {
        statusEl.setText(text);
        statusEl.toggleClass("is-ok", kind === "ok");
        statusEl.toggleClass("is-warn", kind === "warn");
      };

      const load = (force: boolean): Promise<void> => {
        const hit = cache.get(cacheKey());
        if (!force && hit && Date.now() - hit.at < CACHE_MS) {
          fetched = hit.result.models;
          showStatus(hit.result.note, hit.result.ok ? "ok" : "warn");
          return Promise.resolve();
        }
        if (loading) return loading;
        showStatus("Looking for models…", "muted");
        loading = listModels(plugin, o.provider(), o.purpose)
          .then((result) => {
            cache.set(cacheKey(), { at: Date.now(), result });
            fetched = result.models;
            if (!statusEl.isConnected) return;
            showStatus(result.note, result.ok ? "ok" : "warn");
            // Re-open the suggestions now that the list has arrived.
            if (input && input.ownerDocument.activeElement === input) input.dispatchEvent(new Event("input"));
          })
          .finally(() => {
            loading = null;
          });
        return loading;
      };

      const commit = (raw: string) => {
        const value = raw.trim();
        if (value === String(plugin.settings[o.key] ?? "")) return;
        if (value && !fetched.includes(value)) {
          const record = { ...(plugin.settings.customModelSuggestions ?? {}) };
          record[o.listId] = Array.from(new Set([value, ...(record[o.listId] ?? [])])).slice(0, 50);
          plugin.settings.customModelSuggestions = record;
        }
        host.commit(o.key, value);
      };

      setting.addText((t) => {
        input = t.inputEl;
        t.inputEl.addClass("horme-model-input");
        t.setPlaceholder(o.placeholder ?? "Type or pick a model").setValue(
          String(plugin.settings[o.key] ?? ""),
        );
        const suggest = new ModelSuggest(host.app, t.inputEl, allModels, commit);
        void suggest;
        t.inputEl.addEventListener("focus", () => void load(false));
        // "change" fires on Enter or when the field loses focus, so half-typed
        // names are never saved.
        t.inputEl.addEventListener("change", () => commit(t.inputEl.value));
      });

      setting.addExtraButton((b) =>
        b
          .setIcon("refresh-cw")
          .setTooltip("Look for models again")
          .onClick(() => {
            void load(true).then(() => input?.focus());
          }),
      );

      const hit = cache.get(cacheKey());
      if (hit) showStatus(hit.result.note, hit.result.ok ? "ok" : "warn");
    },
  };
}
