// ported from boqo-ai/boqo apps/worker/src/render/settle-end.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
                                                 
                                      
// Cut: boqo's `isStoppedError` (apps/worker/src/stops.ts) reads a worker job's Stop. A skill has no job
// to stop, so only the by-name check stays, kept so a caller's own Stop error still propagates.
const isStoppedError = (error) => error instanceof Error && error.name === "StoppedError";

/**
 * #228: a clip's end moved off the next sentence's first sound.
 *
 * Selection snaps a clip's end to a `transcripts.segments` end, and Deepgram
 * pads a word's `end` up to the next word's `start`, so where two sentences
 * run together the clip ends on the instant the next sentence begins.
 * Deepgram's `start` also runs late: measured 2026-10-25 on project
 * `03ebaae4` against its source audio, the next word's onset began 20, 40
 * and 120 ms before the edge on three clips, so each file closed on a cut-off
 * "S-" or "I-". 231 of that transcript's 259 sentence boundaries abut, and
 * about half of every transcript's over the 40 days before.
 *
 * The render therefore reads half a second of the source before such an end
 * and moves the end back to the quiet point in front of that onset. Only the
 * end: the start was not measured.
 */

/** Analysis frame, seconds (320 samples at 16 kHz). */
export const SETTLE_FRAME_SEC = 0.02;
/** How far before the edge the analysis looks. */
export const SETTLE_LOOK_SEC = 0.5;
/** Decoded before the look window and discarded, so a seek's first frames never count. */
const SETTLE_PREROLL_SEC = 0.1;
/** A word starting this close to the edge is the next sentence beginning on it. */
const EDGE_TOLERANCE_SEC = 0.05;
/** A loud stretch at the end longer than this is not a fragment of the next word (worst measured: 120 ms). */
const MAX_FRAGMENT_SEC = 0.2;
/** The fragment is the frames within this of the end's loudest, so the frame before it is at least this much quieter. */
const LOUD_BAND_DB = 6;
/** Never closer than this to the clip's own last word's start. */
const MIN_LAST_WORD_SEC = 0.1;
/**
 * The walk back from the fragment follows the onset's rising edge only: it
 * steps to an earlier frame while that frame is at least this much quieter.
 * A gentler slope is the clip's own last word fading -- clip bfe48fa3's
 * "become" fell from -17 to -21 dB over 130 ms straight into "So" (source
 * audio, 2026-10-25), and a walk down it would have cut the "m".
 */
const STEEP_DB = 3;

                                                                                                                                          

                             
                                                
                           
                                                           
                                           

/**
 * The abutting edge this rule exists for: the next word starts on `endSec`
 * and the word before it runs right up to it. A real pause after the last
 * word (Deepgram's `end` then falls in silence) returns null, as does an end
 * with no word after it. `words` are the project's, in source seconds.
 */
export function abuttingEdge(
  words                           ,
  endSec        ,
)                                      {
  const nextIndex = words.findIndex((word) => word.start >= endSec - EDGE_TOLERANCE_SEC);
  if (nextIndex <= 0) return null;
  const next = words[nextIndex] ;
  const last = words[nextIndex - 1] ;
  if (next.start > endSec + EDGE_TOLERANCE_SEC) return null;
  if (last.end < endSec - EDGE_TOLERANCE_SEC) return null;
  return { lastWordStartSec: last.start };
}

/**
 * Per-frame RMS of the half second before the edge, as one astats line per
 * frame on stderr. `-vn` so only the audio is decoded; mono 16 kHz in
 * 320-sample frames, so frame k covers `[from + k·0.02, from + (k+1)·0.02)`
 * and the last full frame ends on the edge.
 */
export function settleArgs(sourceUrl        , endSec        )           {
  const fromSec = Math.max(0, endSec - SETTLE_LOOK_SEC - SETTLE_PREROLL_SEC);
  return [
    "-hide_banner", "-nostats", "-threads", "1",
    "-ss", fromSec.toFixed(3), "-t", (endSec - fromSec).toFixed(3),
    "-i", sourceUrl, "-vn",
    "-af", "aresample=16000,asetnsamples=n=320:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-",
  ];
}

/**
 * The frames' `[startSec, dB]` in source seconds, from ametadata's print
 * lines: a `pts_time:` line, then its `RMS_level=` line. Read from the worker
 * image's ffmpeg 5.1.9 (fixture `settle-end-5.1.9.stderr.txt`, 2026-10-25).
 * Digital silence prints `-inf`, kept as -Infinity. Null when no frame parses.
 */
