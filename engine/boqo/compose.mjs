// ported from boqo-ai/boqo apps/worker/src/render/compose.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo packages/core/src/brand-backdrop.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo apps/worker/src/render/config.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
//
// The skill renders one copy of a clip, with no hook, no boqo lockup, hard cuts and the standard look, so the inputs
// `buildFilterGraph` and `composeArgs` take for anything else are cut, each to the constant the skill renders with:
// - `hook` (R5) and its helpers (`ComposeHook`, `hookTransitionFrames`, `hookFadeStartSec`, `hookFrameGuardSec`,
//   `hookPlanProblem`, `joinHookVideo`, `hookAudioStages`, `sec6`): no hook;
// - `cutaways` (M2 stock B-roll, `ComposeCutaway`, `cutawayStages`, `cutawayInputs`): `montage: false`, `broll: false`;
// - `viral` (`ComposeViral`, `captionAndBrandingStages`'s progress bar, the text hook pass, `sfx`, `sfxInputs`,
//   ./viral-overlays): the Viralizator is not part of the skill;
// - `branding` (`BrandingOverlay`, the boqo lockup's mark and ASS, ./branding's `markGeometry` and `LOGO_FADE_SEC`):
//   the skill never draws boqo's own mark; a brand kit's logo is `brandLogo`;
// - `uniqueize` (`isIdentityRecipe`, ./uniqueize-filters): the skill renders copy 0, whose recipe is the identity, so
//   the graph is the inactive branch, always;
// - `shotTransitions` (`foldShotChain`, ./shot-transitions): no transitions, every join a hard cut (R3, the Default
//   template), so the joins are the n-way `concat`;
// - `censor` (B4 Audio Enhance): the skill censors nothing;
// - `gradeWindows` (#192's Illustrated look, ./illustrated-grade, `ILLUSTRATED`): the standard look;
// - `hasAudio`: with none of the above, no stage reads the audio, so the graph never writes `[aout]` and
//   `composeArgs`' `mapFilteredAudio` is always false: the audio is the source's, `-map 0:a?`.
// Kept as boqo has them: the five placement branches, `escapeFilterPath`, the text passes (captions, headline,
// text below), `brandLogo` with its `enableFromSec`, `backdrop` and `blurSigma`, and `composeArgs`' threads, logo
// input and progress stream.
// `DEFAULT_BACKDROP` and `backdropFfmpegColour` are copied from core's brand-backdrop.ts (its zod schema is not:
// the brand kit carries no backdrop, so the render passes none and the Default template's blur applies).
// `RENDER_FALLBACK_BLUR_SIGMA` (config.ts `fallbackBlurSigmaFromEnv`, default 40, unset on the production worker) is
// `FALLBACK_BLUR_SIGMA` below, the `blurSigma` the skill's render passes.
// One addition: `subtitles`, how a pass's file becomes a filter (boqo's `subtitles=<escaped path>` by default). The
// skill's fonts are bundled, not installed, so its render passes a builder that names the fonts folder too
// (engine/captions.mjs `subtitlesFilter`); with the default every string is boqo's.
import { panelSize } from "./crop.mjs";
import { POSTED_VIDEO_ENCODE } from "./posted-encode.mjs";
import { pathExpression } from "./track.mjs";

// ---- packages/core/src/brand-backdrop.ts

export const DEFAULT_BACKDROP = { kind: "blur" };

/** ffmpeg's colour syntax for a filled backdrop: `0xRRGGBB`. Only black and
 *  colour fill anything; blur and crop have no colour to give. */
export function backdropFfmpegColour(backdrop) {
  return backdrop.kind === "black" ? "0x000000" : `0x${backdrop.hex.slice(1).toUpperCase()}`;
}

// ---- apps/worker/src/render/config.ts

/** `fallbackBlurSigmaFromEnv()`, RENDER_FALLBACK_BLUR_SIGMA default 40: the blur behind a `fit` shot. */
export const FALLBACK_BLUR_SIGMA = 40;

