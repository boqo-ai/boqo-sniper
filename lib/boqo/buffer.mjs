// ported from boqo-ai/boqo apps/watcher/src/watch/buffer.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import path from "node:path";

/**
 * The rolling buffer is a directory of MPEG-TS segments named by the epoch
 * second they opened (`-strftime 1 … %s.ts`, C1 design §4.3). Everything
 * here is arithmetic over a listing: the session lists, prunes and cuts;
 * nothing in this file touches the disk, so every rule is pinned by a test
 * on a synthetic listing.
 */

                                                         
                                                                       

const SEGMENT_NAME = /^(\d{9,11})\.ts$/;

export function parseSegmentName(name        )                {
  const match = SEGMENT_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

export function listSegments(dir        , files               )            {
  const segments            = [];
  for (const file of files) {
    const startSec = parseSegmentName(file.name);
    if (startSec === null) continue;
    segments.push({ path: path.join(dir, file.name), startSec, size: file.size });
  }
  return segments.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Every segment overlapping [startAt, endAt]. The two edges are treated
 * asymmetrically, by design, not because one is more "real" than the
 * other: the tail stays inclusive (`s.startSec <= endSec`) -- a segment
 * starting exactly at the window's end is still counted in, by
 * convention, rather than argued from where within it any given frame
 * falls -- while the head is a strict `>`, because a segment ENDING
 * exactly at `startAt` covers [start, start + segmentSec), a half-open
 * span that stops just short of `startAt`, so it holds no content inside
 * the window at all and that edge is excluded.
 */
export function segmentsCovering(segments           , startAtMs        , endAtMs        , segmentSec        )            {
  const startSec = startAtMs / 1000;
  const endSec = endAtMs / 1000;
  return segments.filter((s) => s.startSec <= endSec && s.startSec + segmentSec > startSec);
}

/** The segments that ended before `horizonSec` — safe to unlink. */
export function pruneBefore(segments           , horizonSec        , segmentSec        )            {
  return segments.filter((s) => s.startSec + segmentSec < horizonSec);
}

                                                                                                     

/**
 * The window ending `postRollSec` after the peak, `windowSec` long, clamped
 * to what the buffer still holds (design §4.7). `peakOffsetSec` is where the
 * peak sits inside the cut — the poster's seek.
 */
export function planCut(
  segments           ,
  peakAtMs        ,
  windowSec        ,
  postRollSec        ,
  segmentSec        ,
)                 {
  const oldest = segments[0];
  if (oldest === undefined) return null;
  const endAt = peakAtMs + postRollSec * 1000;
  const startAt = Math.max(endAt - windowSec * 1000, oldest.startSec * 1000);
  if (startAt >= endAt) return null;
  const covering = segmentsCovering(segments, startAt, endAt, segmentSec);
  if (covering.length === 0) return null;
  const first = covering[0] ;
  return {
    startAt,
    endAt,
    segments: covering,
    peakOffsetSec: Math.max(0, (peakAtMs - first.startSec * 1000) / 1000),
  };
}

/** The concat demuxer's list format: `file '<path>'`, a quote inside as `'\''`. */
export function concatListText(segments           )         {
  return segments.map((s) => `file '${s.path.replace(/'/g, "'\\''")}'\n`).join("");
}

/**
 * Stream copy, never a re-encode. `aac_adtstoasc` converts the TS's ADTS
 * audio framing to mp4's; `+faststart` puts the moov atom first so the
 * preview plays before the whole object downloads and ingest's probe reads
 * it at once.
 */
export function buildConcatArgs(listPath        , outPath        )           {
  return [
    "-nostdin", "-y", "-hide_banner", "-nostats",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart",
    outPath,
  ];
}

/**
 * The worker's poster shape (ingest/args.ts buildPosterArgs), at the peak rather than a fraction.
 *
 * Thread-capped on every side, as live-frame.ts's extract is (the same flag
 * placement: `-filter_threads` global, `-threads` before `-i` the decoder and
 * after it the encoder). Uncapped, one of these sizes its pools to the box's
 * 48 cores. Measured in production on 2026-10-15 (#185's gate): ten watches of
 * one channel cut the same moment at once, the watcher's cgroup reached
 * `pids.peak` 1000 of `pids.max` 1000 (`pids.events max 2`), and two of the
 * ten posters failed with "Error while opening decoder ... Resource
 * temporarily unavailable".
 */
export function buildMomentPosterArgs(inputPath        , outPath        , seekSec        )           {
  return [
    "-nostdin", "-y", "-hide_banner", "-nostats",
    "-filter_threads", "1", "-filter_complex_threads", "1", "-threads", "1",
    "-ss", seekSec.toFixed(2), "-i", inputPath,
    "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", "-threads", "1",
    outPath,
  ];
}

export function bytesPerSecond(segments           , segmentSec        )                {
  if (segments.length === 0) return null;
  const bytes = segments.reduce((sum, s) => sum + s.size, 0);
  return bytes / (segments.length * segmentSec);
}

/** Two windows of headroom (design §4.11). An unknown rate refuses nothing — a first segment must be able to land. */
export function hasFreeSpace(freeBytes        , windowSec        , bytesPerSec               )          {
  if (bytesPerSec === null) return true;
  return freeBytes >= 2 * windowSec * bytesPerSec;
}
