// ported from boqo-ai/boqo apps/worker/src/render/panels-plan.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { windowToClipSec } from "./cut-map.mjs";
                                                                          
                                       
                                         

/**
 * The stream panel layout's planner (#293, spec §6.2 and §6.3): from the
 * model's per-frame answers for one shot, the shot's mode, its camera crops
 * and its moving game window. Pure geometry: no I/O and no env reads, so
 * every tunable here is a named constant the caller cannot override, except
 * the game zoom, which the render reads (`RENDER_PANELS_GAME_ZOOM`) and passes.
 *
 * Every rectangle it returns is in source pixels, with integer positions and
 * even sizes, because ffmpeg's `crop` and `scale` take them verbatim.
 */

/** The top band at 1080x1920 (spec §6.2): 600 px, the mocks' proportion. */
const TOP_BAND_MAX = 600 / 1920;
/** The band's floor, 25% of the output (spec §6.2: "stays between 25% and 40%"). */
const TOP_BAND_MIN = 0.25;
/** A camera this wide in source pixels or wider gets the full band. */
const CAMERA_WIDE_PX = 700;
/** A camera this narrow or narrower gets the band's floor. The Dota inset, ~400 px, sits between. */
const CAMERA_NARROW_PX = 300;
/** The band's ceiling, 40% of the output (spec §6.2: "stays between 25% and 40%"). */
const TOP_BAND_CEILING = 0.4;
/**
 * The band is never so short that it shows less than this share of a
 * camera's height, up to TOP_BAND_CEILING. The controller's ruling in Task 8d:
 * where spec §6.2's shrinking band meets §3's "a headline covers the author's
 * face", §3 wins. Task 8c measured the collision on Caedrel 1fa9b7fd: a 364 px
 * wide camera, 367 rows tall, given a 500 px band whose crop (about 2.16:1)
 * kept its top 168 rows, 713 to 881, and so cut the face (rows 843 to 953) at
 * the eyes (docs/research/2026-11-09-stream-panels-eval.md,
 * "Caedrel: why the band still cuts the face" and "Geometry round").
 */
const CAMERA_MIN_SHOWN = 0.6;

/** How far a rectangle may stray outside the frame before it is read as wrong. */
const FRAME_SLACK = 0.02;
/** A game panel smaller than this share of the frame is read as wrong. */
const MIN_GAME_AREA = 0.15;
/** A camera overlapping the game panel (or another camera) by more than this share of its area is read as wrong. */
const MAX_OVERLAP = 0.3;
/** A `people` camera this large or larger is left to today's face logic, which already frames it. */
const FULL_CAMERA_AREA = 0.6;

/**
 * The upscale the game window aims for (spec §6.2: "at most about 2×"): a
 * shot with a focus box gets a window no narrower than the output's width
 * over this, where its game panel allows. A floor on the window's width, not
 * a cap on the upscale: a game panel narrower than that gets its widest
 * window, upscaled past 2×, up to MAX_GAME_UPSCALE_ACCEPTED. At the default
 * game zoom the window is the widest already and this floor is below it;
 * it binds only under a zoom (`gameZoom`).
 */
const MAX_GAME_UPSCALE = 2;
/**
 * A game panel whose widest window would be upscaled past this is read as
 * wrong (final review Important 2: a 1.0 x 0.16 panel passed the area floor
 * and got a window upscaled 8×, a 0.16 x 1.0 one 3.5×, the reviewer's
 * figures). Set past MAX_GAME_UPSCALE so that a 720p `game` shot, whose
 * widest 9:16 window is 720 * 9 / 16 = 405 px (2.67× into 1080), still passes.
 */
const MAX_GAME_UPSCALE_ACCEPTED = 3;
/**
 * A camera whose pixel box is narrower or shorter than this is read as wrong.
 * Final review Important 2: a schema-valid camera `w: 0.0005` planned a 0x0
 * crop that ffmpeg rejects, stored as an `ok` decision, so every retry failed
 * the same way. Intent: the reviewer's suggested floor; the narrowest real
 * camera the evaluation read, Caedrel's inset, is 364 px wide (spec
 * amendment 1).
 */
const MIN_CAMERA_PX = 64;

/**
 * How much of a camera crop's height the head box fills when a face is
 * found inside it. Intent, not measurement: the spec asks that the author
 * "reads large" (§6.2) and names no figure; the owner judges it at the gate.
 */
const CAMERA_FACE_FILL = 0.5;
/** Where the eye line sits in a camera crop, from its top: the upper third, as `RENDER_EYE_LINE_TARGET`'s default. */
const CAMERA_EYE_LINE = 0.33;

/**
 * The game window holds still while the focus centre lies within this share
 * of the window's size from the window's centre, per axis: its middle 60%
 * (Task 10, replacing spec §6.3's 6% and 8% of the frame, which were sized
 * for a 2× window). Intent, taken from the owner's reference clip of
 * 2026-11-10, whose game window does not move for its 27 s; not a
 * measurement. The owner judges it at the gate.
 */
export const FOCUS_HOLD_SHARE = 0.3;
/** How long a move takes (spec §6.3: "ease over about 0.6 s"). */
const EASE_SEC = 0.6;
/** Points between a move's start and its end. */
const EASE_POINTS = 5;

/**
 * The smallest source this layout will take. Intent, not measurement: below
 * 480 lines a stream's inset camera is a few dozen pixels tall and the game
 * panel is upscaled past anything the spec's 2× limit allows.
 */
const MIN_SOURCE_HEIGHT = 480;

/**
 * Two shots continue each other in clip time when one starts this close to
 * where the other ends. Intent: one frame at 24 fps, the slowest frame rate
 * a source is likely to have, so any shorter frame also counts.
 */
