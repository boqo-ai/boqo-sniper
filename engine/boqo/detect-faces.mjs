// ported from boqo-ai/boqo apps/worker/python/detect_faces.py @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
//
// A hand port from Python, line for line, with the Python names kept so a drift diff reads across. What changed
// in the move, and nothing else:
//   - The detector is injected (`detector.process(image) -> Promise<{ detections }>`, the mediapipe solution's
//     shape: engine/blazeface.mjs). Images are `{ width, height, data }`, packed RGB24, where Python has numpy
//     (height, width, 3) arrays.
//   - ffprobe and ffmpeg run through an injected `exec(command, args, { timeoutMs }) -> Promise<{ stdout, stderr }>`
//     (rejecting with `stderr` on the error), not subprocess. Because `exec` resolves only once ffmpeg exits,
//     shot_frames cannot stream a pipe as Python does: it samples a shot in chunks, each ffmpeg call writing at most
//     64 MiB of raw frames to one temporary file that is read a frame at a time and removed before the next call.
//     The bound, in numbers: a call writes floor(64 MiB / frame) frames (chunk_frames + 1 look-ahead), and the
//     scaler caps a frame at 1280 wide, so a frame is 1280 x height x 3 bytes at most: 1280x720 is 2,764,800 B,
//     24 a call (63.3 MiB); a 1080x1920 portrait (not scaled) 6,220,800 B, 10 a call (59.3 MiB); 2160x3840 scaled
//     to 1280x2276, 8,739,840 B, 7 a call (58.3 MiB). Above 32 MiB a frame (taller than 8,738 rows at 1280 wide,
//     which no video source is) a call writes 2 frames. Memory holds one frame. The chunks join into exactly the
//     one-pass frames (shot_frames_command); the price is re-decoding the shot's start for each chunk. A disk
//     failure there is a DiskError, which engine/faces.mjs turns into Fit rather than a failed render.
//   - analyse_shot takes shot_frames as a dependency (`deps.shot_frames`), where Python reads the module global.
//   - main() is `detect_faces`, returning the object main() prints.
//   - Python's arithmetic is kept where JavaScript's differs: round() is half to even on the exact binary value
//     (py_round), str(float) is repr (py_repr), sum() of floats is plain left-to-right addition (Python 3.11, which
//     apps/worker/Dockerfile says the worker image runs; Python 3.12 changed float sum()), numpy slicing clamps
//     out-of-range bounds. The goldens (tests/faces.test.mjs) hold this port to detect_faces.py at tolerance 0.
//
// The module docstring, verbatim:
//
// """Active-speaker face detection for one rendered clip window.
//
// Spec 5.4 step 2. Reads a video and a list of shot windows, samples frames
// inside each shot, and reports the faces it found with a mouth-motion score.
//
// Coordinates stay normalised 0..1, exactly as MediaPipe reports them: the
// TypeScript side needs the frame dimensions anyway for clamping, and putting a
// pixel conversion here would hide the unit in a language its tests cannot read.
//
// Output is a single JSON object on stdout. Anything else — including a
// traceback — is a parse failure on the TypeScript side by design, because
// "printed nothing useful" must never be read as "found no faces", which would
// silently centre-crop an entire video. MediaPipe's own startup logging goes to
// stderr on its own, so this file must never call print() or otherwise write to
// stdout except the one json.dump at the end.
//
// Frames are sourced from ffmpeg, not cv2.VideoCapture. opencv-contrib-python
// bundles its own FFmpeg, built without a software AV1 decoder: against a real
// AV1 source inside the built runtime image, VideoCapture opened successfully
// and then silently returned 0 of 6 reads — exit 0, no Python exception, just
// "Missing Sequence Header" buried in libav's own stderr chatter. The same
// source decodes fine through the image's own `ffmpeg` binary, and a VP9
// source decodes fine through VideoCapture too, so this is an AV1-specific gap
// in the bundled decoder, not a general one — but YouTube serves AV1 broadly,
// so it is not an edge case this product can leave uncovered. `ffmpeg` is
// already a required dependency (extract.ts, scenes.ts, compose.ts all shell
// out to it) and has no such gap, so it sources every frame here too.
// """
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Python's ValueError and RuntimeError, by name, so a caller can tell them apart as the Python caller did. */
export class ValueError extends Error {
  name = 'ValueError';
}
export class RuntimeError extends Error {
  name = 'RuntimeError';
}

// ---- Python's arithmetic and formatting, where JavaScript's differs

/** The exact value of a finite double as `mant * 2**exp`, both BigInt-friendly. */
function exactParts(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased) mant |= 1n << 52n;
  return { mant, exp: (biased || 1) - 1075 };
}

/** True when |x| * 10**nd lies exactly halfway between two integers. */
function isDecimalTie(x, nd) {
  const { mant, exp } = exactParts(Math.abs(x));
  if (mant === 0n || exp >= 0) return false;
  // |x| * 2 * 10**nd = mant * 2**(nd + 1) * 5**nd / 2**-exp is an odd integer exactly when the power of two in
  // mant * 2**(nd + 1) is exactly -exp.
  let twos = 0;
  let m = mant;
  while ((m & 1n) === 0n) {
    m >>= 1n;
    twos++;
  }
  return twos + nd + 1 === -exp;
}

/**
 * Python 3's round(): `round(x)` (an int) or `round(x, nd)` (a float), half to even on the exact binary value.
 * JavaScript's Math.round and toFixed break ties upwards.
 */
export function py_round(x, nd) {
  if (!Number.isFinite(x)) return x;
  if (nd === undefined) {
    const r = Math.round(x);
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }
  if (!isDecimalTie(x, nd)) {
    const r = Number(x.toFixed(nd));
    return r === 0 && (x < 0 || Object.is(x, -0)) ? -0 : r;
  }
  const scaled = Math.abs(x) * 10 ** nd; // exact: a tie is k + 0.5 with k well inside 2**52 here
  const k = Math.floor(scaled);
  const even = k % 2 === 0 ? k : k + 1;
  const r = even / 10 ** nd;
  return x < 0 ? -r : r;
}

