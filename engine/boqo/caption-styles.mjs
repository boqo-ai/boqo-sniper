// ported from boqo-ai/boqo packages/core/src/caption-styles.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import {
  CAPTION_PRESETS, captionPresetFingerprint,
                                                   
} from "./caption-presets.mjs";
// ported from boqo-ai/boqo packages/core/src/illustrated.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut import: ILLUSTRATED_PREVIEW is `export const ILLUSTRATED_PREVIEW = true;` in packages/core/src/illustrated.ts
// (the Illustrated look is developer-only at the pin, so `illustrated` stays out of the gallery and of
// GALLERY_CAPTION_STYLE_KEYS); the rest of that module is the B-roll look this skill does not render.
const ILLUSTRATED_PREVIEW = true;

/**
 * The ten styles the 2026-10-05 gallery adds (spec §2.1; the approved mockup's
 * `CS.CAPS` holds the look of each). Built on karaoke's behaviour so grouping,
 * spacing and margins are the ones every positioned preset shares.
 *
 * NOT in CAPTION_PRESETS, whose digest, POSITIONED_PRESETS and size ceiling stay the legacy five's; caption-style-registry.ts resolves both tables (caption styles P2).
 */
                             
                                                           
                                                          
                  

const KARAOKE = CAPTION_PRESETS.find((p) => p.key === "karaoke")                           ;
const base = (key                 , label        , tier                 , o                                  )                          =>
  ({ ...KARAOKE, key, label, tier, ...o });

export const CAPTION_STYLES                            = [
  base("bounce", "Bounce", "free", { accentColours: ["#FFD400"], emphasis: { kind: "colour" }, entrance: "bounce", reveal: true }),
  base("neon", "Neon", "plus", { fontName: "Bebas Neue", capHeightPx: 52, outlineWidth: 0, accentColours: ["#FFFFFF"], emphasis: { kind: "glow", boost: 0.35 }, glow: { colour: "#FF2BD6", strength: 0.8 }, entrance: "fade" }),
  base("boldkeys", "Bold Keys", "plus", { fontName: "Poppins Black", capHeightPx: 42, outlineWidth: 6, accentColours: ["#FFFFFF", "#39FF14"], cycleColours: ["#FFD400", "#FF3B3B"], keyFont: "Anton", keyScalePct: 118, keyAlways: true, emphasis: { kind: "scale", scalePct: 118 }, animatePop: true }),
  base("typewriter", "Typewriter", "plus", { fontName: "Archivo Black", capHeightPx: 38, textCase: "preserve", outlineWidth: 0, accentColours: ["#F8F800"], shadow: { kind: "soft" }, emphasis: { kind: "none" }, entrance: "type", reveal: true }),
  base("slide", "Slide", "plus", { accentColours: ["#00E5FF"], emphasis: { kind: "colour" }, entrance: "slide" }),
  base("comic", "Comic", "plus", { fontName: "Bangers", capHeightPx: 50, outlineWidth: 11, accentColours: ["#FFFFFF", "#FFD400"], cycleColours: ["#FF5A1F", "#3AE0FF"], keyAlways: true, tilt: "keywords", emphasis: { kind: "scale", scalePct: 114 }, animatePop: true }),
  base("marker", "Marker", "plus", { fontName: "Permanent Marker", capHeightPx: 44, textCase: "preserve", outlineWidth: 5, accentColours: ["#FFE14D"], emphasis: { kind: "marker", colour: "#FFE14D", textColour: "#16131C" } }),
  base("stack", "Shadow Stack", "plus", { fontName: "Archivo Black", capHeightPx: 41, outlineWidth: 0, accentColours: ["#FFD400"], shadow: { kind: "hard", colour: "#FF2E63" }, emphasis: { kind: "colour" } }),
  base("minimal", "Minimal", "plus", { fontName: "Inter", capHeightPx: 30, textCase: "lower", outlineWidth: 0, accentColours: ["#F8F800"], shadow: { kind: "soft" }, emphasis: { kind: "dim", restOpacity: 0.6 }, entrance: "fade", wordsTarget: 5, wordsMax: 5 }),
  base("editorial", "Editorial", "plus", { fontName: "Bebas Neue", capHeightPx: 52, outlineWidth: 6, accentColours: ["#FFE14D", "#FF6B35"], keyFont: "Luckiest Guy", keyScalePct: 120, keyAlways: true, emphasis: { kind: "colour" } }),
  // The Illustrated look's captions (spec §5.1, #192): a small phrase line with up to two
  // key words popped in Anton at 165%, numbers always among them. Always in this table so
  // captionStyleByKey and resolveCaptionStyle know it; in the gallery only after the preview.
  base("illustrated", "Illustrated", "free", { capHeightPx: 34, wordsMin: 3, wordsTarget: 5, wordsMax: 6, maxLines: 2, emphasis: { kind: "scale", scalePct: 112 }, accentColours: ["#F8F800"], keyFont: "Anton", keyScalePct: 165, keyAlways: true, numbersKey: true, keyMax: 2 }),
];

