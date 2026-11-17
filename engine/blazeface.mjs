// BlazeFace short-range through onnxruntime-node: the face detector hosted boqo runs through Python mediapipe
// (`mp.solutions.face_detection.FaceDetection(model_selection=0)`, mediapipe 0.10.18, the Dockerfile's pin), rebuilt
// here step for step so the skill needs no Python and no GPU.
//
// The weights are mediapipe's own: engine/models/blazeface-short.onnx is the wheel's
// `mediapipe/modules/face_detection/face_detection_short_range.tflite` converted to ONNX (engine/models/SOURCE.md has
// the commands, the versions and both checksums). The steps around the model are mediapipe's FaceDetection subgraph,
// read out of 0.10.18 itself: the CalculatorGraphConfig protos embedded in
// `mediapipe/python/_framework_bindings.cpython-311-x86_64-linux-gnu.so` (types `FaceDetectionShortRange` and
// `FaceDetection`), decoded with the wheel's own calculator_pb2 on 2026-11-16. Each step below names the calculator
// it reproduces:
//   1. ImageToTensorCalculator   the whole image, padded to a square around its centre (keep_aspect_ratio), sampled
//                                to 128x128 by OpenCV's warpPerspective (INTER_LINEAR, BORDER_ZERO), scaled to [-1, 1];
//   2. InferenceCalculator       the model (here onnxruntime-node, CPU);
//   3. SsdAnchorsCalculator      896 fixed-size anchors: strides 8, 16, 16, 16, offset 0.5, two per cell;
//   4. TensorsToDetectionsCalculator  boxes and six keypoints decoded against the anchors (reverse_output_order:
//                                x before y), scores clipped to +-100 and sigmoided, a score floor;
//   5. NonMaxSuppressionCalculator    WEIGHTED, IoU over 0.3: each kept box and its keypoints are the score-weighted
//                                mean of every box overlapping it, the score is the leader's;
//   6. DetectionProjectionCalculator  back from the padded square to the image, normalised 0..1.
// mediapipe does this arithmetic in float32, so it is done in float32 here too (Math.fround), and OpenCV's
// fixed-point bilinear sampling (1/32 pixel positions, 15-bit weights) is reproduced rather than approximated.
// The options above were read out of the wheel; the calculators' arithmetic follows their C++ sources in mediapipe
// and OpenCV, which the wheel does not ship. That it matches is measured, not assumed: on 92 frames every detection
// agrees with mediapipe 0.10.18's to float32 rounding (engine/models/SOURCE.md, "Parity with mediapipe").
//
// The ONNX runtime and the model load through `loadBlazeFace`, which throws when either cannot: a missing native
// binary (Windows without the VC++ runtime, an unsupported arch), a missing model, a checksum that does not match.
// engine/faces.mjs turns that into `{ unavailable: true, reason }`, never a failed render.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const f = Math.fround;

/** The model file, beside this module (engine/ is copied whole into boqo-channel and boqo-sniper). */
export const MODEL_FILE = fileURLToPath(new URL('./models/blazeface-short.onnx', import.meta.url));

/** engine/models/SOURCE.md's sha256 of blazeface-short.onnx, checked at every load. */
export const MODEL_SHA256 = '4d8398bc2b606f112f97eb697dddb5f331a6f81098d506132afe9631623b92aa';

/**
 * The FaceDetectionShortRange options and the FaceDetection subgraph's calculator options, as mediapipe 0.10.18
 * builds them (see the header for where they were read). `minScoreThresh` is the one the Python solution overrides
 * with `min_detection_confidence`; see SCORE_FLOOR.
 */
export const OPTIONS = Object.freeze({
  tensorWidth: 128,
  tensorHeight: 128,
  // SsdAnchorsCalculator
  numLayers: 4,
  strides: Object.freeze([8, 16, 16, 16]),
  minScale: 0.1484375,
  maxScale: 0.75,
  anchorOffsetX: 0.5,
  anchorOffsetY: 0.5,
  aspectRatios: Object.freeze([1]),
  interpolatedScaleAspectRatio: 1,
  fixedAnchorSize: true,
  // TensorsToDetectionsCalculator
  numBoxes: 896,
  numCoords: 16,
  boxCoordOffset: 0,
  keypointCoordOffset: 4,
  numKeypoints: 6,
  numValuesPerKeypoint: 2,
  xScale: 128,
  yScale: 128,
  wScale: 128,
  hScale: 128,
  scoreClippingThresh: 100,
  // NonMaxSuppressionCalculator
  minSuppressionThreshold: 0.3,
});

