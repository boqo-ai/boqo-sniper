// ported from boqo-ai/boqo apps/worker/src/render/extract.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * Builds the argv for step 2 of spec §5.4: pull only this clip's bytes out of
 * the source over HTTP range requests, without re-encoding.
 *
 * Pure so the argument order — which is the part that actually matters — can
 * be asserted without running ffmpeg. `-ss` before `-i` is input seeking:
 * ffmpeg jumps to the keyframe before the window and reads forward. After
 * `-i` it would decode and discard everything from zero, which on a
 * 60-minute source turns a range request into a full download.
 */
export function extractArgs(input   
              
                   
                 
                  
 )           {
  if (!(input.endSec > input.startSec)) {
    throw new Error(
      `invalid render window: ${input.startSec} to ${input.endSec}`,
    );
  }

  return [
    "-nostats",
    "-hide_banner",
    "-y",
    "-ss",
    String(input.startSec),
    "-to",
    String(input.endSec),
    "-i",
    input.url,
    "-c",
    "copy",
    input.outPath,
  ];
}