// ---- apps/worker/src/render/compose.ts

/**
 * A project's own logo, replacing the boqo lockup (spec §2.3).
 *
 * `chain` arrives complete from render/brand.ts — this module composes the
 * graph and does not compute geometry, so the two cannot disagree about what
 * a fraction of the frame means.
 *
 * (The type, as a typedef; its field notes are boqo's.)
 * - `chain`: the whole `[1:v] … [blogo]` stage.
 * - `x`, `y`: `overlay`'s x and y, which may be expressions in W, H, w and h.
 * - `enableFromSec`: R5: the file second the logo first shows, the hook's lead. Omitted: the overlay is drawn over
 *   the whole file and its string is today's.
 * @typedef {{ chain: string, x: string, y: string, enableFromSec?: number }} BrandLogoOverlay
 */

/**
 * How far past the lead a logo's `enable` threshold sits: one frame of the
 * looped still on input 1, which `composeArgs` adds with no `-framerate` and
 * so reads at image2's default 25 fps (a render-compose test pins the absent
 * `-framerate`).
 *
 * Measured 2026-10-03 on a 30 fps hooked graph with a 7 s lead: with the
 * threshold at exactly 7, production's ffmpeg 5.1.9 (the boqo-render image)
 * drew the logo on the hook's LAST frame, 6.967 s, inside the transition; at
 * 7.001 it began at 7.033 s. Local 8.1.2 began at 7.033 s at both, because the
 * clip's first frame reached the overlay stamped 6.999996 s.
 *
 * The likely reason, inferred from those numbers and not read from 5.1.9's
 * source: its overlay evaluates `enable` against the newest frame it has
 * taken from EITHER input, and to place the still under main frame p it may
 * already hold the still's next frame, up to 1/25 s past p. Hence a margin of
 * one still-frame. With it, on 5.1.9, at leads of 6.967, 7, 7.033 and 7.1 s
 * (30 fps): no hook frame carried the logo, and it began one or two frames
 * into the clip. Early puts a logo on the hook (Review Focus 1); late costs
 * at most a few tens of milliseconds of logo.
 */
const LOGO_ENABLE_MARGIN_SEC = 1 / 25;

/**
 * ffmpeg's filter parser treats `:` as an argument separator and `\` as an
 * escape, both of which appear in real paths. Only relevant for `subtitles=`,
 * which is the one filter here that takes a filename.
 */
export function escapeFilterPath(path        )         {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}


/**
 * A shot with a subject: crop to the chosen window, then fit that window to
 * the output frame.
 */
function cropBranch(index        , shot      , rect          , output            )         {
  return [
    `[0:v]trim=start=${shot.startSec}:end=${shot.endSec}`,
    // Without setpts the concatenated segments keep their original
    // timestamps, and the output freezes on the first frame of shot two.
    "setpts=PTS-STARTPTS",
    `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`,
    // Scale and pad rather than stretch: the crop is at the output's own
    // aspect ratio by construction (9:16 at the reference size) but rounding
    // to even dimensions leaves it a fraction off, and a source narrower
    // than that ratio is not cropped to it at all.
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease`,
    `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2`,
    // concat matches sample aspect ratio, not just pixel dimensions, and the
    // rounding inside each branch's own scale leaves them with different
    // SARs. Measured at the 9:16 reference: without this the two branches
    // reach concat at 40960:40959 and 18221:18225 — both 1080x1920 — and
    // ffmpeg refuses with "Input link parameters do not match". Every string
    // assertion in the tests still passes, so this is only visible by
    // running ffmpeg.
    `setsar=1[v${index}]`,
  ].join(",");
}

/**
 * A shot whose subject moves: the same chain as `cropBranch`, with `crop`'s
 * x and y given as expressions in `t` rather than as integers. `crop`
 * evaluates `w`/`h` once at configuration but `x`/`y` per frame, which is why
 * only the position can travel and the size is fixed for the whole shot.
 *
 * `setpts=PTS-STARTPTS` MUST precede `crop`, and that ordering is the whole
 * reason a path resets at every cut without any code remembering to reset
 * it. setpts rebases the segment's timestamps to zero, so the `t` the crop
 * expression reads is shot-relative; each shot's path is therefore written in
 * its own time base and simply cannot leak across a cut. Verified through a
 * real `concat`: at output 6s a shot-relative `t` places a reference marker
 * at column 201.5 where a global `t` would have placed it at 81.5 — measured
 * 201.5. Reorder these two filters and the crop pans *across* a cut instead,
 * which the design spec calls worse than no tracking at all, and no string
 * assertion in the tests would notice.
 *
 * `pathExpression` already escapes the commas the filtergraph parser would
 * otherwise split on; its output is interpolated as-is, never re-escaped.
 */
function trackBranch(index        , shot      , path          , output            )         {
  return [
    `[0:v]trim=start=${shot.startSec}:end=${shot.endSec}`,
    "setpts=PTS-STARTPTS",
    `crop=${path.size.width}:${path.size.height}:` +
      `${pathExpression(path.x)}:${pathExpression(path.y)}`,
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease`,
    `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2`,
    `setsar=1[v${index}]`,
  ].join(",");
}