/**
 * The score floor TensorsToDetectionsCalculator applies before the weighted NMS: FaceDetectionShortRange's own 0.5,
 * NOT the solution's `min_detection_confidence`. mp.solutions.face_detection passes that as `graph_options`, and it
 * does not reach the calculator. Measured 2026-11-16 on 92 local frames with min_detection_confidence=0.8:
 * mediapipe 0.10.18 returned 41 detections, 13 of them scoring 0.50-0.80, and its boxes match a 0.5 floor here to
 * float32 rounding, where a 0.8 floor drops those 13 and moves others by up to 0.017 (a weaker overlapping box no
 * longer averaged in). It is detect_faces.py's own `score < min_confidence` re-check, after the NMS, that applies
 * 0.8, which is why its comment records detections scoring 0.6 from a detector built with 0.8.
 */
export const SCORE_FLOOR = 0.5;

/**
 * SsdAnchorsCalculator::GenerateAnchors for these options. With fixed_anchor_size every anchor is 1x1, so only the
 * centres matter: per layer, per cell (row-major), one anchor per aspect ratio plus the interpolated one; layers with
 * the same stride are merged into one grid, which is how 4 layers give 16*16*2 + 8*8*6 = 896.
 * @returns {{ x: number, y: number }[]}
 */
export function ssdAnchors(o = OPTIONS) {
  const anchors = [];
  let layer = 0;
  while (layer < o.numLayers) {
    let perCell = 0;
    let last = layer;
    while (last < o.strides.length && o.strides[last] === o.strides[layer]) {
      perCell += o.aspectRatios.length + (o.interpolatedScaleAspectRatio > 0 ? 1 : 0);
      last++;
    }
    const stride = o.strides[layer];
    const rows = Math.ceil(o.tensorHeight / stride);
    const cols = Math.ceil(o.tensorWidth / stride);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        for (let k = 0; k < perCell; k++) {
          anchors.push({ x: f(f(x + o.anchorOffsetX) / cols), y: f(f(y + o.anchorOffsetY) / rows) });
        }
      }
    }
    layer = last;
  }
  return anchors;
}

const ANCHORS = ssdAnchors();

/**
 * ImageToTensorCalculator's region: the whole image (GetRoi without a NORM_RECT), grown to the tensor's aspect
 * around its centre (PadRoi with keep_aspect_ratio). In pixels, float32.
 */
export function letterboxRoi(width, height, o = OPTIONS) {
  const cx = f(0.5 * width);
  const cy = f(0.5 * height);
  const w = f(width);
  const h = f(height);
  const tensorAspect = f(o.tensorHeight / o.tensorWidth);
  const roiAspect = f(h / w);
  if (tensorAspect > roiAspect) return { cx, cy, width: w, height: f(w * tensorAspect) };
  return { cx, cy, width: f(h / tensorAspect), height: h };
}

/** cvRound / saturate_cast<int> on a double: round half to even (cvtsd2si in the default rounding mode). */
function cvRound(v) {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * cv::getPerspectiveTransform: the 8x8 system solved by OpenCV's LUImpl (Gaussian elimination, partial pivoting,
 * back substitution dividing by the pivot), in double, with the `-src * dst` products formed in float as OpenCV's
 * Point2f arithmetic forms them. Returns the 3x3 matrix row-major.
 *
 * Reproduced rather than written as the exact scale-and-offset it stands for, because the residue matters: the
 * sampling below rounds to 1/32 pixel, and on a frame size where the exact position lands on a half step (962x541,
 * 854x480, 333x517: about one source column or row in two) the solver's last-bit error decides which way it rounds.
 * Measured 2026-11-16 against mediapipe 0.10.18 on 92 local frames (the synthetic face and a public-domain photo,
 * resized into 10 frame sizes): the exact scale-and-offset map left 11 of 41 detections up to 9.3e-4 off
 * mediapipe's; this one matches all 41 to float32 rounding (3.6e-7). The matrices were checked bit for bit against
 * the cv2 4.11 that mediapipe 0.10.18 installs (tests/golden/blazeface-cv-matrices.json).
 */
