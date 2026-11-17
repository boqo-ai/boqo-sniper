// ported from boqo-ai/boqo apps/worker/src/render/scenes.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                                        

                                                            

/**
 * The greyscale branch's size. Small enough to be cheap, large enough that the
 * persistence measure was calibrated on it — every number in spec §4 comes
 * from exactly 64x36, so changing this invalidates `RENDER_CUT_MIN_PERSIST`
 * and both of its measured bounds.
 *
 * "Cheap" is worth stating at the reference source's real frame rate rather
 * than an assumed 30fps: at 2304 bytes a frame, a 90-second clip of the 60fps
 * podcast is ~12 MB on disk, and ~50 MB once `parseGrayFrames` expands each
 * byte to a `Float32`. The in-memory figure is the one that matters, and it
 * is 4x the file.
 *
 * The aspect is forced rather than preserved. That distorts a 16:9 source,
 * which is harmless for a difference measure because both sides of every
 * comparison are distorted identically.
 */
export const GRAY_WIDTH = 64;
export const GRAY_HEIGHT = 36;

/**
 * Every frame's scene score AND a downscaled greyscale copy of every frame,
 * from ONE decode.
 *
 * The scene pass is the one CPU-bound stage in this pipeline, so the
 * persistence signal must not cost a second one — `split` feeds both branches
 * from the same decoded frames.
 *
 * The two outputs go to different places on purpose. `metadata=print:file=-`
 * writes to **stdout**, which `parseSceneScores` reads and which is a trap
 * this codebase has already paid for once: reading stderr instead returns
 * zero scores, which is indistinguishable from "this clip has no cuts". The
 * rawvideo branch therefore goes to a file rather than stdout, where it would
 * interleave with the metadata and corrupt both.
 *
 * It is written even when RENDER_SCENE_THRESHOLD is set and nothing will read
 * it. That costs a few MB in a scratch directory that is deleted at the end of
 * the render, and buys one code path instead of two.
 *
 * `-fps_mode passthrough` sits with the **rawvideo output's** options, and it
 * has to: given before `-i` it would apply to both outputs instead of one.
 * Without it the greyscale stream loses frames on production and the metadata
 * stream does not. The `null` muxer advertises `AVFMT_VARIABLE_FPS` and
 * `rawvideo` does not, so on ffmpeg <= 5.x the default `fps_mode`
 * (`VSYNC_AUTO`) resolves to **CFR for the rawvideo output alone** and drops
 * frames to hit the nominal rate, while the metadata branch passes through
 * VFR untouched. ffmpeg 6.x/7.x reworked that default, which is why this never
 * reproduced on this Mac's 9.0.1 and did on production's 5.1.9: two real clips
 * logged 752 greyscale frames against 750 scores, and 3002 against 3000.
 *
 * **The two counts must match**, which is what makes this a correctness fix
 * rather than a tidy-up. `cutsFromSignals` indexes `frames` positionally
 * against `scores`, and CFR drops are distributed through the stream rather
 * than clustered at either end, so persistence values misalign progressively
 * from the first drop onward — every one read against a frame that is not its
 * own. No truncation of either end could have corrected it.
 *
 * **This flag is necessary and NOT sufficient, measured 2026-08-25 inside the
 * built image — the production mismatch had two independent causes that were
 * partly cancelling.** With the flag, the rawvideo output and the
 * `lavfi.scene_score` LINES agree exactly: 779 = 779 on the vlog gate window
 * and 3084 = 3084 on the gaming one. But `parseSceneScores` returns 750 and
 * 3000 from those same files, because both windows open with
 * negative-timestamp lead-in frames (29 and 84) that its pattern cannot match
 * — see its own doc comment. So production's logged "752 vs 750" was CFR-752
 * against parsed-750, not against a true 750, and what remains after this fix
 * is a CONSTANT ~29-frame offset rather than a growing one. Removing the drift
 * is a strict improvement; the offset is a separate, pre-existing defect, and
 * `pipeline.ts`'s mismatch warning now fires loudly on it instead of nearly
 * silently, which is exactly what that line is for.
 */
