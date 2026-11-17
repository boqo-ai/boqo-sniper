// ported from boqo-ai/boqo apps/worker/src/render/thumbnail.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/** Step 6 of spec §5.4 — one frame out of the finished clip. */
export function thumbnailArgs(input   
                    
                
                  
 )           {
  return [
    "-nostats",
    "-hide_banner",
    "-y",
    "-ss",
    String(input.atSec),
    "-i",
    input.videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    input.outPath,
  ];
}