export function getPerspectiveTransform(src, dst) {
  const a = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  for (let i = 0; i < 4; i++) {
    a[i][0] = a[i + 4][3] = src[i][0];
    a[i][1] = a[i + 4][4] = src[i][1];
    a[i][2] = a[i + 4][5] = 1;
    a[i][6] = -f(src[i][0] * dst[i][0]);
    a[i][7] = -f(src[i][1] * dst[i][0]);
    a[i + 4][6] = -f(src[i][0] * dst[i][1]);
    a[i + 4][7] = -f(src[i][1] * dst[i][1]);
    b[i] = dst[i][0];
    b[i + 4] = dst[i][1];
  }
  for (let i = 0; i < 8; i++) {
    let k = i;
    for (let j = i + 1; j < 8; j++) if (Math.abs(a[j][i]) > Math.abs(a[k][i])) k = j;
    if (k !== i) {
      for (let j = i; j < 8; j++) [a[i][j], a[k][j]] = [a[k][j], a[i][j]];
      [b[i], b[k]] = [b[k], b[i]];
    }
    const d = -1 / a[i][i];
    for (let j = i + 1; j < 8; j++) {
      const alpha = a[j][i] * d;
      for (let q = i + 1; q < 8; q++) a[j][q] += alpha * a[i][q];
      b[j] += alpha * b[i];
    }
  }
  for (let i = 7; i >= 0; i--) {
    let s = b[i];
    for (let q = i + 1; q < 8; q++) s -= a[i][q] * b[q];
    b[i] = s / a[i][i];
  }
  return [...b, 1];
}

/** cv::invert of a 3x3 double matrix (DECOMP_LU, which OpenCV answers by the adjugate over the determinant). */
export function invert3(M) {
  const m = (r, c) => M[r * 3 + c];
  const det =
    m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) -
    m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0)) +
    m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0));
  const d = 1 / det;
  return [
    (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) * d,
    (m(0, 2) * m(2, 1) - m(0, 1) * m(2, 2)) * d,
    (m(0, 1) * m(1, 2) - m(0, 2) * m(1, 1)) * d,
    (m(1, 2) * m(2, 0) - m(1, 0) * m(2, 2)) * d,
    (m(0, 0) * m(2, 2) - m(0, 2) * m(2, 0)) * d,
    (m(0, 2) * m(1, 0) - m(0, 0) * m(1, 2)) * d,
    (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0)) * d,
    (m(0, 1) * m(2, 0) - m(0, 0) * m(2, 1)) * d,
    (m(0, 0) * m(1, 1) - m(0, 1) * m(1, 0)) * d,
  ];
}

/**
 * cv::RotatedRect::points of the padded region at angle 0 (b = cos(0) * 0.5, a = 0), float32: bottom-left,
 * top-left, top-right, bottom-right, the order the tensor's corners (0,128) (0,0) (128,0) (128,128) are listed in.
 */
export function sourceQuad(roi) {
  const hw = f(0.5 * roi.width);
  const hh = f(0.5 * roi.height);
  const p0 = [f(roi.cx - hw), f(roi.cy + hh)];
  const p1 = [f(roi.cx - hw), f(roi.cy - hh)];
  return [p0, p1, [f(f(2 * roi.cx) - p0[0]), f(f(2 * roi.cy) - p0[1])], [f(f(2 * roi.cx) - p1[0]), f(f(2 * roi.cy) - p1[1])]];
}

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;

/**
 * The model's input for one RGB24 image: ImageToTensorCalculator's OpenCV path (image_to_tensor_converter_opencv).
 *   - The source quad is cv::RotatedRect::points of the padded region (float32), the destination the tensor's
 *     corners (0,128) (0,0) (128,0) (128,128): no half-pixel shift, so tensor pixel x samples the source near
 *     left + x * side / 128.
 *   - cv::warpPerspective, INTER_LINEAR, BORDER_CONSTANT 0: per 64x16 block, X0 = M0*bx + M1*y + M2 and per pixel
 *     (X0 + M0*x1) * (32 / W), rounded half to even to 1/32 pixel; bilinear with the integer weights OpenCV's
 *     table holds (they sum to 32768) and a rounding 15-bit shift; a neighbour outside the image reads 0.
 *   - convertTo float: p * (2/255) - 1 in float32.
 * @param {{ width: number, height: number, data: Uint8Array }} image packed RGB24, rows top to bottom
 * @returns {{ tensor: Float32Array, roi: { cx: number, cy: number, width: number, height: number } }}
 */
