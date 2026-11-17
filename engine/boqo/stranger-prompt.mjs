// ported from boqo-ai/boqo apps/worker/src/stranger/prompt.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                               
// Cut: the `@boqo/core` import becomes ./timeline.mjs, the five time maps this file calls (boqo's own code, see its
// header); the Anthropic SDK import was types only (the content blocks are plain objects, unchanged).
import { clipToFileSec, clipToWindowSec, hookFileRanges, sourceToFileSec, windowToClipSec } from "./timeline.mjs";

/**
 * annotate.py's SYSTEM, verbatim (docs/research/scripts/annotate.py:63-67,
 * read 2026-10-18: three adjacent string literals, which Python joins with
 * no separator). Any change here is a new STRANGER_PROMPT_VERSION (spec §4.3);
 * the prompt test reads the script and compares.
 */
export const STRANGER_SYSTEM =
  "You annotate short vertical video clips for a research study. You see keyframes sampled every 5 seconds " +
  "(in order) and the timed transcript. Judge only what is visible or transcribed; where you must guess, pick the " +
  "conservative option. You never see the audio track. Answer with the structured fields only.";

/** annotate.py:58, `"\n".join(lines)[:6000]`. */
const TRANSCRIPT_CAP = 6000;

/** annotate.py:57, `f"[{s['start']:.1f}s] {s['text'].strip()}"`, with the stamp in file time. */
function line(t        , text        )         {
  return `[${t.toFixed(1)}s] ${text.trim()}`;
}

/** A source time on the file's timeline; a time inside a cut lands on the cut's join. */
function fileStamp(timeline              , s        )         {
  const direct = sourceToFileSec(timeline, s);
  if (direct !== null) return direct;
  const w = s - timeline.originSec;
  const cut = timeline.cuts.find((c) => c.start < w && w < c.end) ;
  return clipToFileSec(timeline, windowToClipSec(cut.start, timeline.cuts) );
}

/**
 * The transcript block (spec §4.2 step 4). The corpus stamped Whisper's
 * segments of the posted short against the short's own clock; the product
 * stamps `transcripts.segments` against the rendered file's clock: the Hook's
 * lines first (they play first), then the window's lines, each mapped through
 * the cut map. Precision is not load-bearing (spec §4.2), so a line already
 * in progress when a span opens is stamped at the span's start.
 */
export function strangerTranscript(input   
                                         
                         
                         
                       
 )         {
  const { segments, timeline } = input;
  const lines           = [];
  for (const range of hookFileRanges(timeline)) {
    const clipEnd = range.clipStart + (range.fileEnd - range.fileStart);
    const sourceStart = timeline.originSec + clipToWindowSec(range.clipStart, timeline.cuts);
    const sourceEnd = timeline.originSec + clipToWindowSec(clipEnd, timeline.cuts);
    for (const seg of segments) {
      if (seg.end > sourceStart && seg.start < sourceEnd) lines.push(line(range.fileStart + Math.max(0, seg.start - sourceStart), seg.text));
    }
  }
  for (const seg of segments) {
    if (seg.end > input.windowStartSec && seg.start < input.windowEndSec) {
      lines.push(line(fileStamp(timeline, Math.max(seg.start, input.windowStartSec)), seg.text));
    }
  }
  return lines.join("\n").slice(0, TRANSCRIPT_CAP);
}

/**
 * The user turn, in annotate.py's order (annotate.py:68-72): per frame its
 * label as a text block then the JPEG as a base64 image block, then one text
 * block with the duration and the transcript. The duration is printed to one
 * decimal: the corpus printed its features file's float as-is.
 */
export function strangerContent(
  frames                                            ,
  durationSec        ,
  transcript        ,
)                                                  {
  const content                                                  = [];
  for (const frame of frames) {
    content.push({ type: "text", text: frame.label });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.jpeg.toString("base64") } });
  }
  content.push({ type: "text", text: `Clip duration: ${durationSec.toFixed(1)}s. Timed transcript:\n${transcript}\n\nAnnotate this clip.` });
  return content;
}
