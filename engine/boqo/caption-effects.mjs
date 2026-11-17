// ported from boqo-ai/boqo apps/worker/src/render/caption-effects.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// `@boqo/core` is packages/core/src, whose copies are this directory's.
import { ANIM_MS, LINE_SLIDE_CAP_HEIGHTS, animMs, withinEvent as within } from "./caption-timing.mjs";
import { cssToAss, opacityToAssAlpha } from "./caption-presets.mjs";

/**
 * ASS override tags for the 2026-10-05 style fields. Pure strings, sized from
 * the frame's own cap height so every effect scales with frame height like
 * every other caption absolute (review focus 4).
 */

/** The glow copy: fill invisible, a wide blurred border in the glow colour. */
export function glowTags(glow                                      , capHeightPx        , boost = 0)         {
  const bord = Math.max(2, Math.round(capHeightPx * 0.14));
  const blur = Math.max(1, Math.round(capHeightPx * 0.32));
  const alpha = opacityToAssAlpha(Math.min(1, 0.3 + 0.6 * glow.strength + boost));
  return `\\1a&HFF&\\bord${bord}\\blur${blur}\\3c&H${cssToAss(glow.colour)}&\\3a&H${alpha}&\\shad0`;
}

/** The soft shadow's own opacity: `\4a&H60&`. */
export const SOFT_SHADOW_OPACITY = 1 - 0x60 / 255;

/** hard: one solid offset copy (\shad + \4c); soft: a short translucent drop. */
export function shadowTags(shadow                                                     , capHeightPx        )         {
  if (shadow.kind === "hard") return `\\shad${Math.max(1, Math.round(capHeightPx * 0.1))}\\4c&H${cssToAss(shadow.colour)}&\\4a&H00&`;
  return `\\shad${Math.max(1, Math.round(capHeightPx * 0.05))}\\4c&H000000&\\4a&H${opacityToAssAlpha(SOFT_SHADOW_OPACITY)}&`;
}

/**
 * A word's opacity, as override tags. `\alpha` sets `\4a` too, so a soft shadow's
 * own alpha is re-stated after it, scaled by the word's opacity (the mockup's
 * `opacity` scales its text-shadow the same way). Without it the spoken word's
 * `\alpha&H00&` drew `minimal`'s soft shadow solid black (seen in the loop
 * render, 2026-10-05). A hard shadow is opaque, so `\alpha` alone is already right.
 */
export function opacityTags(opacity        , shadow                                                                 )         {
  const alpha = `\\alpha&H${opacityToAssAlpha(opacity)}&`;
  return shadow?.kind === "soft" ? `${alpha}\\4a&H${opacityToAssAlpha(opacity * SOFT_SHADOW_OPACITY)}&` : alpha;
}

// `animMs` (review focus 5: at least 1 ms) and `within` (review focus 2: never past the
// event) are core's, shared with the browser preview: caption-timing.ts.

/** The pop ramp: from 100% to pct over 80 ms / speed, inside the word's own event. */
export function popTags(pct        , speed                    , stepMs        )         {
  return `\\fscx100\\fscy100\\t(0,${within(animMs(ANIM_MS.emphasisPop, speed), stepMs)},\\fscx${pct}\\fscy${pct})`;
}

/**
 * The highlighter under a spoken word: a filled rect drawn with \p1 at the
 * word's box, its \clip growing left to right over 220 ms / speed.
 */
export function markerEvent(a   
                
              
               
              
                
                 
                 
                 
                 
 )         {
  const r = `${a.left},${a.top},${a.left},${a.top + a.height}`;
  const full = `${a.left},${a.top},${a.left + a.width},${a.top + a.height}`;
  return (
    `Dialogue: 0,${a.start},${a.end},boqo,,0,0,0,,` +
    `{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H${cssToAss(a.colour)}&\\1a&H00&` +
    `\\clip(${r})\\t(0,${within(animMs(ANIM_MS.marker, a.speed), a.stepMs)},\\clip(${full}))\\p1}` +
    `m ${a.left} ${a.top} l ${a.left + a.width} ${a.top} l ${a.left + a.width} ${a.top + a.height} l ${a.left} ${a.top + a.height}{\\p0}`
  );
}

/**
 * A caption's first step: fade in, or fade while moving up 0.55 cap heights
 * into place. The fade and the move share one window, clamped to the step.
 */
export function lineEntrance(kind                  , x        , y        , capHeightPx        , stepMs        , speed         )                               {
  const ms = within(animMs(ANIM_MS.lineEntrance, speed), stepMs);
  const fad = `\\fad(${ms},0)`;
  if (kind === "fade") return { pos: `\\pos(${x},${y})`, fad };
  const dy = Math.max(1, Math.round(capHeightPx * LINE_SLIDE_CAP_HEIGHTS));
  return { pos: `\\move(${x},${y + dy},${x},${y},0,${ms})`, fad };
}

/** The spoken word's own entrance; `type` has none (its reveal is the alpha on the words not yet said). */
export function wordEntrance(kind                           , stepMs        , speed         )         {
  if (kind === "type") return "";
  if (kind === "pop") return `\\fscx60\\fscy60\\t(0,${within(animMs(ANIM_MS.wordPop, speed), stepMs)},\\fscx100\\fscy100)`;
  const up = within(animMs(ANIM_MS.bounceUp, speed), stepMs);
  const down = within(animMs(ANIM_MS.bounceDown, speed), stepMs);
  return `\\fscx0\\fscy0\\t(0,${up},\\fscx115\\fscy115)\\t(${up},${Math.max(up, down)},\\fscx100\\fscy100)`;
}