const ONE_FRAME_SEC = 1 / 24;

/**
 * Whether a clip may get the panel layout at all: a landscape source of a
 * usable size into a portrait output. A vertical or square source has no
 * side-by-side panels to rearrange, and a square or landscape output has no
 * vertical room to stack them in.
 */
export function panelsEligible(frame                                   , output            )          {
  return panelsSourceEligible(frame) && panelsOutputEligible(output);
}

/** `panelsEligible`'s source half, which needs no output, so select's probe skips by it before any frame or model call. */
export function panelsSourceEligible(frame                                   )          {
  return frame.width > frame.height && frame.height >= MIN_SOURCE_HEIGHT;
}

/** `panelsEligible`'s output half, which needs no source frame, so `panels-force` refuses by it before a render. */
export function panelsOutputEligible(output            )          {
  return output.height > output.width;
}

/**
 * One shot's plan. `panels` carries exactly the fields of the `panels` crop
 * placement; `people` is a fixed crop; `game` is a moving window filling the
 * whole output; `none` leaves the shot to `planLayout`.
 */
                        
                                                                              
                                      
                                    
                     

const NONE             = { mode: "none" };

/**
 * Plan one shot from the model's samples.
 *
 * `samples` are the ones inside this shot, and BOTH times are clip seconds:
 * the caller has mapped each stored `sourceSec` to the clip's timeline
 * (`samplesByShot`), and `shot.startSec` is the shot's start on that same
 * timeline, so `sample.sourceSec - shot.startSec` is the sample's time on the
 * returned paths, which start at the shot's 0. Rectangles in the samples are
 * fractions of the source frame; `faces` are this shot's detected faces, also
 * fractions of the frame.
 *
 * `windowWidth`, when given, is a floor on the game window's width: the
 * width a run of same-mode shots shares (`planPanelShots`).
 *
 * `settledCameras`, when given, are the clip's cameras settled over all its
 * samples (`planPanelShots`): a camera of this shot that matches one is
 * replaced by it, so every shot crops the same rectangle.
 *
 * `gameZoom` (default 1, `RENDER_PANELS_GAME_ZOOM`) narrows the game window
 * from the widest its panel holds (`gameWindow`). `startAt`, when given, is
 * where the previous shot's window stopped, for a shot that continues it
 * across a false cut (`planPanelShots`).
 */
export function shotPanels(input   
                                  
                                             
                     
                      
                     
                            
                       
                                        
                    
                                     
 )             {
  const mode = majorityMode(input.samples);
  if (mode === "none") return NONE;
  const winners = input.samples.filter((s) => s.mode === mode);
  const frame        = { width: input.frameWidth, height: input.frameHeight };
  const settled = input.settledCameras ?? [];
  const windowOf = (game           , aspect        , cameras                      ) =>
    gameWindow({
      samples: winners,
      game,
      aspect,
      frame,
      output: input.output,
      startSec: input.shot.startSec,
      floorWidth: input.windowWidth ?? 0,
      zoom: input.gameZoom ?? 1,
      cameras,
      startAt: input.startAt ?? null,
    });
  const shotCameras = () => medianCameras(winners).map((camera) => settledCamera(camera, settled));

  const bigEnough = (camera           ) => {
    const box = pixelBox(camera, frame);
    return widthOf(box) >= MIN_CAMERA_PX && heightOf(box) >= MIN_CAMERA_PX;
  };
  const holdsWindow = (game           , aspect        ) => {
    const box = pixelBox(game, frame);
    const widest = windowSize(Infinity, aspect, widthOf(box), heightOf(box));
    return widest.width > 0 && widest.width * MAX_GAME_UPSCALE_ACCEPTED >= input.output.width;
  };

  if (mode === "people") {
    const cameras = shotCameras();
    // Spec §6.2: several cameras stack by the existing rule, which is today's placement (final review item 8).
    if (cameras.length !== 1 || !inFrame(cameras[0] ) || !bigEnough(cameras[0] )) return NONE;
    const camera = cameras[0] ;
    if (area(camera) >= FULL_CAMERA_AREA) return NONE;
    return { mode: "people", rect: peopleRect(camera, frame, input.output, input.faces) };
  }

  if (mode === "game") {
    // A gameplay upload with no webcam often has no panel to name: the whole frame is the game.
    const game = medianGame(winners) ?? { x: 0, y: 0, w: 1, h: 1 };
    const aspect = input.output.width / input.output.height;
    if (!inFrame(game) || area(game) < MIN_GAME_AREA || !holdsWindow(game, aspect)) return NONE;
    return { mode: "game", game: windowOf(game, aspect, []) };
  }

  const cameras = shotCameras();
  const game = medianGame(winners);
  if (cameras.length === 0 || game === null) return NONE;
  if (!cameras.every(inFrame) || !cameras.every(bigEnough) || !inFrame(game) || area(game) < MIN_GAME_AREA) return NONE;
  for (const camera of cameras) {
    if (!inside(camera, game) && overlap(camera, game) > MAX_OVERLAP * area(camera)) return NONE;
  }
  for (let i = 0; i < cameras.length; i += 1) {
    for (let j = i + 1; j < cameras.length; j += 1) {
      const a = cameras[i] ;
      const b = cameras[j] ;
      if (overlap(a, b) > MAX_OVERLAP * Math.min(area(a), area(b))) return NONE;
    }
  }

  const topHeight = topBandHeight(cameras, frame, input.output);
  const slot = { width: input.output.width / cameras.length, height: topHeight };
  const aspect = input.output.width / (input.output.height - topHeight);
  if (!holdsWindow(game, aspect)) return NONE;
  return {
    mode: "panels",
    cameras: cameras.map((camera) => cameraCrop(camera, frame, slot, input.faces)),
    game: windowOf(game, aspect, cameras),
    topHeight,
  };
}