export function imageToTensor(image, o = OPTIONS) {
  const { width, height, data } = image;
  const roi = letterboxRoi(width, height, o);
  const tw = o.tensorWidth;
  const th = o.tensorHeight;
  const M = invert3(getPerspectiveTransform(sourceQuad(roi), [[0, th], [0, 0], [tw, 0], [tw, th]]));

  // WarpPerspectiveInvoker's blocks: BLOCK_SZ 32, so 64 columns by 16 rows for a 128x128 tensor.
  let bh0 = Math.min(16, th);
  const bw0 = Math.min(Math.trunc(1024 / bh0), tw);
  bh0 = Math.min(Math.trunc(1024 / bw0), th);

  const scale = f(2 / 255);
  const tensor = new Float32Array(tw * th * 3);
  const stride = width * 3;
  const px = (ix, iy, c) => (ix >= 0 && ix < width && iy >= 0 && iy < height ? data[iy * stride + ix * 3 + c] : 0);
  for (let y = 0; y < th; y++) {
    for (let bx = 0; bx < tw; bx += bw0) {
      const X0 = M[0] * bx + M[1] * y + M[2];
      const Y0 = M[3] * bx + M[4] * y + M[5];
      const W0 = M[6] * bx + M[7] * y + M[8];
      for (let x1 = 0; x1 < Math.min(bw0, tw - bx); x1++) {
        let W = W0 + M[6] * x1;
        W = W ? 32 / W : 0;
        const X = cvRound(Math.max(INT_MIN, Math.min(INT_MAX, (X0 + M[0] * x1) * W)));
        const Y = cvRound(Math.max(INT_MIN, Math.min(INT_MAX, (Y0 + M[3] * x1) * W)));
        const ix = X >> 5;
        const iy = Y >> 5;
        const ax = X & 31;
        const ay = Y & 31;
        const w00 = (32 - ax) * (32 - ay) * 32;
        const w01 = ax * (32 - ay) * 32;
        const w10 = (32 - ax) * ay * 32;
        const w11 = ax * ay * 32;
        const out = (y * tw + bx + x1) * 3;
        for (let c = 0; c < 3; c++) {
          const v = px(ix, iy, c) * w00 + px(ix + 1, iy, c) * w01 + px(ix, iy + 1, c) * w10 + px(ix + 1, iy + 1, c) * w11;
          tensor[out + c] = f(f(Math.min(255, (v + 16384) >> 15) * scale) - 1);
        }
      }
    }
  }
  return { tensor, roi };
}

const sigmoid = (s) => f(1 / f(1 + f(Math.exp(-s))));

/**
 * TensorsToDetectionsCalculator: the 896 raw boxes decoded against the anchors, in the padded square's normalised
 * units. A score under `scoreFloor` is skipped, and so is a box whose decoded width or height is negative or NaN.
 * @returns {{ score: number, xmin: number, ymin: number, width: number, height: number, keypoints: { x: number, y: number }[] }[]}
 */
export function decodeDetections(regressors, classificators, scoreFloor, o = OPTIONS) {
  const out = [];
  const floor = f(scoreFloor);
  const clip = o.scoreClippingThresh;
  for (let i = 0; i < o.numBoxes; i++) {
    let s = classificators[i];
    s = s < -clip ? -clip : s > clip ? clip : s;
    const score = sigmoid(s);
    if (score < floor) continue;
    const a = ANCHORS[i];
    const off = i * o.numCoords + o.boxCoordOffset;
    // reverse_output_order: x_center, y_center, w, h.
    const xc = f(f(f(regressors[off] / o.xScale) * 1) + a.x);
    const yc = f(f(f(regressors[off + 1] / o.yScale) * 1) + a.y);
    const w = f(f(regressors[off + 2] / o.wScale) * 1);
    const h = f(f(regressors[off + 3] / o.hScale) * 1);
    const ymin = f(yc - f(h / 2));
    const xmin = f(xc - f(w / 2));
    const ymax = f(yc + f(h / 2));
    const xmax = f(xc + f(w / 2));
    const width = f(xmax - xmin);
    const height = f(ymax - ymin);
    if (!(width >= 0) || !(height >= 0)) continue;
    const keypoints = [];
    for (let k = 0; k < o.numKeypoints; k++) {
      const ko = i * o.numCoords + o.keypointCoordOffset + k * o.numValuesPerKeypoint;
      keypoints.push({
        x: f(f(f(regressors[ko] / o.xScale) * 1) + a.x),
        y: f(f(f(regressors[ko + 1] / o.yScale) * 1) + a.y),
      });
    }
    out.push({ score, xmin, ymin, width, height, keypoints });
  }
  return out;
}