/** Python 3's str() / repr() of a float: the shortest round-trip digits, fixed between 1e-4 and 1e16, else e±XX. */
export function py_repr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const sign = x < 0 || Object.is(x, -0) ? '-' : '';
  const [mant, e] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = Number(e);
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
  const frac = digits.slice(exp + 1);
  return `${sign}${int}.${frac || '0'}`;
}

/** statistics.median: the middle of the sorted values, the mean of the two middles for an even count. */
function median(values) {
  const data = [...values].sort((a, b) => a - b);
  const n = data.length;
  if (n === 0) throw new Error('no median for empty data');
  if (n % 2 === 1) return data[Math.floor(n / 2)];
  const i = n / 2;
  return (data[i - 1] + data[i]) / 2;
}

/** sum() of floats in Python 3.11: left to right from 0. */
const sum = (values) => values.reduce((a, b) => a + b, 0);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export const SAMPLES_PER_SHOT = 12;

// How much of the best-covered face's screen time a face must also hold to
// stay in a shot's roster. See summarise_faces' own use of it for the measured
// gap this sits in, and for the failure it exists to stop.
export const MIN_COVERAGE_RATIO = 0.25;

// Detection runs on a downscaled copy for speed. This is safe only because
// the output stays normalised 0..1 (see the module docstring):
// frameWidth/frameHeight in the JSON output always come from probe_dimensions
// below, never from this scaled figure.
export const DETECT_MAX_WIDTH = 1280;

// How close two face positions must be to count as the same physical face,
// in normalised frame units, once containment alone (see
// match_box_for_point) doesn't settle it. The one remaining caller is
// _track_face, matching a face's box across sampled frames — see its own
// docstring for the measurement that validates this value there (a 0.223
// single-hop drift, against this 0.2 floor).
export const MAX_MATCH_DISTANCE = 0.2;

// How much two boxes must overlap to be treated as one face. Only relevant
// under tiling, where windows overlap by construction. Asymmetric in
// consequence: an unmerged duplicate is harmless, a wrongly merged pair
// deletes a real speaker.
export const MERGE_IOU = 0.3;

// MediaPipe's face detection returns six keypoints in a fixed order. "Right"
// and "left" are the subject's, not the image's. Verified rather than assumed
// against a real left-facing profile frame, where the absolute x of each came
// out nose 965, mouth 996, eyes 1028/1036, ears 1151/1198 — nose leftmost and
// ears rightmost, exactly as a left-facing head puts them.
export const KP_RIGHT_EYE = 0;
export const KP_LEFT_EYE = 1;
export const KP_NOSE = 2;
export const KP_MOUTH = 3;
export const KP_RIGHT_EAR = 4;
export const KP_LEFT_EAR = 5;
export const KEYPOINT_COUNT = 6;

// Fields derived from the keypoints. Optional on every box, because a
// detection may carry no keypoints and the renderer must degrade to the box
// centre rather than fail.
export const KEYPOINT_FIELDS = Object.freeze(['faceCentreX', 'eyeLineY', 'facing', 'mouthDrop']);

/**
 * Face centre, eye line, facing direction and mouth drop, or None.
 *
 * Computed in whatever units `keypoints` arrive in, which under tiling is
 * window-local. Only `faceCentreX` needs mapping to absolute frame units
 * afterwards (see to_absolute). The other three survive untouched:
 * `eyeLineY` is a y coordinate and windows span the full frame height, while
 * `facing` and `mouthDrop` are ratios whose numerator and denominator are
 * both window-local, so the window scale cancels exactly.
 *
 * `faceCentreX` is the eye/nose/mouth cluster, not the head centroid. The
 * detection box covers the whole head including hair, and on a profile the
 * two sit ~180px apart inside a 456px crop window — which renders as the
 * back of the subject's head, with the face against the window edge.
 *
 * `facing` is normalised by box width, not by ear span. On a strict profile
 * the ears nearly coincide — measured 47px apart inside a 311px-wide head —
 * so an ear-span denominator gives -4.46, unbounded and least stable exactly
 * when the value matters most. Box width gives -0.67, and ~0 frontally where
 * the nose and the ear midpoint coincide.
 *
 * `mouthDrop` is the mouth centre relative to the eye line, scaled by face
 * height. Both references move with the head, so head translation and
 * distance from the camera cancel and what is left is jaw movement. This is
 * what replaces the mesh's openness reading, which returns nothing at all on
 * a strict profile (spec §4.2b).
 */
export function face_geometry(keypoints, box) {
  if (keypoints == null || keypoints.length < KEYPOINT_COUNT) return null;
  if (box.width <= 0 || box.height <= 0) return null;

  const right_eye = keypoints[KP_RIGHT_EYE];
  const left_eye = keypoints[KP_LEFT_EYE];
  const nose = keypoints[KP_NOSE];
  const mouth = keypoints[KP_MOUTH];
  const ear_mid_x = (keypoints[KP_RIGHT_EAR].x + keypoints[KP_LEFT_EAR].x) / 2.0;
  const eye_line_y = (right_eye.y + left_eye.y) / 2.0;

  return {
    faceCentreX: (right_eye.x + left_eye.x + nose.x + mouth.x) / 4.0,
    eyeLineY: eye_line_y,
    facing: (nose.x - ear_mid_x) / box.width,
    mouthDrop: (mouth.y - eye_line_y) / box.height,
  };
}

/**
 * Left offsets and widths of the detection windows for one frame.
 *
 * MediaPipe's face detector takes a square input, so a wide frame is
 * squeezed to fit and its faces compress horizontally until the model no
 * longer recognises them. Measured on a real 1920x810 source: the same
 * face scores 0.947 in a 1:1 window, 0.810 at 16:9, 0.709 at 2:1, and is
 * not detected at all at 2.37:1. Production's floor is 0.80, so every
 * frame wider than roughly 2:1 silently produced nothing — and "found no
 * faces" and "could not see" were the same output.
 *
 * Windows are square, which is the shape the model was trained on. A frame
 * already at or below `max_aspect` yields one full-width window, so 9:16
 * and 1:1 sources cost exactly what they cost today.
 *
 * The final window is clamped to the right edge rather than stepped past
 * it: a stride that stops short leaves a strip of the frame unexamined,
 * and on this product's own footage the speaker is frequently composed
 * exactly there.
 *
 * (Port: the windows are `[x0, win]` pairs, Python's tuples.)
 */