/**
 * A `fit` placement: the whole frame over the brand's backdrop (a blurred,
 * frame-filling copy of itself by default; black or a brand colour pad
 * otherwise) -- or, under Crop to Fill, cover-scaled and centre-cropped with
 * no backdrop at all.
 *
 * Fit is what a shot with no detectable subject falls back to, and the
 * reason it replaced a centre crop there: on cinematic framing the centre
 * aims at the emptiest part of the picture -- subjects sit at the edges or
 * the thirds. Crop to Fill brings that centre crop back by the creator's own
 * choice (spec §6.7 #6), for exactly those AUTOMATIC fits: they chose to
 * lose the edges rather than see a backdrop. A fit that was asked for
 * (`placement.chosen`: the creator's per-shot Fit, the series_film genre's
 * pin, a Montage `wide` beat) is the more specific choice and keeps its
 * letterbox, drawn over the default blur (ruling P7-R18).
 */
function fitBranch(
  index        ,
  shot      ,
  placement                                         ,
  blurSigma        ,
  output            ,
  brandBackdrop                = DEFAULT_BACKDROP,
)         {
  const backdrop = brandBackdrop.kind === "crop" && placement.chosen === true ? DEFAULT_BACKDROP : brandBackdrop;
  // Crop to Fill: the frame scaled up until it covers the output and
  // centre-cropped -- the blur branch's own background step, sharp and
  // alone. setsar=1 as every other branch, for concat.
  if (backdrop.kind === "crop") {
    return (
      `[0:v]trim=start=${shot.startSec}:end=${shot.endSec},setpts=PTS-STARTPTS,` +
      `scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,` +
      `crop=${output.width}:${output.height},setsar=1[v${index}]`
    );
  }
  // Black or a brand colour (caption styles §5.3): the sharp frame
  // letterboxed straight onto a fill, the same `scale…decrease,pad` pair
  // cropBranch letterboxes with. Not a separate `color` source, so there is
  // no second input whose frame rate and timestamps must match the source's.
  if (backdrop.kind !== "blur") {
    return (
      `[0:v]trim=start=${shot.startSec}:end=${shot.endSec},setpts=PTS-STARTPTS,` +
      `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,` +
      `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=${backdropFfmpegColour(backdrop)},` +
      `setsar=1[v${index}]`
    );
  }
  return [
    `[0:v]trim=start=${shot.startSec}:end=${shot.endSec},` +
      `setpts=PTS-STARTPTS,split[fg${index}][bg${index}]`,
    // `increase` then crop: the background must cover the output, so it is
    // scaled up until it overflows and then trimmed, never stretched.
    `[bg${index}]scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,` +
      `crop=${output.width}:${output.height},gblur=sigma=${blurSigma}[bb${index}]`,
    `[fg${index}]scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease[fs${index}]`,
    // setsar=1 for the same reason cropBranch carries it: concat compares
    // sample aspect ratio, and these two branches round to different ones.
    `[bb${index}][fs${index}]overlay=(W-w)/2:(H-h)/2,setsar=1[v${index}]`,
  ].join(";");
}

