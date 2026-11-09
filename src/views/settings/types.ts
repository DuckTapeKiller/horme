import type { App } from "obsidian";
import type HormePlugin from "../../../main";
import type { HormeSettings } from "../../types";

export type SettingKey = keyof HormeSettings;

export type StringKey = {
  [K in keyof HormeSettings]: HormeSettings[K] extends string ? K : never;
}[keyof HormeSettings];

/** What the settings helpers need from the settings tab. */
export interface SettingsHost {
  app: App;
  plugin: HormePlugin;
  /** Store a value, save it shortly after, and redraw what depends on it. */
  commit(key: SettingKey, value: unknown): void;
  /** Redraw the page (structure changed) or only re-check what is shown or enabled. */
  refresh(structural: boolean, valuesChangedInCode?: boolean): void;
}