export function tile_windows(width, height, max_aspect, overlap) {
  if (width <= 0 || height <= 0) throw new ValueError(`non-positive frame dimensions: ${width}x${height}`);

  if (width <= height * max_aspect) return [[0, width]];

  // min(), not bare height: a max_aspect small enough that a portrait or
  // square frame still fails the gate above (e.g. 0.5 on a 1080x1920 clip)
  // would otherwise make win (1920) wider than the frame itself (1080).
  // offsets would then need a negative start to reach the right edge —
  // `width - win` below goes negative — and a numpy slice with a negative
  // start wraps around silently rather than raising. Clamping win to the
  // frame's own width keeps every window inside the frame regardless of
  // how max_aspect is set.
  const win = Math.min(height, width);
  const step = Math.max(py_round(win * (1.0 - overlap)), 1);
  const offsets = [];
  for (let x0 = 0; x0 < width - win; x0 += step) offsets.push(x0);
  offsets.push(width - win);

  const seen = new Set();
  const windows = [];
  for (const x0 of offsets) {
    if (!seen.has(x0)) {
      seen.add(x0);
      windows.push([x0, win]);
    }
  }
  return windows;
}

/**
 * Re-expresses one window-local box in whole-frame normalised units.
 *
 * MediaPipe reports coordinates normalised against whatever image it was
 * handed, which under tiling is a window rather than the frame. Everything
 * downstream — summarise_faces, the TypeScript seam, crop.ts — assumes
 * whole-frame units, and the module docstring above already records what
 * happens when a coordinate silently changes meaning: every source
 * mis-crops, and nothing looks wrong until someone watches the video.
 *
 * Only the horizontal axis moves. Windows span the full frame height, so y
 * and height are already absolute.
 */
export function to_absolute(box, x0, win, frame_width) {
  const absolute = {
    x: (x0 + box.x * win) / frame_width,
    y: box.y,
    width: (box.width * win) / frame_width,
    height: box.height,
    confidence: box.confidence,
  };

  // faceCentreX is an x coordinate in window-local units exactly as box["x"]
  // is, so it takes the identical transform. This one line is the highest
  // risk in the change: getting it wrong mis-crops every wide source while
  // every other property still looks right, which is the same silent, total
  // failure this function's own docstring already warns about.
  //
  // eyeLineY, facing and mouthDrop are a y coordinate and two ratios, and
  // pass through unchanged — see face_geometry for why the ratios are
  // scale-invariant.
  if (has(box, 'faceCentreX')) {
    absolute.faceCentreX = (x0 + box.faceCentreX * win) / frame_width;
    for (const field of ['eyeLineY', 'facing', 'mouthDrop']) absolute[field] = box[field];
  }

  return absolute;
}

export function _intersection_over_union(a, b) {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const overlap_w = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const overlap_h = Math.min(ay2, by2) - Math.max(a.y, b.y);
  if (overlap_w <= 0 || overlap_h <= 0) return 0.0;

  const intersection = overlap_w * overlap_h;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0.0;
}

/**
 * Collapses the duplicates that overlapping windows necessarily produce.
 *
 * Windows overlap so that a face sitting on a seam is caught by at least
 * one of them; the cost is that a face in the overlap is reported twice.
 * Measured on real footage, one person produced 0.92 at x=0.56 and 0.91 at
 * x=0.55.
 *
 * Highest confidence wins, which is standard non-maximum suppression. The
 * threshold matters in one direction more than the other: failing to merge
 * a duplicate gives chooseSpeaker two copies of one person to pick between,
 * which is harmless, while merging two real speakers deletes one of them.
 */
export function merge_detections(boxes, iou_threshold) {
  const kept = [];
  // sorted(key=-confidence) is stable, and so is Array.prototype.sort.
  for (const box of [...boxes].sort((p, q) => -p.confidence - -q.confidence)) {
    if (kept.every((other) => _intersection_over_union(box, other) < iou_threshold)) kept.push(box);
  }
  return kept;
}

/**
 * Absolute, de-duplicated boxes from one frame's per-window detections.
 *
 * Separate from analyse_shot so the composition can be tested without
 * MediaPipe: the detector cannot be exercised from a unit test, but the
 * arithmetic that decides where a crop lands must be.
 */
export function boxes_from_windows(results, windows, frame_width, iou_threshold) {
  // zip() silently stops at the shorter sequence, so a caller that ever
  // dropped an entry from `results` (or reordered `windows` against it)
  // would attribute each remaining box to the wrong window's offset —
  // every box's absolute x shifted by whatever the wrong window's x0 is —
  // rather than raising. That would mis-crop every wide source while every
  // test that only checks box *count* or *confidence* stayed green. Today
  // this holds only because analyse_shot's `per_window.append(found)` runs
  // unconditionally for every window (see its own comment); this guard is
  // what makes that invariant load-bearing rather than merely convenient.
  if (results.length !== windows.length) {
    throw new ValueError(`results/windows length mismatch: ${results.length} results for ${windows.length} windows`);
  }
  const absolute = [];
  windows.forEach(([x0, win], i) => {
    for (const box of results[i]) absolute.push(to_absolute(box, x0, win, frame_width));
  });
  return merge_detections(absolute, iou_threshold);
}

/**
 * The video's true encoded width/height, straight from ffprobe.
 *
 * This is the only source of frameWidth/frameHeight in the JSON output.
 * Detection itself runs on a downscaled copy (DETECT_MAX_WIDTH) for speed,
 * but its coordinates are normalised 0..1 regardless — reporting the
 * scaled dimensions here instead would silently mis-crop every source,
 * exactly the failure this field exists to prevent. Raises RuntimeError on
 * any ffprobe failure or non-positive dimensions; the caller turns that
 * into a clean stderr message and a non-zero exit rather than partial JSON.
 *
 * (Port: `exec` is injected; a rejection is the non-zero return code.)
 */
