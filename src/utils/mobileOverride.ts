import type { AiProvider, HormeSettings } from "../types";

/**
 * The provider override on phones and tablets. In memory the settings hold the
 * phone's provider and model, so everything that reads them uses the phone's
 * choice; the copy saved to disk keeps the desktop's, so the override never
 * reaches a computer that shares the settings file.
 *
 * A provider or model picked on the phone (the chat's model menu, the Models
 * page) is stored as the mobile provider and model, so the phone still has it
 * the next time the app opens. It used to be thrown away on every save, and the
 * phone reopened on the first model in the list.
 */
export interface MobileOverride {
  /** The provider the desktop uses, as saved on disk. */
  desktopProvider: AiProvider;
  /** The provider the phone uses now. */
  provider: AiProvider;
  /** That provider's model as saved on disk (the desktop's), hidden while the phone's is shown. */
  desktopModel: unknown;
  /** The phone's model when the override was last brought up to date. */
  model: string;
  /** The mobileModel setting when the override was last brought up to date. */
  mobileModel: string;
}

/** The settings key that holds a provider's chat model. */
export type ModelKeyOf = (provider: AiProvider) => string;

type Rec = Record<string, unknown>;

const raw = (s: HormeSettings, key: string): unknown => (s as unknown as Rec)[key];
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const put = (s: HormeSettings, key: string, v: unknown): void => {
  (s as unknown as Rec)[key] = v;
};

/** Shows the mobile model, or the desktop's model for that provider when none is set. */
function showMobileModel(s: HormeSettings, o: MobileOverride, modelKey: ModelKeyOf): void {
  const chosen = text(s.mobileModel);
  put(s, modelKey(o.provider), chosen || o.desktopModel);
  o.model = text(raw(s, modelKey(o.provider)));
  o.mobileModel = text(s.mobileModel);
}

/** Switches the settings in memory to the phone's provider and model. */
export function applyMobileOverride(s: HormeSettings, modelKey: ModelKeyOf): MobileOverride {
  const o: MobileOverride = {
    desktopProvider: s.aiProvider,
    provider: s.mobileProvider,
    desktopModel: raw(s, modelKey(s.mobileProvider)),
    model: "",
    mobileModel: "",
  };
  s.aiProvider = o.provider;
  showMobileModel(s, o, modelKey);
  return o;
}

/** Puts the desktop's provider and model back in memory, when the override is switched off. */
export function removeMobileOverride(s: HormeSettings, o: MobileOverride, modelKey: ModelKeyOf): void {
  put(s, modelKey(o.provider), o.desktopModel);
  s.aiProvider = o.desktopProvider;
}

/**
 * Brings the override up to date with whatever changed since it was last
 * brought up to date. A provider or model picked on the phone becomes the
 * mobile provider and model. A change on the On mobile page takes effect at once.
 */
export function syncMobileOverride(s: HormeSettings, o: MobileOverride, modelKey: ModelKeyOf): void {
  const liveProvider = s.aiProvider;
  const liveModel = text(raw(s, modelKey(liveProvider)));

  if (liveProvider !== o.provider || liveModel !== o.model) {
    // Picked on the phone.
    if (liveProvider !== o.provider) {
      put(s, modelKey(o.provider), o.desktopModel);
      o.provider = liveProvider;
      o.desktopModel = raw(s, modelKey(liveProvider));
    }
    s.mobileProvider = o.provider;
    s.mobileModel = text(raw(s, modelKey(o.provider)));
    o.model = s.mobileModel;
    o.mobileModel = s.mobileModel;
    return;
  }

  if (s.mobileProvider !== o.provider || text(s.mobileModel) !== o.mobileModel) {
    // Changed on the On mobile page.
    if (s.mobileProvider !== o.provider) {
      put(s, modelKey(o.provider), o.desktopModel);
      o.provider = s.mobileProvider;
      o.desktopModel = raw(s, modelKey(o.provider));
      s.aiProvider = o.provider;
    }
    showMobileModel(s, o, modelKey);
  }
}

/** The settings as written to disk: the desktop's provider and model, everything else as in memory. */
export function settingsForDisk(s: HormeSettings, o: MobileOverride, modelKey: ModelKeyOf): HormeSettings {
  const out: HormeSettings = { ...s };
  out.aiProvider = o.desktopProvider;
  put(out, modelKey(o.provider), o.desktopModel);
  return out;
}
