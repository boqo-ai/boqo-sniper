// ported from boqo-ai/boqo packages/core/src/panels.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";

/** A region of the source frame as fractions of its width and height. */
export const PanelRect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
                                                  

export const PANEL_MODES = ["panels", "people", "game", "none"]         ;
                                                     

export const PanelSample = z.object({
  sourceSec: z.number(),
  mode: z.enum(PANEL_MODES),
  cameras: z.array(PanelRect).max(3),
  game: PanelRect.nullable(),
  focus: PanelRect.nullable(),
  why: z.string(),
});
                                                      

/**
 * What made the worker ask (spec §6.6): a clip's first render, the creator's
 * Game + camera pick on a re-render, or the operator's forced re-render.
 * Optional so a decision stored before it existed still parses; read absent
 * as "not the creator's".
 */
export const PANEL_TRIGGERS = ["first", "creator", "forced"]         ;
                                                           

/**
 * Why a stored decision is `failed`, when it is not the read's own failure:
 * `render-failed` is written by the render handler when a render that placed
 * shots from an `ok` decision failed on its final attempt and shipped without
 * the layout. Optional so a failure stored before it existed still parses;
 * read absent as the read's failure.
 */
export const PANEL_FAILURES = ["render-failed"]         ;
                                                           

export const PanelDecision = z.discriminatedUnion("status", [
  z.object({
    version: z.literal(1),
    status: z.literal("ok"),
    promptVersion: z.string(),
    model: z.string(),
    content: z.enum(["stream_with_game", "screen_no_game", "other"]),
    gameTitle: z.string().nullable(),
    samples: z.array(PanelSample),
    trigger: z.enum(PANEL_TRIGGERS).optional(),
  }),
  z.object({
    version: z.literal(1),
    status: z.literal("failed"),
    reason: z.string(),
    trigger: z.enum(PANEL_TRIGGERS).optional(),
    failure: z.enum(PANEL_FAILURES).optional(),
  }),
  // Written by the operator's forced re-render.
  z.object({ version: z.literal(1), status: z.literal("pending") }),
]);
                                                          

export const PanelProbe = z.object({ version: z.literal(1), isStream: z.boolean(), gameTitle: z.string().nullable() });
                                                    

// Cut: INTERNAL_ACCOUNT_EMAILS, `PanelsMode`, `panelsModeFromEnv`, `isInternalAccountEmail` and `panelsAllowedFor`
// (who gets the layout, by RENDER_PANELS_MODE and the owner's email). The skill has no accounts: the production
// worker runs RENDER_PANELS_MODE=all (its render variables on 2026-11-16, as engine/boqo/scenes.mjs records them),
// so every eligible clip is allowed.
export const PANELS_MODE = "all";
