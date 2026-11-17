// ported from boqo-ai/boqo apps/worker/src/render/pipeline.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo apps/worker/src/render/config.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo packages/core/src/editor-sidecar.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
//
// The placement half of boqo's `planShots` (render/pipeline.ts): every shot of a clip placed through crop.mjs's
// `planLayout`, from the shots engine/shots.mjs found and the faces engine/faces.mjs detected. The detection half
// (extract, pauses, the cut window, scene detection, face detection) is the skill's own orchestration over the
// ported rules (engine/window.mjs, engine/shots.mjs, engine/faces.mjs); this file starts where pipeline.ts has
// `shots` and `detected` in hand.
//
// Cut from `planShots`, each to a constant or a parameter:
// - the extract, `replaceAudio` (Clean Voice), pauses, the cut window and `detectShots`: done before this is called;
// - `detectFaces`: its answer is the `faces` parameter. When it is `{ unavailable: true, reason }` (engine/faces.mjs:
//   onnxruntime-node or the model did not load, the detector failed, the disk refused the frames) every shot is
//   placed with no faces. A shot with a usable stream panels reading keeps its panels layout from the read, planned
//   with `faces: []` (what pipeline.ts passes for a shot the detector returned no entry for: a camera crop then
//   centres on the camera, `game` needs no face); every other shot is Fit. `notes` carries one line saying which;
// - `layoutOverrides` and `reconcileOverrides` (the clip editor's per-shot Layout choices): the skill has no editor,
//   so no shot has an override (`applied.get(index)` is always undefined) and nothing is orphaned;
// - `lookingRoom` (the editor's per-clip choice): always null, so LOOKING_ROOM (crop.mjs) applies;
// - `montage` and its layout intents (`intentsByShot`, `decideIntent`, `stackAllowed`, `keptPlacement`, `honours`):
//   the skill renders no montage (`montage: false`);
// - `layoutEnabledFromEnv` and the `!layoutEnabled` branch (`planCrop(common)` alone): RENDER_LAYOUT_ENABLED is unset
//   on the production worker (its render variables on 2026-11-16, as engine/boqo/scenes.mjs records them, were
//   RENDER_CONTEXT_LINE_ENABLED=0, RENDER_PANELS_MODE=all and RENDER_SHOT_TRANSITIONS_ENABLED=1), so layout modes
//   are on and that branch never runs;
// - `trackEnabledFromEnv`, `trackDeadzoneFromEnv`, `trackMaxPanFromEnv`, `minSubjectCoverageFromEnv` and
//   `minStackCopresenceFromEnv`: unset on the same worker, so each is its code default (TRACK_ENABLED below,
//   TRACK_DEADZONE and TRACK_MAX_PAN in crop.mjs, MIN_SUBJECT_COVERAGE and MIN_STACK_COPRESENCE below);
// - the stream panels callback (`input.panels`): the read itself is the agent's (tools/panels.mjs stores it in
//   clips.json). What reaches this file is the stored read, `panels: { samples, startSec, cuts, gameZoom? }`
//   (`samples` in SOURCE seconds as stored, `startSec` where the window starts in the source, `cuts` the window's
//   snapped cuts), planned here as pipeline.ts plans it: `samplesByShot` through `sourceToClipSec`, then
//   `planPanelShots` with `readingKept(undefined, mode)` for `keep`, and placed through `panelPlacement` (panels-plan.mjs).
//   `panels: { plans, placement }` (one `ShotPanels` per shot and a `panelPlacement` stand-in) is accepted too, for
//   a caller that planned them itself. A planner that throws costs the clip its layout, never the render (spec §6.7):
//   no shot is placed from the read. With no `panels`, no shot is, as in pipeline.ts with no callback;
// - `panelsGameZoom`, `onPanelsPlaced`, `clipId`, `projectId` and every log line.
// Kept: the `layout` pin ("fit" pins every shot, the `series_film` genre's `forceFit`; "auto" otherwise), and
// `subjectRule`, required as in pipeline.ts.
import { countedFaces, planLayout, TRACK_DEADZONE, TRACK_MAX_PAN } from "./crop.mjs";
import { panelPlacement, planPanelShots, readingKept, samplesByShot, sourceToClipSec } from "./panels-plan.mjs";

