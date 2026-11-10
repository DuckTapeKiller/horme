import {
  Notice,
  SecretComponent,
  Setting,
  type SettingControl,
  type SettingDefinitionItem,
  type SettingGroup,
} from "obsidian";
import { FileSuggest, FolderSuggest } from "../../utils/Suggest";
import type { SettingKey, SettingsHost } from "./types";

/**
 * Draws the setting definitions with the classic Setting API, for Obsidian
 * versions before 1.13 that cannot draw definitions themselves. Pages become
 * collapsible sections; every change redraws the whole tab.
 */

type Item = SettingDefinitionItem<SettingKey>;
type AnyDef = Record<string, unknown> & { name?: string; type?: string };

const openSections = new Set<string>();
/** Clean-ups returned by render items (timers, listeners), run before each redraw. */
let cleanups: Array<() => void> = [];

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function isVisible(def: AnyDef): boolean {
  const v = def.visible as boolean | (() => boolean) | undefined;
  if (v === undefined) return true;
  return typeof v === "function" ? v() : v;
}

function evaluate<T>(v: T | (() => T) | undefined): T | undefined {
  return typeof v === "function" ? (v as () => T)() : v;
}

function renderControl(
  host: SettingsHost & { getControlValue(key: string): unknown },
  setting: Setting,
  control: SettingControl<SettingKey>,
) {
  const key = control.key;
  const value = host.getControlValue(key);
  const disabled = evaluate((control as { disabled?: boolean | (() => boolean) }).disabled) ?? false;
  const set = (v: unknown) => host.commit(key, v);

  switch (control.type) {
    case "toggle":
      setting.addToggle((t) => t.setValue(Boolean(value)).setDisabled(disabled).onChange(set));
      break;
    case "dropdown":
      setting.addDropdown((d) => {
        for (const [k, label] of Object.entries(control.options)) d.addOption(k, label);
        d.setValue(str(value)).setDisabled(disabled);
        d.onChange(set);
      });
      break;
    case "slider": {
      const valueEl = setting.controlEl.createSpan({ cls: "horme-fallback-slider-value" });
      const show = (n: number) =>
        valueEl.setText(control.displayFormat ? control.displayFormat(n) : String(n));
      show(Number(value));
      setting.addSlider((sl) =>
        sl
          .setLimits(control.min, control.max, control.step)
          .setValue(Number(value))
          .setDisabled(disabled)
          .onChange((n) => {
            show(n);
            set(n);
          }),
      );
      break;
    }
    case "number":
      setting.addText((t) => {
        t.inputEl.type = "number";
        if (control.min !== undefined) t.inputEl.min = String(control.min);
        if (control.step !== undefined) t.inputEl.step = String(control.step);
        t.setValue(str(value)).setDisabled(disabled);
        t.inputEl.addEventListener("change", () => {
          const n = Number(t.getValue());
          const err = control.validate?.(n);
          if (typeof err === "string" && err) {
            new Notice(err);
            return;
          }
          if (Number.isFinite(n)) set(n);
        });
      });
      break;
    case "textarea":
      setting.addTextArea((t) => {
        t.setValue(str(value)).setDisabled(disabled);
        if (control.placeholder) t.setPlaceholder(control.placeholder);
        if (control.rows) t.inputEl.rows = control.rows;
        t.inputEl.addClass("horme-fallback-wide");
        t.inputEl.addEventListener("change", () => set(t.getValue()));
      });
      break;
    case "secret":
      setting.addComponent((el) => {
        const c = new SecretComponent(host.app, el);
        c.setValue(str(value));
        c.onChange((v) => set((v ?? "").trim()));
        return c;
      });
      break;
    case "color":
      setting.addColorPicker((c) => c.setValue(str(value)).onChange(set));
      break;
    default: {
      // text, file and folder
      setting.addText((t) => {
        if (control.type === "file") new FileSuggest(host.app, t.inputEl);
        if (control.type === "folder") new FolderSuggest(host.app, t.inputEl);
        if ("placeholder" in control && control.placeholder) t.setPlaceholder(control.placeholder);
        t.setValue(str(value)).setDisabled(disabled);
        // Saved on Enter, on blur, or when a suggestion is picked, never mid-word.
        const commit = () => {
          const v = t.getValue();
          void Promise.resolve(control.validate?.(v as never)).then((err) => {
            if (typeof err === "string" && err) {
              new Notice(err);
              return;
            }
            set(v);
          });
        };
        t.inputEl.addEventListener("change", commit);
      });
    }
  }
}

