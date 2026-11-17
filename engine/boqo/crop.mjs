// ported from boqo-ai/boqo apps/worker/src/render/crop.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo apps/worker/src/render/config.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: `eyeLineTargetFromEnv`, `faceHeightTargetFromEnv`, `lookingRoomFromEnv`, `maxUpscaleFromEnv`,
// `motionFloorFromEnv`, `trackDeadzoneFromEnv` and `trackMaxPanFromEnv` (render/config.ts), which read
// RENDER_EYE_LINE_TARGET, RENDER_FACE_HEIGHT_TARGET, RENDER_LOOKING_ROOM, RENDER_MAX_UPSCALE,
// RENDER_MOTION_FLOOR, RENDER_TRACK_DEADZONE and RENDER_TRACK_MAX_PAN. The production worker sets none of them
// (its render variables on 2026-11-16, as engine/boqo/scenes.mjs records them: RENDER_CONTEXT_LINE_ENABLED=0,
// RENDER_PANELS_MODE=all, RENDER_SHOT_TRANSITIONS_ENABLED=1), so each is its code default, a constant at the end
// of this file (EYE_LINE_TARGET, FACE_HEIGHT_TARGET, LOOKING_ROOM, MAX_UPSCALE, MOTION_FLOOR, TRACK_DEADZONE,
// TRACK_MAX_PAN). Also cut: the type imports (`LayoutName`, `OutputSize` from @boqo/core, `FaceBox` from
// ./faces, `PathPoint` from ./track); the shapes are the ones engine/faces.mjs and track.mjs produce.
                                       
import { compressPath, smoothPath } from "./track.mjs";

                                                                               

/**
 * The crop window's default aspect ratio: the OUTPUT frame's own
 * width-over-height, not a fixed 9:16 (stage 5). A `fill` crop is scaled to
 * cover the whole output frame, so its window must be shaped like that
 * frame; a stack panel overrides this default with `panelSize`'s own ratio
 * instead (see `cropSize`'s own `targetRatio` field).
 *
 * At the 9:16 reference size this returns exactly REFERENCE_WIDTH /
 * REFERENCE_HEIGHT — the value the deleted TARGET_RATIO constant held — so
 * nothing downstream moves until a caller passes a different output.
 */
export function targetRatio(output            )         {
  return output.width / output.height;
}

/**
 * Two panels per stack, unconditionally. Not itself frame-dependent — kept
 * as a private constant `panelSize` divides by, rather than inlined, so the
 * "two" in "two panels" is named once.
 */
const STACK_PANELS = 2;

/**
 * A stacked shot's two panels tile the OUTPUT exactly — no gap, no blurred
 * background, no dead space — so each is as wide as the output and half its
 * height: 1080x960 (a 1.125:1 crop of the source) at the 9:16 reference,
 * 1920x540 at 16:9. Spec §7.4 records the alternative that was rejected
 * (OpusClip's own gapped proportions over blur) and why.
 *
 * `stack` stays available at every ratio (design §11.2, owner's decision):
 * at 16:9 each panel is that 1920x540 letterbox strip, which may well read
 * badly — the gate looks at the rendered output and reports on it, rather
 * than this function pre-empting the product judgement by disabling the
 * layout.
 */
export function panelSize(output            )           {
  return { width: output.width, height: output.height / STACK_PANELS };
}

/**
 * Even, rounding DOWN when adjustment is needed — a crop window must never
 * exceed the frame it is cut from. One of three same-shaped `even*` helpers
 * in this render module (`brand.ts`'s `evenNearest`, `uniqueize-filters.ts`'s
 * `evenUp`) that round differently on purpose, each correct for its own call
 * site rather than a bug to consolidate away.
 */
