// The faces in every shot of a clip window, for the framing (spec §7.5 step 4).
//
// The skill's stand-in for boqo's apps/worker/src/render/faces.ts `detectFaces`, which spawns
// apps/worker/python/detect_faces.py with mediapipe: here the same logic (engine/boqo/detect-faces.mjs, a port of
// that script) runs over the same BlazeFace short-range model through onnxruntime-node (engine/blazeface.mjs), with
// no Python and no GPU. The result has the shape faces.ts's `parseFaceOutput` returns:
//   { frameWidth, frameHeight, shots: [{ shotIndex, faces: FaceBox[] }] }
// where a FaceBox is { x, y, width, height, confidence, mouthMotion, faceCentreX?, eyeLineY?, facing?, mouthDrop?,
// coverage, track: [{ t, cx, cy }] }, normalised 0..1 against the source frame, `t` shot-relative seconds.
//
// When onnxruntime-node or the model cannot load (Windows without the VC++ runtime, an unsupported arch, a model
// file that is missing or altered), the detector fails while running, or the disk refuses the sampled frames (no
// space, a quota, an unwritable temporary directory), the answer is `{ unavailable: true, reason }`, never an
// exception: the render then frames every shot Fit (Task A10) with one note, and tools/doctor.mjs names the load
// causes. Other ffprobe and ffmpeg failures still throw, as they fail the clip in hosted boqo.
//
// Disk: the sampled frames of one shot pass through a temporary file in chunks of at most 64 MiB
// (engine/boqo/detect-faces.mjs, SHOT_FRAMES_CHUNK_BYTES), removed after each chunk and whatever happens.
//
// This file is the skill's own and is not held by a golden of its own: every rule it calls is.
import { loadBlazeFace } from './blazeface.mjs';
import { DiskError, detect_faces } from './boqo/detect-faces.mjs';
import { STEP_TIMEOUT_MS } from './window.mjs';

/**
 * Production values (render/config.ts at the pin; the worker sets none of these variables), passed to
 * detect_faces.py by faces.ts on every call.
 */
/** `faceMinConfidenceFromEnv()`, RENDER_FACE_MIN_CONFIDENCE default 0.8. */
export const FACE_MIN_CONFIDENCE = 0.8;
/** `faceModelFromEnv()`, RENDER_FACE_MODEL default 0: mediapipe's short-range model, the one shipped here. */
export const FACE_MODEL = 0;
/** `tileMaxAspectFromEnv()`, RENDER_DETECT_TILE_MAX_ASPECT default 1.5. */
export const TILE_MAX_ASPECT = 1.5;
/** `tileOverlapFromEnv()`, RENDER_DETECT_TILE_OVERLAP default 0.5. */
export const TILE_OVERLAP = 0.5;
/**
 * `trackSampleHzFromEnv()`, RENDER_TRACK_SAMPLE_HZ default 2: pipeline.ts passes it while RENDER_TRACK_ENABLED is
 * on (it is, §6), and 0 (the 12-sample floor alone) when it is off.
 */
export const TRACK_SAMPLE_HZ = 2;

const firstLine = (e) => String(e?.message ?? e).split('\n')[0].trim();

class DetectorFailure extends Error {}

/**
 * Detects the faces of every shot of `file`.
 *
 * `shots` are `{ startSec, endSec }` on `file`'s own clock (engine/shots.mjs's). `fps` is the sampling rate per
 * second of shot, floored at 12 samples a shot (detect_faces.py's `sample_count`). `exec(command, args, { timeoutMs })
 * -> Promise<{ stdout, stderr }>` runs ffprobe and ffmpeg, rejecting with `stderr` on the error; paths travel as
 * argv elements, never inside a shell string. Each shot's sampled frames go to a file in `dir` (default: a fresh
 * temporary directory) at most 64 MiB at a time, and are removed after each chunk.
 *
 * `detector` (a loaded engine/blazeface.mjs detector, to reuse one across clips) or `load` (onnxruntime-node's
 * module loader, for tests) are optional; without either, the model loads here and is released after.
 *
 * @param {{ file: string, shots: { startSec: number, endSec: number }[], fps?: number, exec: Function, dir?: string,
 *           load?: () => Promise<any>, detector?: { process: Function } }} input
 * @returns {Promise<{ frameWidth: number, frameHeight: number, shots: { shotIndex: number, faces: object[] }[] }
 *                   | { unavailable: true, reason: string }>}
 */
export async function detectShotFaces({ file, shots, fps = TRACK_SAMPLE_HZ, exec, dir, load, detector }) {
  let det = detector;
  let owned = false;
  if (!det) {
    try {
      det = await loadBlazeFace(load ? { load } : {});
      owned = true;
    } catch (e) {
      return { unavailable: true, reason: firstLine(e) };
    }
  }

  const guarded = {
    process: async (image) => {
      try {
        return await det.process(image);
      } catch (e) {
        throw new DetectorFailure(firstLine(e));
      }
    },
  };

  try {
    return await detect_faces(
      { exec, timeoutMs: STEP_TIMEOUT_MS, dir },
      {
        video: file,
        shots,
        detector: guarded,
        min_confidence: FACE_MIN_CONFIDENCE,
        tile_max_aspect: TILE_MAX_ASPECT,
        tile_overlap: TILE_OVERLAP,
        track_sample_hz: fps,
      },
    );
  } catch (e) {
    if (e instanceof DetectorFailure) return { unavailable: true, reason: `the face detector failed: ${e.message}` };
    if (e instanceof DiskError) return { unavailable: true, reason: e.message };
    throw e;
  } finally {
    if (owned) await det.release?.();
  }
}