/**
 * A sample that is not inside any shot may stand in for a shot with none of
 * its own only from this close, in clip seconds. Intent, not measurement: a
 * shot the sampler skipped (more shots than the frame cap) borrows a
 * neighbour's answer; a shot a later trim added, far from anything the model
 * saw, is left to today's placement rather than given a layout it never read.
 */
export const BORROW_MAX_SEC = 3;

/**
 * Each shot's samples on the clip's timeline. `toClipSec` maps a stored
 * `sourceSec` to clip seconds, or null when that moment is not in the clip
 * (inside a cut); such a sample is dropped. A sample at a shot's start
 * belongs to that shot; the last shot also keeps one at its end.
 *
 * A shot left with no sample takes the nearest one in time (spec §6.1:
 * every shot gets at least one sampled frame, and the frame cap can leave a
 * shot without one), placed at the shot's midpoint so its path starts inside
 * the shot, provided it lies within `BORROW_MAX_SEC` of the shot.
 */
export function samplesByShot(
  samples                        ,
  shots                                                 ,
  toClipSec                                      ,
)                  {
  const mapped = samples.flatMap((s) => {
    const t = toClipSec(s.sourceSec);
    return t === null ? [] : [{ ...s, sourceSec: t }];
  });
  const byShot = shots.map((shot, index) =>
    mapped.filter((s) => s.sourceSec >= shot.startSec && (s.sourceSec < shot.endSec || (index === shots.length - 1 && s.sourceSec <= shot.endSec))),
  );
  return byShot.map((own, index) => {
    if (own.length > 0) return own;
    const shot = shots[index] ;
    const distance = (t        ) => (t < shot.startSec ? shot.startSec - t : t > shot.endSec ? t - shot.endSec : 0);
    let nearest                     = null;
    for (const s of mapped) {
      if (nearest === null || distance(s.sourceSec) < distance(nearest.sourceSec)) nearest = s;
    }
    if (nearest === null || distance(nearest.sourceSec) > BORROW_MAX_SEC) return [];
    return [{ ...nearest, sourceSec: (shot.startSec + shot.endSec) / 2 }];
  });
}

/**
 * Every shot's plan, with one game-window width per run (spec §6.1: "when a
 * game source over-cuts, consecutive shots with the same mode keep the same
 * window size, so a false cut does not change the zoom"). A run is
 * consecutive shots that `keep` their plan and share a mode, `panels` or
 * `game`; each takes the widest window any shot in the run needs, still
 * clamped to its own game panel. The zoom is the output's width over the
 * window's, so one width is one zoom even where two `panels` shots' bands
 * differ in height.
 *
 * `keep` says whether a shot will be placed from its plan at all (a creator's
 * override of another kind wins), so a shot that will not show its window
 * neither joins nor widens a run.
 *
 * Every shot also crops the clip's own camera rectangles, settled once from
 * all its samples (`settleCameras`). They are computed here, from the stored
 * samples, and never written back, so a re-render crops the same (spec §6.6).
 *
 * Inside a run, a shot that continues the previous one in source time (it
 * starts where that one ends, within ONE_FRAME_SEC, and no cut of the
 * render's joins there) with the same window size starts where the previous
 * window stopped, when its first focus is in that window's hold zone
 * (Task 10): an over-cut game source would otherwise jump the window at every
 * false cut. Shots tile the clip, so this covers every boundary between two
 * such shots that is not a cut's join, a real scene change in the source
 * included; the hold-zone condition is what keeps that harmless. `cuts` are
 * the render's, in window seconds; `gameZoom` is `RENDER_PANELS_GAME_ZOOM`,
 * read by the render once per clip.
 */
export function planPanelShots(input   
                                                     
                                                         
                                         
                     
                      
                     
                       
                   
                                                     
 )               {
  const settledCameras = settleCameras(input.samplesByShot.flat());
  const planOne = (index        , windowWidth         , startAt                           ) =>
    shotPanels({
      samples: input.samplesByShot[index] ?? [],
      shot: input.shots[index] ,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      output: input.output,
      faces: input.faces[index] ?? [],
      settledCameras,
      gameZoom: input.gameZoom,
      ...(windowWidth !== undefined && { windowWidth }),
      ...(startAt !== undefined && { startAt }),
    });
  const plans = input.shots.map((_, index) => planOne(index));
  const windowed = plans.map((plan, index) =>
    (plan.mode === "panels" || plan.mode === "game") && input.keep(index, plan) ? plan : null,
  );

  let start = 0;
  while (start < windowed.length) {
    const first = windowed[start];
    if (first === null || first === undefined) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < windowed.length && windowed[end]?.mode === first.mode) end += 1;
    if (end - start > 1) {
      const widest = Math.max(...windowed.slice(start, end).map((p) => (p .mode === "panels" || p .mode === "game" ? p .game.size.width : 0)));
      for (let i = start; i < end; i += 1) {
        const plan = plans[i] ;
        if ((plan.mode === "panels" || plan.mode === "game") && plan.game.size.width < widest) plans[i] = planOne(i, widest);
      }
    }
    start = end;
  }

  const joins = input.cuts.map((cut) => windowToClipSec(cut.start, input.cuts)).flatMap((t) => (t === null ? [] : [t]));
  const continues = (index        ) => {
    const before = input.shots[index - 1] ;
    const shot = input.shots[index] ;
    return Math.abs(shot.startSec - before.endSec) <= ONE_FRAME_SEC && !joins.some((t) => Math.abs(t - shot.startSec) <= ONE_FRAME_SEC);
  };
  for (let i = 1; i < plans.length; i += 1) {
    const previous = plans[i - 1] ;
    const plan = plans[i] ;
    if (windowed[i - 1] === null || windowed[i] === null || previous.mode !== plan.mode) continue;
    if ((previous.mode !== "panels" && previous.mode !== "game") || (plan.mode !== "panels" && plan.mode !== "game")) continue;
    const size = plan.game.size;
    if (previous.game.size.width !== size.width || previous.game.size.height !== size.height || !continues(i)) continue;
    plans[i] = planOne(i, size.width, { x: previous.game.x.at(-1) .v, y: previous.game.y.at(-1) .v });
  }
  return plans;
}

