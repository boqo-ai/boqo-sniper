// ported from boqo-ai/boqo packages/core/src/headline.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";
import { BrandTiming } from "./brand-timing.mjs";
import { faceFor } from "./caption-faces.mjs";
import { CAPTION_FONTS } from "./caption-overrides.mjs";
import { HEADLINE_STYLES, HEADLINE_STYLE_KEYS,                    } from "./headline-styles.mjs";
                                                

/**
 * The burned-in headline (design §4.3): a clip's own title or hook line,
 * drawn as styled text on a rounded plate.
 *
 * Both source columns are written by selection today and read by no
 * renderer, which makes this the FOURTH consecutive case in this codebase of
 * a signal already on the wire and read by nothing — after per-shot subject
 * coverage, the sentence boundary on `punctuated_word`, and
 * `TranscriptWord.confidence`. Worth grepping for rather than tripping over.
 *
 * Every geometric value here is a FRACTION of frame width or height, never a
 * pixel (parent spec §2.7), which is what keeps stage 5's aspect-ratio work
 * one sweep rather than a retrofit.
 *
 * CSS `#RRGGBB`, matching `BrandCaptions`'s own `Colour`. Declared again
 * rather than imported because that one is deliberately module-private
 * there; the two must not drift, and a test holds them together.
 */
const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Which column the text comes from.
 *
 * `clips.title` is NOT NULL and `clips.hook` is nullable, so a template set
 * to `hook` must fall back to NO headline on a clip that has none rather
 * than drawing an empty plate — see `headlineText`, which is the single
 * place that rule lives.
 */
export const HeadlineSource = z.enum(["title", "hook"]);
                                                            

/** Derived from the schema so the panel's list and the validator's cannot drift. */
export const HEADLINE_SOURCES                            = HeadlineSource.options;

/**
 * The two inks a headline may be drawn in, and the pair is a MEASUREMENT
 * rather than a palette choice.
 *
 * `headlineInk` picks whichever of the two contrasts better against the
 * plate, so the guarantee this feature needs — "no plate colour can produce
 * an unreadable headline" — is a property of the PAIR: the worst plate
 * colour is the one where both inks are equally bad, and the contrast there
 * is `sqrt((Ld + .05)(Ll + .05)) / (Ld + .05)`.
 *
 * Swept over a 16-level-per-channel grid of all 4096 plate colours:
 *
 *   #000000 / #FFFFFF   worst case 4.584:1   (clears WCAG AA's 4.5:1)
 *   #0B0D04 / #F3EFFA   worst case 4.155:1   (does NOT)
 *
 * The second pair is the design system's own near-black and ink-1, and it is
 * what the mockup uses. Pure black and white are used here instead because
 * they are the only pair that clears AA on EVERY plate colour, and the
 * failure direction is not symmetric: a headline is burned in and
 * `requeue-render.js` skips `ready` clips, so an unreadable one is
 * unrecoverable per clip. Deviating from the mockup's two hex values is
 * cheap; deviating from the guarantee is not. Pinned by a sweep test.
 */
export const HEADLINE_INK_DARK = "#000000";
export const HEADLINE_INK_LIGHT = "#FFFFFF";