export function evenDown(value        )         {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * Which question a shot's subject answers.
 *
 * `speaker` — who is talking. Every clip except a Stream Sniper moment's, and
 * the rule this file has always had.
 *
 * `presence` — who is ON SCREEN for the shot; mouth motion only breaks the
 * tie between faces present about equally long. A clip cut from a stream
 * moment is about the streamer, and a stream's frame routinely carries other
 * people's faces inside the content the streamer is watching. Measured
 * 2026-10-01 on project 068a567b (Asmongold scrolling an X feed): a TikTok
 * playing in the feed was on screen for 30-32% of two clips with mouth motion
 * 11-33x the streamer's (8.3e-4 / 3.1e-4 against 2.5e-5 / 2.9e-5), so
 * `speaker` framed the TikTok while the streamer sat in his webcam inset for
 * 100% of both clips. Resolved per clip by `resolveSubjectRule`
 * (render/subject-rule.ts), never read from env.
 */
                                                 

/**
 * How close to the best coverage a face must be to count as equally present
 * under `presence`. 0.1 is ten points of the shot. On the measured clips the
 * faces that matter sit at 1.0 (streamer, a paused video) and 0.30-0.32 (the
 * TikTok), so the answer there does not balance on this value: anything from
 * 0 to 0.67 picks the streamer (e7e0ced6's TikTok, at 0.3205, joins the pool
 * at 0.68). A positive tie rather than strict equality so a streamer who
 * turns away for a few sampled frames is not displaced by a thumbnail that
 * held perfectly still.
 */
export const PRESENCE_TIE = 0.1;

/**
 * Spec §5.4's fallback chain, in order: most mouth motion, then largest face,
 * then nothing (which the caller reads as `{kind: "fit"}` — the whole frame,
 * not a centred crop; see planCrop below).
 *
 * This is an approximation and is documented as one. Real active-speaker
 * detection is audio-visual sync analysis and is out of scope; this lands
 * correctly on most two-person content and never produces something broken.
 *
 * Under `presence` the same chain runs over a narrower pool: only the faces
 * whose coverage is within PRESENCE_TIE of the best-covered one. A face with
 * no coverage reads as fully present, the same reading `stackSubjects` and
 * `planLayout`'s coverage filter give it. `speaker`, the default, is the
 * chain exactly as it was, for every clip that is not a stream moment's.
 */
export function chooseSpeaker(
  faces           ,
  motionFloor        ,
  rule              = "speaker",
)                 {
  if (faces.length === 0) return null;

  const candidates = rule === "presence" ? mostPresent(faces) : faces;

  const speaking = candidates.filter((face) => face.mouthMotion > motionFloor);
  const pool = speaking.length > 0 ? speaking : candidates;

  return pool.reduce((best, face) => {
    if (speaking.length > 0) {
      return face.mouthMotion > best.mouthMotion ? face : best;
    }
    return face.width * face.height > best.width * best.height ? face : best;
  });
}

/** The faces within PRESENCE_TIE of the best coverage; never empty for a non-empty input. */
function mostPresent(faces           )            {
  const bestCoverage = Math.max(...faces.map((face) => face.coverage ?? 1));
  return faces.filter((face) => (face.coverage ?? 1) >= bestCoverage - PRESENCE_TIE);
}

/**
 * A crop window that moves: one size, fixed for the whole shot because
 * ffmpeg's `crop` evaluates `w`/`h` once at configuration, plus an x and a y
 * path it re-evaluates every frame. `compose.ts` renders each path with
 * `pathExpression`; a single-point path compresses back to a bare integer, so
 * a shot with no real motion is byte-identical to the fixed rectangle it
 * would otherwise have produced.
 */
                                                                          

/**
 * What a shot should do: crop to a fixed window, track a moving one, or fit
 * the whole frame.
 *
 * "No subject" is a first-class result rather than a centred rectangle. The
 * centre is not a neutral guess — cinematic composition puts subjects at the
 * edges or the thirds and leaves the middle empty, so on precisely the shots
 * where detection fails, a centre crop aims at the emptiest part of the
 * picture. Measured on a finished clip of a real 1920x810 podcast, 2 of 8
 * sampled frames contained no person at all.
 *
 * `planCrop` produces `track` when a shot's smoothed path really moves, and
 * the plain `crop` form when it compresses to a single value on both axes —
 * never a tracked placement carrying a constant expression, because the two
 * render to different bytes and §5.6 gate 3 compares a file hash.
 *
 * `fit.chosen` (ruling P7-R18): `true` when the whole frame was ASKED for --
 * the creator's per-shot Fit, the `series_film` genre's pin (`forceFit`), or
 * a Montage `wide` beat -- rather than fallen back to because no subject was
 * found. Absent on every automatic fit, so those placements are unchanged.
 * Only `fitBranch` reads it: a Crop to Fill brand crops the automatic fits
 * and leaves the chosen ones letterboxed over the default blur.
 *
 * `panels` (#293, spec §6.2): a stream's cameras side by side in a top band
 * `topHeight` output pixels tall, over a moving window on the game panel
 * that fills the rest. Its fields are `ShotPanels`' `panels` variant
 * (panels-plan.ts): camera rects already at their slot's aspect, the game
 * window one fixed size with shot-relative x/y paths, as `track`'s.
 */
                           
                                    
                                     
                                  
                                                   
                                                                               

/** Keeps a nonsense `facing` from flinging the window off the subject. */
const MAX_FACING = 1;

/**
 * A crop window's size — the part ffmpeg's `crop` filter evaluates once at
 * configuration, whatever expression `w`/`h` carry, so it has to stay fixed
 * for a whole shot. Depends only on the frame and how large the subject is,
 * never on where the subject sits — see `cropPosition` for that half.
 */
                                                         

export function cropSize(input   
                                                                          
                     
                     
                           
                     
                      
     
                                                                            
                                                                      
                                                                             
                                                                       
                                                                       
                                                                        
                                                                           
                   
     
                     
     
                                                                          
                                                                              
                                                                         
                                                                           
                                                                     
                                                                            
                                                                    
     
                       
 )           {
  const { frameWidth, frameHeight } = input;
  const ratio = input.targetRatio ?? targetRatio(input.output);

  // The widest window the source allows: full frame height at the output
  // ratio. This is what every crop was before zoom existed.
  const baseWidth = evenDown(Math.min(frameWidth, frameHeight * ratio));

  // The narrowest the upscale ceiling allows. Math.min against baseWidth
  // matters: on a source whose base crop already exceeds the ceiling — a
  // 1920x810 at 2.37x against a 2.0 ceiling — the floor would otherwise sit
  // above the base and invert the clamp.
  const minWidth = Math.min(evenDown(input.output.width / input.maxUpscale), baseWidth);

  // Zoom so the face fills faceHeightTarget of the output. The window is
  // scaled to the output's own height when composed, and that scale factor
  // cancels out of this arithmetic — the window height that achieves the
  // target is the face's own pixel height divided by the target fraction,
  // whatever the output's actual height is.
  const facePx = input.faceHeight * frameHeight;
  const desiredWidth =
    facePx > 0 ? (facePx / input.faceHeightTarget) * ratio : baseWidth;

  const width = evenDown(Math.min(Math.max(desiredWidth, minWidth), baseWidth));
  const height = evenDown(Math.min(frameHeight, width / ratio));

  return { width, height };
}

/**
 * A crop window's position — the part ffmpeg's `crop` filter re-evaluates
 * every frame, so unlike `cropSize` it can be recomputed for each sampled
 * moment in a shot, against that shot's one fixed `size`.
 */
export function cropPosition(input   
                 
                  
     
                                                                           
                                                                           
                                                                          
                                                                      
    
                                                          
                                                                            
                                                                  
                                                                            
                                                                      
                                                                            
                                                                    
                                                                            
                                                                        
                                                                          
                                                                          
                                                                       
                                                  
     
                 
                      
     
                                                                       
                                                                          
                          
    
                                                                          
                                                                       
                                                                        
                                                                  
                                                                           
                                                                      
                                                              
    
                                                                        
                                                                         
                                                                            
    
                                                                         
                                                                          
                                                                     
                                                                           
                                                                          
                                                                           
                                                                           
                                                                       
                                                                           
                                                                            
                                                                           
                                                                            
                                                                            
                                                                         
                                                                    
                                                                     
                                                                          
                                                                       
     
                  
                   
     
                                                                   
                                                                        
                                                                          
                                                                      
                                                                    
    
                                                                    
                                                                          
                                                                            
                                                                      
                                                                         
                                                                         
                                                                   
                                                                          
                                                                          
                                                                         
                                                                        
     
                          
     
                                                                            
                                                                        
                                                                     
                      
    
                                                                         
                                                                             
                                                                           
                                                                       
                                                                        
                                                                           
                                                 
                                                                           
                                                                       
                                                                           
                                                                             
                                                                        
                                         
     
                  
                        
                     
                      
 )                           {
  const { frameWidth, frameHeight } = input;
  const { width, height } = input.size;

  // Offset *toward* the gaze: facing is negative when the subject looks left,
  // so the window centre moves left, which puts the face right of centre
  // inside it and leaves the empty space in front of the subject rather than
  // behind their head. Clamped because `facing` is a ratio over box width and
  // a degenerate box can make it arbitrarily large.
  const facing = Math.min(Math.max(input.facing, -MAX_FACING), MAX_FACING);
  let centre = input.centreX + facing * input.lookingRoom * width;

  // Keep the whole head box in frame whenever it fits, even at the cost of
  // some of the centring or gaze offset above — see the boxLeft/boxRight
  // doc comment for why. `[boxRight - width/2, boxLeft + width/2]` is
  // exactly the set of window centres for which the window fully contains
  // the box. When the box itself is not narrower than the window — which
  // zoom now makes routine rather than rare, since it shrinks `width` — no
  // centre satisfies that, so the clamp is skipped rather than forced onto
  // an empty (or inverted) range; cutting is unavoidable there.
  const boxWidth = input.boxRight - input.boxLeft;
  if (boxWidth < width) {
    centre = Math.min(Math.max(centre, input.boxRight - width / 2), input.boxLeft + width / 2);
  }

  // The frame-edge clamp runs last: a window must never be pushed outside
  // the real frame to satisfy the box-containment clamp above.
  const x = Math.round(
    Math.min(Math.max(centre - width / 2, 0), Math.max(frameWidth - width, 0)),
  );

  // Vertical only has room once the window is shorter than the frame, which
  // is why zoom and vertical position are one feature rather than two. On
  // any source wider than the output's own ratio with no zoom applied,
  // height equals frameHeight and both branches below pin y at 0 — as it
  // always has (9:16 was the only output ratio this could be measured
  // against before stage 5; the property itself was never specific to it).
  //
  // eyeLineY===null uses centreY (the box's own vertical midpoint) rather
  // than the frame's — see centreY's own doc comment for the measured
  // failure this replaces. Same clamp shape as the eye-line branch, just
  // centring the window on the box instead of placing the eye line at a
  // target fraction down from the top.
  const y =
    input.eyeLineY === null
      ? Math.round(
          Math.min(
            Math.max(input.centreY * frameHeight - height / 2, 0),
            Math.max(frameHeight - height, 0),
          ),
        )
      : Math.round(
          Math.min(
            Math.max(input.eyeLineY * frameHeight - input.eyeLineTarget * height, 0),
            Math.max(frameHeight - height, 0),
          ),
        );

  return { x, y };
}

/**
 * The rectangle itself, given where the subject is. Pure geometry, separated
 * from "which face" so each can be tested alone — Tasks 13 and 16 both extend
 * this function while `chooseSpeaker` stays still.
 *
 * `centreX`, `boxLeft` and `boxRight` are all in absolute source pixels, not
 * normalised units.
 *
 * Implemented in terms of `cropSize` and `cropPosition`: ffmpeg's `crop`
 * filter evaluates `w`/`h` once at configuration but `x`/`y` per frame, so
 * stage 3 needs the size fixed once per shot and the position recomputed per
 * sample. This one-shot call just runs both halves once, from the same
 * input.
 */
export function cropWindow(input   
                  
                 
                      
     
                                                                
                                                                
                                                       
     
                  
                   
     
                                                                           
                            
     
                     
     
                                                                   
                                                        
     
                          
     
                                                                            
                                                                        
     
                  
                     
                        
                           
                     
                      
                                                                          
                                                        
                     
     
                                                                          
                                                                              
                                                                         
                                                                           
                                                                     
                                                                            
                                                                    
     
                       
 )           {
  const size = cropSize({
    faceHeight: input.faceHeight,
    maxUpscale: input.maxUpscale,
    faceHeightTarget: input.faceHeightTarget,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    output: input.output,
    targetRatio: input.targetRatio,
  });
  return { ...size, ...cropPosition({ size, ...input }) };
}

/**
 * A window for one shot: a fixed rectangle when the subject stays put, a
 * tracked path when they move, and the whole frame when there is no subject
 * at all. Spec §2.5 and §5.4.
 *
 * Returns the speaker alongside the placement (null exactly when placement
 * is `{kind: "fit"}`) because a shot's chosen face was previously computed
 * and discarded — an instrument reading the rendered output could re-detect
 * faces in it but had no way to know which one the renderer had aimed at.
 *
 * At 16:9 from a 16:9 source, `stacked` really is structurally 0:
 * `baseWindowWidth` equals the source's own width exactly there (the frame
 * already IS the output ratio), so no pair's spread can ever exceed it --
 * a property of `baseWindowWidth`'s own geometry, not of "nothing to crop".
 *
 * There is usually still plenty to crop, and `tracked` is NOT structurally
 * 0 the same way. The crop window only widens to the full frame once the
 * chosen face clears `RENDER_FACE_HEIGHT_TARGET` (0.3 of frame height, a
 * genuine close-up) -- `cropSize`'s own `desiredWidth >= baseWidth`
 * condition. A normal-sized face still narrows the window well below the
 * frame even at 16:9 -- measured, a 0.12-tall face on a 1920x1080 source
 * narrows to 768 of 1920px (40%) -- and a moving subject inside that
 * window still produces a genuine tracked path. A narrowed `crop` rect and
 * a non-zero `tracked` count are both EXPECTED and CORRECT on most 16:9
 * content; `fitted` is unaffected by any of this, since it depends only on
 * whether a subject was detected at all. Reading `tracked` as evidence a
 * 16:9 render is broken is exactly the misreading this paragraph exists to
 * head off. Design §9.1 carries the identical over-broad claim this
 * paragraph's own first draft was transcribed from verbatim -- both need
 * this same correction, and only this one has had it made so far.
 */
export function planCrop(input   
                   
                     
                      
                                                                        
                     
     
                                                                             
                                                                           
                                                                            
                                                   
     
                         
     
                                                                             
                                                                      
                                                                          
                                                                             
                                                         
     
                    
                                                        
                  
     
                                                                         
                                                                    
                                                                            
                                                                        
                                                                        
                                                                        
                                                             
     
                       
     
                                                                    
                                                                            
                                                               
     
                            
 )                                                        {
  const speaker = chooseSpeaker(input.faces, MOTION_FLOOR, input.subjectRule);
  if (speaker === null) return { placement: { kind: "fit" }, speaker: null };

  const { frameWidth, frameHeight, output } = input;

  // Fixed for the whole shot, every one of these read once from the
  // summarised (medianed) face:
  //   - `size`, because ffmpeg's `crop` evaluates w/h once at configuration
  //     whatever expression they carry;
  //   - `facing` and `eyeLineY` — both which vertical branch `eyeLineY`
  //     selects AND the value that branch reads. `FaceBox.track` carries only
  //     `{t, cx, cy}`, so neither crosses the wire per sample, and unlike the
  //     box edges below there is no sound way to derive either from `cx`:
  //     `cy` is the box's own vertical centre, a different quantity from the
  //     eye line, and the offset between them moves with head tilt. Spec
  //     §5.4 risks 1 and 2, decided on measurement across 45-46 real shots.
  const size = cropSize({
    faceHeight: speaker.height,
    maxUpscale: MAX_UPSCALE,
    faceHeightTarget: FACE_HEIGHT_TARGET,
    frameWidth,
    frameHeight,
    output,
  });
  const perShot = {
    size,
    facing: speaker.facing ?? 0,
    eyeLineY: speaker.eyeLineY ?? null,
    lookingRoom: input.lookingRoom ?? LOOKING_ROOM,
    eyeLineTarget: EYE_LINE_TARGET,
    frameWidth,
    frameHeight,
  };

  // The shot's summarised position — the same arithmetic `cropWindow` runs,
  // so this is exactly the rectangle stage 2 produced. It serves twice: as
  // the placement when nothing moves, and as `smoothPath`'s seed. Seeding at
  // the summarised position rather than at the first sample is what makes a
  // motionless shot settle on precisely this rectangle, which §5.6 gate 3's
  // byte-identical guarantee depends on.
  // The face cluster when keypoints are present, the box centre when they
  // are not — the two coincide on a frontal face and diverge on a profile.
  const summarisedCentreX =
    (speaker.faceCentreX ?? speaker.x + speaker.width / 2) * frameWidth;
  const summarised = cropPosition({
    ...perShot,
    centreX: summarisedCentreX,
    boxLeft: speaker.x * frameWidth,
    boxRight: (speaker.x + speaker.width) * frameWidth,
    centreY: speaker.y + speaker.height / 2,
  });
  const still                = { kind: "crop", rect: { ...size, ...summarised } };

  const track = speaker.track;
  // Under two points there is nothing to smooth: `smoothPath`'s first sample
  // has no predecessor, so it can never move off the seed and the path is the
  // seed by construction.
  if (input.trackEnabled !== true || track === undefined || track.length < 2) {
    return { placement: still, speaker };
  }

  // Varies per sample — and `boxLeft`/`boxRight` land here, the opposite way
  // from `facing` and `eyeLineY` above, on Task 8's measurement rather than
  // on the symmetry of all three coming out of the same detector call. The
  // containment clamp exists to keep the CURRENTLY visible head in frame;
  // anchored to the shot's one representative box while `centreX` moves, it
  // checks containment against a stale, long-gone position — measured
  // divergence beyond the shot's own dead zone in 7 of 45 shots and up to
  // 375px, against 5 of 45 and 162px when both edges are recentred on that
  // sample's own `cx` around the shot's fixed half-width. That recomputation
  // is free, because `centreX` is already per-sample. Spec §5.4 risk 3.
  const halfWidth = (speaker.width * frameWidth) / 2;

  // Fix round 1: the path and the head box live in DIFFERENT spaces, which
  // the spec's own risk-3 bullet did not notice. `track[i].cx` is in
  // face-cluster space while the box is in box space — ~180px apart on a
  // strict profile in a 456px window. Rebuilding the box straight around
  // `cx` therefore hands the seed and every sample a containment box in
  // different spaces, and a perfectly STILL profile computes a different
  // clamp from its own seed: measured on the reported bug's own numbers (box
  // 1027-1338, face cluster at 1000), 882 against 772 — 110px against a
  // 91.2px dead zone, so the window pans on a shot with no subject motion at
  // all. That breaks the byte-identical guarantee on exactly the static
  // shots it protects, and leaves the real head box's far edge outside the
  // window — §4.2b Fix Round 1's regression, on the axis the gate watches.
  //
  // Carrying the shot's fixed face-to-box offset makes the reconstruction
  // reduce EXACTLY to the summarised box when `cx` equals the summarised
  // centre, so a motionless shot agrees with its seed by construction rather
  // than by luck. It is 0 for a face with no keypoints, where `cx` is already
  // the box centre. Same fixed-offset recombination the half-width above
  // already relies on.
  //
  // Which space `cx` is in is a SHOT-level property, not a per-sample one,
  // and the fix round that established that was in Python rather than here.
  // summarise_faces now carries a keypointless sample back into face-cluster
  // space using the shot's own offset before it ever reaches the wire, so
  // every cx in one shot shares one space — the earlier reading, "filled
  // from faceCentreX where it exists", described a per-sample toggle that no
  // longer happens and would have made this offset the wrong correction for
  // some samples and the right one for others. The offset below is still
  // required: the path is in face-cluster space and the box is not.
  const boxOffset = (speaker.x + speaker.width / 2) * frameWidth - summarisedCentreX;

  const xs              = [];
  const ys              = [];
  for (const point of track) {
    const centreX = point.cx * frameWidth;
    // Smoothing runs on `cropPosition`'s CLAMPED output, not on the raw face
    // centre: the clamped value is where the window can actually sit, so a
    // subject walking out of frame stops pushing a target the window is
    // physically unable to reach — which would otherwise hold the dead zone
    // open against an unreachable position for the rest of the shot.
    const boxCentre = centreX + boxOffset;
    const position = cropPosition({
      ...perShot,
      centreX,
      boxLeft: boxCentre - halfWidth,
      boxRight: boxCentre + halfWidth,
      centreY: point.cy,
    });
    xs.push({ t: point.t, v: position.x });
    ys.push({ t: point.t, v: position.y });
  }

  // One dead zone in pixels, shared by both axes — so the VERTICAL tolerance
  // is a fraction of the window's WIDTH, not its height. On a 456x810 window
  // that makes it ~11% of height vertically against 20% of width
  // horizontally, i.e. the window is proportionally more willing to pan up
  // and down than side to side. Recorded rather than changed, because nothing
  // has measured which is better and the alternative (dividing y by
  // size.height) would move every tracked shot's vertical behaviour at once.
  //
  // It was harmless until zoom landed: before that, `height` always equalled
  // frameHeight on any source wider than 9:16 and `y` was pinned at 0, so the
  // vertical dead zone could not fire at all. That is no longer true — spec
  // §7.6c records the Dota crop at 592x1052 with y=71 — so this is now a live
  // asymmetry rather than an inert one.
  const smoothing = {
    deadzone: (input.deadzone ?? TRACK_DEADZONE) * size.width,
    maxPan: input.maxPan ?? TRACK_MAX_PAN,
  };
  const x = compressPath(smoothPath(xs, { ...smoothing, seed: summarised.x }));
  const y = compressPath(smoothPath(ys, { ...smoothing, seed: summarised.y }));

  // Both axes constant means the window never left the seed — i.e. stage 2's
  // own rectangle. Return the plain form rather than a tracked placement
  // whose expression happens to be constant: `crop=456:810:885:0` and
  // `crop=456:810:if(lt(t\\,0)\\,885\\,885):0` are different bytes, and §5.6
  // gate 3 compares a file hash.
  if (x.length <= 1 && y.length <= 1) return { placement: still, speaker };

  return { placement: { kind: "track", path: { size, x, y } }, speaker };
}

/** The face cluster where keypoints exist, the box centre where they do not. */
function centreXOf(face         )         {
  return face.faceCentreX ?? face.x + face.width / 2;
}

/**
 * The WIDTH of the widest window this source allows at the OUTPUT's own
 * aspect ratio — full frame height at that ratio (1080x1920 is the 9:16
 * reference, so this was simply the 9:16 window's width before stage 5 made
 * the ratio a variable). The spread test measures against this rather than
 * against the window cropSize would actually produce, which zoom can make
 * narrower: a stack must fire only when a single window cannot hold the
 * subjects at ANY zoom.
 */
export function baseWindowWidth(frameWidth        , frameHeight        , output            )         {
  return Math.min(frameWidth, frameHeight * targetRatio(output));
}

/** One stacked panel's window: the same geometry as a fill, at twice the
 * output's own aspect ratio (1.125:1 at the 9:16 reference — see
 * `panelSize`). `lookingRoom` is the creator's own per-clip choice (Task
 * 16), same `?? lookingRoomFromEnv()` fallback `planCrop`'s own `perShot`
 * uses -- a stack panel is still a window onto this clip, so it must honour
 * the same per-clip choice a fill or track window would. */
function panelRect(
  face         ,
  frame                                             ,
  output            ,
  lookingRoom                    ,
)           {
  const panel = panelSize(output);
  return cropWindow({
    centreX: centreXOf(face) * frame.frameWidth,
    facing: face.facing ?? 0,
    lookingRoom: lookingRoom ?? LOOKING_ROOM,
    boxLeft: face.x * frame.frameWidth,
    boxRight: (face.x + face.width) * frame.frameWidth,
    faceHeight: face.height,
    eyeLineY: face.eyeLineY ?? null,
    centreY: face.y + face.height / 2,
    maxUpscale: MAX_UPSCALE,
    eyeLineTarget: EYE_LINE_TARGET,
    faceHeightTarget: FACE_HEIGHT_TARGET,
    frameWidth: frame.frameWidth,
    frameHeight: frame.frameHeight,
    output,
    targetRatio: panel.width / panel.height,
  });
}

/**
 * The two subjects a stack shows, top first.
 *
 * Ranked by coverage and then by box area — the best-attested subjects, not
 * the two extremes, so a well-covered pair is never displaced by whoever
 * happens to sit furthest apart. Then ordered by position, because a stable
 * spatial rule cannot silently reorder a stack between renders the way a
 * prominence ranking could.
 *
 * Three or more survivors does not occur anywhere in the four-class reference
 * set, whose largest surviving roster is two. This is therefore defined
 * behaviour rather than measured behaviour.
 */
function stackSubjects(faces           )                     {
  const ranked = [...faces].sort((a, b) => {
    const byCoverage = (b.coverage ?? 1) - (a.coverage ?? 1);
    if (byCoverage !== 0) return byCoverage;
    return b.width * b.height - a.width * a.height;
  });
  // Indexed rather than destructured: `ranked` is a plain FaceBox[], and
  // noUncheckedIndexedAccess can't see that the caller only ever reaches
  // here with 2+ faces (a single-face roster's spread is always 0, which
  // never exceeds baseWindowWidth — see planLayout). Same `!`-on-index-access
  // idiom as track.ts and scenes.ts use for the same reason.
  const first = ranked[0] ;
  const second = ranked[1] ;
  return centreXOf(first) <= centreXOf(second) ? [first, second] : [second, first];
}

/**
 * The fraction of a shot's requested samples in which BOTH faces were
 * detected — how much of the shot a stack of the two would actually show
 * two people. `undefined` when either face carries no track or no coverage
 * (an older helper), which the caller reads as "do not filter", the same
 * rule `coverage` itself follows.
 *
 * Over the whole shot, not over the sparser face's own samples: a face on
 * screen for 9 of 34 samples, every one of them shared, would otherwise read
 * 1.0 and stack a panel that is empty for three quarters of the shot.
 *
 * Shared samples are matched on their timestamps. detect_faces.py stamps
 * every face's track points from the same `sample_time(index, requested,
 * duration)`, rounded to four places, so one sample carries one identical
 * `t` across faces. `requested` is recovered from `coverage`, which is
 * `len(track) / requested` on that side of the seam.
 */
function copresence(a         , b         )                     {
  if (a.track === undefined || b.track === undefined) return undefined;
  if (a.coverage === undefined || a.coverage <= 0) return undefined;
  const requested = Math.round(a.track.length / a.coverage);
  if (requested <= 0) return undefined;
  const seen = new Set(a.track.map((point) => point.t));
  const shared = b.track.filter((point) => seen.has(point.t)).length;
  return shared / requested;
}

/**
 * The faces present for enough of the shot to count as subjects at all.
 * Shared by `planLayout` and `stackAllowed` so the two cannot drift.
 *
 * `coverage === undefined` keeps the face: an older detector emits none,
 * and absent must mean "do not filter" rather than "reject". Reading it as
 * 0 would empty every roster and letterbox every clip, which looks like a
 * deliberate style rather than a broken seam.
 */
function coverageRoster(faces           , minCoverage        )            {
  return faces.filter((face) => face.coverage === undefined || face.coverage >= minCoverage);
}

/**
 * How many of a shot's faces the planner counts (`coverageRoster`, the roster `planLayout` decides Stack on): the
 * editor sidecar's per-shot `faces` (ruling P6-R33), so the editor never offers Stack on a shot the render would fill.
 */
export function countedFaces(faces                    , minCoverage        )         {
  return coverageRoster([...faces], minCoverage).length;
}

/**
 * The co-presence rule: whether two subjects are on screen together for
 * enough of the shot to stack. An unknown co-presence (no tracks) reads as
 * together, the same "absent means do not filter" rule as coverage. Shared by
 * the detector's stack decision (`planLayout`) and a montage two-shot
 * (`stackAllowed`), which has no other co-presence check: a `stack` override
 * skips it inside `planLayout`.
 */
function onScreenTogether(a         , b         , minCopresence        )          {
  const together = copresence(a, b);
  return together === undefined || together >= minCopresence;
}

/**
 * What shape a shot should render as. Spec §4.
 *
 * This is the layer that makes `fit` an editorial choice rather than the
 * fallback for when face detection finds nothing. It reaches `fit` two ways
 * now: no subject at all, and no subject present for enough of the shot to
 * define its framing — the second of which is the whole point, because a
 * detection covering 2% of a shot was framing 100% of it.
 *
 * `planCrop` is called unchanged for every `fill`, so tracking, zoom and the
 * looking-room offset all keep working inside it and cannot drift.
 *
 * Fix round 1 (Important 1): the spread test that decides stack-vs-fill is
 * measured on the PAIR `stackSubjects` would actually draw, never on the
 * whole surviving roster. The original rule measured spread across every
 * survivor and only THEN asked `stackSubjects` for its best-covered two,
 * which need not be the two furthest apart — so a roster of three (two
 * well-covered faces sitting close together, plus a third, sparser one far
 * across the frame) could take the stack branch on the strength of a
 * subject who was then never drawn. `panelRect` on two near-identical
 * positions produced the SAME crop into both panels: the third person cut
 * out entirely, replaced by a duplicate of the other two. Verified against
 * this exact code before the fix: faces at cx 0.10/0.17 (coverage 1.0) plus
 * one at cx 0.90 (coverage 0.60) produced panels
 * `[{810,720,0,72},{810,720,0,72}]`, byte-identical.
 *
 * `stackSubjects`'s own ranking rule (highest coverage, ties by box area) is
 * unchanged and stays the sole authority on WHICH two subjects a stack
 * shows — that selection was never the bug. What moved is only the question
 * asked before ever calling it: not "is the roster spread out" but "would
 * the two subjects we are actually about to show need two panels". A
 * roster of exactly one skips pairing outright (nothing to pair). A roster
 * of exactly two is unaffected by the change: `stackSubjects` returns both
 * of its faces, so the pair IS the roster and the spread is identical to
 * before — confirmed against the reference set, whose only two real stacks
 * (Chaos shots 3 and 5) both have exactly two survivors.
 *
 * Task 16: a creator's own per-shot choice from the editor's Layout panel
 * (`override`) slots in AFTER the coverage filter and BEFORE the decision —
 * the same position `forceFit` already occupies, and `forceFit` still wins
 * when both are present: a genre that pins every shot is a property of the
 * CONTENT, where `series_film` would render nonsense under a `stack`
 * override on a shot with no second subject at all. Detection still runs
 * and `dropped` is still reported regardless of the override, the same
 * reason `forceFit` does not skip the coverage filter either — an override
 * is a decision layered on top of the evidence, not a reason to stop
 * gathering it.
 *
 *   `fit`   — the whole frame, speaker null, unconditionally. Identical
 *             reasoning to `forceFit`'s own `fit` branch: a fit shot aims
 *             at NOTHING, so returning a speaker would hand the editor's
 *             tracker overlay a confidence-labelled box for a face the
 *             render never aimed at.
 *   `stack` — forced whenever the roster has 2+ survivors, regardless of
 *             `pairSpread`. The spread test exists to stop the DETECTOR
 *             stacking on a subject it would then not show (Fix round 1,
 *             above); it has no business second-guessing a creator who
 *             clicked Stack outright. Fewer than 2 survivors cannot stack
 *             at all — `stackSubjects` needs a pair — so that falls through
 *             to the ordinary `planCrop` call below rather than to `fit`:
 *             the honest degradation is whatever this shot would have got
 *             anyway, not a blind letterbox for a creator who chose neither.
 *   `fill`  — the ordinary `planCrop` branch, skipping the stack question
 *             outright (a creator who chose `fill` has already decided this
 *             shot is one window, not two) and with tracking forced OFF for
 *             this one shot: `fill` only ever NARROWS, which is always safe
 *             to allow regardless of the operator's own switch.
 *   `track` — the same branch as `fill`, requesting tracking rather than
 *             forcing it off. The operator's kill switch still wins — a
 *             per-clip override is a project row by another name, and "a
 *             project row must not keep a feature alive after an operator
 *             has killed it" is the same rule `RENDER_BRANDING_ENABLED` and
 *             `resolveRenderRecipe` already state. Concretely this means
 *             requesting and narrowing resolve to the SAME expression below
 *             (`input.override === "fill" ? false : input.trackEnabled`):
 *             `track` simply passes `input.trackEnabled` through unchanged,
 *             which is already what an ordinary (non-overridden) `fill`
 *             does — a shot overridden to track on a deployment with
 *             tracking killed renders exactly as fill would have.
 *
 * `lookingRoom`, when given, replaces the `RENDER_LOOKING_ROOM` env read for
 * every window THIS CLIP renders — `planCrop`'s own `perShot.lookingRoom`
 * and `panelRect`'s stack-panel geometry alike — because it is a per-CLIP
 * choice, independent of any one shot's override. When it is `undefined`
 * the env read happens exactly as it did before this parameter existed,
 * which is what keeps a clip with no per-clip choice byte-for-byte
 * unchanged.
 */
export function planLayout(input   
                   
                     
                      
                                                                         
                     
                                                                                
                      
     
                                                                            
                                                                      
                                                                              
     
                        
                         
                    
                  
     
                                                                          
                                                                            
                                                                         
                           
     
                     
     
                                                                          
                                                                        
                                                                        
                                                                           
                                                                          
                                                                        
                                                                           
                                                                          
     
                        
     
                                                                       
                                      
     
                       
     
                                                                            
                                                                  
                                                                          
                     
     
                            
 )   
                           
                          
                  
                                                                               
                        
  {
  const roster = coverageRoster(input.faces, input.minCoverage);
  const dropped = input.faces.length - roster.length;

  // Placed after the coverage filter rather than before it so `dropped` is
  // still reported truthfully — the "faces below the coverage floor" log
  // line reads the count regardless of forceFit. Detection is not skipped;
  // only its influence on the placement is.
  //
  // `speaker` is null here, same as every other `fit` result (see this
  // function's other `fit` branches and `planCrop`'s own doc comment: "null
  // exactly when placement is `{kind: "fit"}`"). A forced-fit shot aimed at
  // NOTHING — the whole frame, not any one face — so returning `roster[0]`
  // here would hand the editor's tracker overlay a confidence-labelled box
  // for a face the render never aimed at, on every shot of the one genre
  // where every shot is `fit`. `roster[0]` is detector emission order, not
  // `chooseSpeaker`'s pick, so it was never even the "best" face to lie
  // about.
  if (input.forceFit === true) {
    return { placement: { kind: "fit", chosen: true }, speaker: null, dropped, stackRefused: false };
  }

  // The creator's own `fit` choice — same reasoning and the same null
  // speaker as `forceFit` above, one paragraph up. Checked before the
  // roster-empty fallback below so the two reach the identical result by
  // the same branch's own logic rather than by two branches agreeing.
  if (input.override === "fit") {
    return { placement: { kind: "fit", chosen: true }, speaker: null, dropped, stackRefused: false };
  }

  if (roster.length === 0) {
    return { placement: { kind: "fit" }, speaker: null, dropped, stackRefused: false };
  }

  // Only a roster of 2+ can possibly stack — `stackSubjects` needs a pair to
  // rank. `fill` and `track` skip this question outright (see this
  // function's own doc comment): a creator who chose either has already
  // decided this shot is one window, not two.
  let stackRefused = false;
  if (roster.length >= 2 && input.override !== "fill" && input.override !== "track") {
    const [left, right] = stackSubjects(roster);
    const pairSpread = (centreXOf(right) - centreXOf(left)) * input.frameWidth;

    // A `stack` override fires regardless of spread and co-presence — both
    // tests exist to stop the DETECTOR stacking on a subject it would then
    // not show, not to second-guess a creator's own deliberate choice.
    //
    // Co-presence is the second half of that: two people far apart is not
    // two people on screen at once. Measured 2026-10-02 on a moving bodycam
    // shot (clip 93216314), each deputy was detected in a quarter of the
    // samples and never in the same one, so both static panels showed sky
    // or an empty car park for most of 17 seconds.
    const apart = pairSpread > baseWindowWidth(input.frameWidth, input.frameHeight, input.output);
    const together = onScreenTogether(left, right, input.minCopresence);
    stackRefused = input.override !== "stack" && apart && !together;

    if (input.override === "stack" || (apart && together)) {
      return {
        placement: {
          kind: "stack",
          panels: [
            panelRect(left, input, input.output, input.lookingRoom),
            panelRect(right, input, input.output, input.lookingRoom),
          ],
        },
        // The top panel's subject. `speaker` stays non-null except for
        // `fit`, so an instrument reading the output still knows which face
        // was aimed at.
        speaker: left,
        dropped,
        stackRefused: false,
      };
    }
  }

  // Reaches here for: a single survivor; an override of `fill` or `track`
  // (which never consider stacking at all); a `stack` override with fewer
  // than two survivors (not expressible — the honest degradation is
  // whatever this shot would have got anyway, not a blind letterbox); or
  // 2+ whose chosen pair fits one window under the DETECTOR's own decision
  // — which now also covers a roster with an outlier that isn't one of the
  // two `stackSubjects` would show, per the Fix round 1 comment above; or a
  // pair too far apart for one window that is not on screen together often
  // enough to stack (`stackRefused`), which then frames one of them.
  // `planCrop` still gets the WHOLE roster, not just the pair: a fill among
  // 2+ close subjects already ran `chooseSpeaker` over all of them before
  // this change, and that behaviour is unchanged.
  //
  // Named fields rather than `{ ...input, faces: roster }`: the spread
  // would carry `minCoverage`, which planCrop does not declare, and
  // TypeScript's excess-property check applies to a fresh object literal
  // even when its properties come from a spread.
  const { placement, speaker } = planCrop({
    faces: roster,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    output: input.output,
    // `fill` only ever NARROWS (turns tracking off for this one shot,
    // always allowed); every other case here -- `track`, no override, or a
    // `stack` override that fell through for want of a second subject --
    // passes the caller's own value through unchanged, which is what makes
    // `track` a REQUEST rather than a force: the operator's kill switch
    // still wins. See this function's own doc comment above.
    trackEnabled: input.override === "fill" ? false : input.trackEnabled,
    deadzone: input.deadzone,
    maxPan: input.maxPan,
    lookingRoom: input.lookingRoom,
    subjectRule: input.subjectRule,
  });
  return { placement, speaker, dropped, stackRefused };
}

/**
 * Whether a shot could stack (M2 spec §5.2, `two-shot`): two surviving
 * subjects that are on screen together often enough, the detector's own
 * co-presence rule. Unlike the detector, it does not ask that they be too far
 * apart for one window -- a two-shot intent asks for both faces large.
 */
export function stackAllowed(input                                                                  )          {
  const roster = coverageRoster(input.faces, input.minCoverage);
  if (roster.length < 2) return false;
  const [left, right] = stackSubjects(roster);
  return onScreenTogether(left, right, input.minCopresence);
}

// ---- Cut: the framing tunables, from apps/worker/src/render/config.ts ------------------------------------
//
// Each is the code default of the reader named in its first line (the production worker sets none of them; see the
// note at the top of this file). Their doc comments follow, as boqo wrote them.

/**
 * `maxUpscaleFromEnv()`, RENDER_MAX_UPSCALE default 2.5.
 *
 * Ceiling on the total upscale from source pixels to the 1080-wide output.
 *
 * Zoom compounds an upscale that is already large: a 456x810 window from a
 * 1920x810 source is upscaled 2.37x before any zoom at all. At a 2.5 ceiling
 * that source permits 1.06x — **essentially nothing, and correctly so**. A
 * 2560x1440 source starts at 1.33x and permits 1.88x, which is where zoom
 * does real work.
 *
 * Measured (Task 17, spec §7.3e), against both retained real sources: the
 * Dota 2560x1440 source's crop went `810:1440:855:0` -> `624:1108:1002:64` —
 * total upscale 1080/624 = 1.73x, comfortably inside the ceiling. The podcast
 * moved in only 2 of its 5 shots, by exactly 456->432 wide, landing at
 * 1080/432 = 2.5x — the ceiling itself, which confirms the arithmetic above
 * rather than contradicting it: 456px is already a 2.37x upscale, so there
 * was never more than about 5% of headroom to spend there.
 */
export const MAX_UPSCALE = 2.5;

/**
 * `eyeLineTargetFromEnv()`, RENDER_EYE_LINE_TARGET default 0.33.
 *
 * Where the subject's eye line sits in the output, as a fraction of its
 * height. The upper third is the standard portrait convention: it leaves
 * head-room above and puts the shoulders in frame below, rather than
 * centring the eyes and filling the lower half with a microphone.
 *
 * Measured (Task 17, spec §7.3e): confirmed by looking at a rendered frame
 * from the Dota 2560x1440 source, the one retained source where the eye line
 * is not immediately pinned to the top by the upscale ceiling — `y` moved off
 * 0 for the first time, to 64, landing the eye line in the upper third rather
 * than centred. The podcast's crop stayed pinned at y=0 across the sweep,
 * which is expected: it never zooms far enough to have vertical room to
 * spend (see maxUpscaleFromEnv).
 */
export const EYE_LINE_TARGET = 0.33;

/**
 * `faceHeightTargetFromEnv()`, RENDER_FACE_HEIGHT_TARGET default 0.3.
 *
 * How tall the detected head box — the whole head including hair, driven by
 * `speaker.height`, not the face itself (see FaceBox's own doc comment on
 * that distinction) — should be in the output, as a fraction of output
 * height: the zoom target. Larger means a tighter head-and-shoulders
 * framing. Bounded in practice by maxUpscaleFromEnv, which is why it does
 * nothing on a cinemascope source.
 *
 * Measured (Task 17, spec §7.3e): 0.3 is what produced the Dota crop recorded
 * on maxUpscaleFromEnv above — `810:1440:855:0` -> `624:1108:1002:64`, a
 * 1.30x zoom that lands well inside the 2.5x ceiling — confirmed by looking
 * at the extracted frame rather than by the arithmetic alone.
 */
export const FACE_HEIGHT_TARGET = 0.3;

/**
 * `lookingRoomFromEnv()`, RENDER_LOOKING_ROOM default 0.15.
 *
 * How far the crop window shifts toward the direction a subject is facing, as
 * a fraction of the window's own width.
 *
 * A subject facing left wants the empty space on their left, and today's crop
 * gives it to the right, behind the head. Worked through on the measured
 * profile at 0.15: the window moves from 954-1410 to 691-1147, putting the
 * face cluster at 0.60-0.76 of the window instead of 0.02-0.18. The back of
 * the head then falls outside, which is the intent — crop hair, not face.
 *
 * That is arithmetic, not a measurement. Task 17 (not Task 15, which is the
 * motion floor below) settled it against real renders: re-rendered at 0.10,
 * 0.15 and 0.20 on the reported profile clip and judged by eye — 0.15, the
 * default above, is where the face clears the edge without pushing the
 * subject out of frame.
 */
export const LOOKING_ROOM = 0.15;

/**
 * `motionFloorFromEnv()`, RENDER_MOTION_FLOOR default 1.5e-6.
 *
 * Below this, mouth motion is noise rather than speech.
 *
 * A **different quantity** from the constant this replaces. The old
 * MOTION_FLOOR of 1e-5 was a variance of mesh-derived openness in
 * window-normalised units, calibrated against five real talking shots. This
 * is a variance of the mouth's drop below the eye line over face height
 * (detect_faces.py's `mouthDrop`), so the old number does not transfer at
 * any scale and was deliberately not carried over.
 *
 * Measured by running both signals across the same ten real shots of the
 * podcast source, each a person talking continuously:
 *
 *   mesh      8.16e-05  4.49e-06  2.99e-05  8.28e-06  8.82e-06
 *             8.12e-05  3.54e-05  2.87e-05  8.40e-08  3.20e-05
 *   keypoint  4.51e-05  2.06e-05  4.54e-06  1.65e-05  2.28e-05
 *             2.56e-04  2.62e-05  8.27e-05  3.78e-05  4.34e-05
 *
 * The mesh collapses to 8.40e-08 — effectively zero — on the one shot where
 * the keypoint signal reads 3.78e-05: a real talking shot the mesh goes
 * blind on and the keypoint signal does not. The keypoint signal's weakest
 * reading is 4.54e-06 and it never collapses across any of the ten. That
 * comparison, not just the profile failure stage 1 already found, is why
 * the mesh is now deleted from detect_faces.py entirely rather than merely
 * superseded here.
 *
 * 1.5e-6 sits below that weakest reading (4.54e-6) with roughly 3x margin —
 * the same construction the old MOTION_FLOOR used. Honest limitation: this
 * footage contains no labelled still face, so the floor is validated only
 * from below — it admits every real talking shot measured. Nothing here
 * measures a still face, so there is no confirmed value for it to sit
 * under; re-measure against one before trusting the upper side of this
 * floor.
 *
 * A runtime variable rather than a constant for the reason every render
 * tunable is one: it needs iteration against real footage, and tuning must
 * not need a deploy.
 */
export const MOTION_FLOOR = 1.5e-6;

/**
 * `trackDeadzoneFromEnv()`, RENDER_TRACK_DEADZONE default 0.2.
 *
 * How far the target may drift before the window follows, as a fraction of
 * the CROP window's width, not the frame's. What makes an offset matter is
 * its size relative to the window the viewer sees; the two differ by more
 * than 4x on a 1920px source cropped to 456px.
 */
export const TRACK_DEADZONE = 0.2;

/**
 * `trackMaxPanFromEnv()`, RENDER_TRACK_MAX_PAN default 200.
 *
 * Maximum pan speed in SOURCE pixels per second.
 *
 * It caps how fast the window travels once smoothPath has already decided to
 * move; it has no say in *whether* to move. That distinction is the one an
 * operator needs and the unit alone does not give: the dead zone
 * (trackDeadzoneFromEnv) is what prevents jitter, and lowering this instead
 * buys none of it — the window still starts moving at exactly the same
 * moments, only slower, so a twitch becomes a slow drift rather than
 * disappearing. What it does cost is fast subjects: a person crossing the
 * frame outruns a low cap and walks out of the window. Chase jitter with the
 * dead zone; reach for this only when a pan that everyone agrees should
 * happen is happening too abruptly.
 */
export const TRACK_MAX_PAN = 200;