export async function probe_dimensions({ exec, timeoutMs }, video) {
  let stdout;
  try {
    ({ stdout } = await exec(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', video],
      { timeoutMs },
    ));
  } catch (e) {
    throw new RuntimeError(`ffprobe failed on ${video}: ${String(e?.stderr ?? e?.message ?? '').trim()}`);
  }

  const streams = JSON.parse(stdout).streams || [];
  if (!streams.length) throw new RuntimeError(`ffprobe found no video stream in ${video}`);

  const width = Math.trunc(Number(streams[0].width));
  const height = Math.trunc(Number(streams[0].height));
  if (!(width > 0) || !(height > 0)) {
    throw new RuntimeError(`ffprobe reported non-positive dimensions for ${video}: ${width}x${height}`);
  }
  return [width, height];
}

/**
 * Port addition: the most raw-frame bytes one ffmpeg call of shot_frames writes to disk, 64 MiB. See the module
 * header and shot_frames.
 */
export const SHOT_FRAMES_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Port addition: how many frames one chunk of shot_frames yields. Each ffmpeg call writes one frame more, the
 * look-ahead that says whether another chunk follows, so a call writes floor(chunk_bytes / frame_size) frames,
 * at most `chunk_bytes`, for any frame up to half of it; a larger frame gets one frame (and its look-ahead) a call.
 */
export function chunk_frames(frame_size, chunk_bytes = SHOT_FRAMES_CHUNK_BYTES) {
  return Math.max(1, Math.floor(chunk_bytes / frame_size) - 1);
}

/**
 * shot_frames' ffmpeg command and the frame size it produces, `out` being where the raw frames go (Python: "-",
 * stdout). Split out of shot_frames so the argv is held by a golden.
 *
 * (Port: with `chunk` = `{ first, frames }`, the command for one chunk: the same command, with
 * `select='gte(n,first)'` after `fps` and `-frames:v frames` before the output. `n` counts the fps filter's output,
 * so the chunk is that same stream from sample `first` on, cut after `frames`, pixels and timestamps untouched:
 * the chunks of a shot, laid end to end, are byte for byte the one-pass output (measured 2026-11-16 on ffmpeg 7.0.2
 * and 8.1.3, B-frame sources at 29.97 fps, rates of 2 to 7.5 Hz, chunks of 1 to 23 frames; tests/faces.test.mjs
 * checks it against the ffmpeg on the PATH). A `setpts` there would NOT be: the output `-t` would then cut each
 * chunk at a different frame.)
 */
export function shot_frames_command(video, start, end, width, height, count, out = '-', chunk = null) {
  const duration = Math.max(end - start, 1e-3);
  const scale_width = Math.min(width, DETECT_MAX_WIDTH);
  let scale_height = width ? py_round((height * scale_width) / width) : 0;
  scale_height -= scale_height % 2;
  const select = chunk ? `select='gte(n,${chunk.first})',` : '';
  const argv = [
    'ffmpeg', '-v', 'error',
    '-ss', py_repr(start), '-i', video, '-t', py_repr(duration),
    '-vf', `fps=${py_repr(count / duration)},${select}scale=${scale_width}:${scale_height}`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', ...(chunk ? ['-frames:v', String(chunk.frames)] : []), out,
  ];
  return { argv, scale_width, scale_height };
}

/**
 * Port addition: the face step could not use the disk it needs for its sampled frames (no space, a quota, a
 * read-only or unwritable temporary directory). engine/faces.mjs answers it with `{ unavailable: true, reason }`,
 * so the render frames the clip Fit rather than failing; any other ffmpeg failure stays a RuntimeError, as in
 * Python.
 */
export class DiskError extends Error {
  name = 'DiskError';
}

/** ffmpeg's words for a write the disk refused (libavutil's strerror of ENOSPC, EDQUOT, EROFS). */
const DISK_FULL = /No space left on device|Disk quota exceeded|Read-only file system/i;

const disk_error = (what, e) => new DiskError(`the face frames could not be ${what}: ${e?.code ? `${e.code} ` : ''}${String(e?.message ?? e).split('\n')[0]}`);

/** A Node fs call, its failure a DiskError. */
async function on_disk(what, fn) {
  try {
    return await fn();
  } catch (e) {
    throw disk_error(what, e);
  }
}

