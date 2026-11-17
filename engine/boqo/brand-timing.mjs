// ported from boqo-ai/boqo packages/core/src/brand-timing.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";

/**
 * When an overlaid element is on screen.
 *
 * Extracted from `BrandLogo.timing`, where it was declared inline until stage
 * 4, so the headline can carry the same shape rather than a second copy of
 * it. Two hand-written copies of a schema is a drift waiting to happen, and
 * the symptom here would be the sharpest kind: a `window` that one element
 * honours and the other silently reads as `whole`.
 *
 * The zod output is byte-identical to the inline union it replaces — same
 * discriminant, same field names, same bounds — so `logoDiffers`'s
 * `JSON.stringify(timing)` comparison and every stored `brand_settings` blob
 * are unaffected. A test pins that both existing shapes still parse.
 *
 * `whole` holds for the clip's whole length. `window` reuses the boqo
 * lockup's own three-seconds-in, four-second-hold shape and its fades, which
 * is why the two bounds are generous rather than tight: the element they
 * describe may be a mark in a corner or a headline across the top.
 */
export const BrandTiming = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("whole") }),
  z.object({
    kind: z.literal("window"),
    startSec: z.number().min(0).max(60),
    holdSec: z.number().min(0.5).max(60),
  }),
]);
                                                      