/**
 * `trackEnabledFromEnv()`, RENDER_TRACK_ENABLED default on (render/config.ts).
 *
 * The kill switch of spec §6, so a tracking regression found in production
 * can be turned off without a deploy, leaving the stage 1 and 2 fixes — the
 * ones that address the original complaint — in place.
 *
 * (The rest of boqo's comment is about reading the variable, which the skill does not.)
 */
export const TRACK_ENABLED = true;

/**
 * `minSubjectCoverageFromEnv()`, RENDER_MIN_SUBJECT_COVERAGE default 0.2 (render/config.ts).
 *
 * The fraction of a shot's sampled frames a face must have been present for
 * before it may decide that shot's framing. Faces below it leave the roster,
 * and a shot whose roster empties is fitted rather than cropped.
 *
 * 0.20, measured across 42 shots of four content classes rather than chosen:
 * every detection that produced wrong output read 2%, 8% or 8%, and the
 * lowest correctly-framed subject read 25%. The layout is identical for any
 * value from 0.10 to 0.50 — a 5x range — so unlike the break ratio this
 * replaces nothing, the answer does not balance on the constant.
 *
 * 0.30 was measured and rejected. It fixes one more real defect (a bystander
 * at the frame edge winning a vlog shot) at a 1.2x margin below a real
 * subject, which is the shape that broke RENDER_SCENE_MIN_BREAK_RATIO.
 *
 * NOTE: setting this to 0 does NOT disable the filter. fractionFromEnv
 * rejects values <= 0 and falls back, so 0 leaves it at 0.20.
 * RENDER_LAYOUT_ENABLED is the off switch.
 */
export const MIN_SUBJECT_COVERAGE = 0.2;

/**
 * `minStackCopresenceFromEnv()`, RENDER_STACK_MIN_COPRESENCE default 0.5 (render/config.ts).
 *
 * The share of a shot's sampled frames in which BOTH faces of a would-be
 * stack must be detected together before the detector stacks them (see
 * crop.ts's `copresence`). Two people far apart is not two people on screen
 * at once: on a moving camera each can be in frame for a quarter of the shot
 * and never at the same time, and each static panel then shows nothing for
 * most of it.
 *
 * 0.5, measured 2026-10-02 rather than placed in a gap, because there is no
 * gap: detect_faces.py was re-run at production's settings on all 519
 * stacked shots in production sidecars, and the 491 that still found a pair
 * spread across 0..1 with no clean break. Five frames of 18 of them, three
 * per band, were then looked at:
 * - At 0.5 and above, 8 of 9 showed both people throughout. The ninth was a
 *   missed cut, which no layout rule can fix.
 * - Below 0.5 it was 5 good, 4 bad. The bad ones were a moving camera
 *   leaving static panels on sky, stage seating or wrapping paper. The good
 *   ones were steady two-shots whose faces the detector under-reads in
 *   profile.
 * Refusing a stack frames one subject — ordinary short-form framing — so a
 * good stack refused costs little and a bad one refused removes an empty
 * panel. 0.5 refuses 152 of the 491 (31%), about a quarter of stacked
 * screen time. Note the measurement ran on this machine's ffmpeg, not
 * production's, and 28 of the 519 found fewer than two faces here.
 *
 * NOTE: as with RENDER_MIN_SUBJECT_COVERAGE, 0 does NOT disable this.
 * fractionFromEnv rejects values <= 0 and falls back. RENDER_LAYOUT_ENABLED
 * is the off switch, and it takes stacking with it.
 */
export const MIN_STACK_COPRESENCE = 0.5;

