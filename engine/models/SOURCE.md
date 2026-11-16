# engine/models

## blazeface-short.onnx

BlazeFace short-range: the face detector hosted boqo runs through Python mediapipe
(`mp.solutions.face_detection.FaceDetection(model_selection=0)` in `apps/worker/python/detect_faces.py`), with
mediapipe's own weights, converted from TensorFlow Lite to ONNX so `onnxruntime-node` can run it.
`engine/blazeface.mjs` loads it and rebuilds the steps mediapipe runs around it.

| | |
|---|---|
| ONNX sha256 | `4d8398bc2b606f112f97eb697dddb5f331a6f81098d506132afe9631623b92aa` (checked at every load: `MODEL_SHA256` in `engine/blazeface.mjs`) |
| ONNX size | 418,469 bytes |
| Input | `input`, float32 `[1, 128, 128, 3]` (NHWC, RGB, values in [-1, 1]) |
| Outputs | `regressors` float32 `[1, 896, 16]`, `classificators` float32 `[1, 896, 1]` (raw logits) |
| Operators | Add, Concat, Conv, MaxPool, Pad, Relu, Reshape, Transpose; opset 13; weights float32 |

### Origin

- Package: mediapipe 0.10.18 on PyPI (the version `apps/worker/Dockerfile` pins), wheel
  `mediapipe-0.10.18-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`, sha256
  `12db0f7b1cc18e2e3f604f6e95020b82c214c470d7d94ff32eeb8f8729a45ec3`.
- File in the wheel: `mediapipe/modules/face_detection/face_detection_short_range.tflite`, 229,714 bytes, sha256
  `bbff11cebd1eb27a1e004cae0b0e63ec8c551cbf34a4451148b4908b8db3eca8` (the wheel's RECORD lists the same digest,
  `u_8Rzr0esnoeAEyuCw5j7IxVHL80pEURSLSQi42z7Kg`).
- Authors: The MediaPipe Authors (https://github.com/google/mediapipe).

### Conversion (2026-11-16)

In a throwaway Python 3.11.14 venv (uv 0.10.0), never the parity venv `~/.boqo-mp`:

```sh
uv venv --python 3.11 conv
uv pip install --python conv/bin/python tf2onnx==1.16.1 tensorflow-cpu==2.15.1 onnx==1.16.2 onnxruntime==1.23.2 "numpy<2"
# resolved: numpy 1.26.4, protobuf 3.20.3
conv/bin/python -I -m tf2onnx.convert --tflite face_detection_short_range.tflite --output blazeface-short.onnx --opset 13
```

tf2onnx dequantises the TFLite file's float16 weights into float32 initialisers and folds the casts away (hence the
larger file). It does not write the same bytes twice: four conversions gave four sha256s, differing only in the
generated names of folded constants (`const_fold_opt__NNN`, `pad_const__NN`); their outputs were bitwise identical on
10 random inputs. The file here is the first conversion, the one every measurement below used.

Checked against the TFLite model itself (TensorFlow 2.15.1's interpreter, XNNPACK) on 5 random inputs: the largest
output difference was 5.8e-5 on outputs ranging to about +-140, float32 rounding. `onnx.checker` passes.

### Parity with mediapipe (2026-11-16, this box, onnxruntime-node 1.23.2)

`node scripts/parity/faces-compare.mjs --boqo "$PARITY" ...` against mediapipe 0.10.18 in `~/.boqo-mp`:

- Raw detector on 92 local frames (the synthetic face and a public-domain photo resized into 10 frame sizes,
  measured here and not committed): 41 of 41 detections matched, IoU >= 0.999997, coordinates within 3.6e-7,
  scores within 4.2e-7.
- detect_faces.py's per-frame path (tiling, the 0.8 re-check, merging) on the same frames: 46 of 46, IoU >= 0.999997.
- The synthetic set (`--synthetic`): 8 of 8 raw, 10 of 10 production. 24 lavfi test-pattern frames: no detection on
  either side.
- Whole videos (`--video`), detect_faces.py itself against `detectShotFaces` on two synthetic 8-second videos
  (1280x720 and 1920x816, a moving face then two faces), 4 shots each: same faces in every shot, median-box IoU
  >= 0.999998, identical coverage and track times, track centres within 1.2e-7.

### Score floor

mediapipe's FaceDetectionShortRange graph sets the pre-NMS score floor to 0.5. The Python solution passes
`min_detection_confidence` as `graph_options`, but in 0.10.18 it does not reach the calculator: with 0.8, mediapipe
still returned 13 detections scoring 0.50-0.80 of 41 on the frames above, and only a 0.5 floor here reproduces its
boxes. detect_faces.py's own `score < min_confidence` re-check applies 0.8, after the weighted NMS.
`SCORE_FLOOR` in `engine/blazeface.mjs` is therefore 0.5.

### Licence

Apache License, Version 2.0 (the mediapipe wheel's `LICENSE`; full text in `LICENSE-APACHE-2.0.txt` beside this
file).

    Copyright The MediaPipe Authors.

    Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance
    with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software distributed under the License is
    distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See
    the License for the specific language governing permissions and limitations under the License.

Modified: `blazeface-short.onnx` is a format conversion of `face_detection_short_range.tflite` (TFLite to ONNX,
float16 weights stored as float32), made by boqo on 2026-11-16 as described above. No weight was retrained or
changed in value.
