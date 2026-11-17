// ported from boqo-ai/boqo packages/core/src/caption-overrides.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";
import {
  BRAND_CAPTION_KEY,
  DEFAULT_CAPTION_PRESET_KEY,
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  CAPTION_WORDS_MAX,
  CAPTION_WORDS_MIN,
} from "./caption-presets.mjs";
import { GALLERY_CAPTION_STYLE_KEYS } from "./caption-styles.mjs";
import { captionStyleByKey, resolveCaptionStyle } from "./caption-style-registry.mjs";

/**
 * The faces a template may name. DECLARED, not derived from the presets,
 * and that is deliberate: deriving would look tidier and would couple the
 * offer list to the preset table, so removing a preset one day would
 * silently drop its face from the list and make every stored template
 * naming it fail validation — which, because `parseBrandSettings` is total,
 * drops the WHOLE brand block rather than one field.
 *
 * The real authority for "measured" is
 * `packages/core/src/caption-metrics-table.ts`, which `apps/web` reads
 * directly -- there is no package-boundary problem to route around any
 * more. `apps/worker/tests/caption-fonts.test.ts` still binds the two,
 * which is the same construction LOGO_FIELDS uses against BrandLogo.shape
 * and for the same reason. `packages/core/tests/caption-faces.test.ts` binds this list to `CAPTION_FACES`, so a face added to the registry is offered on purpose or fails there.
 */
export const CAPTION_FONTS = [
  "Montserrat ExtraBold",
  "Oswald",
  "Inter",
  "DejaVu Sans",
  // The seven display faces of the 2026-10-05 pack (caption-faces.ts
  // NEW_CAPTION_FACES), pickable since caption styles P2. None covers
  // Cyrillic (measured 2026-10-05); the renderer swaps in each one's covering
  // face for such a clip (`coveringFace`), so offering them is safe there too.
  "Anton",
  "Bebas Neue",
  "Bangers",
  "Poppins Black",
  "Archivo Black",
  "Luckiest Guy",
  "Permanent Marker",
]         ;
                                                             

/** CSS `#RRGGBB`. The renderer converts to ASS `&HBBGGRR` at emission. */
const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Re-exported, not defined here. Both bounds MOVED to `caption-presets.ts` on
 * 2026-09-05 so that `captionSizeCeiling` could be derived from
 * `CAPTION_POSITION_MAX` rather than from a second copy of `0.9` sitting one
 * file away — size and position are not independent constraints (a creator
 * can set both to their extremes at once), and a hand-copied bound is the
 * shape this repository already records failing under `booleanFromEnv`.
 *
 * The names are kept exported from here because every consumer reaches them
 * through the barrel, so nothing outside these two files can tell.
 */
export { CAPTION_POSITION_MIN, CAPTION_POSITION_MAX } from "./caption-presets.mjs";
import { CAPTION_POSITION_MIN, CAPTION_POSITION_MAX } from "./caption-presets.mjs";

/**
 * Caption APPEARANCE, carried by a brand template (design §2.1). The preset
 * a project chose still owns caption BEHAVIOUR, and is untouched.
 *
 * Every member is optional, and the absence of one means "leave the preset's
 * own value alone". That is what makes one template usable across `karaoke`
 * and `clean` without flattening the difference between them.
 */
export const BrandCaptions = z.object({
  /**
   * A discriminated union from day one so stage 3b's uploaded fonts slot in
   * with no migration — the whole reason stage 3 was split from them.
   */
  font: z
    .object({ kind: z.literal("builtin"), name: z.enum(CAPTION_FONTS) })
    .optional(),
  baseColour: Colour.optional(),
  /** 1-2, because `karaoke` cycles two per word index and the others use one. */
  accentColours: z.array(Colour).min(1).max(2).optional(),
  outlineColour: Colour.optional(),
  textCase: z.enum(["upper", "preserve", "lower"]).optional(),
  positionFraction: z.number().min(CAPTION_POSITION_MIN).max(CAPTION_POSITION_MAX).optional(),
  wordsTarget: z.number().int().min(CAPTION_WORDS_MIN).max(CAPTION_WORDS_MAX).optional(),
  /**
   * A MULTIPLE of the preset's own `capHeightPx`, not an absolute size.
   * See `CAPTION_SIZE_MIN`/`MAX` for why relative, and why the shipped ceiling
   * sits under the one the frame geometry permits.
   */
  sizeScale: z.number().min(CAPTION_SIZE_MIN).max(CAPTION_SIZE_MAX).optional(),
  // ---- caption styles P2 (spec §3.1): the brand's style and the knobs its ⚙ shows ----
  /**
   * The style the block is laid over under `default` (`resolveProjectCaptions`);
   * absent = karaoke, so every brand stored before P2 renders unchanged. A key
   * this build does not know reads as absent instead of failing the whole brand
   * block (`parseBrandSettings` is total): `.catch` on zod 4.4.3, measured
   * 2026-10-05 -- the key reads `undefined` and the block's other members survive.
   */
  style: z.enum(GALLERY_CAPTION_STYLE_KEYS).optional().catch(undefined),
  /** The key words' face, on a style that has one. */
  keyFont: z.enum(CAPTION_FONTS).optional(),
  glowColour: Colour.optional(),
  /** In the preset's own units (`glow.strength`). */
  glowStrength: z.number().min(0).max(1).optional(),
  /** A hard shadow's colour. */
  shadowColour: Colour.optional(),
  /** false: key words keep one colour instead of cycling. */
  cycle: z.boolean().optional(),
  /** Divides every animation's duration (`PositionedCaptionPreset.speed`). */
  speed: z.number().min(0.5).max(2).optional(),
});
                                                          

