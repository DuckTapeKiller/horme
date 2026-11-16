import type { AiProvider, HormeSettings } from "../types";

/**
 * The provider override on phones and tablets. In memory the settings hold the
 * phone's provider and model, so everything that reads them uses the phone's
 * choice; the copy saved to disk keeps the desktop's, so the override never
 * reaches a computer that shares the settings file.
 *
 * A provider or model picked on the phone (the chat's model menu, the Models
 * page, the On mobile page) is the phone's own choice. It is kept on the phone
 * itself (see PhoneChoice), never in the settings file: that file is shared with
 * the other devices through sync, and a computer saving its own copy afterwards
 * put the old mobile model back, so the phone reopened on the model it had before.
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
  /** The mobile provider as the settings file has it: the one a phone starts from. */
  syncedProvider: AiProvider;
  /** The mobile model as the settings file has it. */
  syncedModel: string;
  /** What this phone chose for itself, or null while it follows the settings file. */
  choice: PhoneChoice | null;
}

/**
 * What a phone chose for itself, kept on that phone. It holds until the mobile
 * provider or model is changed on a computer after it: that change is meant for
 * every phone (mobileChangedAt in the settings file records when it was made).
 */
export interface PhoneChoice {
  provider: AiProvider;
  model: string;
  /** When it was chosen, in milliseconds since 1970. */
  at: number;
}

/** Reads a stored phone choice, or null when the value is not one. */
export function parsePhoneChoice(v: unknown): PhoneChoice | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Rec;
  if (typeof r.provider !== "string" || !r.provider) return null;
  if (typeof r.model !== "string") return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  return { provider: r.provider as AiProvider, model: text(r.model), at: r.at };
}

/** When the mobile provider or model was last changed on a computer, 0 if never. */
const changedOnComputerAt = (s: HormeSettings): number =>
  typeof s.mobileChangedAt === "number" && Number.isFinite(s.mobileChangedAt) ? s.mobileChangedAt : 0;

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

/**
 * Switches the settings in memory to the phone's provider and model: the phone's
 * own choice when it has one that still holds, the settings file's otherwise.
 */
export function applyMobileOverride(
  s: HormeSettings,
  modelKey: ModelKeyOf,
  stored: PhoneChoice | null = null,
): MobileOverride {
  const syncedProvider = s.mobileProvider;
  const syncedModel = typeof s.mobileModel === "string" ? s.mobileModel : "";
  const choice = stored && stored.at >= changedOnComputerAt(s) ? stored : null;
  if (choice) {
    s.mobileProvider = choice.provider;
    s.mobileModel = choice.model;
  }
  const o: MobileOverride = {
    desktopProvider: s.aiProvider,
    provider: s.mobileProvider,
    desktopModel: raw(s, modelKey(s.mobileProvider)),
    model: "",
    mobileModel: "",
    syncedProvider,
    syncedModel,
    choice,
  };
  s.aiProvider = o.provider;
  showMobileModel(s, o, modelKey);
  return o;
}

/** Puts the desktop's provider and model back in memory, when the override is switched off. */
export function removeMobileOverride(s: HormeSettings, o: MobileOverride, modelKey: ModelKeyOf): void {
  put(s, modelKey(o.provider), o.desktopModel);
  s.aiProvider = o.desktopProvider;
  s.mobileProvider = o.syncedProvider;
  s.mobileModel = o.syncedModel;
}

/**
 * Brings the override up to date with whatever changed since it was last
 * brought up to date. A provider or model picked on the phone becomes the
 * phone's own choice. A change on the On mobile page takes effect at once, and
 * is the phone's own choice too.
 */
export function syncMobileOverride(
  s: HormeSettings,
  o: MobileOverride,
  modelKey: ModelKeyOf,
  now: number = Date.now(),
): void {
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
    o.choice = { provider: o.provider, model: s.mobileModel, at: now };
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
    o.choice = { provider: o.provider, model: text(s.mobileModel), at: now };
  }
}

/**
 * The settings as written to disk: the desktop's provider and model, and the
 * mobile provider and model the file already had. Everything else as in memory.
 * The phone's own choice is not written here: it stays on the phone.
 */
export function settingsForDisk(s: HormeSettings, o: MobileOverride, modelKey: ModelKeyOf): HormeSettings {
  const out: HormeSettings = { ...s };
  out.aiProvider = o.desktopProvider;
  put(out, modelKey(o.provider), o.desktopModel);
  out.mobileProvider = o.syncedProvider;
  out.mobileModel = o.syncedModel;
  return out;
}
