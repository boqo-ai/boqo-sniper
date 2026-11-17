// ported from boqo-ai/boqo apps/worker/src/render/brand.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                            
// Cut import: LOGO_FADE_SEC is `export const LOGO_FADE_SEC = 0.32;` in apps/worker/src/render/branding.ts (the boqo
// lockup's own letter-by-letter fade and its timing, which this skill does not draw); only the mark's fade is used here.
// ported from boqo-ai/boqo apps/worker/src/render/branding.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
/** The mark's own fade, which runs after the letters in both directions. */
export const LOGO_FADE_SEC = 0.32;

                                                          

/**
 * Even, because yuv420p cannot encode an odd dimension — rounded to the
 * NEAREST even value, with a floor of 2, because a logo must never size down
 * to 0px. This is one of three same-shaped `even*` helpers in this render
 * module (`crop.ts`'s `evenDown`, `uniqueize-filters.ts`'s `evenUp`) that
 * round differently on purpose, each correct for its own call site — see
 * either sibling for why they are not one shared function.
 */
function evenNearest(value        )         {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Where the logo sits, as ffmpeg `overlay` expressions.
 *
 * The right and bottom anchors are expressions in W, H, w and h rather than
 * numbers, and that is the whole reason this feature needs no image probe
 * (spec §4.1): ffmpeg knows the overlay's own dimensions at filter time, so
 * boqo never has to learn the logo's aspect ratio to place it.
 *
 * Margins are fractions of the FRAME, so stage 5's other two ratios need no
 * second table of numbers.
 */
export function logoOverlayPosition(
  logo           ,
  frame           ,
)                           {
  const mx = Math.round(logo.marginX * frame.width);
  const my = Math.round(logo.marginY * frame.height);
  const [vertical, horizontal] = logo.anchor.split("-");

  const x =
    horizontal === "left" ? `${mx}` : horizontal === "right" ? `W-w-${mx}` : "(W-w)/2";
  const y = vertical === "top" ? `${my}` : `H-h-${my}`;
  return { x, y };
}

/**
 * When a windowed logo has finished leaving. Mirrors `brandingTiming`'s own
 * arithmetic, including that a fade's `st` is when the ramp BEGINS.
 */
function windowEndSec(logo           )         {
  if (logo.timing.kind === "whole") return 0;
  return logo.timing.startSec + LOGO_FADE_SEC + logo.timing.holdSec + LOGO_FADE_SEC;
}

/**
 * All or nothing, the rule `brandingFits` already states: a logo that fades
 * in and is cut off mid-hold looks like a rendering fault, while a clip
 * without one looks like a clip.
 */
export function logoFits(clipDurationSec        , logo           )          {
  if (logo.timing.kind === "whole") return true;
  return clipDurationSec >= windowEndSec(logo);
}

/**
 * The complete `[1:v] … [blogo]` stage.
 *
 * At full opacity and whole-clip timing this is one `scale` and nothing
 * else — no `format=rgba`, no `colorchannelmixer`, no `fade`. Keeping the
 * graph as short as it can be is not tidiness: filter count is what took
 * seven of eight clips down on 2026-08-25, and every filter here is paid on
 * every clip of every project using the template.
 *
 * Takes no duration: this stage's own filters do not depend on the clip's
 * length, `composeArgs` is what bounds the looped still with `-t`, and
 * whether a *windowed* logo's timing fits the clip is `logoFits`'s job,
 * already checked by the one caller before this is ever reached. An earlier
 * revision carried a `durationSec` parameter it never read, on the theory
 * that requiring it would keep the caller from forgetting the two belong
 * together — but a discarded parameter enforces nothing a type signature
 * does not already give up on the moment the value is unused, so it is
 * gone rather than kept as documentation with no teeth.
 */
export function logoChain(logo           , frame           )         {
  const width = evenNearest(logo.width * frame.width);
  const stages = [`scale=${width}:-2`];

  if (logo.opacity < 1) {
    // format=rgba first: colorchannelmixer needs an alpha plane to write
    // into, and a PNG without one has none.
    stages.push("format=rgba", `colorchannelmixer=aa=${logo.opacity}`);
  }

  if (logo.timing.kind === "window") {
    const outAt = logo.timing.startSec + LOGO_FADE_SEC + logo.timing.holdSec;
    // fade's alpha=1 mode needs an alpha plane too, and holding alpha at 0
    // outside the ramps is what makes `enable=` unnecessary.
    if (logo.opacity >= 1) stages.push("format=rgba");
    stages.push(
      `fade=t=in:st=${logo.timing.startSec}:d=${LOGO_FADE_SEC}:alpha=1`,
      `fade=t=out:st=${outAt}:d=${LOGO_FADE_SEC}:alpha=1`,
    );
  }

  return `[1:v]${stages.join(",")}[blogo]`;
}

/**
 * Shift a logo's window timing by the given offset, leaving whole timing unchanged.
 *
 * A "window" logo's fades move by the offset, as every overlay moves by the
 * hook's lead in file time. A "whole" logo is left alone on purpose: its
 * chain has no timing to move, and keeping it off the hook is not this
 * function's job but compose's -- the logo overlay's `enable` gate
 * (`BrandLogoOverlay.enableFromSec` in compose.ts, set to the lead by
 * renderClip) is what makes a whole logo cover the clip and not the hook.
 */
export function shiftLogoTiming(logo           , offsetSec        )            {
  return logo.timing.kind === "whole"
    ? logo
    : { ...logo, timing: { ...logo.timing, startSec: logo.timing.startSec + offsetSec } };
}