export function parseFrames(stderr        , fromSec        )                                 {
  const frames                          = [];
  let pts                = null;
  for (const line of stderr.split("\n")) {
    const time = /pts_time:(\S+)/.exec(line);
    if (time !== null) {
      pts = Number(time[1]);
      continue;
    }
    const level = /lavfi\.astats\.Overall\.RMS_level=(\S+)/.exec(line);
    if (level !== null && pts !== null && Number.isFinite(pts)) {
      const db = level[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(level[1]);
      if (!Number.isNaN(db)) frames.push([fromSec + pts, db]);
      pts = null;
    }
  }
  return frames.length > 0 ? frames : null;
}

/**
 * Where the end goes, from the frames of the look window (pure).
 *
 * Only an end that is still sounding counts: the loudest of the last three
 * frames must reach the window's median, and the edge frame must be within
 * LOUD_BAND_DB of it, or the end is already quiet and nothing of the next
 * word is in it. The fragment is then the run of frames
 * at the very end within LOUD_BAND_DB of that peak. Walking back from it down
 * the onset's rising edge (STEEP_DB a frame) finds where the next word starts
 * to sound; the end moves to the middle of the frame before it. Kept as it is
 * when the window is too short to read, when the run is too long to be a
 * fragment, or when the new end would reach into the clip's own last word.
 */
export function settlePoint(
  frames                                          ,
  input                                              ,
)                                                                                                    {
  const half = SETTLE_FRAME_SEC / 2;
  const look = frames.filter(([start]) => start >= input.endSec - SETTLE_LOOK_SEC - half && start + SETTLE_FRAME_SEC <= input.endSec + half);
  if (look.length < 4) return { reason: "no-dip" };
  // A read that stopped early (a dropped connection ffmpeg takes for the end
  // of the file) would make the clip's own last word look like the end.
  if (Math.abs(look.at(-1) [0] + SETTLE_FRAME_SEC - input.endSec) > half) return { reason: "short-read" };
  const db = look.map(([, level]) => level);
  const last = db.length - 1;
  const peak = Math.max(db[last] , db[last - 1] , db[last - 2] );
  const sorted = [...db].sort((a, b) => a - b);
  if (peak < sorted[Math.floor(sorted.length / 2)] ) return { reason: "quiet-end" };
  // The edge frame itself must sound: a next word's fragment is loud where it
  // is cut, while a last syllable louder than a soft onset ("to-DAY | so")
  // would otherwise pass as the fragment and be cut (final review, #228).
  if (db[last]  < peak - LOUD_BAND_DB) return { reason: "quiet-end" };
  let onset = last;
  while (onset > 0 && db[onset - 1]  >= peak - LOUD_BAND_DB) onset -= 1;
  if ((last - onset + 1) * SETTLE_FRAME_SEC > MAX_FRAGMENT_SEC + 1e-6) return { reason: "too-long" };
  if (onset === 0) return { reason: "no-dip" };
  // The frame before the fragment is already LOUD_BAND_DB under its peak, by
  // the loop above; the walk only follows the rest of the rising edge down.
  let dip = onset - 1;
  while (dip > 0 && db[dip - 1]  <= db[dip]  - STEEP_DB) dip -= 1;
  const endSec = look[dip] [0] + SETTLE_FRAME_SEC / 2;
  if (endSec < input.lastWordStartSec + MIN_LAST_WORD_SEC) return { reason: "too-early" };
  return { endSec };
}

/**
 * The render's end for one window. Intent: never fails a render -- an ffmpeg
 * failure or unreadable output keeps the end and says why. A Stop propagates.
 */
export async function settleEnd(
  deps                  ,
  input                                                                                                                                ,
)                           {
  const edge = abuttingEdge(input.words, input.endSec);
  if (edge === null) return { status: "untouched" };
  if (!input.enabled) return { status: "kept", reason: "disabled" };

  const args = settleArgs(input.sourceUrl, input.endSec);
  let stderr        ;
  try {
    ({ stderr } = await deps.exec("ffmpeg", args, { timeoutMs: input.timeoutMs }));
  } catch (error) {
    if (isStoppedError(error)) throw error;
    return { status: "kept", reason: "ffmpeg-failed" };
  }
  const frames = parseFrames(stderr, Number(args[args.indexOf("-ss") + 1]));
  if (frames === null) return { status: "kept", reason: "parse-failed" };

  const point = settlePoint(frames, { endSec: input.endSec, lastWordStartSec: Math.max(edge.lastWordStartSec, input.startSec) });
  if ("reason" in point) return { status: "kept", reason: point.reason };
  return { status: "settled", endSec: point.endSec, movedSec: input.endSec - point.endSec };
}
