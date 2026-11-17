// ported from boqo-ai/boqo apps/worker/src/panels/probe.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo apps/worker/src/post/original.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
//
// The select-time probe's pure parts: its limits, `probeTimes`, the ffprobe size read and its rotation. Cut: the
// rest of the module is the worker's own (`runPanelProbe` and `probeForSelect`: the switch and the owner's email,
// the R2 store, the cost record, the 30 s ceiling, the scratch dir). In the skill the agent reads the six frames and
// `tools/panels.mjs probe-record` stores the answer, so none of that has a counterpart. `panelsSourceEligible`, which
// the worker calls here, is in panels-plan.mjs; `PANEL_PROBE_CEILING_MS` and `SIGNED_URL_TTL_SEC` are not used.
// `frameArgs` is panels-frames.mjs's. `rotationOf` is post/original.ts's, copied here for `parseProbeSize`.

/**
 * The per-project probe's limits (#293, plan Task 6). One request of six
 * frames at 640 px, inside 30 s from its start to its write.
 *
 * Cost, estimated before the evaluation: a frame is 640 px wide, and the
 * probe runs only on a landscape source, so it is at most 640x640 and, at
 * 16:9, 640x360. At the w*h/750 tokens per image of the older vision tokenizer
 * (the high-resolution tier's cap, 4,784 tokens at 2576 px and 3.75 MP, is
 * about w*h/784, read from the claude-api skill 2026-11-09), six frames are
 * about 1,850 input tokens at 16:9 and at most about 3,280 at 1:1, plus
 * about 100 of system text and labels. At claude-sonnet-5-5's $2 per million
 * input tokens (packages/billing/src/costs.ts) that is about 0.4 cents, and
 * at most 0.7 cents, inside spec §6.1's one cent per non-stream project.
 * Measured since, in the evaluation's probe of 49 sources (2026-11-09,
 * docs/research/2026-11-09-stream-panels-eval.md, "Probe"): about 23 output
 * tokens a probe, and about $0.0047 a source in all.
 */
export const PANEL_PROBE_FRAMES = 6;
export const PANEL_PROBE_FRAME_WIDTH = 640;

/** The midpoints of the first `count` clips with a length: the best-ranked, when the clips come ranked. */
export function probeTimes(clips                                                 , count        )           {
  return clips
    .filter((clip) => clip.endSec > clip.startSec)
    .slice(0, Math.max(0, count))
    .map((clip) => clip.startSec + (clip.endSec - clip.startSec) / 2);
}

/** ffprobe's streams for the first video stream of `url`, as JSON: the size and the rotation side data. */
export function probeSizeArgs(url        )           {
  return ["-v", "error", "-select_streams", "v:0", "-show_streams", "-print_format", "json", url];
}

/**
 * The first video stream's size as displayed: a quarter-turn rotation swaps
 * width and height, the way Post reads it (post/original.ts probeForPost,
 * whose rotation reader this shares). Null when there is no usable size.
 */
export function parseProbeSize(stdout        )                                           {
  let parsed               ;
  try {
    parsed = JSON.parse(stdout)                 ;
  } catch {
    return null;
  }
  const video = parsed?.streams?.find((s) => s.codec_type === "video");
  if (!video) return null;
  const { width, height } = video;
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0)) return null;
  return Math.abs(rotationOf(video)) % 180 === 90 ? { width: height, height: width } : { width, height };
}

/** Degrees the container turns the picture, 0 when it says nothing. The display matrix wins over the older `rotate` tag. */
function rotationOf(video) {
  const side = video.side_data_list?.find((d) => typeof d.rotation === "number" && Number.isFinite(d.rotation))?.rotation;
  const raw = side ?? Number(video.tags?.rotate);
  return Number.isFinite(raw) ? raw : 0;
}
