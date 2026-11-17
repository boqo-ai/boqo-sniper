// ported from boqo-ai/boqo apps/worker/src/render/loudness.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo packages/core/src/loudness.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Cut imports:
// - `CLIP_LOUDNESS` (@boqo/core, packages/core/src/loudness.ts) is copied below with its comment;
// - `isStoppedError` (../stops): the skill has no Stop (a person stops a run by ending the process), so every
//   failed call is a drop;
// - `log` (../logger) and `logLoudness`: the skill logs nothing; the render turns a skip into one note line;
// - `loudnormEnabledFromEnv` (./config, RENDER_LOUDNORM_ENABLED, default on and unset on the production worker) and
//   `loudnessWanted`: the pass runs on every clip (loudness on, §6);
// - the `ClipAudio` and `ExecFn` types. `deps.exec(command, args, { timeoutMs }) -> Promise<{ stdout, stderr }>`
//   rejects when the command fails, as engine/window.mjs's does.
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";

// ---- packages/core/src/loudness.ts

/**
 * The loudness every rendered clip is normalised to (#193, spec
 * 2026-10-19-boqo-loudness-every-clip-design.md §3): integrated LUFS, true
 * peak dBTP, loudness range LU.
 *
 * Moved here from `ILLUSTRATED.loudness` with its provenance (Illustrated
 * spec §9.1). H: -14 LUFS integrated and -1 dBTP are the sheet's targets (the
 * reference measured -14.4 / +1.0 dBTP). Design (§0.2 #5): lra 7, loudnorm's
 * default, where the reference's LRA 3.0 would need dynamic mode.
 *
 * Imports nothing, on purpose: `illustrated.ts` is a leaf and takes this
 * constant from here.
 */
export const CLIP_LOUDNESS = Object.freeze({
  integrated: -14,
  truePeak: -1,
  lra: 7,
});

// ---- apps/worker/src/render/loudness.ts

/**
 * The loudness pass (#192 spec §9.1): a two-pass linear `loudnorm` over the
 * composed `clip.mp4`, video copied, audio re-encoded once. `loudnessWanted`
 * below is the one place that decides when it runs.
 */

/** Integrated loudness (LUFS), true peak (dBTP) and loudness range (LU). */
                                                                                   

/** What the measure pass read, fed back to the apply pass as `measured_*` and `offset`. */
                                                                                                                               

                             
     
                        
                     
                      
                      
                       
                       
                        
                                                                                                                 
                                 
                 
     
                                                                                 

/**
 * The pass's target for one clip (Studio Next 6.4, ruling P6-D5): the clip's
 * own `ClipAudio.loudness`. `null` is the default pass (`CLIP_LOUDNESS`), an
 * integer the same pass at that integrated target, `"off"` no pass at all
 * ("As recorded"). `loudnessWanted` stays the kill switch over all three.
 */
export function clipLoudnessTarget(loudness                       )                        {
  if (loudness === "off") return null;
  if (loudness === null) return CLIP_LOUDNESS;
  return { ...CLIP_LOUDNESS, integrated: loudness };
}

// Analysis-class flags on both passes: the measure pass decodes audio only
// (`-vn` is what makes it so, see measureArgs), and the apply pass copies the
// video and encodes only the audio, so neither needs the compose step's thread
// budget.
const THREAD_FLAGS = ["-filter_threads", "1", "-threads", "1"];

function targetFilter(target                )         {
  return `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}`;
}

/**
 * `-vn` because without it ffmpeg decodes the video stream into the null muxer
 * too. Measured 2026-10-19 in the worker image (boqo-worker:ill-830c066e,
 * ffmpeg 5.1.9), without / with `-vn`: 10.87 s / 1.26 s on a 61 s shipped
 * Stream Sniper clip and 5.09 s / 0.88 s on a 40 s Clips clip, `input_i` the
 * same. The same measurement found that over a file with NO audio stream the
 * `-vn` call exits 1 with no JSON, so that case reads as `ffmpeg-failed`.
 */
export function measureArgs(inPath        , target                )           {
  return [
    "-hide_banner", "-nostats", ...THREAD_FLAGS,
    "-i", inPath, "-vn",
    "-af", `${targetFilter(target)}:print_format=json`,
    "-f", "null", "-",
  ];
}

/**
 * `-y` so a retry in the same scratch directory overwrites a `clip-loud.mp4` a
 * killed attempt left behind rather than stopping at ffmpeg's overwrite
 * prompt. `-ar 48000` because loudnorm resamples to 192 kHz internally (spec
 * §9.1 step 2), and the pass must ship the rate it was given.
 *
 * `-b:a 192k`, not 128k: measured 2026-10-19 in the image's ffmpeg 5.1.9 on
 * five shipped production clips (spec 2026-10-19-boqo-loudness-every-clip
 * §3.4), at 128k the shipped file's true peak was +2.16 and +1.52 dBTP on two
 * files that went `dynamic` while loudnorm printed -1.00; the same pass into
 * WAV measured -0.9 and into AAC 192k -0.8 / -0.4. The encode's overshoot is
 * what the higher rate removes.
 */