/**
 * A shot with two subjects a single window cannot hold: two full-width panels
 * stacked, each an independently positioned crop of the SAME frame, so both
 * subjects are on screen at once instead of one being discarded.
 *
 * One `split` rather than two `trim`s: both panels read the same instant of
 * the same shot, and trimming twice would decode it twice.
 *
 * `increase` then `crop`, where cropBranch uses `decrease` then `pad`. A
 * full-bleed crop may legitimately letterbox when the source is narrower
 * than the OUTPUT's own aspect ratio; a panel never may, because black bars
 * *inside* a stack read as a broken layout rather than an honest one. The
 * source rect is twice the output's own aspect ratio by construction —
 * 1.125:1 at the 9:16 reference size, see `panelSize` — so this correction
 * is at most a few pixels of horizontal overflow, never a real crop.
 *
 * `setsar=1` on each panel and again after `vstack`, for the reason
 * cropBranch carries it: `vstack` requires equal input widths (both panels
 * share the OUTPUT's own width by construction — 1080 at the 9:16
 * reference) and `concat` compares sample aspect ratio, which every string
 * assertion in the tests is blind to.
 */
function stackBranch(
  index        ,
  shot      ,
  panels                     ,
  output            ,
)         {
  const inputs = panels.map((_, i) => `[s${index}_${i}]`).join("");
  const outputs = panels.map((_, i) => `[p${index}_${i}]`).join("");
  const panel = panelSize(output);

  return [
    `[0:v]trim=start=${shot.startSec}:end=${shot.endSec},` +
      `setpts=PTS-STARTPTS,split=${panels.length}${inputs}`,
    ...panels.map(
      (rect, i) =>
        `[s${index}_${i}]crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},` +
        `scale=${panel.width}:${panel.height}:force_original_aspect_ratio=increase,` +
        `crop=${panel.width}:${panel.height},setsar=1[p${index}_${i}]`,
    ),
    `${outputs}vstack=inputs=${panels.length},setsar=1[v${index}]`,
  ].join(";");
}

/**
 * Splits `total` into `count` even widths that add up to it exactly, the
 * spare pairs of pixels going to the leftmost slots. `hstack` puts the slots
 * side by side and `vstack` then refuses a top band whose width is not the
 * game band's, so the camera slots must sum to the output's width on any
 * split, not just one `count` divides evenly.
 */
function slotWidths(total        , count        )           {
  const base = 2 * Math.floor(total / (2 * count));
  const widths = Array.from({ length: count }, () => base);
  let spare = total - base * count;
  for (let i = 0; spare >= 2; i = (i + 1) % count, spare -= 2) widths[i]  += 2;
  // Only an odd `total` leaves one pixel; every output size is even.
  if (spare === 1) widths[count - 1]  += 1;
  return widths;
}

/**
 * A stream panel shot (#293, spec §6.2): the cameras side by side in a top
 * band `topHeight` tall, over the game window scaled to the band beneath.
 *
 * One `split` for every camera and the game, as `stackBranch` does, and
 * `setpts=PTS-STARTPTS` before it, so the game window's path reads a
 * shot-relative `t` and resets at every cut (see `trackBranch`).
 *
 * Each camera is `increase` then `crop`, as a stack panel: its rect is
 * already at the slot's aspect, so this trims at most the rounding, and a
 * camera never letterboxes. The game window is a plain `scale`: it is at
 * the game band's aspect by construction (panels-plan.ts `gameWindow`).
 *
 * `setsar=1` on every input to `hstack`/`vstack` and again on the result,
 * for the reason cropBranch carries it: concat compares sample aspect ratio.
 */