/**
 * Whether a shot keeps its panel reading under the creator's override (final
 * review Important 3, spec §6.5 and §6.6). Kept with no override; with
 * `panels`, whatever the reading (a shot read as `game` or `people` keeps its
 * previous placement, which is the reading, and the caller counts the pick as
 * refused); with `track` on a `game` reading and `fill` on a `people` one,
 * because the editor shows those shots under those names, so re-picking the
 * checked card writes exactly that override. Any other override wins over
 * the reading, and a `none` reading is never kept.
 */
export function readingKept(override                        , mode                    )          {
  if (mode === "none") return false;
  if (override === undefined || override === "panels") return true;
  return (override === "track" && mode === "game") || (override === "fill" && mode === "people");
}

/**
 * A stored sample's source second on the clip's timeline: through the
 * window's start, then the cuts. Null strictly inside a cut, where that
 * moment is not in the file. Within a millisecond of a cut's edge it lands
 * on the join: a frame sampled at a join was labelled with the cut's end
 * (`clipToWindowSec`), and adding then subtracting the window's start can
 * move it a few ulps inside the cut.
 */
export function sourceToClipSec(sourceSec        , startSec        , cuts                )                {
  const windowSec = sourceSec - startSec;
  const direct = windowToClipSec(windowSec, cuts);
  if (direct !== null) return direct;
  const edge = cuts.find((c) => Math.abs(windowSec - c.start) <= EDGE_SEC || Math.abs(windowSec - c.end) <= EDGE_SEC);
  return edge === undefined ? null : windowToClipSec(edge.start, cuts);
}

const EDGE_SEC = 1e-3;

/**
 * A shot's panel reading as a placement and the face it aims at, or null for
 * `none` (today's `planLayout` places the shot). `panels` aims at the face in
 * the first camera, `people` at the face in its crop, and `game` at nobody: a
 * `track` window over the game, at the output's aspect.
 *
 * Also null for a plan whose geometry ffmpeg would not take (`planGeometryOk`),
 * so a planner bug costs the shot its layout, never the render (spec §6.7).
 */
export function panelPlacement(
  plan            ,
  faces                    ,
  frameWidth        ,
  frameHeight        ,
)                                                               {
  if (!planGeometryOk(plan, frameWidth, frameHeight)) return null;
  if (plan.mode === "panels") {
    return {
      placement: { kind: "panels", cameras: plan.cameras, game: plan.game, topHeight: plan.topHeight },
      speaker: faceInRect(plan.cameras[0] , faces, frameWidth, frameHeight),
    };
  }
  if (plan.mode === "people") {
    return { placement: { kind: "crop", rect: plan.rect }, speaker: faceInRect(plan.rect, faces, frameWidth, frameHeight) };
  }
  if (plan.mode === "game") return { placement: { kind: "track", path: plan.game }, speaker: null };
  return null;
}

/**
 * Whether every rectangle a plan hands compose is one ffmpeg's `crop` takes:
 * integer position, even size at least 2 a side, wholly inside the source
 * frame, for a moving window at every point of its path; and a top band that
 * is even and at least 2. `none` has nothing to check.
 */
export function planGeometryOk(plan            , frameWidth        , frameHeight        )          {
  const evenSide = (v        ) => Number.isInteger(v) && v >= 2 && v % 2 === 0;
  const span = (at        , size        , max        ) => Number.isInteger(at) && at >= 0 && at + size <= max;
  const rectOk = (r          ) => evenSide(r.width) && evenSide(r.height) && span(r.x, r.width, frameWidth) && span(r.y, r.height, frameHeight);
  const pathOk = (p          ) =>
    evenSide(p.size.width) &&
    evenSide(p.size.height) &&
    p.x.length > 0 &&
    p.y.length > 0 &&
    p.x.every((point) => span(point.v, p.size.width, frameWidth)) &&
    p.y.every((point) => span(point.v, p.size.height, frameHeight));
  if (plan.mode === "panels") return evenSide(plan.topHeight) && plan.cameras.length > 0 && plan.cameras.every(rectOk) && pathOk(plan.game);
  if (plan.mode === "people") return rectOk(plan.rect);
  if (plan.mode === "game") return pathOk(plan.game);
  return true;
}

/** The largest face whose centre lies inside a pixel rectangle of the source frame, or null. */
export function faceInRect(rect          , faces                    , frameWidth        , frameHeight        )                 {
  let best                 = null;
  for (const face of faces) {
    const cx = (face.faceCentreX ?? face.x + face.width / 2) * frameWidth;
    const cy = (face.y + face.height / 2) * frameHeight;
    const centred = cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
    if (centred && (best === null || face.width * face.height > best.width * best.height)) best = face;
  }
  return best;
}

/**
 * A move-and-hold path through `keys` (in increasing `t`). The first value
 * is held; a key under `holdPx` from the last value kept is dropped; each
 * kept key holds the previous value until `t - 0.6`, then eases to its own
 * value at `t` along a smoothstep, through five points between. A path that
 * never moves is one point, which `pathExpression` writes as a bare integer.
 */