/** sRGB channel (0-255) to linear light, per WCAG 2.x. */
function channelToLinear(value        )         {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a `#RRGGBB` colour, per WCAG 2.x. */
export function relativeLuminance(hex        )         {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channelToLinear((n >> 16) & 255);
  const g = channelToLinear((n >> 8) & 255);
  const b = channelToLinear(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(a        , b        )         {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white text on an arbitrary plate, COMPUTED rather than looked up.
 *
 * Design §4.3 requires this: "once any colour can be chosen, a pale plate
 * with hardcoded dark text is the `highlight` preset's invisible-caption
 * failure repeating on burned-in output."
 *
 * It compares the two measured contrasts directly instead of testing
 * luminance against a threshold, and that is not a stylistic preference —
 * the mockup's own `inkOn` uses a threshold of 0.34 where the true crossover
 * for its ink pair is 0.173, and the gap is reachable from its own swatches.
 * Measured on the six plate chips the mockup offers:
 *
 *   #C8FF4D  L 0.843   dark    16.64:1
 *   #FFB547  L 0.548   dark    11.13:1
 *   #9B7BFF  L 0.284   light    2.78:1   <- below AA; dark gives 6.21:1
 *   #FF5FA8  L 0.323   light    2.49:1   <- below AA; dark gives 6.94:1
 *   #07060B  L 0.002   light   17.83:1
 *   #FFFFFF  L 1.000   dark    19.56:1
 *
 * Two of six. Comparing the ratios cannot be wrong for any input and needs
 * no constant, so there is nothing left to tune or to get wrong later.
 */
export function headlineInk(plateColour        )         {
  const plate = relativeLuminance(plateColour);
  const dark = contrastRatio(plate, relativeLuminance(HEADLINE_INK_DARK));
  const light = contrastRatio(plate, relativeLuminance(HEADLINE_INK_LIGHT));
  return dark >= light ? HEADLINE_INK_DARK : HEADLINE_INK_LIGHT;
}

/**
 * The contrast every headline is guaranteed, whatever plate colour and
 * whatever footage sits behind a translucent one.
 *
 * 3:1 is WCAG AA's floor for LARGE text, which is the applicable bar rather
 * than a relaxation of 4.5:1: the smallest headline this schema permits is
 * `HEADLINE_CAP_MIN * REFERENCE_HEIGHT` = 23px of cap height, drawn bold, far
 * past AA's 24px/18.5pt large-text threshold. At full opacity the real
 * guarantee is 4.584:1 and clears AA outright.
 */
export const HEADLINE_MIN_CONTRAST = 3;

/**
 * How translucent a plate may be before the ink choice stops being safe.
 *
 * `headlineInk` reads the plate's own colour, but a translucent plate is
 * composited over footage boqo has not seen, so what actually reaches the
 * eye is `alpha * plate + (1 - alpha) * footage` — PER CHANNEL AND IN THE
 * VIDEO'S GAMMA-ENCODED SPACE, because that is where libass blends, not in
 * linear light. So the guarantee degrades as alpha falls, and this is where
 * it stops clearing `HEADLINE_MIN_CONTRAST`.
 *
 * Swept over all 4096 plate colours on a 16-level-per-channel grid against
 * both footage extremes (every channel 0, every channel 255), taking the
 * worst:
 *
 *   alpha 1.00   4.584:1   (AA)
 *   alpha 0.90   3.804:1
 *   alpha 0.85   3.469:1
 *   alpha 0.80   3.172:1   <- the last step above 3:1
 *   alpha 0.75   2.903:1   FAILS
 *
 * So 0.8 is a derived bound, not taste — the same construction
 * `captionSizeCeiling` uses, and pinned by the same kind of sweep test, so
 * a future change to either ink fails there rather than off the readable end
 * of a burned-in clip.
 */
export const HEADLINE_PLATE_OPACITY_MIN = 0.8;

/**
 * At most three lines, matching every positioned caption preset's own
 * `maxLines`. It bounds `HEADLINE_CAP_CEILING` below, so it is not merely a
 * wrapping preference: the plate has to fit the frame at its tallest.
 */
export const HEADLINE_MAX_LINES = 3;

/** Distance between line centres, as a multiple of cap height. */
export const HEADLINE_LINE_SPACING_RATIO = 1.35;

/**
 * One line's own drawn height — ascender to descender — as a multiple of cap
 * height. `caption-metrics-table.ts` measures cap height and advance width
 * and nothing else, so this is a ratio rather than a measurement, and it is
 * deliberately generous: it sizes the PLATE, and a plate slightly taller
 * than its text reads as padding while one slightly shorter reads as a
 * clipped box. Checked against rendered pixels in the acceptance gate.
 */
export const HEADLINE_GLYPH_BOX_RATIO = 1.45;

/** Plate padding above and below the text block, as a multiple of cap height. */
export const HEADLINE_PAD_Y_RATIO = 0.4;

/** Plate padding either side of the text, as a multiple of cap height. */
export const HEADLINE_PAD_X_RATIO = 0.55;

/**
 * The plate's full height for a given line count and cap height, in output
 * pixels. Exported because the renderer draws with it, the ceiling below is
 * derived from it, and the preview scales by it — three readers of one
 * geometry, which is exactly the shape that drifts when it is written out
 * three times.
 */
export function headlinePlateHeight(lines        , capHeightPx        )         {
  const spans = Math.max(0, lines - 1) * HEADLINE_LINE_SPACING_RATIO;
  return capHeightPx * (spans + HEADLINE_GLYPH_BOX_RATIO + 2 * HEADLINE_PAD_Y_RATIO);
}

/**
 * The band `positionFraction` may occupy, as the plate's own CENTRE.
 *
 * Symmetric on purpose: with `min = 1 - max` a single edge distance bounds
 * both the top and the bottom, so `HEADLINE_CAP_CEILING` below needs one
 * term rather than two that could disagree.
 */
export const HEADLINE_POSITION_MIN = 0.08;
export const HEADLINE_POSITION_MAX = 0.92;

/**
 * How tall a headline could be before its plate, sat at the closest to an
 * edge the schema allows and wrapped to the most lines it allows, leaves the
 * frame.
 *
 * Derived, never typed by hand, and it exists for the reason
 * `captionSizeCeiling` does: size and position are not independent, and a
 * creator may set both to their extremes at once. That pairing is exactly
 * what nothing had tested when the caption size control shipped.
 */
export const HEADLINE_CAP_CEILING =
  (2 * Math.min(HEADLINE_POSITION_MIN, 1 - HEADLINE_POSITION_MAX)) /
  ((HEADLINE_MAX_LINES - 1) * HEADLINE_LINE_SPACING_RATIO +
    HEADLINE_GLYPH_BOX_RATIO +
    2 * HEADLINE_PAD_Y_RATIO);

/**
 * The band a template may set cap height within, as a fraction of frame
 * HEIGHT — the same unit the position band uses, so the two compose.
 *
 * The shipped ceiling sits under `HEADLINE_CAP_CEILING` for the reason
 * `CAPTION_SIZE_MAX` sits under its own: the failure directions are not
 * symmetric. Too large is a plate clipped off the top of a clip, burned in
 * and unrecoverable; too small is merely small.
 */
export const HEADLINE_CAP_MIN = 0.012;
export const HEADLINE_CAP_MAX = 0.03;

/**
 * The band for the TEXT's own width, as a fraction of frame width. The plate
 * is this plus `HEADLINE_PAD_X_RATIO` of cap height either side.
 */
export const HEADLINE_BOX_MIN = 0.4;
export const HEADLINE_BOX_MAX = 0.92;

/**
 * What keeps the PLATE inside the frame at the largest cap the band permits
 * -- the horizontal twin of `HEADLINE_CAP_CEILING`.
 *
 * Its only frame dependence is the aspect, so unlike `captionSizeCeiling`
 * this is NOT invariant across ratios: it loosens as the frame widens
 * (0.941 / 0.967 / 0.981), and its test asserts that direction. It clears
 * HEADLINE_BOX_MAX at every ratio stage 5 ships, so it carries no defect --
 * it becomes a function because a constant derived from a frame size that is
 * no longer constant is a lie whatever its value.
 */
export function headlineBoxCeiling(output            )         {
  return 1 - (2 * HEADLINE_PAD_X_RATIO * HEADLINE_CAP_MAX * output.height) / output.width;
}

/**
 * Corner radius as a fraction of frame WIDTH. `BorderStyle: 3` draws a square
 * plate and ASS has no corner radius, so the plate is a `\p1` vector drawing
 * (design §4.3) — cheap, and only possible because the width is already
 * measured.
 *
 * The renderer clamps to half the plate's smaller dimension, because a radius
 * past that produces a degenerate path rather than a rounder box.
 */
export const HEADLINE_RADIUS_MIN = 0;
export const HEADLINE_RADIUS_MAX = 0.06;

export const BrandHeadline = z.object({
  source: HeadlineSource,
  /**
   * A discriminated union from day one for the reason `BrandCaptions.font`
   * is one: stage 3b's uploaded fonts slot in with no migration.
   *
   * Restricted to the measured registry faces (CAPTION_FONTS), and that
   * restriction is what makes the headline possible at all -- it emits
   * through measureWidth and wrapGroup, and both read
   * caption-metrics-table.ts, which has one entry per face. Measured
   * 2026-10-05 with a probe over `layoutHeadline`: all eleven faces fit the
   * widest real title unshrunk and shrink the widest real hook without
   * overflow, so `apps/worker/tests/render-headline.test.ts`'s loops over
   * `CAPTION_FONTS` hold for the wider list.
   */
  font: z.object({ kind: z.literal("builtin"), name: z.enum(CAPTION_FONTS) }),
  capHeightFraction: z.number().min(HEADLINE_CAP_MIN).max(HEADLINE_CAP_MAX),
  plateColour: Colour,
  plateOpacity: z.number().min(HEADLINE_PLATE_OPACITY_MIN).max(1),
  cornerRadiusFraction: z.number().min(HEADLINE_RADIUS_MIN).max(HEADLINE_RADIUS_MAX),
  boxWidthFraction: z.number().min(HEADLINE_BOX_MIN).max(HEADLINE_BOX_MAX),
  positionFraction: z.number().min(HEADLINE_POSITION_MIN).max(HEADLINE_POSITION_MAX),
  timing: BrandTiming,
  // ---- caption styles P2 (spec §3.1): the headline's style and its knobs. All
  // optional, so every headline stored before P2 parses unchanged and draws as
  // it did (`headlineStyleFor` answers undefined). A style this build does not
  // know reads as absent, as BrandCaptions.style does (zod 4.4.3 `.catch`,
  // measured 2026-10-05). The plate fields above are the plate look's knobs. ----
  style: z.enum(HEADLINE_STYLE_KEYS).optional().catch(undefined),
  /** Ink for the text and marker looks; a plate's ink stays `headlineInk`'s. */
  textColour: Colour.optional(),
  outlineColour: Colour.optional(),
  glowColour: Colour.optional(),
  glowStrength: z.number().min(0).max(1).optional(),
  shadowColour: Colour.optional(),
  entrance: z.enum(["none", "fade", "pop", "slide", "type"]).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  /** Absent = the title as written. */
  textCase: z.enum(["upper", "preserve"]).optional(),
});
                                                          

/**
 * Every field, for the diff and the change summary to walk.
 *
 * `satisfies` is one-directional — it checks every LISTED name is real, never
 * that every real key is listed — so it alone would still compile with a new
 * field silently missing, which is "a control that silently does nothing",
 * the failure this whole stage's contrast rule also exists to prevent. The
 * exhaustiveness test against `BrandHeadline.shape` closes it; this export
 * just makes that test possible, exactly as `LOGO_FIELDS` does.
 */
export const HEADLINE_FIELDS = [
  "source",
  "font",
  "capHeightFraction",
  "plateColour",
  "plateOpacity",
  "cornerRadiusFraction",
  "boxWidthFraction",
  "positionFraction",
  "timing",
  "style",
  "textColour",
  "outlineColour",
  "glowColour",
  "glowStrength",
  "shadowColour",
  "entrance",
  "speed",
  "textCase",
]                                                    ;

/**
 * What a headline would actually say on one clip, or null for no headline at
 * all.
 *
 * The single place design §4.3's nullable-hook rule lives: "a template set to
 * `hook` must fall back to no headline on a clip that has none rather than
 * drawing an empty plate." A whitespace-only hook counts as none for the same
 * reason — an empty plate is the failure being avoided, and a plate holding a
 * space is the same picture.
 *
 * Worth knowing before this reads as dead: measured on production
 * 2026-09-05, ALL 1113 clips have a non-null hook, so this branch is real per
 * the schema and has never occurred. Its test has to construct the case; there
 * is none to look at.
 */
export function headlineText(
  headline                           ,
  clip                                        ,
)                {
  if (headline === undefined) return null;
  const raw = headline.source === "title" ? clip.title : clip.hook;
  if (raw === null) return null;
  const text = raw.trim();
  return text === "" ? null : text;
}

/**
 * What a headline starts out as when a creator first turns one on -- and,
 * since caption styles P3 (ruling R7), the base a clip's text element is laid
 * over when its brand carries no headline. It moved here from
 * `apps/web/src/components/brand/headline-controls.ts` (which re-exports it)
 * because the worker draws text elements and cannot import from web.
 *
 * `title` rather than `hook`, because `clips.title` is NOT NULL: a template
 * whose default source could be absent would ship a headline that silently
 * does not appear on some clips. The lime plate is the mockup's own default,
 * and `positionFraction` 0.14 puts the plate's centre where the mockup's
 * `top: 9%` puts its top edge at this size. Spec D14: a new headline shows
 * 0–3 s.
 */
export const DEFAULT_HEADLINE                = {
  source: "title",
  font: { kind: "builtin", name: "Montserrat ExtraBold" },
  capHeightFraction: 0.022,
  plateColour: "#C8FF4D",
  plateOpacity: 1,
  cornerRadiusFraction: 0.01,
  boxWidthFraction: 0.84,
  positionFraction: 0.14,
  timing: { kind: "window", startSec: 0, holdSec: 3 },
};

/**
 * When a headline is on screen, in clip seconds, lead excluded: `whole` is
 * the clip's own length, which the caller supplies; a window is clamped into
 * it. In core since caption styles P3, so the renderer's emitter and a text
 * element's span (`elementSpan`, text-layers.ts) are one rule, not two.
 */
export function headlineWindow(
  headline               ,
  clipDurationSec        ,
)                                       {
  if (headline.timing.kind === "whole") return { startSec: 0, endSec: clipDurationSec };
  const startSec = Math.min(headline.timing.startSec, clipDurationSec);
  return {
    startSec,
    endSec: Math.min(startSec + headline.timing.holdSec, clipDurationSec),
  };
}

/**
 * The headline style a brand's headline draws in, its knobs laid over the
 * style's own values (P2-R8), for `buildHeadlineAss`'s `style` argument.
 *
 * Undefined without a style (or with one this build does not know): today's
 * headline, byte for byte. `font` and `plateColour` are REQUIRED brand fields,
 * so "the user set it" cannot be told from "it was there": the brand's wins
 * wherever the style draws one, and picking a style seeds both with the
 * style's own (style-list-model.ts `pickHeadlineStyle`). The bare plate keeps
 * `font: null` and no `plateColour` -- the brand's face drawn directly, which
 * `buildHeadlineAss` treats as today's path -- unless the brand's face needs a
 * covering fallback, in which case the face is named so the renderer can
 * swap it for a title it cannot draw.
 *
 * Every other knob lands exactly where `headlineKnobsFor` offers it (the
 * approved ⚙ is the authority): `textColour` only on the text and marker looks
 * (a plate's ink derives from the plate), and `speed` only under a style that
 * has an entrance of its own.
 */
export function headlineStyleFor(headline               )                            {
  if (headline.style === undefined) return undefined;
  const base = HEADLINE_STYLES.find((style) => style.key === headline.style);
  if (base === undefined) return undefined;
  const face = headline.font.name;
  return {
    ...base,
    font: base.font !== null || faceFor(face).fallback !== null ? face : null,
    plateColour: base.plateColour === undefined ? undefined : headline.plateColour,
    textColour: base.look !== "plate" ? (headline.textColour ?? base.textColour) : base.textColour,
    textCase: headline.textCase ?? base.textCase,
    outline: base.outline === undefined ? undefined : { ...base.outline, colour: headline.outlineColour ?? base.outline.colour },
    glow: base.glow === undefined ? undefined : { colour: headline.glowColour ?? base.glow.colour, strength: headline.glowStrength ?? base.glow.strength },
    shadow: base.shadow === undefined ? undefined : { kind: "hard", colour: headline.shadowColour ?? base.shadow.colour },
    entrance: headline.entrance ?? base.entrance,
    speed: base.entrance !== "none" ? (headline.speed ?? base.speed) : base.speed,
  };
}