/**
 * `count` RGB frames sampled evenly across [start, end], via ffmpeg.
 *
 * One ffmpeg call per shot rather than a `cv2.VideoCapture` seek per
 * sampled timestamp: `-ss` before `-i` seeks near the target and, because
 * this call also decodes (`-vf`/`-pix_fmt` force a real decode rather than
 * a stream copy), ffmpeg corrects forward to the exact requested time; the
 * `fps` filter then samples the rest of the window evenly from there. That
 * is what actually lands on `count` distinct frames on long-GOP footage —
 * repeated `CAP_PROP_POS_MSEC` seeks landed on the same handful of
 * keyframes in practice (9-12 of 12 requested reads on real footage;
 * ffmpeg's `fps` filter gets all 12).
 *
 * Frames are already RGB (`-pix_fmt rgb24`), scaled to at most
 * DETECT_MAX_WIDTH wide (see that constant). Returns however many complete
 * frames ffmpeg actually produced — `count` in the overwhelmingly common
 * case, but read from the buffer rather than assumed, since the `fps`
 * filter's output count can be off by one at a shot boundary. Raises
 * RuntimeError on any ffmpeg failure, for the same reason probe_dimensions
 * does: a message on stderr and a non-zero exit, never partial JSON.
 *
 * Yields `(index, frame)` and never holds more than one frame. The previous
 * version ran ffmpeg with capture_output=True and then built a list of
 * per-frame copies, so peak memory scaled with shot length: at 2Hz a
 * single-shot 60s clip needed ~0.5GB and at 4Hz ~1.0GB, doubled again by
 * RENDER_CONCURRENCY=2. Sampling at a rate rather than a fixed 12 per shot
 * made that a real ceiling rather than a theoretical one, and a single-shot
 * clip is not an edge case — adaptive scene detection legitimately returns
 * no cuts on gameplay. `index` is yielded because the caller needs the
 * ORIGINAL sample index to compute a timestamp; frames that produce no
 * detection are dropped downstream, and a positional index would silently
 * close those gaps.
 *
 * (Port: shot_frames runs ffmpeg through the injected `exec`, which resolves only when ffmpeg exits, so the frames
 * pass through a file, `<dir>/faces.rgb`, and the shot is sampled in chunks to bound it: each call writes at most
 * SHOT_FRAMES_CHUNK_BYTES (chunk_frames), the file is read one frame at a time, then removed before the next call.
 * The frames, their order and their indexes are the one-pass ones (shot_frames_command). The cost is decoding:
 * each chunk decodes the shot from its start up to its own last sample, about chunks/2 single passes in all. A
 * shot of up to 23 samples at 1280x720 (11.5 s at 2 Hz), or 9 at 1080x1920, is one call. Measured 2026-11-16
 * (24 cores, ffmpeg 8.1.3, H.264 30 fps), a 90-second single shot at 2 Hz: 1280x720 in 8 calls, 11.5 s against
 * 2.9 s for one pass, the file peaking at 63.3 MiB against 475 MiB; 1080x1920 in 20 calls, 32.4 s against 2.8 s,
 * 59.3 MiB against 1,068 MiB.
 *
 * As in Python, the frames ffmpeg wrote are yielded before its failure is raised. A missing file reads as no
 * frames, as an empty pipe does. A disk failure (ffmpeg's or Node's) raises DiskError, not RuntimeError. `dir`
 * defaults to a fresh temporary directory; the file, and that directory, are removed however the generator ends.
 * Yields `[index, frame]`. A zero frame size, which would loop forever in Python, yields nothing.)
 */
export async function* shot_frames({ exec, timeoutMs, dir, chunk_bytes = SHOT_FRAMES_CHUNK_BYTES }, video, start, end, width, height, count) {
  const own = dir ? null : await on_disk('given a temporary directory', () => mkdtemp(join(tmpdir(), 'boqo-faces-')));
  const file = join(dir ?? own, 'faces.rgb');
  const { scale_width, scale_height } = shot_frames_command(video, start, end, width, height, count);
  const frame_size = scale_width * scale_height * 3;
  try {
    if (!frame_size) return;
    const per_chunk = chunk_frames(frame_size, chunk_bytes);
    let index = 0;
    for (;;) {
      const { argv } = shot_frames_command(video, start, end, width, height, count, file, { first: index, frames: per_chunk + 1 });
      let failure = null;
      try {
        await exec(argv[0], argv.slice(1), { timeoutMs });
      } catch (e) {
        failure = e;
      }

      let more = false;
      let fh = null;
      try {
        fh = await open(file, 'r');
      } catch (e) {
        if (e?.code !== 'ENOENT') throw disk_error('read', e);
      }
      if (fh) {
        try {
          const written = Math.floor((await on_disk('read', () => fh.stat())).size / frame_size);
          // A failed call yields everything it wrote, as Python yields what came through the pipe before the exit.
          const take = failure ? written : Math.min(written, per_chunk);
          more = !failure && written > per_chunk;
          for (let k = 0; k < take; k++) {
            const data = new Uint8Array(frame_size);
            const { bytesRead } = await on_disk('read', () => fh.read(data, 0, frame_size, k * frame_size));
            // A short read is the end of the stream, not a frame: a partial
            // buffer reshaped would raise, and silently padding it would hand
            // the detector garbage pixels.
            if (bytesRead < frame_size) {
              more = false;
              break;
            }
            yield [index, { width: scale_width, height: scale_height, data }];
            index += 1;
          }
        } finally {
          await fh.close().catch(() => {});
        }
        await on_disk('removed', () => rm(file, { force: true }));
      }

      if (failure) {
        const stderr = String(failure?.stderr ?? '').trim();
        if (DISK_FULL.test(stderr) || stderr.includes(file) || DISK_FULL.test(String(failure?.message ?? '')) || ['ENOSPC', 'EDQUOT', 'EROFS'].includes(failure?.code)) {
          throw disk_error('written', { code: failure?.code, message: stderr.split('\n').find((l) => DISK_FULL.test(l)) ?? (stderr || failure?.message) });
        }
        throw new RuntimeError(`ffmpeg failed sampling ${video} [${py_repr(start)},${py_repr(end)}]: ${String(failure?.stderr ?? failure?.message ?? '').trim()}`);
      }
      if (!more) return;
    }
  } finally {
    // However the generator ends (exhausted, a raise, the caller stopping early): the frames file, and the
    // directory when it is our own, are removed; a failure here must not hide the one already raised.
    await rm(own ?? file, { recursive: true, force: true }).catch(() => {});
  }
}

const _box_center = (box) => [box.x + box.width / 2.0, box.y + box.height / 2.0];

const _contains = (box, [x, y]) => box.x <= x && x <= box.x + box.width && box.y <= y && y <= box.y + box.height;

// Python's `** 0.5` (C pow). Math.sqrt is correctly rounded; pow(x, 0.5) may differ from it in the last bit, which
// matters only for a distance exactly at MAX_MATCH_DISTANCE: the golden's boundary points (0.12, 0.16 from a centre)
// agree with Python's.
const _distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

/**
 * Index of the detection box a point (another frame's box centre)
 * belongs to, or None if none plausibly matches.
 *
 * The box that contains the point, or, failing that, the nearest box
 * centre, as long as it is close enough (MAX_MATCH_DISTANCE) to plausibly
 * be the same face rather than a genuinely different one.
 *
 * Used to pair a face across sampled frames (see _track_face): MediaPipe
 * gives no tracking ID and static_image_mode processes every frame
 * independently, so a face's own box position is the only available
 * stand-in for identity from one sampled frame to the next.
 */
