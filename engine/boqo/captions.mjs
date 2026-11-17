// ported from boqo-ai/boqo apps/worker/src/render/captions.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// `@boqo/core` is packages/core/src, whose copies are this directory's. REFERENCE_SIZE is
// `OUTPUT_SIZES[DEFAULT_ASPECT_RATIO]` in packages/core/src/output-size.ts, the 9:16 entry: the one constant of
// that module this file reads (the rest is the brand template's ratio, resolved by the caller into `output`).
import { REFERENCE_HEIGHT, REFERENCE_WIDTH, cssToAss, opacityToAssAlpha, scalePreset } from "./caption-presets.mjs";
import { captionDisplayText, captionText } from "./caption-words.mjs";
import { distributeEvenly, endsSentence, layoutCaptions } from "./caption-layout.mjs";
import { faceFor } from "./caption-faces.mjs";
import { fontMetrics, measureWidth } from "./caption-metrics.mjs";
import { keyColourOf, tiltDegOf } from "./caption-timing.mjs";
const REFERENCE_SIZE = { width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT };
import { glowTags, lineEntrance, markerEvent, opacityTags, popTags, shadowTags, wordEntrance } from "./caption-effects.mjs";

/**
 * Re-exported because this module is where `captionText` has always lived for
 * its callers, and a move that also churned every import site would make the
 * diff harder to check than the change deserves.
 *
 * It MOVED to `packages/core` (caption-words.ts) so the clip editor's
 * transcript panel can normalise a word exactly as the renderer does. Two
 * copies -- one per app -- is the failure this repository records most often,
 * and here it would show as the panel marking a different word from the one
 * the render highlights, which that panel's own design rule forbids.
 */
export { captionText };

                            
                   
                   
                                                                           
                     
                          
                        
                         
                          
  

/**
 * The single hardcoded P1 preset (spec §2.4). Values are the starting point
 * for §10's open item, to be settled against real frames with the render
 * harness rather than chosen in the abstract.
 */
export const DEFAULT_CAPTION_STYLE               = {
  fontName: "DejaVu Sans",
  fontSize: 84,
  baseColour: "FFFFFF",
  highlightColour: "00E5FF",
  outlineColour: "000000",
  marginVertical: 420,
  maxWordsPerLine: 4,
};

/**
 * The legacy Style line's own `Outline` and `MarginL`/`MarginR`, measured
 * against the 9:16 reference frame like every other absolute in this file.
 *
 * Named rather than left as literals inside `buildAss`'s template string on
 * purpose: a literal there is invisible to any grep for a named constant --
 * which is exactly how these two survived unscaled long enough to need this
 * note (design §5). Do not inline them back.
 */
const LEGACY_OUTLINE_PX = 6;

/** The legacy preset draws a word as the transcript spells it (B4: masked or not). */
const LEGACY_TEXT = { textCase: "preserve", stripPunctuation: false }         ;
const LEGACY_SIDE_MARGIN_PX = 60;

/**
 * Restates a `CaptionStyle`'s absolutes for the frame actually being
 * rendered -- the legacy path's own counterpart to `scalePreset`.
 *
 * Both `fontSize` and `marginVertical` were measured against the 9:16
 * reference and scale with HEIGHT, the same basis `scalePreset` uses for
 * `capHeightPx` and `outlineWidth` (design §3's height basis for every
 * caption absolute in this codebase).
 *
 * At the reference size the factor is exactly 1 and `x * 1 === x` for every
 * finite x, so this returns a style identical to its input -- the early
 * return makes that identity rather than merely arithmetic equality,
 * matching `scaled` in caption-presets.ts.
 */
export function scaleCaptionStyle(style              , output            )               {
  const v = output.height / REFERENCE_HEIGHT;
  if (v === 1) return style;
  return {
    ...style,
    fontSize: Math.round(style.fontSize * v),
    marginVertical: Math.round(style.marginVertical * v),
  };
}

/**
 * `H:MM:SS.cc` — ASS uses centiseconds, not milliseconds.
 *
 * Exported for branding.ts, which writes its own ASS file. One formatter
 * rather than two: this repo has already recorded a two-line predicate
 * reaching three hand-copied copies before anyone noticed.
 */