/** NonMaxSuppressionCalculator's OverlapSimilarity, INTERSECTION_OVER_UNION, in float32. */
function overlap(a, b) {
  const axmax = f(a.xmin + a.width);
  const aymax = f(a.ymin + a.height);
  const bxmax = f(b.xmin + b.width);
  const bymax = f(b.ymin + b.height);
  const empty = (r, xmax, ymax) => r.xmin > xmax || r.ymin > ymax;
  if (empty(a, axmax, aymax) || empty(b, bxmax, bymax) || bxmax < a.xmin || axmax < b.xmin || bymax < a.ymin || aymax < b.ymin) return 0;
  const iw = f(Math.min(axmax, bxmax) - Math.max(a.xmin, b.xmin));
  const ih = f(Math.min(aymax, bymax) - Math.max(a.ymin, b.ymin));
  const inter = f(iw * ih);
  const norm = f(f(f(a.width * a.height) + f(b.width * b.height)) - inter);
  return norm > 0 ? f(inter / norm) : 0;
}

/**
 * NonMaxSuppressionCalculator, algorithm WEIGHTED: highest score first; every remaining box overlapping it by more
 * than `threshold` (itself included) is folded into one detection whose box corners and keypoints are the
 * score-weighted means and whose score is the leader's; repeat on what is left.
 */
export function weightedNms(detections, threshold = OPTIONS.minSuppressionThreshold) {
  let remaining = detections.map((d, i) => ({ d, i })).sort((p, q) => q.d.score - p.d.score || p.i - q.i);
  const out = [];
  const t = f(threshold);
  while (remaining.length) {
    const lead = remaining[0].d;
    const candidates = [];
    const rest = [];
    for (const r of remaining) (overlap(r.d, lead) > t ? candidates : rest).push(r);
    let total = 0;
    let xmin = 0;
    let ymin = 0;
    let xmax = 0;
    let ymax = 0;
    const kps = lead.keypoints.map(() => ({ x: 0, y: 0 }));
    for (const { d } of candidates) {
      total = f(total + d.score);
      xmin = f(xmin + f(d.xmin * d.score));
      ymin = f(ymin + f(d.ymin * d.score));
      xmax = f(xmax + f(f(d.xmin + d.width) * d.score));
      ymax = f(ymax + f(f(d.ymin + d.height) * d.score));
      d.keypoints.forEach((k, j) => {
        kps[j].x = f(kps[j].x + f(k.x * d.score));
        kps[j].y = f(kps[j].y + f(k.y * d.score));
      });
    }
    const wxmin = f(xmin / total);
    const wymin = f(ymin / total);
    out.push({
      score: lead.score,
      xmin: wxmin,
      ymin: wymin,
      width: f(f(xmax / total) - wxmin),
      height: f(f(ymax / total) - wymin),
      keypoints: kps.map((k) => ({ x: f(k.x / total), y: f(k.y / total) })),
    });
    if (rest.length === remaining.length) break;
    remaining = rest;
  }
  return out;
}

/**
 * DetectionProjectionCalculator with ImageToTensorCalculator's matrix (GetRotatedSubRectToRectTransformMatrix at
 * rotation 0): normalised padded-square units to normalised image units. A box is projected corner by corner and
 * re-boxed, which at rotation 0 is the same box.
 */
export function projectDetections(detections, roi, width, height) {
  const g = f(1 / width);
  const h = f(1 / height);
  const m0 = f(roi.width * g);
  const m3 = f(f(f(-0.5 * roi.width) + roi.cx) * g);
  const m5 = f(roi.height * h);
  const m7 = f(f(f(-0.5 * roi.height) + roi.cy) * h);
  const px = (x) => f(f(x * m0) + m3);
  const py = (y) => f(f(y * m5) + m7);
  return detections.map((d) => {
    const x0 = px(d.xmin);
    const x1 = px(f(d.xmin + d.width));
    const y0 = py(d.ymin);
    const y1 = py(f(d.ymin + d.height));
    const xmin = Math.min(x0, x1);
    const ymin = Math.min(y0, y1);
    return {
      score: d.score,
      xmin,
      ymin,
      width: f(Math.max(x0, x1) - xmin),
      height: f(Math.max(y0, y1) - ymin),
      keypoints: d.keypoints.map((k) => ({ x: px(k.x), y: py(k.y) })),
    };
  });
}

/**
 * The detections for one image from the model's two outputs, shaped as the mediapipe solution returns them
 * (`detection.score[0]`, `location_data.relative_bounding_box`, `location_data.relative_keypoints`), so
 * engine/boqo/detect-faces.mjs reads them exactly as detect_faces.py does.
 */