/** Out of the gallery while ILLUSTRATED_PREVIEW holds, so the tiles manifest's digest stays the fifteen's. */
const inGallery = (s                         ) => !ILLUSTRATED_PREVIEW || s.key !== "illustrated";

/** The picker's order: today's five, then the ten (then illustrated, once promoted). `none` is not a style. */
export const GALLERY_CAPTION_STYLES                  = [
  ...CAPTION_PRESETS.filter((p) => p.key !== "none"),
  ...CAPTION_STYLES.filter(inGallery),
];

const SHIPPED_GALLERY_KEYS = [
  "karaoke", "punch", "clean", "highlight", "classic",
  "bounce", "neon", "boldkeys", "typewriter", "slide", "comic", "marker", "stack", "minimal", "editorial",
]         ;

/** The gallery's keys as a tuple, for schemas (`BrandCaptions.style`); a test binds it to the table. */
export const GALLERY_CAPTION_STYLE_KEYS = ILLUSTRATED_PREVIEW
  ? SHIPPED_GALLERY_KEYS
  : ([...SHIPPED_GALLERY_KEYS, "illustrated"]         );

                                                                                                                        

/** What a style's ⚙ shows: the shared knobs, then only what this style draws (mockup `CS.knobs`). Position is dragged, never a knob. */
export function knobsFor(preset               )                {
  if (preset.emission !== "positioned") return [];
  const k                = [{ key: "font", label: "Font", kind: "font" }];
  if (preset.keyFont) k.push({ key: "keyFont", label: "Key-word font", kind: "font" });
  k.push({ key: "size", label: "Size", kind: "range" }, { key: "words", label: "Words on screen", kind: "step" }, { key: "case", label: "Case", kind: "seg" });
  k.push({ key: "textColour", label: "Text", kind: "colour" });
  if (preset.emphasis.kind !== "none" && preset.emphasis.kind !== "dim") k.push({ key: "accentColour", label: preset.emphasis.kind === "marker" ? "Highlighter" : "Active word", kind: "colour" });
  if (preset.accentColours.length >= 2 || preset.cycleColours) k.push({ key: "keyColour", label: "Key words", kind: "colour" });
  if (preset.outlineWidth > 0) k.push({ key: "outlineColour", label: "Outline", kind: "colour" });
  if (preset.glow) k.push({ key: "glowColour", label: "Glow", kind: "colour" }, { key: "glowStrength", label: "Glow strength", kind: "range" });
  if (preset.shadow?.kind === "hard") k.push({ key: "shadowColour", label: "Shadow", kind: "colour" });
  if (preset.cycleColours) k.push({ key: "cycle", label: "Cycle key-word colours", kind: "switch" });
  if (preset.entrance || preset.emphasis.kind === "marker") k.push({ key: "speed", label: "Animation speed", kind: "range" });
  return k;
}

/** Everything about the gallery that changes how a loop tile looks (labels excluded), for the tile manifest. */
export function captionStyleFingerprint()         {
  return captionPresetFingerprint(GALLERY_CAPTION_STYLES);
}
