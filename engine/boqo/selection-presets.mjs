// ported from boqo-ai/boqo packages/core/src/selection-presets.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: the import of packages/core/src/constants.ts. Auto's four numbers, at the pin.
const CLIP_TARGET_MIN_SEC = 20;
const CLIP_TARGET_MAX_SEC = 75;
const CLIP_HARD_MIN_SEC = 15;
const CLIP_HARD_MAX_SEC = 90;

                      
          
             
          
            
          
                   
                  

                           
          
              
           
           
            
              

/**
 * One clip-length choice.
 *
 * The soft band is what the prompt asks the model to aim for; the hard band
 * is what `snapAndFilter` enforces afterwards. They are deliberately
 * different numbers: snapping moves a boundary onto the nearest sentence
 * edge, which can lengthen or shorten a clip by a whole sentence, so a soft
 * band equal to the hard band would discard clips the model got right.
 */
                                
                     
                
                     
                     
                     
                     
  

/**
 * The four numbers a `ClipLengthPreset` carries, without its `key` and
 * `label`. A part is not a user-selectable preset — its length is a property
 * of the format, fixed by the genre — so it has neither.
 *
 * Derived from `ClipLengthPreset` rather than declared independently: the two
 * are consumed by the same soft/hard reasoning in `snapAndFilter` and
 * `repairPartLengths`, and a second hand-written copy of four field names is
 * a place they can drift apart.
 */
                              
                   
                                                           
  

/**
 * One genre choice.
 *
 * `guidance` is appended to the selection prompt's **user** message, never to
 * `SELECTION_RUBRIC` — the rubric is the prompt-cache prefix and a single
 * interpolated value would invalidate it on every call.
 *
 * Null for `auto`, which must emit nothing at all rather than an empty
 * string: an empty paragraph still adds a blank line, and then an auto
 * project's prompt is no longer byte-identical to the pre-change one.
 */
                           
                
                
                          
     
                                                                        
                                                                         
                                                                         
                                                               
                                                                
     
                                
     
                                                                              
                                                                            
                                                                          
                                                                              
                                              
     
                         
                                                        
                                
  

/**
 * Auto is the four existing constants, not a copy of their values. A literal
 * here would drift the moment anyone retuned `constants.ts`, and every
 * project that predates this feature carries NULL, which resolves to exactly
 * this row.
 */
const AUTO_CLIP_LENGTH                   = {
  key: "auto",
  label: "Auto",
  softMinSec: CLIP_TARGET_MIN_SEC,
  softMaxSec: CLIP_TARGET_MAX_SEC,
  hardMinSec: CLIP_HARD_MIN_SEC,
  hardMaxSec: CLIP_HARD_MAX_SEC,
};

/**
 * Order is display order in the dashboard's select. Auto first because it is
 * the default and the one most users should leave alone.
 *
 * The ceiling is 180 seconds because that is the common limit across YouTube
 * Shorts, Instagram Reels and TikTok — a clip longer than that has nowhere to
 * go. See the spec's §9.2: the top preset is gated on a pid-limit
 * measurement, because a three-minute clip of dense-cut content is roughly
 * eighty shots and every shot's ffmpeg branch carries its own threaded
 * filters.
 */
export const CLIP_LENGTH_PRESETS                              = [
  AUTO_CLIP_LENGTH,
  { key: "under_30", label: "Under 30s", softMinSec: 12, softMaxSec: 28, hardMinSec: 10, hardMaxSec: 35 },
  { key: "30_60", label: "30–60s", softMinSec: 32, softMaxSec: 58, hardMinSec: 25, hardMaxSec: 70 },
  { key: "60_90", label: "60–90s", softMinSec: 62, softMaxSec: 88, hardMinSec: 52, hardMaxSec: 100 },
  { key: "90_120", label: "90s – 2 min", softMinSec: 92, softMaxSec: 118, hardMinSec: 80, hardMaxSec: 135 },
  { key: "120_180", label: "2 – 3 min", softMinSec: 122, softMaxSec: 175, hardMinSec: 105, hardMaxSec: 180 },
];