function panelsBranch(
  index        ,
  shot      ,
  placement                                            ,
  output            ,
)         {
  const { cameras, game, topHeight } = placement;
  const widths = slotWidths(output.width, cameras.length);
  const splits = cameras.map((_, i) => `[s${index}_${i}]`).join("") + `[s${index}_g]`;
  const tops = cameras.map((_, i) => `[p${index}_${i}]`).join("");
  const top = cameras.length > 1 ? `[pt${index}]` : tops;

  return [
    `[0:v]trim=start=${shot.startSec}:end=${shot.endSec},` +
      `setpts=PTS-STARTPTS,split=${cameras.length + 1}${splits}`,
    ...cameras.map(
      (rect, i) =>
        `[s${index}_${i}]crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},` +
        `scale=${widths[i]}:${topHeight}:force_original_aspect_ratio=increase,` +
        `crop=${widths[i]}:${topHeight},setsar=1[p${index}_${i}]`,
    ),
    `[s${index}_g]crop=${game.size.width}:${game.size.height}:` +
      `${pathExpression(game.x)}:${pathExpression(game.y)},` +
      `scale=${output.width}:${output.height - topHeight},setsar=1[pg${index}]`,
    ...(cameras.length > 1 ? [`${tops}hstack=inputs=${cameras.length}${top}`] : []),
    `${top}[pg${index}]vstack=inputs=2,setsar=1[v${index}]`,
  ].join(";");
}

                                
                         
                                  
                                   
                                    
                                      
                                                                     
                                                                        
                                                                            
                     
                              
  


/** boqo's own pass: `subtitles=` and the file's path, escaped for the filter parser. */
const boqoSubtitles = (path) => `subtitles=${escapeFilterPath(path)}`;

/**
 * The caption and logo stages, reading from `fromLabel` and writing `toLabel`.
 *
 * (boqo's `captionAndBrandingStages` wraps this with the Viralizator's progress bar, and with no bar is this function
 * itself; the skill draws no bar, so this is called directly. Its boqo-mark branch is cut with `branding`.)
 *
 * @param {{ assPath: string | null, headlineAssPath?: string | null, textBelowAssPath?: string | null,
 *   brandLogo?: BrandLogoOverlay | null, subtitles?: (path: string) => string }} input
 * @param {string} fromLabel
 * @param {string} toLabel
 * @returns {string[]}
 */
function textAndOverlayStages(input, fromLabel, toLabel) {
  const brandLogo = input.brandLogo ?? null;
  const subtitles = input.subtitles ?? boqoSubtitles;

  // Every burned-in text pass, in draw order, each with its own `subtitles`
  // filter. The headline gets its own file rather than extra events inside
  // captions.ass because the `none` preset writes no caption file at all and
  // `classic` is the frozen SHA-256 control arm -- see render/headline.ts.
  //
  // The label names are per-PASS rather than per-index, so a clip carrying
  // only a headline does not emit a stage called `[vcapped]`. The filter
  // graph is read by a human at every acceptance gate, and a label that
  // names the wrong thing is the cheapest possible way to mislead one.
  const passes = [];
  // Caption styles P3 (ruling R2): ASS layers order events only inside one
  // file, so the text layers under the Captions layer get their own pass,
  // drawn first; those over it stay in headline.ass, after.
  const textBelowAssPath = input.textBelowAssPath ?? null;
  if (textBelowAssPath !== null) passes.push({ label: "[vtextb]", path: textBelowAssPath });
  if (input.assPath !== null) passes.push({ label: "[vcapped]", path: input.assPath });
  const headlineAssPath = input.headlineAssPath ?? null;
  if (headlineAssPath !== null) passes.push({ label: "[vhead]", path: headlineAssPath });

  /**
   * Chains the passes from `fromLabel`, with the last one writing `endLabel`.
   *
   * With exactly one pass this returns the single string this function
   * emitted before the headline existed, and with none it returns the
   * pass-through -- which is what makes a headline-free clip byte-identical
   * by construction rather than by a comparison after the fact.
   */
  const textStages = (endLabel) =>
    passes.length === 0
      ? [`${fromLabel}null${endLabel}`]
      : passes.map(
          (pass, index) =>
            `${index === 0 ? fromLabel : passes[index - 1].label}` +
            subtitles(pass.path) +
            `${index === passes.length - 1 ? endLabel : pass.label}`,
        );

  if (brandLogo === null) {
    return textStages(toLabel);
  }

  // An overlay reads whatever the last text pass wrote; with no passes at all
  // it reads `fromLabel` directly and no `null` filter is emitted, exactly as
  // before.
  const captionStage = passes.length === 0 ? [] : textStages(passes[passes.length - 1].label);
  const overlayFrom = passes.length === 0 ? fromLabel : passes[passes.length - 1].label;

  // No second subtitles filter: the boqo lockup's text is an ASS event and
  // a brand logo is only an image.
  //
  // R5: from just past the lead, so no logo pixel lands on the hook. `\\,`
  // is the escape `censorAudioChain`'s `between()` uses, so the graph
  // parser does not split `gte()` at its comma.
  const enable =
    brandLogo.enableFromSec === undefined
      ? ""
      : `:enable='gte(t\\,${String(Number((brandLogo.enableFromSec + LOGO_ENABLE_MARGIN_SEC).toFixed(6)))})'`;
  return [
    ...captionStage,
    brandLogo.chain,
    `${overlayFrom}[blogo]overlay=${brandLogo.x}:${brandLogo.y}${enable}${toLabel}`,
  ];
}