export function match_box_for_point(boxes, point) {
  for (let index = 0; index < boxes.length; index++) {
    if (_contains(boxes[index], point)) return index;
  }

  if (!boxes.length) return null;

  let nearest_index = 0;
  let nearest_distance = _distance(_box_center(boxes[0]), point);
  for (let index = 1; index < boxes.length; index++) {
    const d = _distance(_box_center(boxes[index]), point);
    if (d < nearest_distance) {
      nearest_index = index;
      nearest_distance = d;
    }
  }
  return nearest_distance <= MAX_MATCH_DISTANCE ? nearest_index : null;
}

/**
 * Frames that produced at least one qualifying box, each keeping its
 * ORIGINAL sample index.
 *
 * Extracted from analyse_shot so the index-preservation rule is testable on
 * its own. Dropping the frame is right — there is nothing to track in it —
 * but dropping its index is not: the position of an entry in this list is
 * not its position in time, and a path built from positions would compress
 * a five-sample occlusion into one step and skew every keypoint after it.
 */
export function _frames_with_boxes(indexed_boxes) {
  return indexed_boxes.filter(([, boxes]) => boxes.length).map(([index, boxes]) => ({ index, boxes }));
}

/**
 * Follows one face across every sampled frame, from `start_index` outwards.
 *
 * The probe point walks *with* the face — each step matches against the
 * previous matched box's centre, not against a fixed reference box. That
 * distinction is the whole point: a speaker can drift much further across a
 * shot than MAX_MATCH_DISTANCE permits in a single hop (measured: 0.223 of
 * frame width over one 11-second shot, against a 0.2 threshold), while each
 * ~0.9-second step between samples stays comfortably inside it. Matching
 * every frame against one reference box therefore drops exactly the samples
 * that prove the face moved.
 *
 * A frame with no plausible match is skipped rather than ending the walk, so
 * a face that is briefly occluded or missed is re-acquired from the last
 * position actually seen.
 *
 * Returns `(entries, drops)` where each entry is `{"index": <original
 * sample index>, "box": {...}}`, sorted by index. Sorted because `walk`
 * runs forward from the seed and then backward, so the natural append
 * order is 5,6,7,4,3,2 — and a path read in that order pans backwards
 * through the middle of the shot. `drops` holds the mouthDrop readings of
 * every matched box that carried keypoints.
 */
export function _track_face(frames, start_index, seed) {
  const entries = [];
  const drops = [];

  const walk = (indices) => {
    let point = _box_center(seed);
    for (const i of indices) {
      const match = match_box_for_point(frames[i].boxes, point);
      if (match === null) continue;
      const box = frames[i].boxes[match];
      entries.push({ index: frames[i].index, box });
      point = _box_center(box);
      // The openness reading rides on the box itself now, so there is
      // no mesh output to pair with it. Skipped when a detection had no
      // keypoints, exactly as a missing mesh match was skipped before.
      if (has(box, 'mouthDrop')) drops.push(box.mouthDrop);
    }
  };

  const range = (from, to, step) => {
    const out = [];
    for (let i = from; step > 0 ? i < to : i > to; i += step) out.push(i);
    return out;
  };
  walk(range(start_index, frames.length, 1));
  walk(range(start_index - 1, -1, -1));
  entries.sort((a, b) => a.index - b.index);
  return [entries, drops];
}

/**
 * Component-wise median of one face's sampled boxes.
 *
 * Median rather than mean: a single frame where detection clipped the box or
 * latched briefly onto something else would drag an average, and the crop it
 * feeds is static for the whole shot, so one bad sample would mis-frame every
 * second of it.
 */
export function _median_box(boxes) {
  const summary = {
    x: median(boxes.map((box) => box.x)),
    y: median(boxes.map((box) => box.y)),
    width: median(boxes.map((box) => box.width)),
    height: median(boxes.map((box) => box.height)),
    confidence: median(boxes.map((box) => box.confidence)),
  };

  // Medianed only across the samples that carried them, and omitted
  // entirely when none did, so a detection without keypoints degrades to
  // the box centre downstream rather than inventing a face position.
  for (const field of KEYPOINT_FIELDS) {
    const values = boxes.filter((box) => has(box, field)).map((box) => box[field]);
    if (values.length) summary[field] = median(values);
  }

  return summary;
}

/**
 * How many frames to sample from a shot of `duration` seconds.
 *
 * Floored at today's fixed count rather than allowed to fall below it: at
 * 2Hz a 1.6s shot would otherwise get 3 samples, fewer than the 12 it gets
 * today, so sampling at a rate would degrade short shots while improving
 * long ones. RENDER_MIN_SHOT_SEC is 0.5, so the floor binds up to 6s.
 */
export function sample_count(duration, hz, floor = SAMPLES_PER_SHOT) {
  if (hz <= 0) return floor;
  return Math.max(py_round(duration * hz), floor);
}

/**
 * Shot-relative timestamp of sample `index`.
 *
 * Divided by the REQUESTED count, not the returned one: shot_frames can
 * return one fewer frame than asked for at a shot boundary, and dividing by
 * what came back re-spaces every timestamp and stretches the path — worse
 * the further into the shot. This is the same trap audit_frames.frame_timestamp
 * documents with a measurement.
 */
export function sample_time(index, requested, duration) {
  return py_round((index * duration) / requested, 4);
}

/**
 * Collapses the sampled frames of one shot into one static box per face.
 *
 * Spec §2.2 fixes the crop as static per shot, so this has to answer "where
 * was this face during this shot" with a single number — and the answer has
 * to be representative of the whole shot, not of whichever frame happened to
 * be looked at first.
 *
 * `duration` and `requested` (the shot's length and its requested sample
 * count) exist only to convert each surviving entry's original sample index
 * into a shot-relative timestamp for `track` below — see sample_time for why
 * it is the REQUESTED count, not len(frames), that the conversion divides by.
 */
