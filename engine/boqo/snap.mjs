// ported from boqo-ai/boqo apps/worker/src/select/snap.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: the import of packages/core/src/constants.ts. MAX_CLIP_OVERLAP_RATIO, at the pin
// (a clip overlapping a kept one by more than 25% of the shorter is dropped).
const MAX_CLIP_OVERLAP_RATIO = 0.25;

                        
                 
              
               
              
                     
              
              
                                                                                                 
                  

/**
 * How much of the shorter of a candidate and the seed's window may overlap
 * before a seeded re-analysis drops the candidate: the seed's own moment is
 * what the creator already has. Looser than `MAX_CLIP_OVERLAP_RATIO` (0.25)
 * on purpose, since a neighbour that shares a sentence with the seed is the
 * kind of moment the creator asked for.
 */
export const SEED_WINDOW_OVERLAP_RATIO = 0.5;

                           
                           
                                                               
                                
                     
  

                                                                           

                           
                   
                   
     
                                                                             
                                                                            
                                                                            
                                                                     
     
                     
                     
     
                                                                              
                                                                         
                                                                             
                                        
     
                                                           
  

/**
 * Moves `value` onto the nearest of `edges`. Ties go to the earlier edge, so
 * the result is deterministic rather than dependent on iteration order.
 */
function nearestEdge(value        , edges          )         {
  let best = edges[0] ;
  let bestDistance = Math.abs(value - best);

  for (const edge of edges) {
    const distance = Math.abs(value - edge);
    if (distance < bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }

  return best;
}

/** Overlap between two clips as a fraction of the shorter one. */
function overlapRatio(a                                      , b                                      )         {
  const overlap =
    Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (overlap <= 0) return 0;

  const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return shorter <= 0 ? 1 : overlap / shorter;
}

/**
 * Turns the model's approximate boundaries into ones boqo will actually
 * render (spec §5.3 steps 4-5).
 *
 * Snapping is against `transcripts.segments` rather than the R2 word
 * timings. Segments are already sentence-level, and they are the exact lines
 * the model was shown — so every kept boundary provably matches an anchor
 * the model saw, and nothing has to read a multi-megabyte JSON object out of
 * R2 to find out where a sentence ends.
 *
 * Every rejection is returned with a reason rather than silently discarded.
 * "Why did this video only produce two clips" is the first question anyone
 * asks about selection, and without the reasons it is unanswerable.
 */
export function snapAndFilter(
  candidates                 ,
  segments                     ,
  opts             ,
)             {
  if (segments.length === 0) {
    return {
      kept: [],
      dropped: candidates.map((candidate) => ({
        candidate,
        snapped: null,
        reason: "no_segments"         ,
      })),
    };
  }

  const starts = segments.map((s) => s.start);
  const ends = segments.map((s) => s.end);

  const dropped                = [];
  const survivors                                                             = [];

  for (const candidate of candidates) {
    const snapped                = {
      ...candidate,
      startSec: nearestEdge(candidate.startSec, starts),
      endSec: nearestEdge(candidate.endSec, ends),
    };

    const reason = rejectMechanically(snapped, opts);
    if (reason) {
      dropped.push({ candidate, snapped, reason });
      continue;
    }

    if (opts.seedWindow && overlapRatio(snapped, opts.seedWindow) > SEED_WINDOW_OVERLAP_RATIO) {
      dropped.push({ candidate, snapped, reason: "seed_window" });
      continue;
    }

    survivors.push({ original: candidate, snapped });
  }

  // Highest score first, so a collision is resolved in favour of the better
  // clip rather than whichever the model happened to list first.
  const ranked = [...survivors].sort(
    (a, b) =>
      b.snapped.score - a.snapped.score || a.snapped.startSec - b.snapped.startSec,
  );

  const kept                  = [];
  for (const { original, snapped: clip } of ranked) {
    // Collision is checked before the cap: a clip that is both beyond the cap
    // and genuinely overlapping should say so. `overlaps` names a real
    // property of the clip; `over_cap` only names its rank, and reporting the
    // rank hides the overlap in the one surface built for diagnosis.
    const collides = kept.some(
      (existing) => overlapRatio(existing, clip) > MAX_CLIP_OVERLAP_RATIO,
    );
    if (collides) {
      dropped.push({ candidate: original, snapped: clip, reason: "overlaps" });
      continue;
    }

    if (kept.length >= opts.maxClips) {
      dropped.push({ candidate: original, snapped: clip, reason: "over_cap" });
      continue;
    }

    kept.push(clip);
  }

  // Transcript order for display: this is how the dashboard lists clips and
  // how a human reads them back against the video.
  kept.sort((a, b) => a.startSec - b.startSec);

  return { kept, dropped };
}

function rejectMechanically(
  clip               ,
  opts             ,
)                    {
  if (clip.endSec <= clip.startSec) return "inverted";

  const durationSec = clip.endSec - clip.startSec;
  if (durationSec < opts.hardMinSec) return "too_short";
  if (durationSec > opts.hardMaxSec) return "too_long";

  if (clip.score < opts.minScore) return "below_threshold";

  return null;
}