export function sceneSignalArgs(input                                    )           {
  return [
    "-nostats",
    "-hide_banner",
    "-y",
    "-i",
    input.path,
    // Nothing here reads the audio, and the null muxer would otherwise still
    // decode the whole track to feed it.
    "-an",
    "-filter_complex",
    "[0:v]split[a][b];" +
      "[a]select='gte(scene,0)',metadata=print:file=-[m];" +
      `[b]scale=${GRAY_WIDTH}:${GRAY_HEIGHT},format=gray[g]`,
    "-map",
    "[m]",
    "-f",
    "null",
    "-",
    "-map",
    "[g]",
    // Output-scoped on purpose: see the doc comment. This is the difference
    // between 752 greyscale frames and 779 on ffmpeg 5.1.9.
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    input.grayPath,
  ];
}

/**
 * ffmpeg prints a frame line and then its metadata on the following line, so
 * a time is held until its score arrives.
 *
 * `pts_time:` is matched with its label rather than by position: the progress
 * line also has a `time=` field, and a looser pattern reads it as a frame at
 * the end of every clip.
 *
 * **A third cause of a dropped pair, systematic rather than accidental, and
 * measured 2026-08-25: a NEGATIVE `pts_time`.** The pattern requires a digit
 * straight after the colon, so `pts_time:-1.16` does not match at all, the
 * score line that follows finds no pending time, and the pair is discarded.
 * Both real gate windows open with such a lead-in — 29 frames on the vlog, 84
 * on the gaming clip — so this returns 750 of 779 and 3000 of 3084 on them.
 * That is NOT harmless: the greyscale stream keeps those frames, so
 * `cutsFromSignals` pairs `scores[i]` with a frame ~29 earlier than its own.
 * It is left as-is rather than "fixed" by loosening the pattern, because
 * admitting negative times changes `fpsFromScores`, the ratio neighbourhood
 * and the cut times themselves — that needs measuring, not assuming. A frame line that is never followed by its score
 * line — because another frame line arrives first and overwrites the
 * pending time, or because the output ends first — is dropped rather than
 * given a fabricated value.
 *
 * That is not "frame 0 has no predecessor": this file's own fixture
 * (fixtures/scene-scores.txt, header) records that real ffmpeg output pairs
 * a score with every frame including frame 0, and it is 0.000000. So a
 * genuinely unpaired frame line means its score line was lost, truncated or
 * reordered, not that none was ever coming — worth discarding rather than
 * papering over with an invented score. Nor would a fabricated value "drag
 * the median": that rule is gone. `cutsFromSignals` (below) reads each
 * frame's own local ratio and persistence rather than comparing against a
 * median+MAD threshold or a global sorted break, so there is no median left
 * to drag.
 */
export function parseSceneScores(text        )               {
  const scores               = [];
  let pendingTime                = null;

  for (const line of text.split("\n")) {
    const frame = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (frame !== null) {
      pendingTime = Number(frame[1]);
      continue;
    }
    const score = /lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (score !== null && pendingTime !== null) {
      const value = Number(score[1]);
      if (Number.isFinite(value)) scores.push({ timeSec: pendingTime, score: value });
      pendingTime = null;
    }
  }

  return scores;
}

/**
 * The denominator's floor. A perfectly static passage scores ~0 on every
 * frame, and without this a single 0.5 against a neighbourhood of 0.0000
 * would be Infinity — an invented cut out of rounding, which is the same
 * hazard RENDER_SCENE_MIN_SCORE guarded in the rule this replaces.
 */
const RATIO_DENOMINATOR_FLOOR = 0.005;

/**
 * How much each frame's score stands out from its own temporal neighbourhood.
 *
 * This is the statistic the break rule could not see. Sorting the scores
 * throws away time, and time is the only thing that separates a cut from
 * motion: **a cut is a step, motion is a plateau.** Measured, a real cut
 * reads 20-70 here while a whip-pan or a handheld swing reads 1.1-1.3,
 * because sustained motion by definition has neighbours as large as itself.
 *
 * The frame itself is excluded from its own neighbourhood. Included, a lone
 * spike dilutes its own denominator and drags its ratio toward 1 — the
 * larger the spike, the more it hides itself.
 */