export function assTime(seconds        )         {
  const clamped = Math.max(seconds, 0);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const centis = Math.round((clamped - Math.floor(clamped)) * 100);
  const pad = (n        , w = 2) => String(n).padStart(w, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(Math.min(centis, 99))}`;
}

/**
 * Braces open an override block in ASS, and a backslash starts a tag. A
 * transcript containing either would otherwise swallow the rest of the line
 * or inject styling — this is the same class of problem as unescaped HTML.
 *
 * Exported since stage 4: the headline draws a clip's own `title`/`hook`,
 * which are LLM output rather than a transcript and are the more likely of
 * the two to carry a brace. One escaper, not a second copy beside it.
 */
export function escapeText(text        )         {
  return text.replace(/[\\{}]/g, "");
}

/**
 * Splits one sentence into as few lines as `max` allows, sized as evenly as
 * the split permits: five words at four per line is 3 + 2, never 4 + 1. A
 * plain slice leaves the last word of a sentence alone on screen, which
 * reads as a stutter at exactly the moment the thought completes.
 */
function balancedLines                          (sentence     , max        )        {
  if (sentence.length === 0) return [];
  return distributeEvenly(sentence, Math.ceil(sentence.length / max));
}

/**
 * Groups words into caption lines, breaking at sentence boundaries first and
 * only then at `max`.
 *
 * The previous rule was a fixed slice every `max` words, which put a line
 * break wherever the count happened to land — so a line routinely carried the
 * tail of one sentence and the head of the next ("spot. Darius, get up"). A
 * caption showing two half-thoughts is unreadable at feed speed, and it was
 * not an occasional slip: on a real 47-second clip 18 of 37 caption lines
 * straddled a sentence end, one of them carrying four ("go? Go. Go. Oh").
 *
 * A sentence never shares a line with another sentence. A sentence longer
 * than `max` is divided; a sentence shorter than `max` keeps the line to
 * itself rather than borrowing words from what follows.
 */
export function captionLines                          (words     , max        )        {
  const lines        = [];
  let sentence      = [];

  for (const word of words) {
    sentence.push(word);
    if (endsSentence(word.word)) {
      lines.push(...balancedLines(sentence, max));
      sentence = [];
    }
  }
  // Whatever trailed the last full stop — a clip almost always ends mid-
  // sentence, since its boundaries come from selection, not from grammar.
  lines.push(...balancedLines(sentence, max));

  return lines;
}

/**
 * One dialogue event per word state (spec §5.4 step 4): the whole line is
 * shown for every event, and only the active word carries a colour override,
 * so the highlight walks the line as it is spoken.
 *
 * Each event runs to the *next* word's start rather than to its own end.
 * Word timings from a transcript are not contiguous — there is a real gap
 * between "didn't" ending and "even" starting — and an event that stopped at
 * its own word's end would leave those gaps covered by no event at all, so
 * the entire caption line blinks out and back between words rather than
 * persisting with the highlight parked. The last word in a line keeps its own
 * end, which is what makes the line clear before the next one appears.
 *
 * `output` defaults to `REFERENCE_SIZE` so every existing caller and every
 * direct test of this function is untouched; `buildCaptions`'s legacy branch
 * is the one production caller that ever passes something else.
 */
export function buildAss(
  words               ,
  style              ,
  output             = REFERENCE_SIZE,
)         {
  const usable = words.filter((word) => word.end > word.start);

  // Outline scales with HEIGHT and the two margins with WIDTH -- the same
  // per-axis basis `scalePreset` uses for the positioned path's geometry
  // (design §3). At the reference size both factors are 1 and these come
  // back exactly `6` and `60`, so this is identity rather than merely close.
  const outline = Math.round(LEGACY_OUTLINE_PX * (output.height / REFERENCE_HEIGHT));
  const sideMargin = Math.round(LEGACY_SIDE_MARGIN_PX * (output.width / REFERENCE_WIDTH));

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    // Without these, libass scales positions against the video's own
    // resolution and the margin lands somewhere else entirely.
    `PlayResX: ${output.width}`,
    `PlayResY: ${output.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: boqo,${style.fontName},${style.fontSize},&H00${style.baseColour},&H00${style.outlineColour},&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${sideMargin},${sideMargin},${style.marginVertical},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events           = [];
  for (const line of captionLines(usable, style.maxWordsPerLine)) {
    for (const [index, active] of line.entries()) {
      const text = line
        .map((word) => {
          // The legacy emission neither strips nor recases, so for a word
          // with no mask this is `word.word` exactly -- captionText with both
          // off is the identity -- and `classic`, the SHA-256 control arm, is
          // unchanged. A masked word draws its mask, its punctuation kept.
          const safe = escapeText(captionDisplayText(word, LEGACY_TEXT));
          return word === active
            ? `{\\c&H${style.highlightColour}&}${safe}{\\c&H${style.baseColour}&}`
            : safe;
        })
        .join(" ");
      // Held until the next word takes over, so the gap between them is
      // covered. Math.max guards the one case that would invert the event:
      // overlapping timings, where the next word starts before this one ends.
      const next = line[index + 1];
      const end = next ? Math.max(active.end, next.start) : active.end;
      events.push(
        `Dialogue: 0,${assTime(active.start)},${assTime(end)},boqo,,0,0,0,,${text}`,
      );
    }
  }

  return [...header, ...events, ""].join("\n");
}

/**
 * The caption track for one clip, plus the count of groups that could not be
 * fitted. `ass` is empty exactly when the preset is `none`.
 *
 * Dispatches on `preset.emission` before anything else. The legacy branch is
 * the pre-2026-08-25 renderer called unchanged, NOT a reimplementation that
 * happens to agree — the acceptance gate compares SHA-256 against real
 * pre-change renders, and a re-derivation is precisely what that comparison
 * exists to reject.
 *
 * `output` is REQUIRED, not defaulted: stage 5 makes the frame a variable
 * and every caller must state which one it is drawing against, the same
 * reasoning `renderClip`'s own `captionStyle`/`layout`/`uniqueize` fields are
 * required rather than optional-with-a-default (pipeline.ts) — a default
 * here would be a second resolution point, and callers would drift from one
 * another about which frame a clip was actually drawn against.
 */
export function buildCaptions(
  words               ,
  preset               ,
  output            ,
  cutSec                    = [],
  /**
   * The clip's keyword list (stage 8a), or null when its selection predates
   * stage 8a. Defaulted rather than required, unlike `output`: every existing
   * caller means "no keywords", and unlike a frame size there is exactly one
   * sensible reading of its absence.
   */
  emphasisWords                           = null,
  /**
   * Positioned presets only: the texts the covering face is decided from when
   * they are not `words` -- a hook segment names the clip's face, or its Style
   * line would differ from the clip's and the merge would refuse it.
   */
  coverTexts                    ,
  /**
   * Caption styles P3 (ruling R10): the clip's stored caption timings, keyed
   * by a group's first word index, for the clip's OWN occurrence only.
   * Positioned presets only: `classic` is the frozen control arm and ignores
   * them, as it ignores every word's key mark (ruling R11).
   */
  timeSpans                                             ,
)                                                                                          {
  if (preset.emission === "none") return { ass: "", overflowGroups: 0, emphasisMatched: 0, fallbackUsed: false };
  // `cutSec` deliberately does not reach this branch. `classic` is the
  // control arm the acceptance gate compares by SHA-256 against pre-change
  // renders, so it stays the pre-2026-08-25 emitter called unchanged.
  if (preset.emission === "legacy") {
    const style = scaleCaptionStyle(
      {
        fontName: preset.fontName,
        fontSize: preset.fontSize,
        baseColour: cssToAss(preset.baseColour),
        highlightColour: cssToAss(preset.accentColours[0] ),
        outlineColour: cssToAss(preset.outlineColour),
        marginVertical: preset.marginVertical,
        maxWordsPerLine: preset.maxWordsPerLine,
      },
      output,
    );
    return {
      ass: buildAss(words, style, output),
      overflowGroups: 0,
      // `classic` is the frozen control arm the acceptance gate compares by
      // SHA-256 against pre-change renders, so stage 8a deliberately does not
      // reach it -- the same exclusion every caption override already has.
      emphasisMatched: 0,
      fallbackUsed: false,
    };
  }
  return buildPositioned(words, preset, output, cutSec, emphasisWords, coverTexts, timeSpans);
}

function buildPositioned(
  words               ,
  preset                         ,
  output            ,
  cutSec                   ,
  emphasisWords                          ,
  coverTexts                               ,
  timeSpans                                                        ,
)                                                                                          {
  // Never `scalePresetExact`, whose fractional `capHeightPx` (25.3125 at
  // 1:1) libass would accept silently rather than reject (see that
  // function's own doc comment in caption-presets.ts). render-captions.test.ts's
  // "the built worker bundle" describe block does NOT count `scalePreset`
  // call sites -- it asserts only that `scalePresetExact` never appears in
  // the built bundle, with `scalePreset` itself as the positive control
  // proving the check can see anything at all. There are genuinely TWO call
  // sites now (this one, and another inside `layoutCaptions` below), and
  // that is safe rather than a drift risk: `scalePreset` is pure over
  // `(preset, output)`, so both calls return byte-identical values, and the
  // shared rounding decision every caller of `scaled` relies on is upheld
  // by that purity, not by call-site uniqueness.
  const scaled = scalePreset(preset, output);

  const base = cssToAss(scaled.baseColour);
  const outline = cssToAss(scaled.outlineColour);
  /**
   * What the border looks like for a word that is NOT the active one.
   *
   * Empty for a `scale` preset, which keeps the Style line's own outline. For
   * a `box` preset there IS no outline — BorderStyle 3 replaces it with a
   * filled block — so this is the only contrast device an inactive word has,
   * and it is a translucent plate rather than the fully transparent border
   * this preset first shipped with (see `CaptionEmphasis`).
   *
   * Derived once and used in BOTH places that need it — the line prefix and
   * `emphasise`'s restore span — because the two must agree exactly. They did
   * not have to before, when both were the constant `\3a&HFF&`; with a colour
   * and an alpha in play, two hand-written copies is a drift waiting to
   * happen and the symptom would be one word per line with the wrong plate.
   */
  const resting =
    scaled.emphasis.kind === "box"
      ? `\\3a&H${opacityToAssAlpha(scaled.emphasis.inactiveBoxOpacity)}&` +
        `\\3c&H${cssToAss(scaled.emphasis.inactiveBoxColour)}&`
      : scaled.emphasis.kind === "dim"
        ? opacityTags(scaled.emphasis.restOpacity, scaled.shadow)
        : "";
  // Glow's copy and the marker's rect draw on Layer 0 under the text, so the text moves
  // up to Layer 1 only for those styles; every other style keeps Layer 0 (legacy bytes).
  const textLayer = scaled.glow || scaled.emphasis.kind === "marker" ? 1 : 0;
  const effects = scaled.shadow ? shadowTags(scaled.shadow, scaled.capHeightPx) : "";
  // A word drawn on its own overlay (R24) would need its own glow copy, and the line's glow
  // copy would need the word ghosted out of it. No style combines them, so none is built.
  if (scaled.glow && animatesAnyWord(scaled)) {
    throw new Error(`caption style ${scaled.key} combines glow with a per-word animation; the overlay has no glow copy`);
  }
  // What a word after a ghost returns to: the line's own opacity (a dim style's rest) or opaque.
  const restAlpha = resting.startsWith("\\alpha") ? resting : opacityTags(1, scaled.shadow);

  // `usable` is filtered here, exactly as before this task, so that
  // `layoutCaptions` -- shared with the clip editor's compositor -- never has
  // to make its own decision about a zero-or-negative-duration word; the
  // renderer's caller decides once, and the compositor's own future caller
  // must filter the same way to agree with it.
  const usable = words.filter((w) => w.end > w.start);
  const layout = layoutCaptions(usable, preset, output, cutSec, emphasisWords, coverTexts, timeSpans);
  // `scaled` is still needed for the Style line and `resting`, whose
  // fields (borderStyle, outlineWidth, baseColour, outlineColour, emphasis)
  // `layoutCaptions`'s own `CaptionLayout` return type does not carry. This
  // IS a second `scalePreset` call, not the same call as the one above --
  // see that call's own comment for why two call sites are safe. Read
  // `fontName`/`fontSize` off `layout` below rather than recomputing them
  // from `scaled` here, so the two calls cannot be read as disagreeing
  // about the one thing both of them compute.

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${output.width}`,
    `PlayResY: ${output.height}`,
    // 2 = no automatic wrapping. wrapGroup already decided the breaks, and
    // letting libass re-break them would put text where no \pos accounts
    // for it.
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment 5 (middle-centre) so \pos names the line's own centre;
    // margins are 0 because \pos overrides them entirely.
    `Style: boqo,${layout.fontName},${layout.fontSize},&H00${base},&H00${outline},&H00000000,${faceFor(layout.fontName).bold},0,0,0,100,100,0,0,${scaled.borderStyle},${scaled.outlineWidth},0,5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events           = [];

  for (const group of layout.groups) {
    for (const step of group.steps) {
      /**
       * Whether this active word is one the model marked (stage 8a).
       *
       * This REPLACES a per-word cycle through `accentColours`. Until now the
       * two colours `karaoke` ships alternated word by word and meant
       * nothing; they now mean ordinary and keyword. So the product's "two
       * colour" highlighting is the same two colours, finally carrying a
       * signal — and `karaoke`'s look genuinely changes on every new project,
       * from yellow/green alternating to mostly-yellow with green keywords.
       * That is the feature, and it is the one taste call in stage 8a.
       *
       * A clip whose selection predates 8a has a NULL list, which yields an
       * empty set, so every word takes `accentColours[0]` and the caption is
       * a single accent colour throughout. `layoutCaptions` is what computes
       * this now; `wordSpan` below only reads it off each word's layout.
       */
      // Every animation window is clamped to this, the event it lives in.
      const stepMs = (step.endSec - step.startSec) * 1000;
      // A caption's first step carries the line entrance; the steps after it hold still.
      const first = step.wordIndex === 0;
      for (const [lineIndex, line] of group.lines.entries()) {
        // `escapeText` runs HERE, at the point each word's text is embedded
        // into the `.ass` file, rather than inside `layoutCaptions` --
        // braces and backslashes are an ASS-specific hazard (they open an
        // override block or start a tag), not a browser one, and the clip
        // editor's compositor has no reason to strip characters a DOM text
        // node renders safely as-is.
        // A word that scales or tilts is drawn twice (R24): invisible in its line, upright
        // and at the width it ends the step at (full size; a `scale` emphasis's settled
        // width, horizontally, R27), so the line keeps one advance for the whole step and
        // never re-centres, and visible on its own overlay event, which carries the
        // animation about the word's own centre (as the mockup's CSS transform does).
        const alone = (index        ) =>
          !(scaled.reveal && index > step.wordIndex) && animatesAlone(scaled, group.words[index] , index === step.wordIndex);
        const rendered = line
          .map((index) => {
            const span = wordSpan(escapeText(group.words[index] .text), group.words[index] , index === step.wordIndex, index > step.wordIndex, scaled, base, resting, layout, stepMs, alone(index));
            return alone(index) ? ghost(span, restAlpha) : span;
          })
          .join(" ");
        const x = output.width / 2;
        const y = group.lineY[lineIndex] ;
        const line0 =
          first && (scaled.entrance === "fade" || scaled.entrance === "slide")
            ? lineEntrance(scaled.entrance, x, y, scaled.capHeightPx, stepMs, scaled.speed)
            : null;
        // The glow copy takes the same position and fade, so it moves and fades with its text (R5).
        const place = line0 ? line0.pos + line0.fad : `\\pos(${x},${y})`;
        // `resting` after `effects`: a dim style's opacity re-states the soft shadow's alpha (opacityTags).
        const prefix = `{\\an5${place}${effects}${resting}}`;
        const overlays = line.filter(alone).map((target) => {
          // The overlay is the whole line at the line's own place, every word but this one
          // invisible. Sharing the line's box keeps the word on the line's baseline in any
          // face (a lone word's \\an5 box centres on its own face's ascent and descent: a
          // lone Poppins word sat ~12 px above a line holding Anton, loop render 2026-10-05),
          // and in a centred line a word that grows by D moves the line by D/2 while it widens
          // by D, so its centre holds: it scales about its own centre, as the mockup's does.
          const body = line
            .map((index) => {
              const span = wordSpan(escapeText(group.words[index] .text), group.words[index] , index === step.wordIndex, index > step.wordIndex, scaled, base, resting, layout, stepMs, index !== target);
              return index === target ? span : ghost(span, restAlpha);
            })
            .join(" ");
          const wl = group.words[target] ;
          if (!tilts(scaled, wl, target === step.wordIndex)) return prefix + body;
          // A tilt turns about the word's own centre: wl.x is its left edge (as for the
          // marker), plus half its width in the face it is drawn in.
          const widthOf = (x                   ) =>
            x.keyword && layout.keyFontName !== null && layout.keyFontSize !== null
              ? measureWidth(fontMetrics(layout.keyFontName), x.text, layout.keyFontSize)
              : measureWidth(fontMetrics(layout.fontName), x.text, layout.fontSize);
          // A `scale` emphasis's spoken word holds its settled width in this line (R27), so
          // the centred line spreads by that extra width, half each way: a word before it
          // sits half of it further left, a word after it half further right -- up to 23 px on
          // the real-clip phrases. Unshifted, \org would turn the word about a point up to
          // ~23 px away, moving it by up to 1.2 px (computed from the metrics table, 2026-10-05).
          const spoken = step.wordIndex;
          const reserved = target !== spoken && line.includes(spoken) && scaled.emphasis.kind === "scale"
            ? (widthOf(group.words[spoken] ) * (scaled.emphasis.scalePct - 100)) / 100
            : 0;
          const shift = target < spoken ? -reserved / 2 : reserved / 2;
          return prefix.replace("}", `\\org(${Math.round(wl.x + widthOf(wl) / 2 + shift)},${y})}`) + body;
        });
        const times = `${assTime(step.startSec)},${assTime(step.endSec)}`;
        if (overlays.length === 0) {
          events.push(`Dialogue: ${textLayer},${times},boqo,,0,0,0,,${prefix}${rendered}`);
        } else {
          // One event draws every outline under every fill; across events the later one's
          // outline would cover its neighbour's fill (an overlay's 11 px outline ate the
          // next word's first letter in the loop render, 2026-10-05). So the line and its
          // overlays draw their outlines (and shadows) on this layer and their fills on the
          // next, each composited once. Measured in the worker image (Task 10 re-review,
          // 2026-10-05): the split differs from one event only on the anti-aliased ring
          // where fill meets outline, by up to 51/255 under a coloured outline (a faint
          // 1 px ring; comic, boldkeys and bounce on their overlay steps).
          const texts = [prefix + rendered, ...overlays];
          for (const t of texts) events.push(`Dialogue: ${textLayer},${times},boqo,,0,0,0,,${outlinePass(t)}`);
          for (const t of texts) events.push(`Dialogue: ${textLayer + 1},${times},boqo,,0,0,0,,${fillPass(t)}`);
        }
        if (scaled.glow) {
          // The glow copy is the whole line; only a `glow` emphasis lifts the spoken word's own glow.
          const glowLine = line
            .map((index) => {
              const t = escapeText(group.words[index] .text);
              return index === step.wordIndex && scaled.emphasis.kind === "glow"
                ? `{${glowTags(scaled.glow , scaled.capHeightPx, scaled.emphasis.boost)}}${t}{${glowTags(scaled.glow , scaled.capHeightPx)}}`
                : t;
            })
            .join(" ");
          events.push(
            `Dialogue: 0,${assTime(step.startSec)},${assTime(step.endSec)},boqo,,0,0,0,,` +
              `{\\an5${place}${glowTags(scaled.glow, scaled.capHeightPx)}}${glowLine}`,
          );
        }
        if (scaled.emphasis.kind === "marker" && line.includes(step.wordIndex)) {
          const wl = group.words[step.wordIndex] ;
          const width = Math.round(measureWidth(fontMetrics(layout.fontName), wl.text, layout.fontSize));
          const height = Math.round(scaled.capHeightPx * 1.25);
          events.push(
            markerEvent({
              start: assTime(step.startSec),
              end: assTime(step.endSec),
              // wl.x is the word's LEFT edge, so the rect hangs off it, not off a centre.
              left: wl.x - Math.round(scaled.capHeightPx * 0.12),
              top: group.lineY[lineIndex]  - Math.round(height / 2),
              width: width + Math.round(scaled.capHeightPx * 0.24),
              height,
              colour: scaled.emphasis.colour,
              speed: scaled.speed,
              stepMs,
            }),
          );
        }
      }
    }
  }

  return {
    ass: [...header, ...events, ""].join("\n"),
    overflowGroups: layout.overflowGroups,
    emphasisMatched: layout.emphasisMatched,
    fallbackUsed: layout.fallbackUsed,
  };
}

/**
 * One word's ASS text in one step. For a legacy preset (no key face, no
 * keyAlways, no tilt, no reveal) this is exactly what it was: the spoken word
 * goes through `emphasise`, every other word is bare.
 *
 * A key word's run is closed here, before the caller joins the next word with
 * a space, so the space is drawn in the base face -- the face `layoutCaptions`
 * measured it in.
 */
function wordSpan(
  text        ,
  wl                   ,
  spoken         ,
  future         ,
  preset                         ,
  base        ,
  resting        ,
  layout               ,
  stepMs        ,
  /** Drawn without its scale ramp or tilt: the in-line ghost of an overlaid word (R24). */
  still = false,
)         {
  if (spoken) return emphasise(text, preset, base, resting, wl, layout, stepMs, still);
  const hidden = preset.reveal && future;
  let open = "";
  let close = "";
  // keyAlways: a key word keeps its colour whether or not it is the spoken one.
  if (wl.keyword && preset.keyAlways) {
    open += `\\c&H${cssToAss(keyColourOf(preset, wl))}&`;
    close += `\\c&H${base}&`;
  }
  const [faceOpen, faceClose] = keyFaceTags(wl, layout);
  open += faceOpen;
  close += faceClose;
  if (wl.keyword && preset.tilt === "keywords" && !still) {
    open += `\\frz${frzOf(wl)}`;
    close += "\\frz0";
  }
  if (hidden) {
    // `resting` is the line's own alpha for a dim style, so that is what an unspoken word returns to.
    open += "\\alpha&HFF&";
    close += resting.startsWith("\\alpha") ? resting : opacityTags(1, preset.shadow);
  }
  return open === "" ? text : `{${open}}${text}{${close}}`;
}

/**
 * Whether this word is drawn on its own overlay event (R24): it scales (the
 * spoken word's pop or bounce entrance, or an animated pop emphasis) or it
 * tilts. libass lays a line out with each glyph's scale, so a word growing in
 * its line re-centres the whole line, and \\frz turns about the line's origin,
 * so a tilted end word leaves the baseline (both seen in the loop render,
 * 2026-10-05). Legacy presets set none of these fields, so they never overlay.
 */
function animatesAlone(preset                         , wl                   , spoken         )          {
  if (tilts(preset, wl, spoken)) return true;
  return spoken && (preset.entrance === "pop" || preset.entrance === "bounce"
    || (preset.emphasis.kind === "scale" && preset.animatePop === true));
}

/** Whether this word is drawn turned: every key word under `keywords`, the spoken one under `active`. */
function tilts(preset                         , wl                   , spoken         )          {
  return (preset.tilt === "keywords" && wl.keyword) || (preset.tilt === "active" && spoken);
}

/** Whether a style draws any word on an overlay. */
function animatesAnyWord(preset                         )          {
  return preset.tilt !== undefined || preset.entrance === "pop" || preset.entrance === "bounce"
    || (preset.emphasis.kind === "scale" && preset.animatePop === true);
}

/**
 * An event's outline and shadow only: its fill transparent from the first block on and
 * after every `\\alpha` that would bring it back. libass cuts the glyph's interior out
 * of the border, so this pass draws a hollow ring and the fill pass on the layer above
 * covers the hole (measured in the worker image, Task 10 re-review, 2026-10-05).
 */
function outlinePass(text        )         {
  return text
    .replace(/\\alpha&H([0-9A-F]{2})&/g, (m) => `${m}\\1a&HFF&`)
    .replace("}", "\\1a&HFF&}");
}

/** An event's fill only: no border, no shadow, whatever its spans set. */
function fillPass(text        )         {
  return text
    .replace(/\\bord[\d.]+/g, "\\bord0")
    .replace(/\\shad[\d.]+/g, "\\shad0")
    .replace("}", "\\bord0\\shad0}");
}

/**
 * A word kept in its line only for its advance: its own tags (face, size, colour) so
 * it measures what it draws, made invisible after them, and the line's opacity back after it.
 */
function ghost(span        , restAlpha        )         {
  const m = /^\{([^}]*)\}([^{]*)\{([^}]*)\}$/.exec(span);
  return m ? `{${m[1]}\\alpha&HFF&}${m[2]}{${m[3]}${restAlpha}}` : `{\\alpha&HFF&}${span}{${restAlpha}}`;
}

