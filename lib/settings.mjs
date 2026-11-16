// A session's settings (spec §7.7): the hosted watch's, read from <home>/boqo-sniper/config.json when the watcher
// starts and written to the session's settings.json, which `next` reads for the bar. A flag on watch.mjs
// (--sensitivity) overrides the file.
//
// Bounds are boqo's WATCH_BOUNDS (packages/core/src/stream.ts @ bcc9d99cc): a whole number between min and max,
// the same test as its `withinBound`; the prompt is boqo's `normalizePrompt` (packages/core/src/prompt.ts), which
// caps at PROMPT_MAX code points instead of refusing. `visionPerHour` is the skill's own (lib/vision-budget.mjs).

export const WATCH_BOUNDS = {
  windowSec: { min: 120, max: 600, default: 300 },
  sensitivity: { min: 30, max: 95, default: 70 },
  autoClipMinScore: { min: 50, max: 95, default: 80 },
  // not in boqo: images the agent may look at in a rolling hour; 0 spends none
  visionPerHour: { min: 0, max: 6000, default: 600 },
};

export const PROMPT_MAX = 300;

/** boqo's normalizePrompt: whitespace runs to one space, control characters dropped, capped at 300 code points; empty is null. */
export function normalizePrompt(raw) {
  if (raw === null || raw === undefined) return null;
  const folded = String(raw).replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "").replace(/ {2,}/g, " ").trim();
  const capped = Array.from(folded).slice(0, PROMPT_MAX).join("").trimEnd();
  return capped === "" ? null : capped;
}

export function withinBound(key, value) {
  const b = WATCH_BOUNDS[key];
  return Number.isInteger(value) && value >= b.min && value <= b.max;
}

/**
 * The settings in force: `{sensitivity, autoClip, autoClipMinScore, windowSec, prompt, visionPerHour}`.
 * `config` is the parsed config.json, `overrides` what the command line gave (a key left undefined or null
 * is not given). A value out of bounds throws with boqo's wording: "sensitivity must be a whole number between 30
 * and 95." (config.json: ... when it came from the file).
 */
export function resolveSettings(config = {}, overrides = {}) {
  const out = {};
  for (const key of Object.keys(WATCH_BOUNDS)) {
    const fromFlag = overrides[key] !== undefined && overrides[key] !== null;
    const value = fromFlag ? overrides[key] : config?.[key];
    if (value === undefined || value === null) {
      out[key] = WATCH_BOUNDS[key].default;
    } else if (withinBound(key, value)) {
      out[key] = value;
    } else {
      const b = WATCH_BOUNDS[key];
      const where = fromFlag ? "" : "config.json: ";
      throw new Error(`${where}${key} must be a whole number between ${b.min} and ${b.max}.`);
    }
  }
  const auto = config?.autoClip;
  if (auto !== undefined && auto !== null && typeof auto !== "boolean") throw new Error("config.json: autoClip must be true or false.");
  out.autoClip = auto ?? true;
  const prompt = config?.prompt;
  if (prompt !== undefined && prompt !== null && typeof prompt !== "string") throw new Error("config.json: prompt must be text.");
  out.prompt = normalizePrompt(prompt);
  return out;
}

/**
 * Does this moment go to the agent on its own? A hand-made one always (hosted: clip_requested); a detected one when
 * autoClip is on and its score is at or above autoClipMinScore. Anything else is listed and waits for "clip it".
 */
export function isAutoMoment(meta, settings) {
  if (meta?.signal === "manual") return true;
  return Boolean(settings.autoClip) && Number(meta?.score) >= settings.autoClipMinScore;
}

/** The settings with every missing piece at its default (a session folder with no settings.json: v0.1's, or a test's). */
export function defaultSettings() {
  return resolveSettings({}, {});
}