export function frameRatios(scores          , window        )           {
  return scores.map((score, i) => {
    let sum = 0;
    let n = 0;
    for (let k = i - window; k <= i + window; k += 1) {
      if (k === i || k < 0 || k >= scores.length) continue;
      sum += scores[k] ;
      n += 1;
    }
    const mean = n > 0 ? sum / n : 0;
    return score / Math.max(mean, RATIO_DENOMINATOR_FLOOR);
  });
}

/** One downscaled greyscale frame, values 0..1, row-major. */
                                     

/**
 * The rawvideo second output of the scene pass, split into frames.
 *
 * A trailing partial frame is discarded rather than padded. ffmpeg writing a
 * short final picture would otherwise produce a frame of the wrong length,
 * and every persistence value computed against it would be quietly wrong
 * rather than absent — the failure class this codebase keeps finding by
 * watching output rather than by reading counts.
 */
export function parseGrayFrames(
  buffer            ,
  width        ,
  height        ,
)              {
  const size = width * height;
  if (size <= 0) return [];
  const count = Math.floor(buffer.length / size);
  const frames              = [];
  for (let i = 0; i < count; i += 1) {
    const frame = new Float32Array(size);
    const base = i * size;
    for (let p = 0; p < size; p += 1) frame[p] = buffer[base + p]  / 255;
    frames.push(frame);
  }
  return frames;
}

/**
 * Did the change stick? Compares the picture `lead` frames BEFORE each frame
 * against `lead` frames AFTER it, skipping the frame itself.
 *
 * A cut changes the picture for good, so both sides differ. An in-game spell
 * flash covers half the screen for one frame and reverts, so both sides are
 * the same shot and this reads near zero. Measured: five verified Dota
 * effects read 0.048-0.093 while every verified cut reads 0.096 or above.
 *
 * Frames whose lead or lag runs off either end report 0, which can only
 * SUPPRESS a cut (see `isCut` — persistence is never sufficient on its own),
 * so the clip's first and last few frames degrade toward the strong-ratio arm
 * rather than toward a false positive.
 */
export function framePersistence(frames             , lead        )           {
  return frames.map((_, i) => {
    const before = frames[i - lead];
    const after = frames[i + lead];
    if (before === undefined || after === undefined) return 0;
    let sum = 0;
    for (let p = 0; p < before.length; p += 1) sum += Math.abs(before[p]  - after[p] );
    return before.length > 0 ? sum / before.length : 0;
  });
}

/**
 * The clip's frame rate, derived from the score timestamps rather than
 * probed. Every frame is scored, so consecutive timestamps differ by exactly
 * one frame interval; the MEDIAN gap is used so a frame `parseSceneScores`
 * legitimately dropped (an unpaired frame line — see its doc comment) cannot
 * skew the answer the way a mean would.
 *
 * Only `framePersistence`'s lead/lag needs this, and 25 is a safe fallback:
 * it is the slowest rate any source here runs at, so an underestimate makes
 * the comparison span LESS time, which is the conservative direction.
 */