/**
 * `tiltDegOf` is the CSS-sense angle the mockup draws (positive = clockwise); \frz turns
 * counter-clockwise for positive values (measured in the worker image's libass, 2026-10-05;
 * render-branding.test.ts pins the same), so the tag carries its negation.
 */
const frzOf = (wl                   ) => -tiltDegOf(wl);

/** ASS `\b` for a face's registry bold flag (-1 bold, 0 regular). */
const boldTag = (fontName        ) => `\\b${faceFor(fontName).bold === -1 ? 1 : 0}`;

/**
 * A key word's face switch and its undoing. The key face's OWN bold goes on
 * with it and the base face's comes back after: a single-weight key face
 * (Bold 0) drawn under the base's Bold -1 would be synthesised bold by libass,
 * smearing its glyphs (ink +8-12%, advances within 1 px over a 27-character
 * line: measured in boqo-render:latest, 2026-10-05; caption-faces.ts).
 */
function keyFaceTags(wl                   , layout               )                   {
  if (!wl.keyword || !layout.keyFontName) return ["", ""];
  return [
    `\\fn${layout.keyFontName}\\fs${layout.keyFontSize}${boldTag(layout.keyFontName)}`,
    `\\fn${layout.fontName}\\fs${layout.fontSize}${boldTag(layout.fontName)}`,
  ];
}