// ---- From packages/core/src/editor-sidecar.ts ---------------------------------------------------------------

/**
 * The renderer's `CropPlacement.kind` is `"crop"` where the interface says
 * `"fill"`. This is the only place the two vocabularies meet, so they never
 * have to agree by memory. Everything downstream derives its label from
 * `placement.kind` rather than storing one beside it — one field cannot
 * drift from itself.
 */
const LAYOUT_NAMES = {
  crop: "fill",
  track: "track",
  fit: "fit",
  stack: "stack",
  panels: "panels",
};

/** What a shot's placement is called in the interface: `fill | fit | stack | track | panels`. */
export function layoutNameFor(kind) {
  return LAYOUT_NAMES[kind];
}

// ---- From apps/worker/src/render/pipeline.ts ------------------------------------------------------------------

/**
 * One shot's plan: which window it renders through, and which face (if any)
 * drove that choice. `speaker` is null on a `"fit"` placement — no face
 * cleared the bar, so there was nothing to choose — and on a shot placed
 * from the stream panel reading (#293) that aims at no face: a `game` shot's
 * `"track"` window, and a `panels` or `people` shot with no face found in
 * its camera (panels-plan.ts `panelPlacement`). For a `"stack"` placement,
 * `speaker` is the **top** panel's subject.
 *
 * The skill adds `layout`, `layoutNameFor(placement.kind)`, beside pipeline.ts's fields.
 *
 * @typedef {{ shotIndex: number, shot: { startSec: number, endSec: number }, placement: object,
 *             speaker: object | null, faces: number, layout: 'fill' | 'fit' | 'stack' | 'track' | 'panels' }} ShotPlan
 */

/**
 * The stream panel reading of this clip (Task A11), in one of two forms.
 * - The stored read: `samples` (`PanelSample[]`, source seconds), `startSec` (the window's start in the source),
 *   `cuts` (the window's snapped cuts, window seconds; default none) and `gameZoom` (default 1,
 *   RENDER_PANELS_GAME_ZOOM): planned here.
 * - Planned by the caller: `plans`, one panels-plan.mjs `ShotPanels` per shot (`planPanelShots`), and
 *   `placement`, panels-plan.mjs's `panelPlacement(plan, faces, frameWidth, frameHeight)`.
 *
 * @typedef {{ samples: object[], startSec: number, cuts?: { start: number, end: number }[], gameZoom?: number | null }
 *   | { plans: ({ mode: 'panels' | 'people' | 'game' | 'none' } & object)[],
 *       placement: (plan: object, faces: object[], frameWidth: number, frameHeight: number)
 *         => ({ placement: object, speaker: object | null } | null) }} PanelsPlan
 */

const oneLine = (text) => String(text ?? "").split("\n")[0].trim();

/**
 * Places every shot.
 *
 * `shots` are engine/shots.mjs's (`{ startSec, endSec }`, clip seconds). `faces` is engine/faces.mjs's
 * `detectShotFaces` answer: `{ frameWidth, frameHeight, shots: [{ shotIndex, faces }] }`, its `shots` array alone,
 * or `{ unavailable: true, reason }`. `frame` is the source frame the faces are normalised against (the detector's
 * `frameWidth`/`frameHeight`); it defaults to the detection's own, and when both are given they must agree (a
 * TypeError otherwise: boxes read against another frame place a crop in the wrong place). With the array form or
 * `unavailable`, `frame` is required. `output` is the frame every shot is scaled into (1080x1920). `subjectRule` is
 * subject-rule.mjs's `resolveSubjectRule` answer, required as in pipeline.ts.
 *
 * Returns `placed` (one ShotPlan per shot, in order), `notes` (one line when the faces were unavailable, saying
 * which shots went whole (Fit) and which kept the panels layout; else none), and pipeline.ts's two placement counts: `coverageDropped` (faces under the coverage floor) and
 * `stacksRefused` (pairs far enough apart to stack but not on screen together for MIN_STACK_COPRESENCE of the shot).
 *
 * @param {{ shots: { startSec: number, endSec: number }[], faces: object, frame?: { width: number, height: number },
 *           output: { width: number, height: number }, subjectRule: 'speaker' | 'presence',
 *           layout?: 'auto' | 'fit', panels?: PanelsPlan | null }} input
 * @returns {{ placed: ShotPlan[], notes: string[], coverageDropped: number, stacksRefused: number }}
 */