export function fpsFromScores(scores              )         {
  if (scores.length < 2) return 25;
  const gaps           = [];
  for (let i = 1; i < scores.length; i += 1) {
    const gap = scores[i] .timeSec - scores[i - 1] .timeSec;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 25;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ;
  return median > 0 ? 1 / median : 25;
}

                          
                                                                           
                
                                                                        
                   
                                                
                      
                                                          
                     
                                                           
                 
  

/**
 * Spec §3.3. A spike is NECESSARY; persistence only disambiguates.
 *
 * **`persist` can never fire on its own, and that is the load-bearing part
 * of the shape.** An earlier draft made this an OR and it is unusable:
 * sustained camera motion changes the picture permanently, so it persists
 * exactly like a cut. Measured, the persist arm alone added 27 spurious
 * frames across the podcast's 1-second whip-pan and 303 across the vlog's
 * handheld take. Requiring `minRatio` first rejects every one of them,
 * because motion by definition has neighbours as large as itself.
 *
 * Measured against 44 points classified by looking at the frames: Podcast
 * 7/7, Vlog 4/4, Gaming's 7 real cuts accepted and all 5 of its in-game
 * spell effects rejected, Chaos 21/21.
 *
 * Margins are thin and stated rather than buried (spec §4.1): the strongest
 * verified effect reads ratio 17 against `strongRatio` 20, and persists at
 * 0.0930 against `minPersist` 0.12. The effects dataset is five points from
 * one video — narrower evidence than the break rule had on the day it broke.
 * More gameplay-with-effects footage is the highest-value addition here.
 */
export function isCut(
  input                                                   ,
  opts            ,
)          {
  if (input.score < opts.floor) return false;
  if (input.ratio < opts.minRatio) return false;
  return input.ratio >= opts.strongRatio || input.persist >= opts.minPersist;
}

/** How far either side `persist` looks. Seconds, converted to frames. */
const PERSIST_LEAD_SEC = 0.12;

/**
 * The cut times in one clip, from the two per-frame signals.
 *
 * `frames` is indexed positionally against `scores`. The two come from the
 * same ffmpeg pass and normally match, but `parseSceneScores` legitimately
 * drops an unpaired frame line, so a mismatch is possible; a frame with no
 * counterpart persists at 0, which can only suppress a cut. Passing no frames
 * at all is therefore a valid degraded mode — the strong arm alone — rather
 * than an error, and `pipeline.ts` uses exactly that if the rawvideo output
 * is unreadable.
 */
export function cutsFromSignals(
  scores              ,
  frames             ,
  opts            ,
)                                                   {
  if (scores.length === 0) return { cuts: [], strong: 0, weak: 0 };

  const ratios = frameRatios(scores.map((s) => s.score), opts.window);
  const lead = Math.max(2, Math.round(PERSIST_LEAD_SEC * fpsFromScores(scores)));
  const persists = framePersistence(frames, lead);

  const cuts           = [];
  let strong = 0;
  let weak = 0;
  for (let i = 0; i < scores.length; i += 1) {
    const ratio = ratios[i] ;
    const persist = persists[i] ?? 0;
    if (!isCut({ score: scores[i] .score, ratio, persist }, opts)) continue;
    cuts.push(scores[i] .timeSec);
    if (ratio >= opts.strongRatio) strong += 1;
    else weak += 1;
  }
  cuts.sort((a, b) => a - b);
  return { cuts, strong, weak };
}

/**
 * Turns cut points into the contiguous shots the composer needs.
 *
 * Contiguity is a requirement, not an aesthetic: `compose.ts` concatenates
 * these, so a gap would drop frames and an overlap would duplicate them.
 * Every degenerate input therefore collapses to "one shot covering
 * everything" rather than to an empty list — a clip with no detectable cuts
 * is the common case, not an error.
 *
 * `minShotSec` is a required parameter rather than the constant it used to
 * be, and required rather than defaulted so that every call site is explicit.
 * It bounds the damage of a threshold too low for its content: measured, at
 * 0.10 with a 1.5s floor the podcast keeps all 7 of its real cuts while
 * gameplay drops from 78 to 24. That is the failure that reaches a viewer as
 * a jittering crop.
 */
export function shotsFrom(
  cutTimes          ,
  durationSec        ,
  minShotSec        ,
)         {
  const boundaries = [...new Set(cutTimes)]
    .filter((time) => time > 0 && time < durationSec)
    .sort((a, b) => a - b);

  const shots         = [];
  let start = 0;
  for (const cut of boundaries) {
    if (cut - start < minShotSec) continue;
    shots.push({ startSec: start, endSec: cut });
    start = cut;
  }

  // Always closes the final shot at the real duration, so the shots always
  // sum to the clip.
  if (durationSec - start >= minShotSec || shots.length === 0) {
    shots.push({ startSec: start, endSec: durationSec });
  } else {
    shots[shots.length - 1] .endSec = durationSec;
  }

  return shots;
}

// ---- Cut: the thresholds, from apps/worker/src/render/config.ts ------------------------------------------
//
// Cut: `sceneThresholdOverrideFromEnv`, `cutFloorFromEnv`, `cutMinRatioFromEnv`, `cutStrongRatioFromEnv`,
// `cutMinPersistFromEnv`, `cutWindowFromEnv` and `minShotSecFromEnv` (render/config.ts), and with them
// `fractionFromEnv` and `positiveNumberFromEnv`, which read RENDER_SCENE_THRESHOLD, RENDER_CUT_FLOOR,
// RENDER_CUT_MIN_RATIO, RENDER_CUT_STRONG_RATIO, RENDER_CUT_MIN_PERSIST, RENDER_CUT_WINDOW and
// RENDER_MIN_SHOT_SEC. The production worker sets none of them (its render variables on 2026-11-16 were
// RENDER_CONTEXT_LINE_ENABLED=0, RENDER_PANELS_MODE=all and RENDER_SHOT_TRANSITIONS_ENABLED=1), so each is its
// code default, a constant here. Their doc comments follow, as boqo wrote them.

/**
 * An explicit fixed threshold, or null to derive one per clip.
 *
 * Returning null when unset is what selects adaptive mode, and the ordering
 * mattered at deploy time: production had RENDER_SCENE_THRESHOLD=0.10 set on
 * the worker, so adaptive detection shipped **inert** until that variable was
 * removed. That is the same shape of failure as fragmentRetries reading the
 * wrong stream and entrypoint.sh never executing — a fix that is merged,
 * built and deployed and still not running. The mode is therefore logged on
 * every render (see pipeline.ts), so the log answers which one fired rather
 * than the deploy succeeding answering it.
 *
 * The variable was removed and adaptive detection is live. Checked
 * 2026-08-23, 2026-08-24 and again 2026-08-25, in
 * `railway variables --service worker` and inside the running process:
 * **no RENDER_* variable of any kind is set on the worker.** Every render
 * tunable, tracking included, runs at its code default.
 *
 * This comment has now been wrong about that twice, in opposite directions,
 * which is worth leaving on the record given it is a comment whose entire
 * subject is that exact kind of drift. It first said "today" in the present
 * tense for a day after that stopped being true; it was then corrected to
 * "RENDER_TRACK_ENABLED is the only RENDER_* variable set on the worker",
 * which was true only between the stage 3 merge and gate 5 passing, and
 * stale again within a day. **Do not trust this sentence; run the command.**
 * Confirm the mode on any render by reading sceneMode from the log, not by
 * reading this.
 *
 * The old default of 0.36 is gone rather than retained as a fallback: it was
 * measured on one 40-second window of one video, and production has since
 * shown it finding 0 of 7 real cuts on a real podcast clip.
 *
 * The skill is always in adaptive mode: null. boqo's fixed mode (every frame
 * whose score is over the override is a cut) is not copied.
 */
export const SCENE_THRESHOLD_OVERRIDE = null;

/**
 * The raw scene score below which a frame is not a cut candidate at all,
 * whatever it scores on the other two axes.
 *
 * Inherited unchanged from the rule this replaces, where it was
 * RENDER_SCENE_MIN_SCORE and was settled by sweep against ten real clips:
 * 0.01, 0.02 and 0.03 all give nine of ten cut counts exactly right, 0.04
 * drops to eight.
 */
export const CUT_FLOOR = 0.02;

/**
 * The spike a cut must ALWAYS clear, as a multiple of its own ±window
 * neighbourhood. Necessary, never sufficient.
 *
 * 10 because the weakest real cuts measured anywhere — two in the Chaos
 * source, both verified by eye — read exactly 10. Sustained camera motion
 * reads 1.1-1.3, so this gate is what stops persistence firing on a whip-pan.
 */
export const CUT_MIN_RATIO = 10;

/**
 * A spike this large is a cut on its own, no persistence required.
 *
 * 20 against a strongest-verified-effect reading of 17 — a margin of 1.18x,
 * which is thin, and is the same shape of narrow band that broke
 * RENDER_SCENE_MIN_BREAK_RATIO on 2026-08-24. A ratio moves when EITHER side
 * moves: if a future source misses, re-measure both sides rather than nudging
 * this.
 */
export const CUT_STRONG_RATIO = 20;

/**
 * In the band between minRatio and strongRatio, how much the picture must
 * have changed for good.
 *
 * Bounded on both sides: the strongest verified in-game spell effect persists
 * at 0.0930, the weakest real cut needing this arm at 0.1440. 0.12 sits 1.29x
 * above the floor and 1.20x below the ceiling, near the geometric middle of a
 * 1.55x window.
 */
export const CUT_MIN_PERSIST = 0.12;

/**
 * Frames either side that a score is compared against. Whole frames.
 */
export const CUT_WINDOW = 3;

/**
 * The shortest shot `shotsFrom` will emit; anything closer to the shot start
 * is merged into its predecessor.
 *
 * **0.5, not the 1.5 this carried until 2026-08-25.** Measured inter-cut gaps
 * across all four content classes, counting from t=0 and excluding the tail:
 *
 * | class | gaps | <1.5s | <1.0s | <0.5s | min |
 * |---|---|---|---|---|---|
 * | Podcast | 7 | 1 | 0 | 0 | 1.12 |
 * | Vlog | 4 | 0 | 0 | 0 | 3.24 |
 * | Gaming | 7 | 2 | 0 | 0 | 1.34 |
 * | Chaos | 21 | 9 | 5 | 1 | 0.27 |
 *
 * At 1.5, nearly half of the Chaos source's correctly-detected cuts are
 * thrown away, and every discarded cut leaves a shot spanning two camera
 * angles — the SAME FAILURE MODE as the defect recorded as "the desk bug" in
 * the subject-tracking spec §4.3c. At 0.5 only its single 0.27s gap is lost.
 * It also honours the podcast's own t=1.12 cut.
 *
 * **An earlier revision of this comment called that t=1.12 cut "the exact cut
 * whose suppression caused the desk bug". That was wrong.** The desk bug is
 * clip 1197a55c at t=0.200, and 0.200 is below 0.5, so this change does not
 * honour it and does not fix its cause — `summarise_faces`'s roster fix still
 * carries that alone. What generalises is the mechanism, not the instance: a
 * cut suppressed by the floor leaves one shot spanning two camera angles, and
 * that is what this floor change reduces the frequency of. Recorded rather
 * than quietly edited, because this branch's whole subject is claims that do
 * not survive being checked.
 *
 * §4.3c declined this before, on the grounds that honouring sub-floor cuts
 * "reintroduces sub-1.5s shots on gameplay", and asked for a re-measurement
 * on the Dota source rather than an assumption. That is the Gaming row above,
 * and it does not say what was assumed: dropping to 0.5 DOES add two shots
 * there, at 1.34s and 1.48s. Both are real cuts — the 1.34s one is a
 * verified cut from one player at a desk to a different player in a different
 * room. §4.3c's concern was *spurious* shots produced by over-detection, and
 * the floor was compensating for a detector rather than for content.
 *
 * Not removed entirely: it still bounds the blast radius if the detector is
 * ever wrong on content none of the four classes represents.
 */
export const MIN_SHOT_SEC = 0.5;

/** The options pipeline.ts hands `cutsFromSignals`: the five thresholds above. */
export const CUT_OPTIONS = Object.freeze({
  floor: CUT_FLOOR,
  minRatio: CUT_MIN_RATIO,
  strongRatio: CUT_STRONG_RATIO,
  minPersist: CUT_MIN_PERSIST,
  window: CUT_WINDOW,
});