export function detectionsFromOutputs({ regressors, classificators, roi, width, height, scoreFloor = SCORE_FLOOR }) {
  const decoded = decodeDetections(regressors, classificators, scoreFloor);
  return projectDetections(weightedNms(decoded), roi, width, height).map((d) => ({
    score: [d.score],
    location_data: {
      relative_bounding_box: { xmin: d.xmin, ymin: d.ymin, width: d.width, height: d.height },
      relative_keypoints: d.keypoints,
    },
  }));
}

/** The default `load`: onnxruntime-node's module, whichever way Node's ESM/CJS interop hands it over. */
export async function loadOnnxRuntime() {
  const mod = await import('onnxruntime-node');
  return mod.InferenceSession ? mod : mod.default;
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0].trim();

/**
 * What `loadBlazeFace` throws: a one-line message, and a `code` of this module's own that callers (tools/doctor's
 * hints) classify on, never onnxruntime's wording:
 *   ORT_NOT_INSTALLED  the onnxruntime-node package is not there (the skill's packages were never installed);
 *   ORT_LOAD           the package is there but its native binary does not load (no VC++ runtime, another arch);
 *   ORT_SESSION        the runtime loads but cannot open the model;
 *   ORT_RUN            the session opens but cannot run a blank image;
 *   MODEL_MISSING      the model file cannot be read;
 *   MODEL_CHECKSUM     the model file is not the one SOURCE.md records.
 */
export class FaceModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FaceModelError';
    this.code = code;
  }
}

/**
 * Loads onnxruntime-node and the model, checks the model's sha256, and runs one blank image through it so a
 * native binary that loads but cannot run fails here rather than mid-render. Throws a FaceModelError whose message
 * is the one-line cause; `load` is injectable for tests.
 *
 * Returns `{ process(image) -> Promise<{ detections }>, release() }`. `image` is `{ width, height, data }`, packed
 * RGB24. The model is passed to onnxruntime as bytes, never as a path, so a home directory with spaces or
 * non-ASCII characters cannot break it.
 * @param {{ load?: () => Promise<any>, modelFile?: string, sha256?: string, scoreFloor?: number }} [o]
 */
export async function loadBlazeFace({ load = loadOnnxRuntime, modelFile = MODEL_FILE, sha256 = MODEL_SHA256, scoreFloor = SCORE_FLOOR } = {}) {
  let bytes;
  try {
    bytes = await readFile(modelFile);
  } catch (e) {
    throw new FaceModelError('MODEL_MISSING', `the face model is missing (${modelFile}): ${firstLine(e)}`);
  }
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) {
    throw new FaceModelError('MODEL_CHECKSUM', `the face model's checksum does not match (${modelFile}: ${got}, expected ${sha256})`);
  }

  let ort;
  try {
    ort = await load();
    if (!ort?.InferenceSession || !ort?.Tensor) throw new Error('the module has no InferenceSession');
  } catch (e) {
    // ERR_MODULE_NOT_FOUND is Node's code for an import specifier that does not resolve: the package itself is
    // absent. A missing native binary inside a present package is a CommonJS require failing (MODULE_NOT_FOUND).
    if (e?.code === 'ERR_MODULE_NOT_FOUND') throw new FaceModelError('ORT_NOT_INSTALLED', 'onnxruntime-node is not installed');
    throw new FaceModelError('ORT_LOAD', `onnxruntime-node did not load: ${firstLine(e)}`);
  }

  let session;
  try {
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'] });
  } catch (e) {
    throw new FaceModelError('ORT_SESSION', `onnxruntime-node could not open the face model: ${firstLine(e)}`);
  }
  const input = session.inputNames[0];
  const o = OPTIONS;

  const process = async (image) => {
    const { tensor, roi } = imageToTensor(image);
    const out = await session.run({ [input]: new ort.Tensor('float32', tensor, [1, o.tensorHeight, o.tensorWidth, 3]) });
    return {
      detections: detectionsFromOutputs({
        regressors: out.regressors.data,
        classificators: out.classificators.data,
        roi,
        width: image.width,
        height: image.height,
        scoreFloor,
      }),
    };
  };

  try {
    await process({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 3) });
  } catch (e) {
    throw new FaceModelError('ORT_RUN', `onnxruntime-node could not run the face model: ${firstLine(e)}`);
  }

  return {
    process,
    release: async () => {
      await session.release?.();
    },
  };
}