/**
 * A clip's own overrides (`clips.caption_overrides`): the brand block without
 * `style`. A clip's style lives in its own `caption_style` column; a `style`
 * sent inside the overrides is dropped by this parse -- zod strips an unknown
 * key (measured on zod 4.4.3, 2026-10-05) -- and never stored (ruling P2-R6).
 */
export const ClipCaptionOverrides = BrandCaptions.omit({ style: true });
                                                                        

                                                       

/**
 * How many override fields a block actually carries. Logged as
 * `captionOverrides` on `shot placement complete` so a deployed-but-inert
 * feature is distinguishable from a deployed-and-firing one — this codebase
 * has three times shipped a feature whose non-firing looked exactly like its
 * not being deployed.
 */
export function countCaptionOverrides(captions                           )         {
  if (captions === undefined) return 0;
  return Object.values(captions).filter((value) => value !== undefined).length;
}

/**
 * Whether a caption block would reach a project on this preset at all.
 *
 * The interface's counterpart to `applyCaptionOverrides`'s identity return:
 * the composer must not tell a creator that their template "restyles these"
 * above a `classic` or `none` tile it provably ignores, and design §2.2
 * requires the exclusion be VISIBLE rather than silent in two places — the
 * template editor's panel says it in words, and the composer says it by
 * omitting a line that would otherwise be false.
 *
 * Derived from the same `emission` discriminant the renderer branches on,
 * never a second hand-kept list of excluded keys, and bound to
 * `applyCaptionOverrides` by a test that walks every preset: the two must
 * agree for all of them, so one cannot start excluding a preset the other
 * still styles.
 */
export function captionOverridesReach(value                           )          {
  return resolveCaptionStyle(value).emission === "positioned";
}

/**
 * Lay a template's caption appearance over the preset a project chose.
 *
 * Returns the preset BY IDENTITY — not a structurally-equal copy — when
 * there is nothing to apply, so "this project is unaffected" is checkable by
 * reference. That is what the gate's byte-identity arms rest on.
 *
 * `legacy` and `none` are returned untouched whatever the block says (design
 * §2.2): `classic` exists to be a frozen control arm and carries a raw ASS
 * `fontSize` where this path derives one from a measured cap ratio, so a
 * font swap there would move caption size by up to 37% with nothing to catch
 * it; `none` has no captions to style.
 */