export function focusPath(keys                                     , holdPx        )              {
  const first = keys[0];
  if (first === undefined) return [];
  const out              = [{ t: first.t, v: Math.round(first.v) }];
  let kept = first.v;
  for (const key of keys.slice(1)) {
    if (Math.abs(key.v - kept) < holdPx) continue;
    const from = out[out.length - 1] ;
    if (key.t <= from.t) continue;
    const start = Math.max(key.t - EASE_SEC, from.t);
    if (start > from.t) out.push({ t: roundTime(start), v: from.v });
    const span = key.t - start;
    for (let i = 1; i <= EASE_POINTS; i += 1) {
      const s = i / (EASE_POINTS + 1);
      out.push({ t: roundTime(start + span * s), v: Math.round(from.v + (key.v - from.v) * smoothstep(s)) });
    }
    out.push({ t: key.t, v: Math.round(key.v) });
    kept = key.v;
  }
  return out;
}

                                               
/** An integer pixel box: the whole pixels lying inside a fractional rectangle, clamped to the frame. */
                                                                             

/** The most common mode among the samples; a tie for the top, or no samples, is `none`. */
function majorityMode(samples                        )            {
  const counts = new Map                   ();
  for (const s of samples) counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
  let best            = "none";
  let bestCount = 0;
  let tied = false;
  for (const [mode, count] of counts) {
    if (count > bestCount) {
      best = mode;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? "none" : best;
}

function median(values          )         {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]  : (sorted[mid - 1]  + sorted[mid] ) / 2;
}

function medianRect(rects                      )            {
  return {
    x: median(rects.map((r) => r.x)),
    y: median(rects.map((r) => r.y)),
    w: median(rects.map((r) => r.w)),
    h: median(rects.map((r) => r.h)),
  };
}

function medianGame(samples                        )                   {
  const games = samples.flatMap((s) => (s.game === null ? [] : [s.game]));
  return games.length === 0 ? null : medianRect(games);
}

/**
 * The cameras, left to right, each the median of its position across the
 * samples that report the shot's usual number of cameras (the most common
 * count; a tie takes the smaller). Matched by left-to-right order, so the
 * order the model lists them in does not matter.
 */
function medianCameras(samples                        )              {
  const counts = new Map                ();
  for (const s of samples) counts.set(s.cameras.length, (counts.get(s.cameras.length) ?? 0) + 1);
  let n = 0;
  let nCount = 0;
  for (const [count, times] of counts) {
    if (times > nCount || (times === nCount && count < n)) {
      n = count;
      nCount = times;
    }
  }
  const sets = samples.filter((s) => s.cameras.length === n).map((s) => [...s.cameras].sort((a, b) => a.x - b.x));
  return Array.from({ length: n }, (_, i) => medianRect(sets.map((set) => set[i] )));
}

/**
 * Two camera boxes are one camera when they overlap by at least this share of
 * their union. Intent: only reads that agree on every edge to within a few
 * rows join, because the inner quartile then picks among them, and a read of
 * part of the camera that joined could set an edge for every shot. Computed
 * from stored reads (Task 8d and its fix round, 2026-11-09): every reading
 * joined in Fry's six decisions overlaps its camera by 0.884 or more (the
 * 518-row reads of 8c `ref-r1`); Caedrel's inset against his full camera is
 * 0.20; Task 8b's Caedrel decision reads the inset as 269x378 from x 115 in
 * 9 of 25 samples, 0.67 to 0.69 with the whole inset, and at a threshold of
 * 0.5 those reads settled the whole clip's inset at 259x367.
 */
const CAMERA_MATCH_IOU = 0.8;

/**
 * The clip's cameras, each settled once from every sample that shows it, of
 * any mode (Task 8d's ruling: a camera seen in several samples is one camera).
 * Each box joins the camera, settled so far, it overlaps most, at
 * CAMERA_MATCH_IOU or more, or starts a new one. Each edge is then the inner
 * quartile of that camera's readings: the 75th percentile of its left and top
 * edges and the 25th of its right and bottom ones. Toward the inside, by the
 * controller's ruling: a box too large shows what is attached to the camera
 * (Task 8b and 8c measured Fry's banner taken in by the taller reads,
 * docs/research/2026-11-09-stream-panels-eval.md), while one a few rows too
 * small loses only the picture's edge. A quartile rather than the innermost
 * reading, so that from five readings on a single stray small one does not
 * decide an edge.
 *
 * A sample a shot borrowed (`samplesByShot`) is counted again for that shot.
 */
function settleCameras(samples                        )              {
  const groups                = [];
  for (const s of [...samples].sort((a, b) => a.sourceSec - b.sourceSec)) {
    for (const camera of s.cameras) {
      let best                     = null;
      let bestOverlap = 0;
      for (const group of groups) {
        const share = overlapShare(camera, innerQuartiles(group));
        if (share >= CAMERA_MATCH_IOU && share > bestOverlap) {
          best = group;
          bestOverlap = share;
        }
      }
      if (best === null) groups.push([camera]);
      else best.push(camera);
    }
  }
  return groups.map(innerQuartiles);
}

/** A shot's camera replaced by the clip's settled camera it overlaps most, at CAMERA_MATCH_IOU or more; else as read. */
function settledCamera(camera           , settled                      )            {
  let best                   = null;
  let bestOverlap = 0;
  for (const candidate of settled) {
    const share = overlapShare(camera, candidate);
    if (share >= CAMERA_MATCH_IOU && share > bestOverlap) {
      best = candidate;
      bestOverlap = share;
    }
  }
  return best ?? camera;
}

function innerQuartiles(boxes                      )            {
  const left = quantile(boxes.map((b) => b.x), 0.75);
  const top = quantile(boxes.map((b) => b.y), 0.75);
  const right = quantile(boxes.map((b) => b.x + b.w), 0.25);
  const bottom = quantile(boxes.map((b) => b.y + b.h), 0.25);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The `q` quantile of `values`, interpolated linearly between ranks. */
function quantile(values                   , q        )         {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]  + (sorted[hi]  - sorted[lo] ) * (at - lo);
}

/** Intersection over union. */
function overlapShare(a           , b           )         {
  const shared = overlap(a, b);
  const union = area(a) + area(b) - shared;
  return union > 0 ? shared / union : 0;
}

function area(r           )         {
  return r.w * r.h;
}

function inFrame(r           )          {
  return (
    r.w > 0 &&
    r.h > 0 &&
    r.x >= -FRAME_SLACK &&
    r.y >= -FRAME_SLACK &&
    r.x + r.w <= 1 + FRAME_SLACK &&
    r.y + r.h <= 1 + FRAME_SLACK
  );
}

function overlap(a           , b           )         {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** `inner` lies within `outer`, with the same slack a rectangle gets against the frame. */
function inside(inner           , outer           )          {
  return (
    inner.x >= outer.x - FRAME_SLACK &&
    inner.y >= outer.y - FRAME_SLACK &&
    inner.x + inner.w <= outer.x + outer.w + FRAME_SLACK &&
    inner.y + inner.h <= outer.y + outer.h + FRAME_SLACK
  );
}

/** The epsilon keeps 0.55 * 720 = 396.00000000000006 (node, 2026-11-09) from ceiling to 397. */
const PIXEL_EPSILON = 1e-6;

function pixelBox(r           , frame       )           {
  const clamp = (v        , max        ) => Math.min(Math.max(v, 0), max);
  return {
    left: clamp(Math.ceil(r.x * frame.width - PIXEL_EPSILON), frame.width),
    top: clamp(Math.ceil(r.y * frame.height - PIXEL_EPSILON), frame.height),
    right: clamp(Math.floor((r.x + r.w) * frame.width + PIXEL_EPSILON), frame.width),
    bottom: clamp(Math.floor((r.y + r.h) * frame.height + PIXEL_EPSILON), frame.height),
  };
}

function floorEven(v        )         {
  return Math.floor(v / 2) * 2;
}

function ceilEven(v        )         {
  return Math.ceil(v / 2) * 2;
}

function nearestEven(v        )         {
  return Math.round(v / 2) * 2;
}

/** `v` moved into [lo, hi]; `lo` wins when the range is empty. */
function clampInto(v        , lo        , hi        )         {
  return Math.max(Math.min(v, hi), lo);
}

/**
 * An even-sized window of aspect `aspect` (width over height) at least
 * `minWidth` wide where the box allows, and never larger than the box. The
 * binding side is computed first and the other rounded to the nearest even
 * value, so the largest window keeps the box's full extent on that side.
 */
function windowSize(minWidth        , aspect        , maxWidth        , maxHeight        )           {
  const widest = Math.min(maxWidth, maxHeight * aspect);
  if (minWidth >= widest) {
    if (maxWidth / maxHeight > aspect) {
      const height = floorEven(maxHeight);
      return { width: Math.min(nearestEven(height * aspect), floorEven(maxWidth)), height };
    }
    const width = floorEven(maxWidth);
    return { width, height: Math.min(nearestEven(width / aspect), floorEven(maxHeight)) };
  }
  const width = Math.min(ceilEven(minWidth), floorEven(maxWidth));
  return { width, height: Math.min(nearestEven(width / aspect), floorEven(maxHeight)) };
}

function widthOf(box          )         {
  return box.right - box.left;
}

function heightOf(box          )         {
  return box.bottom - box.top;
}

/**
 * The top band's height: 600 px at 1920 for a camera 700 source pixels wide
 * or wider, falling linearly to 480 (25%) at 300 px. With several cameras each
 * gets `1/n` of the band's width, so the narrowest camera's width times `n` is
 * what compares with a single camera filling the band.
 *
 * Then raised, up to TOP_BAND_CEILING, until the largest crop of each camera
 * that fits its slot shows CAMERA_MIN_SHOWN of the camera's height. A camera
 * wider than its slot's shape is shown whole already and asks for nothing.
 */
function topBandHeight(cameras                      , frame       , output            )         {
  const cameraPx = Math.min(...cameras.map((c) => c.w * frame.width)) * cameras.length;
  const share = clampInto((cameraPx - CAMERA_NARROW_PX) / (CAMERA_WIDE_PX - CAMERA_NARROW_PX), 0, 1);
  const fraction = TOP_BAND_MIN + (TOP_BAND_MAX - TOP_BAND_MIN) * share;
  const byWidth = nearestEven(fraction * output.height);

  // A crop filling a slot of width S at band height h is the camera's width w
  // tall w * h / S, so showing a share k of its height H needs h >= k * S * H / w.
  const slotWidth = output.width / cameras.length;
  const toShow = Math.max(...cameras.map((c) => (CAMERA_MIN_SHOWN * slotWidth * (c.h * frame.height)) / (c.w * frame.width)));
  return Math.max(byWidth, Math.min(ceilEven(toShow), floorEven(TOP_BAND_CEILING * output.height)));
}

/** The largest face whose centre lies inside the camera, or none. */
function faceIn(camera           , faces                    )                 {
  let best                 = null;
  for (const face of faces) {
    const cx = face.faceCentreX ?? face.x + face.width / 2;
    const cy = face.y + face.height / 2;
    const centred = cx >= camera.x && cx <= camera.x + camera.w && cy >= camera.y && cy <= camera.y + camera.h;
    if (centred && (best === null || face.width * face.height > best.width * best.height)) best = face;
  }
  return best;
}

/**
 * A face must lie at least this share of its box inside a camera to pull the
 * camera out to hold it. Intent, not measurement: a face cut by the camera's
 * edge is the author's, one that only grazes it may be someone else's.
 */
const FACE_PULL_SHARE = 0.25;

/**
 * The camera grown to hold a detected face its box cuts through (spec §6.2,
 * "faces stay whole"): Task 8b measured a read whose camera box held only
 * the top half of a webcam (Caedrel, docs/research/2026-11-09-stream-panels-eval.md).
 * The largest such face wins; a face wholly inside, or less than
 * FACE_PULL_SHARE inside, leaves the camera as read. It cannot help when no
 * face is detected (spec §4: small inset faces are not reliably found). On
 * that Caedrel clip the render's own face settings found none (Task 8c,
 * measured 2026-11-09), so there it changes nothing. Nor can it help when
 * the box misses the face altogether.
 */
function holdFaceWhole(camera           , faces                    , frame       )            {
  let pulled                 = null;
  for (const face of faces) {
    const box = { x: face.x, y: face.y, w: face.width, h: face.height };
    if (inside(box, camera) || overlap(box, camera) < FACE_PULL_SHARE * area(box)) continue;
    if (pulled === null || face.width * face.height > pulled.width * pulled.height) pulled = face;
  }
  if (pulled === null) return camera;
  // Out to whole pixels, so pixelBox's rounding cannot cut the face's last row.
  const left = Math.max(0, Math.floor(Math.min(camera.x, pulled.x) * frame.width)) / frame.width;
  const top = Math.max(0, Math.floor(Math.min(camera.y, pulled.y) * frame.height)) / frame.height;
  const right = Math.min(frame.width, Math.ceil(Math.max(camera.x + camera.w, pulled.x + pulled.width) * frame.width)) / frame.width;
  const bottom = Math.min(frame.height, Math.ceil(Math.max(camera.y + camera.h, pulled.y + pulled.height) * frame.height)) / frame.height;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * One camera's crop for its slot in the top band, at the slot's aspect and
 * never wider than the camera itself. With a face inside the camera, framed
 * on the face, whole, with its eye line in the upper third; without one, the
 * largest crop, centred both ways (Task 8d's ruling), so that a face the
 * detector missed is not cut by a crop held against the camera's top: Task 8c
 * measured Caedrel's face at rows 843 to 953 of a camera from 713 to 1080.
 * A banner under the camera is kept out by the clip's settled rectangle
 * (`settleCameras`), not by the crop's placement.
 */
function cameraCrop(read           , frame       , slot          , faces                    )           {
  const camera = holdFaceWhole(read, faces, frame);
  const box = pixelBox(camera, frame);
  const aspect = slot.width / slot.height;
  const face = faceIn(camera, faces);

  if (face === null) {
    const size = windowSize(Infinity, aspect, widthOf(box), heightOf(box));
    return {
      ...size,
      x: box.left + Math.round((widthOf(box) - size.width) / 2),
      y: box.top + Math.round((heightOf(box) - size.height) / 2),
    };
  }

  const faceLeft = face.x * frame.width;
  const faceRight = (face.x + face.width) * frame.width;
  const faceTop = face.y * frame.height;
  const faceBottom = (face.y + face.height) * frame.height;
  const faceHeight = faceBottom - faceTop;
  const minWidth = Math.max((faceHeight / CAMERA_FACE_FILL) * aspect, faceRight - faceLeft, faceHeight * aspect);
  const size = windowSize(minWidth, aspect, widthOf(box), heightOf(box));

  const centreX = (face.faceCentreX ?? face.x + face.width / 2) * frame.width;
  let x = Math.round(centreX - size.width / 2);
  x = clampInto(x, Math.ceil(faceRight - size.width), Math.floor(faceLeft));
  x = clampInto(x, box.left, box.right - size.width);

  // No eye line from the detector: the box's middle stands in for it.
  const eyeLine = (face.eyeLineY ?? face.y + face.height / 2) * frame.height;
  let y = Math.round(eyeLine - CAMERA_EYE_LINE * size.height);
  y = clampInto(y, Math.ceil(faceBottom - size.height), Math.floor(faceTop));
  y = clampInto(y, box.top, box.bottom - size.height);

  return { ...size, x, y };
}

/** A `people` shot's crop: the largest output-shaped rectangle inside the camera, centred on its face (or on the camera). */
function peopleRect(camera           , frame       , output            , faces                    )           {
  const box = pixelBox(camera, frame);
  const size = windowSize(Infinity, output.width / output.height, widthOf(box), heightOf(box));
  const face = faceIn(camera, faces);
  const cx = face === null ? (box.left + box.right) / 2 : (face.faceCentreX ?? face.x + face.width / 2) * frame.width;
  const cy = face === null ? (box.top + box.bottom) / 2 : (face.y + face.height / 2) * frame.height;
  return {
    ...size,
    x: clampInto(Math.round(cx - size.width / 2), box.left, box.right - size.width),
    y: clampInto(Math.round(cy - size.height / 2), box.top, box.bottom - size.height),
  };
}

/**
 * The game window (Task 10, after the owner's reference clip): one size for
 * the shot, by default the widest window of the band's aspect its game panel
 * holds, so a full-screen game keeps its full height and its interface.
 * `zoom` narrows it to the widest width over `zoom`, then the floors apply:
 * no narrower than the output's width over MAX_GAME_UPSCALE, than the shot's
 * largest focus box, or than `floorWidth` (a run's shared width,
 * `planPanelShots`); never larger than the widest. A shot whose samples name
 * no focus shows the widest window, at home.
 *
 * Horizontally the window travels inside the clear span (`clearSpan`) when
 * its `cameras` leave one, else inside the game panel; vertically inside the
 * panel. Home is the window centred on the panel, clamped into that travel.
 * Per axis, the window holds while the focus centre stays within
 * FOCUS_HOLD_SHARE of its size from its centre, and otherwise moves, eased,
 * to `targetX` or `targetY`'s position for that sample. A window the focus
 * pulled past the clear span also moves once a sample's own position is
 * clear again, so a camera stays out of the window whenever the focus allows. A shot starts at `startAt`, then at
 * home, each only when its first focus centre is in that position's hold
 * zone; else on its first focus, so it never opens with a pan.
 */
function gameWindow(input   
                                  
                  
                 
               
                     
                   
                     
               
                                
                                           
 )           {
  const { frame, aspect } = input;
  const box = pixelBox(input.game, frame);
  const focused = input.samples
    .flatMap((s) => (s.focus === null ? [] : [{ t: roundTime(Math.max(0, s.sourceSec - input.startSec)), focus: s.focus }]))
    .sort((a, b) => a.t - b.t);

  const widest = windowSize(Infinity, aspect, widthOf(box), heightOf(box));
  const largest = Math.max(
    0,
    ...focused.map(({ focus }) => Math.max(focus.w * frame.width, focus.h * frame.height * aspect)),
  );
  const minWidth = Math.max(widest.width / input.zoom, largest, input.output.width / MAX_GAME_UPSCALE, input.floorWidth);
  // At or past the widest, the widest itself: windowSize's own rounding could give back a row short of the panel.
  const size = focused.length === 0 || minWidth >= widest.width ? widest : windowSize(minWidth, aspect, widthOf(box), heightOf(box));

  const maxX = box.right - size.width;
  const maxY = box.bottom - size.height;
  const span = clearSpan(box, input.cameras.map((c) => pixelBox(c, frame)), size.width);
  const lo = span?.lo ?? box.left;
  const hi = span?.hi ?? maxX;
  const home = {
    x: clampInto(Math.round((box.left + box.right) / 2 - size.width / 2), lo, hi),
    y: clampInto(Math.round((box.top + box.bottom) / 2 - size.height / 2), box.top, maxY),
  };
  if (focused.length === 0) return { size, x: [{ t: 0, v: home.x }], y: [{ t: 0, v: home.y }] };

  // The focus outranks the clear span: a box the clamped window cuts pulls it, inside the panel, by the least amount.
  const targetX = (left        , right        ) => {
    const centre = (left + right) / 2;
    let x = clampInto(Math.round(centre - size.width / 2), lo, hi);
    if (right - left > size.width) x = Math.round(centre - size.width / 2);
    else if (left < x) x = Math.floor(left + PIXEL_EPSILON);
    else if (right > x + size.width) x = Math.ceil(right - size.width - PIXEL_EPSILON);
    return clampInto(x, box.left, maxX);
  };
  const targetY = (centre        ) => clampInto(Math.round(centre - size.height / 2), box.top, maxY);
  const held = (centre        , at        , extent        ) => Math.abs(centre - (at + extent / 2)) <= FOCUS_HOLD_SHARE * extent;
  const clear = (at        ) => span === null || (at >= span.lo && at <= span.hi);
  // A window the focus pulled past the clear span holds there only while this sample's own position needs it too.
  const holdsX = (key                                             , at        ) =>
    held(key.cx, at, size.width) && (clear(at) || !clear(targetX(key.left, key.right)));

  // One key per instant: two samples at the same time keep the later one.
  const keys = new Map                                                                 ();
  for (const { t, focus } of focused) {
    const left = focus.x * frame.width;
    const right = (focus.x + focus.w) * frame.width;
    keys.set(t, { left, right, cx: (left + right) / 2, cy: (focus.y + focus.h / 2) * frame.height });
  }
  const ordered = [...keys.entries()];
  const first = ordered[0] [1];
  const from = input.startAt === null ? null : { x: clampInto(input.startAt.x, box.left, maxX), y: clampInto(input.startAt.y, box.top, maxY) };
  // Home is inside the clear span by construction, so only `from` can need the clear-span check.
  let x = from !== null && holdsX(first, from.x) ? from.x : held(first.cx, home.x, size.width) ? home.x : targetX(first.left, first.right);
  let y = from !== null && held(first.cy, from.y, size.height) ? from.y : held(first.cy, home.y, size.height) ? home.y : targetY(first.cy);
  const xs                             = [];
  const ys                             = [];
  for (const [index, [t, key]] of ordered.entries()) {
    if (index > 0) {
      if (!holdsX(key, x)) x = targetX(key.left, key.right);
      if (!held(key.cy, y, size.height)) y = targetY(key.cy);
    }
    xs.push({ t, v: x });
    ys.push({ t, v: y });
  }
  // A move under a pixel is no move.
  return { size, x: focusPath(xs, 1), y: focusPath(ys, 1) };
}

/**
 * The span of x positions a window `width` wide may take in the game panel
 * without showing a camera the top band already shows (Task 10), or null.
 * Each camera overlapping the panel narrows the travel, in turn, to the wider
 * of its two sides; null when what remains is narrower than the window, and
 * the whole panel is then the travel.
 */
function clearSpan(box          , cameras                     , width        )                                    {
  let left = box.left;
  let right = box.right;
  for (const camera of cameras) {
    const meets = camera.right > left && camera.left < right && camera.bottom > box.top && camera.top < box.bottom;
    if (!meets) continue;
    if (camera.left - left >= right - camera.right) right = camera.left;
    else left = camera.right;
  }
  return right - left >= width ? { lo: left, hi: right - width } : null;
}

function smoothstep(s        )         {
  return s * s * (3 - 2 * s);
}

/** Milliseconds are finer than a frame, and keep the ffmpeg expressions short. */
function roundTime(t        )         {
  return Math.round(t * 1000) / 1000;
}