/**
 * The single encode pass of spec §5.4 steps 3 and 5. Each shot is placed
 * independently, the pieces are concatenated, and captions are burned on.
 *
 * Every branch reaches `concat` already at output dimensions. That is not a
 * stylistic choice: `concat` requires its inputs to match, and a clip may mix
 * a cropped shot with a fitted one.
 *
 * The graph shape does not branch on shot count — one shot still goes through
 * `concat=n=1`. A special case there would be a second code path exercised
 * only by the most common input, which is the worst place to have one.
 *
 * (The input's field notes are boqo's, for the fields kept.)
 * - `shots`: each shot and its placement (`planShots`' `placed`).
 * - `output`: the frame every shot is composed to and the whole graph reaches `concat` at (stage 5). Required, not
 *   defaulted: a default here would be a second resolution point a caller could silently disagree with.
 * - `assPath`: null for the `none` caption preset — see the pass-through below.
 * - `headlineAssPath`: omitted or null: no headline. Its own file and its own `subtitles` filter, independent of the
 *   caption preset — see render/headline.ts.
 * - `textBelowAssPath`: omitted or null: no text layer below the captions. Caption styles P3 (ruling R2): its own
 *   file and pass, drawn BEFORE the captions.
 * - `blurSigma`: the blur behind a `fit` shot (`FALLBACK_BLUR_SIGMA`).
 * - `backdrop`: omitted or null: blur.
 * - `brandLogo`: omitted or null: no logo.
 * - `subtitles` (the skill's): how a pass's path becomes a filter; boqo's `subtitles=<escaped path>` when omitted.
 *
 * @param {{ shots: { shot: { startSec: number, endSec: number }, placement: object }[],
 *   output: { width: number, height: number }, assPath: string | null, headlineAssPath?: string | null,
 *   textBelowAssPath?: string | null, blurSigma: number, backdrop?: object | null,
 *   brandLogo?: BrandLogoOverlay | null, subtitles?: (path: string) => string }} input
 * @returns {string}
 */
