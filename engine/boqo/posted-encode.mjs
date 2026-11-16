// ported from boqo-ai/boqo apps/worker/src/render/posted-encode.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Cut import: the `OutputSize` type (@boqo/core), `{ width, height }` in pixels.
                                             

/**
 * The video encode of every file boqo can post: a clip (compose.ts), its
 * export (export/ffmpeg.ts) and a Uniqueizer copy (unique/graph.ts). One
 * list, so the three cannot drift apart again.
 *
 * `fast` at CRF 18, not the `veryfast` at CRF 20 all three used before.
 * Measured 2026-10-23 on libx264 (ffmpeg 8.1.2), VMAF against the input:
 * - posted clip 47613374 (31 s, 1080 x 1920, 60 fps), 4 threads: 96.6 ->
 *   98.1, 5.3 -> 6.8 Mbps, 9.3 s -> 17.7 s. `medium` CRF 18 scored 98.1 too,
 *   at 22.7 s, so it buys nothing over `fast`.
 * - copy 7dc1010d's own recipe on its production source, against a lossless
 *   encode of the same graph: 95.9 -> 97.5, 1.2 -> 2.0 Mbps.
 * Instagram and TikTok re-encode whatever they receive, so the file sent is
 * the best their encode can start from.
 *
 * `-fpsmax 60`: Instagram's Reels API takes 23-60 fps (Meta's IG User Media
 * reference, read 2026-10-23). Copy 4d414e37 went to Instagram at 120 fps,
 * its upload's own rate. It clamps only a rate above 60 and leaves a lower
 * one alone. Measured 2026-10-23 inside the production worker (ffmpeg
 * 5.1.9): 120 fps testsrc2 came out at 60/1, and 30 fps stayed 30/1.
 */
export const POSTED_VIDEO_ENCODE = ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-fpsmax", "60"]         ;

/**
 * The largest frame a posted file carries. 1920 is the Reels API's
 * "maximum columns (horizontal pixels)" (Meta's IG User Media reference,
 * read 2026-10-23). 3840 rows is a 4K portrait frame's height.
 */
export const POSTED_MAX_SIZE             = { width: 1920, height: 3840 };

const evenDown = (n        )         => n - (n % 2);

/**
 * The frame a Uniqueizer copy is encoded at. A source inside
 * POSTED_MAX_SIZE keeps its size. A larger one is scaled down to fit and
 * keeps its shape. Both sides are evened down, because yuv420p cannot encode
 * an odd dimension and geometryChain's crop needs an even size.
 */
export function postedFrame(source            )             {
  const scale = Math.min(1, POSTED_MAX_SIZE.width / source.width, POSTED_MAX_SIZE.height / source.height);
  return { width: evenDown(Math.round(source.width * scale)), height: evenDown(Math.round(source.height * scale)) };
}