const AUTO_GENRE              = {
  key: "auto",
  label: "Auto",
  guidance: null,
  selection: "clips",
  layout: "auto",
  partLength: null,
};

/**
 * Written in the rubric's own voice: plain, no emphasis markers, no
 * instruction to double-check. `claude-opus-5` reads both at face value —
 * emphasis causes over-triggering and self-verification instructions cause
 * over-verification with no quality gain.
 *
 * This is prompt content and is expected to be tuned with the dry-run script
 * (`pnpm --filter @boqo/worker dryrun <projectId>`), not frozen.
 */
// Cut: the series_film preset, with the scene path it selects (not in the skill).
export const GENRE_PRESETS                         = [
  AUTO_GENRE,
  {
    key: "podcast",
    label: "Podcast / interview",
    guidance:
      "This video is a podcast or interview. The moments worth clipping are usually a guest making a claim and then defending it, a disagreement between the speakers, a concrete story told start to finish, or a specific number or example that lands. Introductions, sponsor reads, scheduling talk and sign-offs are not clips, however well they are delivered.",
    selection: "clips",
    layout: "auto",
    partLength: null,
  },
  {
    key: "talk",
    label: "Talk / lecture",
    guidance:
      "This video is a talk, lecture or prepared presentation. A speaker here builds an argument over several minutes, so a clip must contain a whole step of that argument rather than a fragment of one — a complete point, a worked example, or a claim together with the reason that supports it. Slide references and housekeeping about the session are not clips.",
    selection: "clips",
    layout: "auto",
    partLength: null,
  },
  {
    key: "gaming",
    label: "Gaming",
    guidance:
      "This video is gameplay with commentary. The moments worth clipping are a genuine reaction, a play going unusually right or wrong, or a decision the speaker explains as they make it. Much of the audio is routine narration of what is on screen and is not worth clipping. A great deal of what makes a gaming moment good is visual and does not appear in this transcript, so judge only what the words themselves carry.",
    selection: "clips",
    layout: "auto",
    partLength: null,
  },
  {
    key: "vlog",
    label: "Vlog / IRL",
    guidance:
      "This video is a vlog — a day, a trip, or behind the scenes. The moments worth clipping are a story told to camera, a strong or surprising opinion, or a turn where the day changes. Logistics, travel narration and talk about what is coming later in the video are not clips.",
    selection: "clips",
    layout: "auto",
    partLength: null,
  },
  {
    key: "entertainment",
    label: "Entertainment / challenge",
    guidance:
      "This video is entertainment — a challenge, a stunt, a reaction or comedy. A clip needs a setup and its payoff inside the same clip: a rule explained and then broken, a bet and its outcome, a reaction with enough context to land. The stakes have to be legible from the words alone, because the viewer will not have seen the setup elsewhere in the video.",
    selection: "clips",
    layout: "auto",
    partLength: null,
  },
];

/**
 * Resolves a stored column value to a preset. Never throws.
 *
 * `onUnknown` is a callback rather than a direct `log()` because this module
 * lives in `@boqo/core` and must not depend on the worker's logger. The
 * worker passes one; the web app does not need to.
 *
 * Falling back rather than throwing is the same rule `effortFromEnv` follows
 * for an unrecognised `SELECT_EFFORT`, and it is what makes the two-deploy
 * window safe: `web` deploys first and can write a genre a not-yet-redeployed
 * worker has never heard of.
 */
export function resolveClipLength(
  value                           ,
  onUnknown                          ,
)                   {
  if (value === null || value === undefined) return AUTO_CLIP_LENGTH;
  const match = CLIP_LENGTH_PRESETS.find((preset) => preset.key === value);
  if (match) return match;
  onUnknown?.(value);
  return AUTO_CLIP_LENGTH;
}

/** See `resolveClipLength` — same contract, same reasoning. */
export function resolveGenre(
  value                           ,
  onUnknown                          ,
)              {
  if (value === null || value === undefined) return AUTO_GENRE;
  const match = GENRE_PRESETS.find((preset) => preset.key === value);
  if (match) return match;
  onUnknown?.(value);
  return AUTO_GENRE;
}