export function buildFilterGraph(input) {
  const segments = input.shots.map(({ shot, placement }, index) => {
    // (boqo extends a shot's end here for a fading join and moves every trim edge half a frame behind a hook; with
    // no transition and no hook both leave the shot as it is.)
    if (placement.kind === "crop") return cropBranch(index, shot, placement.rect, input.output);
    if (placement.kind === "track") return trackBranch(index, shot, placement.path, input.output);
    if (placement.kind === "stack") return stackBranch(index, shot, placement.panels, input.output);
    if (placement.kind === "panels") return panelsBranch(index, shot, placement, input.output);
    if (placement.kind === "fit")
      return fitBranch(index, shot, placement, input.blurSigma, input.output, input.backdrop ?? DEFAULT_BACKDROP);
    // Exhaustive rather than a bare `return fitBranch(...)` fallthrough: a
    // placement kind added later would otherwise render silently as a
    // letterbox, which is a wrong video that passes every test.
    throw new Error(`unknown placement kind: ${JSON.stringify(placement)}`);
  });

  const labels = input.shots.map((_, index) => `[v${index}]`).join("");
  const concat = `${labels}concat=n=${input.shots.length}:v=1:a=0[vcat]`;

  // Inactive (no uniqueize recipe, no grade windows, no censor, no hook, no
  // sounds): the plain branch, with every audio stage empty.
  return [...segments, concat, ...textAndOverlayStages(input, "[vcat]", "[vout]")].join(";");
}

/**
 * The encode's argv: the window on input 0, the logo (a looped still) on input 1 when there is one, the graph, and
 * the posted encode (`POSTED_VIDEO_ENCODE`) with AAC 128k and `+faststart`.
 *
 * (boqo's field notes, for the fields kept.)
 * - `filterThreads`, `encodeThreads`: slice threads per filter, and encoder threads. Both are passed in rather than
 *   left to ffmpeg, which sizes every pool from the CPU count it can see — and inside boqo's container that number
 *   is the HOST's. Measured in production on 2026-08-25, after a project rendered 7 of its 8 clips as `ffmpeg
 *   exited with 1`: the worker's cgroup allows 1000 tasks (`pids.max`) while `nproc` reports 48; a 21-shot graph
 *   spawned 385 tasks at nproc=8, and the caps took the same render to 78.
 * - `brandingMark`: the image on ffmpeg's input 1 — the boqo mark, or the project's own logo, never both. Omitted or
 *   null: no second input.
 * - `progress`: Clips p3 (Ruling R1): ask ffmpeg for its `-progress` key/value stream on stdout, once a second.
 *   Omitted or false: the arguments are byte-identical to the renderer before this phase.
 * (`mapFilteredAudio`, `cutawayInputs` and `sfxInputs` are cut: see the top of this file.)
 *
 * @param {{ videoPath: string, filterGraph: string, outPath: string, filterThreads: number, encodeThreads: number,
 *   brandingMark?: { path: string, durationSec: number } | null, progress?: boolean }} input
 * @returns {string[]}
 */
export function composeArgs(input) {
  return [
    "-nostats",
    "-hide_banner",
    "-y",
    ...(input.progress === true ? ["-progress", "pipe:1", "-stats_period", "1"] : []),
    // Global options, so they MUST precede -i. After the input they are
    // applied to the wrong scope and the pools silently size from nproc
    // again, which no string assertion on their presence would catch.
    "-filter_complex_threads",
    String(input.filterThreads),
    "-filter_threads",
    String(input.filterThreads),
    "-threads",
    String(input.encodeThreads),
    "-i",
    input.videoPath,
    // A still image looped for exactly the clip's length. `-loop 1` alone is
    // an INFINITE stream and overlay's default eof_action=repeat would give
    // it no reason to stop, so `-t` is not optional here. No `-framerate`:
    // LOGO_ENABLE_MARGIN_SEC is one frame at image2's default 25 fps.
    ...(input.brandingMark
      ? ["-loop", "1", "-t", String(input.brandingMark.durationSec), "-i", input.brandingMark.path]
      : []),
    "-filter_complex",
    input.filterGraph,
    "-map",
    "[vout]",
    "-map",
    // `[aout]` when the graph filtered the audio, `0:a?` otherwise. Never
    // both: two mappings would give the output two audio streams.
    "0:a?",
    ...POSTED_VIDEO_ENCODE,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    input.outPath,
  ];
}