export function summarise_faces(frames, duration, requested) {
  if (!frames.length) return [];

  // The roster is every DISTINCT face tracked across the shot, not the faces
  // of whichever single frame saw the most.
  //
  // It was the latter until 2026-08-24, and the difference only shows on a
  // shot that spans a camera change — which is supposed to be impossible,
  // since a cut ends a shot, but is not: `shotsFrom` discards a cut that
  // falls within RENDER_MIN_SHOT_SEC of the shot start, so a clip whose
  // first 0.2s are the tail of the previous angle renders as one shot across
  // two. Measured on clip 1197a55c, found by a human watching it: the
  // close-up occupied 1 of the 12 sampled frames and the wide two-shot the
  // other 11, the roster was seeded from the close-up's frame, and the wide
  // shot's speaker — detectable at 0.935 confidence in every one of his 11
  // frames — was never a candidate at all. The whole 2.5 seconds was framed
  // on where the close-up face had been, which for 2.3 of them is a desk.
  //
  // Seeding repeatedly from whatever is still unclaimed costs nothing on the
  // ordinary case (one pass, same answer) and is the only way a face that
  // never shares a frame with the roster's own can be seen.
  //
  // `remaining` is a shallow copy per frame because each track removes the
  // boxes it claims, which keeps the tracks disjoint: _track_face matches
  // greedily and would otherwise re-follow a face another track already owns
  // and report it twice. A frame emptied this way is simply skipped —
  // match_box_for_point returns None for an empty box list.
  const remaining = frames.map((f) => ({ index: f.index, boxes: [...f.boxes] }));
  const position = new Map(remaining.map((f, i) => [f.index, i]));

  let faces = [];
  for (;;) {
    const seedable = [];
    remaining.forEach((f, i) => {
      if (f.boxes.length) seedable.push(i);
    });
    if (!seedable.length) break;
    // Same rule as before, over what is left: the frame seeing the most
    // unclaimed faces goes first, ties to the earliest.
    let representative_index = seedable[0];
    for (const i of seedable) if (remaining[i].boxes.length > remaining[representative_index].boxes.length) representative_index = i;
    const seed = remaining[representative_index].boxes[0];

    const [entries, drops] = _track_face(remaining, representative_index, seed);
    for (const entry of entries) {
      const boxes = remaining[position.get(entry.index)].boxes;
      const j = boxes.indexOf(entry.box);
      if (j !== -1) boxes.splice(j, 1);
    }

    const boxes = entries.map((entry) => entry.box);
    const face = _median_box(boxes.length ? boxes : [seed]);

    // Variance of the mouth's drop below the eye line across the shot's
    // samples. Two readings are the minimum that can vary at all.
    //
    // This replaces the face mesh's openness reading, which returns zero
    // faces on a strict profile — measured, in both production tile
    // windows, on a frame where detection scored 0.826. mouthMotion was
    // therefore structurally zero for any profile face, so active-speaker
    // selection was blind precisely when two people turn toward each
    // other, which is the interview case it exists for.
    if (drops.length < 2) {
      face.mouthMotion = 0.0;
    } else {
      const mean = sum(drops) / drops.length;
      face.mouthMotion = sum(drops.map((value) => (value - mean) ** 2)) / drops.length;
    }

    // The per-sample path spec §5.2 smooths. Centres rather than boxes:
    // the smoother only ever needs a position, and faceCentreX is the
    // keypoint cluster where present — the value §4.2b established the
    // crop must follow, not the head-box centre.
    //
    // Every cx in one shot must be in the SAME space, which a per-sample
    // `.get("faceCentreX", box centre)` did not guarantee: a sample whose
    // own detection carried no keypoints reported a box centre while its
    // neighbours reported a face cluster, and the two sit ~180px apart on
    // a strict profile. Nothing downstream can see the switch — crop.ts
    // derives its face-to-box offset ONCE, from the summarised face
    // (populated whenever ANY sample had keypoints) — so it shifts that
    // sample's pan target and its containment box together, in the same
    // direction, and no clamp catches it. Measured on §4.2b's own numbers
    // (head box 1027-1338, face cluster at 1000, 1920x810, 456px window,
    // 91.2px dead zone), a subject who does not move at all: 882 -> 1065
    // -> 882, a 183px there-and-back pan aimed at the back of the head,
    // twice the dead zone, and a `crop` placement turned into a `track`
    // one — which breaks the byte-identical guarantee on precisely the
    // still shots that guarantee exists to protect.
    //
    // This is the same hazard `eyeLineY` is frozen per shot to avoid
    // (crop.ts's cropPosition), and `cx` was the sibling left free to
    // toggle. The shot's own face-to-box offset carries a keypointless
    // sample back into face-cluster space; it is 0 when NO sample had
    // keypoints, where every cx is already a box centre and stays one.
    const offset = has(face, 'faceCentreX') ? face.x + face.width / 2.0 - face.faceCentreX : 0.0;
    face.track = entries.map((e) => ({
      t: sample_time(e.index, requested, duration),
      cx: has(e.box, 'faceCentreX') ? e.box.faceCentreX : e.box.x + e.box.width / 2.0 - offset,
      cy: e.box.y + e.box.height / 2.0,
    }));

    // How much of this shot this face was actually present for, 0..1.
    //
    // Distinct from MIN_COVERAGE_RATIO below, which is RELATIVE to the
    // best-covered face and therefore reads full marks for the leader
    // however sparse the leader is. That is correct for choosing between
    // faces and structurally unable to reject a shot in which every
    // candidate is bad — measured, a jungle-terrain detection present in
    // 1 of 42 sampled frames framed a 21-second shot, and a pair present
    // in 1 of 12 framed another. crop.ts's planLayout reads this absolute
    // value and sends such a shot to `fit` instead.
    //
    // `requested` rather than len(frames) is the denominator: extraction
    // can return fewer frames than were asked for, and a face found in
    // every frame that arrived is not the same as a face present
    // throughout. Computed here because `requested` exists only on this
    // side of the seam.
    face.coverage = requested > 0 ? Math.min(1.0, entries.length / requested) : 0.0;

    faces.push(face);
  }

  // A face glimpsed in a small fraction of the shot is not this shot's
  // subject, and must not be able to win downstream on size. That is exactly
  // how the 1197a55c crop landed on a desk: chooseSpeaker's fallback picks
  // the LARGEST face whenever nobody clears RENDER_MOTION_FLOOR, and a
  // close-up head glimpsed once is four times the area of the real speaker
  // sitting further from the camera. Widening the roster above puts the real
  // speaker in the running; this is what stops the glimpse beating him.
  //
  // Relative to the best-covered face rather than an absolute count, which
  // is what keeps it from ever emptying the roster: the leader always
  // survives its own threshold, so a shot where every face is fleeting — a
  // busy cutaway, a crowd — keeps all of them and still crops rather than
  // falling through to a blind fit. Sparse is only a reason to prefer
  // someone else when there IS someone else.
  //
  // 0.25 sits in a measured gap, not at a guessed value: across the 46 real
  // shots of the ten-clip reference set, the median chosen face appears in
  // 100% of its shot's sampled frames and exactly one face anywhere in the
  // set falls below 25% — the 8% glimpse this rule exists to reject. No
  // real shot sits near the threshold.
  if (faces.length) {
    const best = Math.max(...faces.map((face) => face.track.length));
    faces = faces.filter((f) => f.track.length >= best * MIN_COVERAGE_RATIO);
  }

  return faces;
}