export function planShots(input) {
  const { shots, output } = input;
  if (input.subjectRule !== "speaker" && input.subjectRule !== "presence") {
    throw new TypeError(`planShots: subjectRule must be "speaker" or "presence", got ${input.subjectRule}`);
  }
  const unavailable = input.faces?.unavailable === true;
  const detectorFrame = unavailable || Array.isArray(input.faces) ? null : frameOf(input.faces);
  if (input.frame != null && detectorFrame !== null && (input.frame.width !== detectorFrame.width || input.frame.height !== detectorFrame.height)) {
    throw new TypeError(
      `planShots: frame ${input.frame.width}x${input.frame.height} is not the detector's ${detectorFrame.width}x${detectorFrame.height}`,
    );
  }
  const frame = input.frame ?? detectorFrame;
  if (frame == null) throw new TypeError("planShots: frame is required unless the face detection carries frameWidth and frameHeight");
  const notes = [];
  const detectedShots = unavailable ? [] : Array.isArray(input.faces) ? input.faces : (input.faces?.shots ?? []);

  const trackEnabled = TRACK_ENABLED;
  const minCoverage = MIN_SUBJECT_COVERAGE;
  const minCopresence = MIN_STACK_COPRESENCE;

  // Keyed on the detector's own shotIndex rather than read positionally.
  // detect_faces.py appends one entry per requested shot, in order, so the
  // two agree today — but nothing in the JSON seam enforces that, and a
  // positional read would silently hand shot N the crop chosen for shot N-1
  // if it ever stopped being true. That is a wrong crop that renders fine,
  // passes every unit test and is only visible by watching the video, which
  // is the failure class this pipeline has already been bitten by once.
  //
  // (faces.ts `parseFaceOutput`: an entry whose `faces` is not an array reads as no faces.)
  const facesByShot = new Map(detectedShots.map((entry) => [entry.shotIndex, Array.isArray(entry.faces) ? entry.faces : []]));

  // #293: the stream panel layout. Asked only when a placement could show
  // it: layout modes on and no `fit` pin (`series_film`), which wins over all
  // of it. Whether a shot's override keeps its reading is `readingKept`'s
  // rule, here and in the planner's `keep`.
  //
  // (Faces unavailable: the planner still runs, every shot with no faces, as pipeline.ts runs it for a shot the
  // detector returned no entry for; a shot it places keeps its panels layout, the others are Fit.)
  const forceFit = input.layout === "fit";
  let panelPlans = null;
  let placementOf = panelPlacement;
  if (input.panels != null && !forceFit) {
    if (Array.isArray(input.panels.plans)) {
      panelPlans = input.panels.plans;
      placementOf = input.panels.placement;
    } else if (Array.isArray(input.panels.samples)) {
      const { samples, startSec, gameZoom } = input.panels;
      const cuts = input.panels.cuts ?? [];
      if (!Number.isFinite(startSec)) throw new TypeError("planShots: panels.startSec (the window's start in the source) is required");
      // Final review Important 2: a planner that throws costs the clip its layout, never its render (spec §6.7).
      try {
        panelPlans = planPanelShots({
          samplesByShot: samplesByShot(samples, shots, (sourceSec) => sourceToClipSec(sourceSec, startSec, cuts)),
          shots,
          faces: shots.map((_, index) => facesByShot.get(index) ?? []),
          frameWidth: frame.width,
          frameHeight: frame.height,
          output,
          cuts,
          gameZoom: gameZoom ?? 1,
          keep: (_index, plan) => readingKept(undefined, plan.mode),
        });
      } catch {
        panelPlans = null;
      }
    } else {
      throw new TypeError("planShots: panels needs samples (and startSec) or plans and placement");
    }
  }

  let coverageDropped = 0;
  let stacksRefused = 0;
  // The shots whose placement came from the panels reading (pipeline.ts counts them as `panelsUsed`).
  const fromReading = [];
  const placed = shots.map((shot, index) => {
    const faces = facesByShot.get(index);
    const common = {
      faces: faces ?? [],
      frameWidth: frame.width,
      frameHeight: frame.height,
      output,
      trackEnabled,
      deadzone: TRACK_DEADZONE,
      maxPan: TRACK_MAX_PAN,
      // In `common` rather than only planLayout's arguments, so the layout
      // kill switch below keeps it: that switch restores the pre-layout-modes
      // PLACEMENT, and which face a stream clip is about is a separate
      // question it was never meant to answer. For every clip that is not a
      // stream moment's this is `speaker`, planCrop's own default, so the
      // kill-switch path is unchanged for them.
      // (That kill-switch branch is cut here: layout modes are on in production.)
      subjectRule: input.subjectRule,
    };
    const asked = {
      ...common,
      minCoverage,
      minCopresence,
      forceFit: input.layout === "fit",
      lookingRoom: undefined,
    };
    // Today's call with today's arguments: a shot no intent reaches places
    // exactly as before M2. The coverage and stack-refused counts read this
    // first answer only -- the detector's, not the plan's.
    const first = planLayout({ ...asked, override: undefined });
    coverageDropped += first.dropped;
    if (first.stackRefused) stacksRefused += 1;
    // #293: the shot's panel reading replaces today's answer where it applies;
    // everything below (intents included) then works on that placement.
    let panelled = null;
    if (panelPlans !== null) {
      const plan = panelPlans[index];
      try {
        panelled = placementOf(plan, common.faces, frame.width, frame.height);
      } catch {
        panelled = null;
      }
    }
    let base = first;
    // panels-plan.ts `readingKept(override, mode)` with no override: kept unless the reading is `none`.
    if (panelled !== null && readingKept(undefined, panelPlans[index]?.mode)) {
      base = panelled;
      fromReading.push(index);
    }
    return {
      shotIndex: index,
      shot,
      placement: base.placement,
      speaker: base.speaker,
      faces: countedFaces(faces ?? [], minCoverage),
      layout: layoutNameFor(base.placement.kind),
    };
  });

  if (unavailable) notes.push(unavailableNote(input.faces.reason, shots.length, fromReading));

  return { placed, notes, coverageDropped, stacksRefused };
}

/** The detector's frame size, or null when the detection carries none. */
function frameOf(faces) {
  const width = faces?.frameWidth;
  const height = faces?.frameHeight;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The one note for faces that are unavailable. `fromReading` are the 0-based shot indexes placed from the panels
 * reading; the note counts shots from 1, as a person does.
 */
function unavailableNote(reason, shotCount, fromReading) {
  const whole = Array.from({ length: shotCount }, (_, i) => i).filter((i) => !fromReading.includes(i));
  const numbers = (list) => `${list.length === 1 ? "shot" : "shots"} ${list.map((i) => i + 1).join(", ")}`;
  const lead =
    fromReading.length === 0
      ? "Faces unavailable, every shot is Fit"
      : whole.length === 0
        ? "Faces unavailable, every shot keeps its panels layout from the read"
        : `Faces unavailable, ${numbers(whole)} ${whole.length === 1 ? "is" : "are"} Fit and ${numbers(fromReading)} keep${fromReading.length === 1 ? "s" : ""} the panels layout from the read`;
  const why = oneLine(reason);
  return why ? `${lead}: ${why}` : `${lead}.`;
}