export function applyCaptionOverrides(
  preset               ,
  captions                           ,
)                {
  if (captions === undefined) return preset;
  if (preset.emission !== "positioned") return preset;
  if (countCaptionOverrides(captions) === 0) return preset;

  const next = { ...preset };
  if (captions.font !== undefined) next.fontName = captions.font.name;
  if (captions.baseColour !== undefined) next.baseColour = captions.baseColour;
  if (captions.accentColours !== undefined) {
    next.accentColours = [...captions.accentColours];
    // A marker style draws its highlighter from `emphasis.colour`, not from the
    // accents (read from the source, 2026-10-05: the worker's captions.ts hands
    // it to markerEvent, caption-visual.ts draws `v.marker` in it), so its ⚙'s
    // Highlighter knob lands there. A new object: the table is shared.
    // `box` keeps reading `boxColour` as it always has (stored clips depend on it).
    if (next.emphasis.kind === "marker") next.emphasis = { ...next.emphasis, colour: captions.accentColours[0]  };
  }
  if (captions.outlineColour !== undefined) next.outlineColour = captions.outlineColour;
  if (captions.textCase !== undefined) next.textCase = captions.textCase;
  if (captions.positionFraction !== undefined) next.centreFraction = captions.positionFraction;
  if (captions.wordsTarget !== undefined) {
    // Clamped into `[CAPTION_WORDS_MIN, preset.wordsMax]`, and the choice of
    // those two bounds -- rather than the preset's own `wordsMin`/`wordsMax`
    // pair, which is what this line read until 2026-09-04 -- is the whole
    // reason a template can ask for one word per caption at all.
    //
    // `wordsMax` IS a render-time constraint: `captionGroups` walks its group
    // count up until `ceil(n / groupCount)` no longer exceeds it, so a target
    // above it would fight that loop, and clamping keeps the two coherent.
    // `wordsMin` is NOT: `bounds.min` has zero references in
    // `render/captions.ts`. Clamping up to it protected nothing and silently
    // raised every target below the preset's own floor back to 3 -- so a
    // template asking for 1 would have rendered identically to one asking for
    // 3, with the control moving, the value persisting and the change summary
    // reporting it as changed. Exactly the shape of failure this repository
    // keeps recording, and the one this change exists to avoid shipping.
    //
    // The floor that remains is the renderer's own arithmetic: it divides the
    // word count by the target, so the target must be at least 1.
    // positionFraction is still not re-clamped at all, for the reason it never
    // was: its band is preset-independent, so the schema bound is the whole
    // guard there.
    next.wordsTarget = Math.min(
      Math.max(captions.wordsTarget, CAPTION_WORDS_MIN),
      next.wordsMax,
    );
  }
  if (captions.sizeScale !== undefined) {
    // Scaling `capHeightPx` is the SAFE form of the size control design §4.2
    // refuses, and the difference is which numbers move together.
    //
    // `buildPositioned` derives three things from this one value
    // (`render/captions.ts:495-498`): the ASS `Fontsize`, via
    // `assFontSize(metrics, capHeightPx)`; the line spacing, via
    // `capHeightPx * lineSpacingRatio`; and — because that same font size is
    // handed to `measureWidth` — every line-break decision `wrapGroup` makes.
    // Scale the cap height and all three move coherently. Override the ASS
    // `Fontsize` directly, which is what §4.2 was written against, and the
    // glyphs grow while the line spacing stays behind on the old cap height.
    //
    // Rounded because every preset declares an integer here and
    // `assFontSize`/`lineSpacing` both round downstream anyway; keeping the
    // stored value integral makes a rendered clip reproducible from the row.
    //
    // The clamp is the schema's, not a second one: unlike `wordsTarget` there
    // is no per-preset band to reconcile with, because the bound that matters
    // (`captionSizeCeiling`) is already computed ACROSS the presets, against
    // the worst of them. A per-preset re-clamp here would silently let a
    // `clean` project exceed what the shipped ceiling promises.
    next.capHeightPx = Math.round(next.capHeightPx * captions.sizeScale);
  }
  // ---- caption styles P2: the style knobs (spec §3.1). Each lands only on a
  // preset that draws it, so a block carried from a style with glow or a key
  // face onto one without changes nothing: the editor never writes a knob a
  // style does not show (style-list-model.ts), and nothing here applies one. ----
  if (captions.keyFont !== undefined && next.keyFont !== undefined) next.keyFont = captions.keyFont;
  if (next.glow !== undefined && (captions.glowColour !== undefined || captions.glowStrength !== undefined)) {
    next.glow = { colour: captions.glowColour ?? next.glow.colour, strength: captions.glowStrength ?? next.glow.strength };
  }
  if (captions.shadowColour !== undefined && next.shadow?.kind === "hard") {
    next.shadow = { kind: "hard", colour: captions.shadowColour };
  }
  if (captions.cycle === false) delete next.cycleColours;
  if (captions.speed !== undefined && (next.entrance !== undefined || next.emphasis.kind === "marker")) {
    next.speed = captions.speed;
  }
  return next;
}

/**
 * What a project's captions resolve to, and whether its brand had a say.
 *
 * Both halves come back from ONE call on purpose. The count is what
 * `shot placement complete` logs as `captionOverrides`, and it used to be
 * read straight off the template's own block — which counted fields the
 * render was about to apply, and was right only while every project applied
 * them. Under `BRAND_CAPTION_KEY` a project can carry a template with four
 * caption overrides and use none of them, so a count taken from the block
 * would report 4 on a clip drawn with zero. Returning the two together means
 * the log cannot disagree with the pixels.
 */
                               
                                                                                        
                        
                                                                                              
                           
  