/** numpy's `frame[:, left:right]` (then ascontiguousarray): out-of-range bounds clamp, negative ones count back. */
function slice_columns(frame, left, right) {
  const norm = (i) => (i < 0 ? Math.max(0, i + frame.width) : Math.min(i, frame.width));
  const a = norm(left);
  const width = Math.max(0, norm(right) - a);
  const data = new Uint8Array(width * frame.height * 3);
  for (let y = 0; y < frame.height; y++) {
    const from = (y * frame.width + a) * 3;
    data.set(frame.data.subarray(from, from + width * 3), y * width * 3);
  }
  return { width, height: frame.height, data };
}

/**
 * One window of one frame: its qualifying boxes.
 *
 * `found` holds **window-local** boxes, exactly as MediaPipe reports them;
 * the caller maps them to absolute frame units via boxes_from_windows.
 *
 * `found` is returned unconditionally, including empty. The caller appends
 * it to per_window for every window, and boxes_from_windows enforces that
 * the two lists have equal length — an "optimisation" that skipped empty
 * windows would silently attribute every later box to the wrong offset.
 */
export async function _process_window(frame, x0, win, scale, detector, min_confidence) {
  const left = py_round(x0 * scale);
  const right = py_round((x0 + win) * scale);
  const window_image = slice_columns(frame, left, right);

  const found = [];
  const detected = await detector.process(window_image);
  for (const detection of detected.detections || []) {
    const score = detection.score[0];
    // Re-checked rather than trusted to the constructor argument:
    // MediaPipe returned detections scoring 0.609, 0.602 and 0.619 from a
    // detector built with min_detection_confidence=0.8. This explicit
    // check is the only thing that makes the documented threshold real.
    if (score < min_confidence) continue;
    const box = detection.location_data.relative_bounding_box;
    const entry = { x: box.xmin, y: box.ymin, width: box.width, height: box.height, confidence: score };
    const geometry = face_geometry(detection.location_data.relative_keypoints, entry);
    if (geometry !== null) Object.assign(entry, geometry);
    found.push(entry);
  }

  return found;
}

/**
 * Returns the faces in this shot, each with a mouth-motion score.
 *
 * (Port: `deps.shot_frames(video, start, end, width, height, count)` is the frame source, an async iterable of
 * `[index, frame]`.)
 */
export async function analyse_shot(video, detector, start, end, min_confidence, width, height, max_aspect, overlap, track_sample_hz, deps) {
  const duration = Math.max(end - start, 1e-3);
  const requested = sample_count(duration, track_sample_hz);
  const indexed = []; // (original sample index, this frame's qualifying boxes)
  const windows = tile_windows(width, height, max_aspect, overlap);

  for await (const [index, frame] of deps.shot_frames(video, start, end, width, height, requested)) {
    const scale = frame.width / width; // detection runs on a downscaled copy
    const per_window = [];

    for (const [x0, win] of windows) {
      const found = await _process_window(frame, x0, win, scale, detector, min_confidence);
      // Unconditional — one entry per window, every window, even when
      // `found` is empty. See _process_window's own docstring.
      per_window.push(found);
    }

    const frame_boxes = boxes_from_windows(per_window, windows, width, MERGE_IOU);
    indexed.push([index, frame_boxes]);
  }

  const frames = _frames_with_boxes(indexed);
  return summarise_faces(frames, duration, requested);
}

/**
 * main(), as a function: the faces of every shot of `video`, with the frame's true size.
 *
 * (Port: argv becomes arguments. Python's defaults for the tunables are dead code from faces.ts, which always
 * passes them; the caller passes them here too. Shots are `{ startSec, endSec }`, as faces.ts's JSON carries them.
 * Returns `{ frameWidth, frameHeight, shots: [{ shotIndex, faces }] }`, the object main() prints and
 * parseFaceOutput reads.)
 */
export async function detect_faces({ exec, timeoutMs, dir }, { video, shots, detector, min_confidence, tile_max_aspect, tile_overlap, track_sample_hz }) {
  const [width, height] = await probe_dimensions({ exec, timeoutMs }, video);

  const results = [];
  const shot_frames_with = (...args) => shot_frames({ exec, timeoutMs, dir }, ...args);
  for (const [index, shot] of shots.entries()) {
    const faces = await analyse_shot(
      video,
      detector,
      Number(shot.startSec),
      Number(shot.endSec),
      min_confidence,
      width,
      height,
      tile_max_aspect,
      tile_overlap,
      track_sample_hz,
      { shot_frames: shot_frames_with },
    );
    results.push({ shotIndex: index, faces });
  }

  return { frameWidth: width, frameHeight: height, shots: results };
}
