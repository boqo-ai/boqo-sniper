// ported from boqo-ai/boqo apps/worker/src/render/cut-window.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                      

/**
 * Removing filler words from a clip's window (B4 design §4.4): the frames AND
 * the audio, in one re-encode, before anything is planned -- so scene
 * detection, face detection, layout, captions and the sidecar all run on the
 * shorter file and agree with it by construction.
 */

/** The audio fade at each join, so a cut never clicks (design §4.4). */
export const CUT_FADE_SEC = 0.01;

/**
 * How far below a printed frame time a cut edge may sit and still snap to
 * that frame. ffprobe prints six decimals, so a frame at 4.3 can print as
 * 4.299999.
 */
const SNAP_TOLERANCE_SEC = 1e-6;

/** Snapped edges are floored to 0.1 ms -- see `snapCutsToFrames`. */
const SNAP_QUANTUM_PER_SEC = 10_000;

/** ffprobe's argv for the presentation time of every video packet in `path`. */
export function frameTimesArgs(path        )           {
  return ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path];
}

/**
 * Frame times, ascending. A stream-copied window carries its pre-roll as
 * negative timestamps (its edit list); those never decode into the window,
 * so they are dropped, and so is any `N/A`.
 */
export function parseFrameTimes(stdout        )           {
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseFloat(line.trim()))
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((a, b) => a - b);
}

/**
 * Moves every cut edge onto a video frame, so the video and the audio of each
 * kept segment cut at the SAME instant.
 *
 * Measured on production's ffmpeg 5.1.9 (the boqo-render image, 2026-10-01,
 * while drafting B4 Plan 1 Task 10 -- the plan's Appendix records the run):
 * 25 cuts over a 40 s window that flashes a frame and clicks the audio every
 * second. Cut at the transcript's own times (`trim` +
 * `setpts=PTS-STARTPTS` per segment, then `concat`), the picture drifted
 * 117 ms behind the cut map by the end and lip sync wobbled between 13 and
 * 60 ms; the same cuts snapped to frames held both within 0.6 ms of the uncut
 * window. `concat` takes the longer of each segment's video and audio, and a
 * video segment can only end on a frame, so every unsnapped join adds up to a
 * frame.
 *
 * Each edge goes to the first frame at or after it, floored to 0.1 ms: the
 * floor keeps the snapped edge at or below the true frame time when ffprobe
 * has rounded the printed value up, so `trim=start` still includes that
 * frame. A cut that snaps to nothing (shorter than a frame) is dropped;
 * overlapping cuts are merged. Snapping an already-snapped list returns it
 * unchanged.
 */
export function snapCutsToFrames(cuts                , frameTimes                   )        {
  const snap = (time        )                => {
    const frame = frameTimes.find((candidate) => candidate >= time - SNAP_TOLERANCE_SEC);
    return frame === undefined
      ? null
      : Math.floor(frame * SNAP_QUANTUM_PER_SEC + 1e-6) / SNAP_QUANTUM_PER_SEC;
  };
  const out        = [];
  for (const cut of cuts) {
    const start = snap(cut.start);
    const end = snap(cut.end);
    if (start === null || end === null || end <= start) continue;
    const last = out[out.length - 1];
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({ start, end });
    }
  }
  return out;
}

function sec(value        )         {
  return String(Number(value.toFixed(6)));
}

/**
 * The trim/concat chains that keep `keep` and drop the rest, ending in
 * `[cvout]` (and `[caout]` with audio): cutWindowArgs's graph, and the
 * enhance stage's over a whole source (B4 Plan 2 ruling S7). One builder,
 * so a clip's cut and a whole source's cut cannot drift.
 */
export function cutFilterChains(
  keep                ,
  hasAudio         ,
)                                                                  {
  if (keep.length === 0) throw new Error("a cut window needs at least one kept segment");
  const last = keep.length - 1;
  const chains           = [];
  const pads           = [];
  keep.forEach((segment, index) => {
    chains.push(
      `[0:v]trim=start=${sec(segment.start)}:end=${sec(segment.end)},` +
        `setpts=PTS-${sec(segment.start)}/TB[cv${index}]`,
    );
    if (!hasAudio) {
      pads.push(`[cv${index}]`);
      return;
    }
    const audio = [
      `[0:a]atrim=start=${sec(segment.start)}:end=${sec(segment.end)}`,
      `asetpts=PTS-${sec(segment.start)}/TB`,
    ];
    if (index > 0) audio.push(`afade=t=in:d=${CUT_FADE_SEC}`);
    if (index < last) {
      audio.push(`afade=t=out:st=${sec(segment.end - segment.start - CUT_FADE_SEC)}:d=${CUT_FADE_SEC}`);
    }
    chains.push(`${audio.join(",")}[ca${index}]`);
    pads.push(`[cv${index}][ca${index}]`);
  });
  chains.push(
    `${pads.join("")}concat=n=${keep.length}:v=1:a=${hasAudio ? 1 : 0}` + (hasAudio ? "[cvout][caout]" : "[cvout]"),
  );
  return { chains, video: "[cvout]", audio: hasAudio ? "[caout]" : null };
}

/**
 * ffmpeg's argv for the cut window: every kept segment's video and audio
 * trimmed, rebased onto the segment's own start, and concatenated in one
 * pass; a `CUT_FADE_SEC` fade on each side of every join.
 *
 * `setpts=PTS-<start>/TB` rather than `PTS-STARTPTS`: with snapped edges the
 * two agree for every segment but the first, whose window can start between
 * frames, and there the anchored form keeps the first frame where it is
 * relative to the audio.
 *
 * Video only when the window has no audio stream -- no `atrim`, no `afade`,
 * `concat ... a=0`, no audio map -- since a filter cannot read a stream that
 * does not exist.
 *
 * The thread caps are the render's own (`composeArgs`, the 2026-08-25 pid
 * incident): the two filter caps are global and sit before `-i`; `-threads`
 * before `-i` caps the decoder and a second `-threads` before the output caps
 * the encoder, which the first never reaches (Ruling P26, the same shape as
 * `buildBlurRenderArgs`). Measured on 5.1.9 in the boqo-render image at
 * nproc 8, with this exact argv on a 26-segment cut: peak 11 threads; 20
 * without the encoder's `-threads`; 32 with no caps at all.
 *
 * CRF 16 because this is an intermediate: the clip's own quality is set by
 * compose's encode, which reads this file. Intent, not a measurement.
 */
export function cutWindowArgs(input   
                 
                  
                       
                    
                        
                        
 )           {
  const { chains } = cutFilterChains(input.keep, input.hasAudio);

  return [
    "-nostats",
    "-hide_banner",
    "-y",
    "-filter_complex_threads",
    String(input.filterThreads),
    "-filter_threads",
    String(input.filterThreads),
    "-threads",
    String(input.encodeThreads),
    "-i",
    input.inPath,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[cvout]",
    ...(input.hasAudio ? ["-map", "[caout]"] : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    String(input.encodeThreads),
    ...(input.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    input.outPath,
  ];
}
