// ported from boqo-ai/boqo packages/core/src/rank.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";
import { parseReplay } from "./replay.mjs";
import { parseStandaloneTest } from "./standalone.mjs";
// Cut: the import of packages/core/src/stranger.ts (A6 ported it whole as ./stranger.mjs; this stays a subset because the
// skill's row has no promptVersion, model, effort, cost or the rest, and the order's goldens and tests build rows without them). The order reads only the
// `judgment`, and the stand-alone chip's reason reads `why` and `frames` (engine/boqo/handbook-outcomes.mjs),
// so `parseStranger` here is a stated SUBSET of hosted's StrangerSchema: it checks those three fields as
// hosted does (judgment an integer 1..5, why a string, frames a number) and not the other ten (v, promptVersion,
// model, selectionModel, effort, fileVersion, annotation, costUsd, sha, judgedAt). The skill stores a judgment
// as {overall, why, annotation} (A6) and hands the order {judgment: overall, why, frames}, so the other
// ten do not exist on its side. Total, like every jsonb reader here.
const StrangerRead = z.object({ judgment: z.number().int().min(1).max(5), why: z.string(), frames: z.number() });
export function parseStranger(raw         ) {
  const parsed = StrangerRead.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What the handbook order reads off a clip row. The three jsonb columns are read through their total parsers. */
                         
                
                   
                  
                    
                          
  

                         
                 
                 
                     
                          
  

/**
 * The terms of the handbook order (spec §6.1). A null or unparseable column
 * contributes 0 and is never a failure. The judgment (1-5) is mapped onto 0..1
 * so that judgment 5 weighs the same as the top of the replay curve.
 */
export function rankTerms(c           )            {
  const pct = parseReplay(c.replay)?.pct ?? null;
  const judgment = parseStranger(c.stranger)?.judgment ?? null;
  const fails = parseStandaloneTest(c.standaloneTest)?.outcome === "fails";
  const signal = (pct ?? 0) + (judgment === null ? 0 : (judgment - 1) / 4);
  return { fails, signal, pct, judgment };
}

/**
 * Clips in handbook order (spec §6.1): clips that fail the stand-alone test
 * last; then signal descending; then score descending; then start ascending.
 * There is no threshold here. Returns a new array. Intent: ties keep input
 * order, which relies on `Array.prototype.sort` being stable (guaranteed by the
 * language since ES2019, so on the Node 20+ the services run).
 */
export function rankClips                     (clips              )      {
  const keyed = clips.map((clip) => ({ clip, terms: rankTerms(clip) }));
  keyed.sort((a, b) => {
    if (a.terms.fails !== b.terms.fails) return a.terms.fails ? 1 : -1;
    if (a.terms.signal !== b.terms.signal) return b.terms.signal - a.terms.signal;
    if (a.clip.score !== b.clip.score) return b.clip.score - a.clip.score;
    return a.clip.startSec - b.clip.startSec;
  });
  return keyed.map((k) => k.clip);
}
