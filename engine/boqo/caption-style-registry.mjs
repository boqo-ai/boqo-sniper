// ported from boqo-ai/boqo packages/core/src/caption-style-registry.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import {
  BRAND_CAPTION_KEY,
  CAPTION_PRESETS,
  DEFAULT_CAPTION_PRESET_KEY,
                     
                               
} from "./caption-presets.mjs";
import { CAPTION_STYLES, GALLERY_CAPTION_STYLES } from "./caption-styles.mjs";

// One registry over both caption tables (caption styles P2, ruling P2-R1):
// `CAPTION_PRESETS` (today's five plus `none`, unchanged, whose digest,
// `POSITIONED_PRESETS` and size ceiling stay theirs) and `CAPTION_STYLES`
// (P1's ten). Its own module because caption-styles.ts spreads karaoke out of
// CAPTION_PRESETS at load, so caption-presets.ts cannot import the styles
// back without a cycle.

const KARAOKE = CAPTION_PRESETS.find((p) => p.key === DEFAULT_CAPTION_PRESET_KEY)                           ;

/**
 * What `default` resolves to: karaoke's BEHAVIOUR -- words per group,
 * positioning, emphasis -- as the base a template's caption APPEARANCE is
 * laid over. That split is the brand-template design's own
 * (`caption-overrides.ts`: "The preset a project chose still owns caption
 * BEHAVIOUR"), so this entry has to name a preset for its behaviour half,
 * and karaoke is the one `resolveCaptionStyle` already defaults to. A brand
 * whose block names a `style` gets that style as its base instead
 * (`resolveProjectCaptions`, caption styles P2).
 *
 * `label` is the literal word rather than the template's name. The name is
 * already on the Brand template control directly above the picker, and a
 * tile that renamed itself when a template was renamed would disagree with
 * what `/projects/[id]` prints for the same project from the same function.
 */
const BRAND_DEFAULT                          = { ...KARAOKE, key: BRAND_CAPTION_KEY, label: "Default" };

const NONE = CAPTION_PRESETS.find((p) => p.key === "none") ;
const ALL                           = [...CAPTION_PRESETS, ...CAPTION_STYLES];

/**
 * Every caption a picker offers, in picker order: the fifteen-style gallery,
 * then No captions. `default` is not a row of it -- a picker prepends it when
 * the applied brand carries captions (caption-cycle.ts `captionEntries`).
 */
export const PICKABLE_CAPTION_STYLES                           = [...GALLERY_CAPTION_STYLES, NONE];

/** The table entry for `key` in either table, or null -- `default` is not a table entry. */
export function captionStyleByKey(key        )                       {
  return ALL.find((preset) => preset.key === key) ?? null;
}

/** See `resolveClipLength` in ./selection-presets — same contract, same reasoning. */
export function resolveCaptionStyle(
  value                           ,
  onUnknown                          ,
)                {
  if (value === null || value === undefined) return KARAOKE;
  // Before the tables, because `default` is deliberately not IN either --
  // see BRAND_CAPTION_KEY. Without this branch the sentinel reads as an
  // unrecognised value and falls back to karaoke, which is not merely a
  // wrong label: `createProject` stores `resolveCaptionStyle(input).key`, so
  // the fallback would rewrite the creator's choice to `karaoke` on the way
  // into the database and the brand's captions would never be asked for
  // again.
  if (value === BRAND_CAPTION_KEY) return BRAND_DEFAULT;
  const match = captionStyleByKey(value);
  if (match) return match;
  onUnknown?.(value);
  return KARAOKE;
}

/**
 * Whether a caption key is one of the Creator+ styles (caption styles spec §6,
 * P2-R2). The one answer every write gate, render strip and lock reads: a
 * positioned table entry whose `tier` is `plus`. The five legacy styles (no
 * tier), `none`, `default` and anything this build does not know are free --
 * an unknown key renders karaoke, which is free.
 */
export function captionStyleTier(key                           )                  {
  if (key === null || key === undefined) return "free";
  const preset = captionStyleByKey(key);
  return preset !== null && preset.emission === "positioned" && preset.tier === "plus" ? "plus" : "free";
}