function renderItems(
  host: SettingsHost & { getControlValue(key: string): unknown },
  container: HTMLElement,
  items: Item[],
  path: string,
) {
  for (const raw of items) {
    const def = raw as unknown as AnyDef;
    if (!isVisible(def)) continue;

    if (def.type === "page") {
      const id = `${path}/${String(def.name)}`;
      const details = container.createEl("details", { cls: "horme-fallback-page" });
      details.open = openSections.has(id);
      details.addEventListener("toggle", () => {
        if (details.open) openSections.add(id);
        else openSections.delete(id);
      });
      const summary = details.createEl("summary");
      summary.createSpan({ cls: "horme-fallback-page-name", text: String(def.name) });
      const shown = evaluate(def.displayValue as string | (() => string) | undefined);
      if (shown) summary.createSpan({ cls: "horme-fallback-page-value", text: shown });
      if (evaluate(def.status as "warning" | null | (() => "warning" | null)) === "warning") {
        summary.addClass("is-warning");
      }
      if (def.desc) details.createDiv({ cls: "horme-fallback-page-desc", text: str(def.desc) });
      renderItems(
        host,
        details.createDiv({ cls: "horme-fallback-page-body" }),
        (def.items as Item[]) ?? [],
        id,
      );
      continue;
    }

    if (def.type === "group" || def.type === "list") {
      const wrap = container.createDiv({ cls: `horme-fallback-group ${str(def.cls)}` });
      const heading = def.heading as string | undefined;
      const addItem = def.addItem as { name: string; action: (el: HTMLElement) => void } | undefined;
      if (heading || addItem) {
        const h = new Setting(wrap).setName(heading ?? "").setHeading();
        if (addItem)
          h.addExtraButton((b) =>
            b
              .setIcon("plus")
              .setTooltip(addItem.name)
              .onClick(() => addItem.action(h.controlEl)),
          );
      }
      const children = (def.items as Item[]) ?? [];
      if (def.type === "list" && children.length === 0 && def.emptyState) {
        wrap.createDiv({ cls: "horme-settings-muted", text: str(def.emptyState) });
      }
      const onDelete = def.onDelete as ((i: number) => void) | undefined;
      children.forEach((child, i) => {
        const before = wrap.childElementCount;
        renderItems(host, wrap, [child], path);
        if (onDelete && wrap.childElementCount > before) {
          const row = wrap.lastElementChild;
          const control = row?.querySelector(".setting-item-control");
          if (control?.instanceOf(HTMLElement)) {
            const del = control.createDiv({
              cls: "clickable-icon extra-setting-button",
              attr: { "aria-label": "Delete" },
            });
            del.setText("✕");
            del.addEventListener("click", () => onDelete(i));
          }
        }
      });
      continue;
    }

    const setting = new Setting(container);
    if (def.render) {
      const cleanup = (def.render as (s: Setting, g: SettingGroup) => void | (() => void))(
        setting,
        null as unknown as SettingGroup,
      );
      if (typeof cleanup === "function") cleanups.push(cleanup);
      continue;
    }
    setting.setName(String(def.name ?? ""));
    if (def.desc) setting.setDesc(str(def.desc));
    if (def.control) {
      renderControl(host, setting, def.control as SettingControl<SettingKey>);
    } else if (def.action) {
      const action = def.action as (el: HTMLElement, i: number) => void;
      setting.addButton((b) => b.setButtonText("Open").onClick(() => action(setting.settingEl, 0)));
    }
  }
}

export function renderFallback(
  host: SettingsHost & { getControlValue(key: string): unknown },
  containerEl: HTMLElement,
  items: Item[],
): void {
  const scroller = containerEl.closest(".vertical-tab-content");
  const top = scroller?.instanceOf(HTMLElement) ? scroller.scrollTop : 0;
  disposeFallback();
  containerEl.empty();
  containerEl.addClass("horme-fallback");
  renderItems(host, containerEl, items, "");
  window.requestAnimationFrame(() => {
    if (scroller?.instanceOf(HTMLElement)) scroller.scrollTop = top;
  });
}

/** Stops the timers and listeners of the last fallback drawing. */
export function disposeFallback(): void {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* a failed clean-up must not stop the others */
    }
  }
  cleanups = [];
}