/**
 * The spoken word's own span, returned to the base state after it.
 *
 * `resting` is the caller's own inactive-border tags, passed in rather than
 * recomputed so the state this restores TO is the same one the line prefix
 * set — the whole line must carry one plate, not a different one either side
 * of the active word.
 */
function emphasise(
  text        ,
  preset                         ,
  base        ,
  resting        ,
  wl                   ,
  layout               ,
  stepMs        ,
  still = false,
)         {
  const colours = preset.accentColours;
  /**
   * The keyword colour, or null when this preset cannot say "keyword".
   *
   * A preset with a single accent colour has no second colour to say it
   * WITH, so it renders exactly as it does today and a brand template can
   * add one (`BrandCaptions.accentColours` is already 1-2). That is stage
   * 3's own rule applied: no colour without a signal behind it.
   */
  const keywordColour = wl.keyword && colours.length >= 2 ? keyColourOf(preset, wl) : null;
  const [faceOpen, faceClose] = keyFaceTags(wl, layout);
  const tilted = !still && (preset.tilt === "active" || (preset.tilt === "keywords" && wl.keyword));
  const extraOpen = faceOpen + (tilted ? `\\frz${frzOf(wl)}` : "");
  const extraClose = faceClose + (tilted ? "\\frz0" : "");
  const emphasis = preset.emphasis;
  // The spoken word's own entrance goes first in every branch's opening tags. Its size ramp
  // is a state the rest of the line inherits, so the closing tags put the size back
  // (a `scale` emphasis already does; the `type` entrance has no ramp).
  const enter = !still && (preset.entrance === "pop" || preset.entrance === "bounce" || preset.entrance === "type") ? wordEntrance(preset.entrance, stepMs, preset.speed) : "";
  const leave = enter === "" ? "" : "\\fscx100\\fscy100";

  switch (emphasis.kind) {
    case "scale": {
      const pct = emphasis.scalePct;
      const accent = cssToAss(keywordColour ?? (preset.keyAlways && wl.keyword ? keyColourOf(preset, wl) : colours[0] ));
      // A ghost (R24) reserves the width the word settles at on its overlay, horizontally
      // only, so the popped word never grows into its neighbours (R27: comic's 114% word
      // closed both spaces on real clips, "THANME", Task 11 render 2026-10-05). Its
      // neighbours take their place at the step's first frame, as karaoke's and punch's
      // instant scale moves them, never during the ramp.
      const grow = still ? `\\fscx${pct}` : preset.animatePop ? popTags(pct, preset.speed, stepMs) : `\\fscx${pct}\\fscy${pct}`;
      return `{${enter}\\c&H${accent}&${grow}${extraOpen}}${text}{\\c&H${base}&\\fscx100\\fscy100${extraClose}}`;
    }
    case "box": {
      /**
       * BorderStyle 3, where the PLATE carries the emphasis and the glyph does
       * not — so the keyword colour has to land on `\3c`, not on `\c`.
       *
       * This branch is why the rule is expressed here rather than at the call
       * site as "pick a different accent": until this change it read
       * `preset.accentColours` NOT AT ALL, so a keyword rule written only as an
       * accent swap would have worked on `karaoke`, `punch` and `clean` and been
       * silently inert on `highlight` — three presets right, one wrong, with
       * nothing failing. Its own test drives a `box` preset for that reason.
       *
       * With no keyword colour this is byte-identical to what it emitted before,
       * so `highlight`'s look is unchanged for every clip that has no keywords
       * and for every template that sets a single accent.
       */
      const box = cssToAss(keywordColour ?? emphasis.boxColour);
      const on = cssToAss(emphasis.textColour);
      return `{${enter}\\3a&H00&\\3c&H${box}&\\c&H${on}&}${text}{${resting}\\c&H${base}&${leave}}`;
    }
    case "colour":
      return `{${enter}\\c&H${cssToAss(keywordColour ?? colours[0] )}&${extraOpen}}${text}{\\c&H${base}&${extraClose}${leave}}`;
    case "marker":
      // The rect under the word is its own event (markerEvent); the word is drawn dark over it, borderless.
      return `{${enter}\\c&H${cssToAss(emphasis.textColour)}&\\bord0${extraOpen}}${text}{\\c&H${base}&\\bord${preset.outlineWidth}${extraClose}${leave}}`;
    case "glow":
      // The glow's own brightening is on the glow copy's event; here the glyph takes the accent.
      return `{${enter}\\c&H${cssToAss(colours[0] )}&${extraOpen}}${text}{\\c&H${base}&${extraClose}${leave}}`;
    case "dim":
      return `{${enter}${opacityTags(1, preset.shadow)}${extraOpen}}${text}{${resting}${extraClose}${leave}}`;
    case "none":
      return enter + extraOpen === "" ? text : `{${enter}${extraOpen}}${text}{${extraClose}${leave}}`;
    default: {
      // A new emphasis kind must be compiled here; it cannot fall through to bare text.
      const unhandled        = emphasis;
      throw new Error(`unhandled caption emphasis ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Splits an ASS file after its `[Events]` Format line: [header, events]. Null when it has none. */
function splitAssEvents(ass        )                          {
  const marker = "\n[Events]\n";
  const at = ass.indexOf(marker);
  if (at === -1) return null;
  const formatEnd = ass.indexOf("\n", at + marker.length);
  if (formatEnd === -1) return null;
  return [ass.slice(0, formatEnd + 1), ass.slice(formatEnd + 1)];
}

/**
 * R5 (owner, 2026-10-04): the hook's captions are each hook range captioned
 * on its own (`hookCaptionSegments`), so no line holds words from two
 * moments, or from the hook and the clip -- which `classic`'s sentence-only
 * grouping would otherwise do. Their events join the clip's file under its
 * one header, ahead of the clip's own events, which stay byte for byte what
 * `buildCaptions` wrote. Null when any part's header differs from the base's
 * (it is a pure function of the preset and the frame, so it should not; the
 * caller then leaves the hook uncaptioned rather than guess).
 */
export function mergeCaptionEvents(base        , parts                   )                {
  const extras = parts.filter((part) => part !== "");
  if (extras.length === 0) return base;
  const split = splitAssEvents(base);
  if (split === null) return null;
  const [header, events] = split;
  const added           = [];
  for (const part of extras) {
    const other = splitAssEvents(part);
    if (other === null || other[0] !== header) return null;
    added.push(other[1]);
  }
  return header + added.join("") + events;
}