export function applyArgs(inPath        , outPath        , target                , m                 )           {
  const measured =
    `measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}` +
    `:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}`;
  return [
    "-hide_banner", "-nostats", "-y", ...THREAD_FLAGS,
    "-i", inPath,
    "-c:v", "copy",
    "-af", `${targetFilter(target)}:${measured}:linear=true:print_format=json`,
    "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ];
}

/**
 * loudnorm's `print_format=json` block, as a flat map of its string values, or
 * null when the text carries none that parses.
 *
 * The LAST `{ … }` block in the text, not the text's tail. Measured 2026-10-19
 * on the same `-f lavfi -i sine … -af loudnorm=…:print_format=json -f null -`
 * run (fixtures `loudnorm-5.1.9.stderr.txt` and `loudnorm-8.stderr.txt`):
 * production's ffmpeg 5.1.9 prints `[Parsed_loudnorm_0 @ …]` and then the JSON
 * block as the very last thing on stderr, while the host's 8.1.2 prints the
 * block BEFORE its `[out#0/null @ …]` muxing summary and `size=` line. The
 * block itself is flat (no nested braces) in both.
 */
export function parseLoudnormJson(stderr        )                                {
  const start = stderr.lastIndexOf("{");
  if (start === -1) return null;
  const end = stderr.indexOf("}", start);
  if (end === -1) return null;
  let parsed         ;
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out                         = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

/** A finite number from one of the block's fields; null for a missing field, "-inf" (silence) or "nan". */
function numberField(json                        , key        )                {
  const raw = json[key];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function measureFrom(json                               )                         {
  if (json === null) return null;
  const inputI = numberField(json, "input_i");
  const inputTp = numberField(json, "input_tp");
  const inputLra = numberField(json, "input_lra");
  const inputThresh = numberField(json, "input_thresh");
  const targetOffset = numberField(json, "target_offset");
  if (inputI === null || inputTp === null || inputLra === null || inputThresh === null || targetOffset === null) return null;
  return { inputI, inputTp, inputLra, inputThresh, targetOffset };
}

function outputFrom(json                               )                                                                                              {
  if (json === null) return null;
  const outputI = numberField(json, "output_i");
  const outputTp = numberField(json, "output_tp");
  const outputLra = numberField(json, "output_lra");
  const type = json.normalization_type;
  if (outputI === null || outputTp === null || outputLra === null) return null;
  if (type !== "linear" && type !== "dynamic") return null;
  return { outputI, outputTp, outputLra, type };
}

/**
 * Measure, apply to `<dir>/clip-loud.mp4`, and rename it over `path`. Intent:
 * a failure is a drop, never a throw (spec §9.1 step 3) -- a non-zero exit, an
 * unparseable JSON, or a missing or empty output leaves `path` as compose
 * wrote it and says why. A Stop is not a failure and propagates. (The skill has none: see the top of this file.)
 */
export async function applyLoudness(
  deps                  ,
  input                                                                                ,
)                           {
  const startedAt = Date.now();
  const loudPath = path.join(input.dir, "clip-loud.mp4");
  const drop = async (reason                                  )                           => {
    await rm(loudPath, { force: true });
    return { status: "skipped", reason };
  };

  let measureStderr        ;
  try {
    ({ stderr: measureStderr } = await deps.exec("ffmpeg", measureArgs(input.path, input.target), { timeoutMs: input.timeoutMs() }));
  } catch {
    return drop("ffmpeg-failed");
  }
  const measure = measureFrom(parseLoudnormJson(measureStderr));
  if (measure === null) return drop("parse-failed");

  let applyStderr        ;
  try {
    ({ stderr: applyStderr } = await deps.exec("ffmpeg", applyArgs(input.path, loudPath, input.target, measure), {
      timeoutMs: input.timeoutMs(),
    }));
  } catch {
    return drop("ffmpeg-failed");
  }
  const output = outputFrom(parseLoudnormJson(applyStderr));
  if (output === null) return drop("parse-failed");

  try {
    if ((await stat(loudPath)).size === 0) return drop("ffmpeg-failed");
    await rename(loudPath, input.path);
  } catch {
    return drop("ffmpeg-failed");
  }

  return {
    status: "applied",
    inputI: measure.inputI,
    outputI: output.outputI,
    inputTp: measure.inputTp,
    outputTp: output.outputTp,
    inputLra: measure.inputLra,
    outputLra: output.outputLra,
    type: output.type,
    ms: Date.now() - startedAt,
  };
}