/**
 * The ONE place that decides how a project's captions look.
 *
 * Every drawing site calls this rather than pairing `resolveCaptionStyle`
 * with `applyCaptionOverrides` itself: the render handler, the render
 * harness, and the clip editor's own route (it fed that editor's transcript
 * panel until §5.5 removed it; the route still resolves the preset, for the
 * Captions panel's chip). The pair is what those
 * three used to do, and it left the opt-out rule as three independent
 * `if`s to remember — the shape that let the uniqueizer harness compute a
 * recipe correctly and then render the wrong window (finding F64), and the
 * shape stage 8a's own gate found again when a hardcoded role survived a
 * whole test file. One function cannot be forgotten at one of three call
 * sites.
 *
 * A project that never asked for its brand's captions gets the preset BY
 * IDENTITY, the same reference guarantee `applyCaptionOverrides` makes and
 * for the same reason: "this project is unaffected" stays checkable by
 * reference, which is what the byte-identity gate arms rest on.
 */
/**
 * The caption entry a project gets when nobody chose one.
 *
 * ONE rule, three callers: the creation form, which shows it already
 * selected before the creator touches anything, and both creation routes,
 * which see payloads carrying no caption style at all -- /home's Clips
 * widget posts a url and nothing else, by its own deliberate design.
 *
 * It resolves to the brand entry whenever the template being applied carries
 * captions, and that is what keeps the product coherent rather than merely
 * convenient. The template is applied either way, so defaulting to a preset
 * would leave a project wearing its brand's logo, headline and ratio while
 * ignoring the brand's captions -- one template, half applied, decided by
 * which box the creator happened to type a link into.
 *
 * It is also what keeps this whole opt-in inert for anyone who does not go
 * looking for it: before the `default` entry existed a brand's captions
 * reached every project, and afterwards they still reach every project
 * nobody has deliberately opted out of.
 */
export function defaultCaptionStyle(captions                           )         {
  return captions === undefined ? DEFAULT_CAPTION_PRESET_KEY : BRAND_CAPTION_KEY;
}

export function resolveProjectCaptions(
  captionStyle                           ,
  captions                           ,
  onUnknown                          ,
)                  {
  const preset = resolveCaptionStyle(captionStyle, onUnknown);
  if (preset.key !== BRAND_CAPTION_KEY) return { preset, overridesApplied: 0 };
  return { preset: applyCaptionOverrides(brandBase(preset, captions), captions), overridesApplied: countCaptionOverrides(captions) };
}

/**
 * The preset a brand's caption block is laid over under `default` (spec §3.1,
 * P2-R7): the brand's own `style` when it names one, else `preset` itself --
 * karaoke's behaviour under the brand key, by reference, so every brand stored
 * before P2 resolves exactly as it did. The style comes under the brand's key
 * and label, so "is this the brand's captions" still reads `default`.
 */
function brandBase(preset               , captions                           )                {
  const style = captions?.style === undefined ? null : captionStyleByKey(captions.style);
  if (style === null) return preset;
  return { ...style, key: BRAND_CAPTION_KEY, label: preset.label };
}

/**
 * What a CLIP's captions resolve to. `ProjectCaptions` plus one count.
 *
 * Two counts rather than one sum, deliberately: `overridesApplied` keeps
 * its exact existing meaning -- how many of the BRAND's caption fields the
 * render applied, which is what `shot placement complete` already logs --
 * so that field cannot quietly start reporting something else, and a field
 * overridden at both levels is not counted twice.
 */
                                                                              

/**
 * The ONE place a clip's captions are decided. `resolveProjectCaptions` is
 * still the one place a PROJECT's are, and this calls it rather than
 * restating it.
 *
 * Two steps, and only the second is new:
 *
 *   1. the project's own resolution, against the clip's preset key if it
 *      has one -- UNCHANGED, including the rule that a brand's caption
 *      block applies only at key `default` and that every other preset
 *      comes back BY IDENTITY;
 *   2. the clip's own hand-tuned overrides, applied on top of whatever
 *      step 1 produced.
 *
 * A clip that has touched neither returns step 1's object by reference,
 * which is what keeps "this clip is unaffected" checkable and is the
 * property the byte-identity control arm rests on.
 *
 * `applyCaptionOverrides` returns a non-positioned preset (`classic`,
 * `none`) untouched whatever the block says, so step 2 is a no-op there --
 * belt to the braces of the editor hiding those controls for those two
 * presets.
 */
export function resolveClipCaptions(
  input   
                                         
                                            
                                                           
                                             
   ,
  onUnknown                          ,
)               {
  const base = resolveProjectCaptions(
    input.clipStyle ?? input.projectStyle,
    input.brandCaptions,
    onUnknown,
  );
  const clipOverrides = input.clipOverrides ?? undefined;
  if (clipOverrides === undefined) return { ...base, clipOverridesApplied: 0 };
  return {
    preset: applyCaptionOverrides(base.preset, clipOverrides),
    overridesApplied: base.overridesApplied,
    clipOverridesApplied: countCaptionOverrides(clipOverrides),
  };
}
