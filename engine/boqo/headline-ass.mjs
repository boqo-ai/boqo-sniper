// ported from boqo-ai/boqo apps/worker/src/render/headline.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut imports: `@boqo/core` becomes the sibling copies (caption-timing, headline, caption-metrics, caption-faces,
// caption-presets, caption-layout); `./captions` and `./caption-effects` become their copies. Nothing else is cut.
import { ANIM_MS, HEADLINE_SLIDE_CAP_HEIGHTS, animMs, withinEvent as within } from "./caption-timing.mjs";
import {
  HEADLINE_CAP_MIN,
  HEADLINE_GLYPH_BOX_RATIO,
  HEADLINE_LINE_SPACING_RATIO,
  HEADLINE_MAX_LINES,
  HEADLINE_PAD_X_RATIO,
  HEADLINE_PAD_Y_RATIO,
  headlineInk,
  headlinePlateHeight,
  headlineWindow,
} from "./headline.mjs";
import { assFontSize, fontMetrics, measureWidth } from "./caption-metrics.mjs";
import { coveringFace, faceFor } from "./caption-faces.mjs";
import { cssToAss, opacityToAssAlpha } from "./caption-presets.mjs";
import { wrapGroup } from "./caption-layout.mjs";
// Core's since caption styles P3, re-exported so this module's callers and
// tests keep reading it from here.
export { headlineWindow } from "./headline.mjs";
import { assTime, escapeText } from "./captions.mjs";
import { glowTags, shadowTags } from "./caption-effects.mjs";

/**
 * The burned-in headline (design §4.3).
 *
 * It emits through stage 3's `measureWidth` and `wrapGroup`, which is the
 * entire reason this stage comes after stage 3 -- NOT, as CLAUDE.md's
 * stage-3 section claimed until 2026-09-05, because it needs stage 3b's
 * uploaded fonts. Those are a different thing and this stage does not touch
 * them; it inherits them free if and when 3b ships.
 *
 * A separate `.ass` file and a separate `subtitles` filter rather than extra
 * events inside `captions.ass`, for two reasons that are not stylistic. The
 * `none` preset writes no caption file at all, so a headline merged into it
 * would silently vanish on exactly the projects that chose to have no
 * captions; and `classic` is the frozen control arm the acceptance gate
 * compares by SHA-256, so adding events to its emission path is the one
 * change that would make that comparison meaningless. `branding.ts` is
 * separate from captions for the identical pair of reasons.
 */

/** How far a bezier control point sits from a rounded corner's own corner. */
const KAPPA = 0.5523;

/**
 * The step the fitter walks cap height down by when the text will not fit.
 *
 * One output pixel: fine enough that the shrink is invisible against the
 * requested size, coarse enough that the worst case (the largest cap in the
 * band down to the smallest) is a few dozen iterations of a pure function.
 */
const SHRINK_STEP_PX = 1;

                              
                                                                          
                  
                                                                             
                      
                                                     
                   
                                                                              
                  
     
                                                                         
    
                                                                           
                                                                             
                                                                             
                                                             
     
                    
  

/**
 * Break `text` into at most `HEADLINE_MAX_LINES` lines that fit the box,
 * shrinking the cap height until they do.
 *
 * Shrink-to-fit rather than clip or truncate, because design 8.2's own gate
 * for this stage asks for "the widest real title in the database, wrapped and
 * INSIDE its box" -- and the widest real hook in production is 132 characters
 * (measured 2026-09-05), which does not fit three lines at any size a person
 * would choose. Truncating would drop words a creator wrote; clipping is the
 * failure this whole width model exists to prevent. Shrinking is the only one
 * of the three that always produces the whole text inside the frame.
 *
 * The creator's size control is therefore a MAXIMUM, not a promise, and
 * `shrunk` is what says so to the log.
 */
export function layoutHeadline(
  text        ,
  headline               ,
  frame                                   ,
)                 {
  const metrics = fontMetrics(headline.font.name);
  const words = text.split(/\s+/).filter((word) => word !== "").map(escapeText);
  const maxWidth = headline.boxWidthFraction * frame.width;
  const requested = Math.round(headline.capHeightFraction * frame.height);
  const floor = Math.max(1, Math.round(HEADLINE_CAP_MIN * frame.height));

  // Empty only if the caller handed in whitespace, which `headlineText`
  // already rules out -- kept because this function is exported and a
  // zero-line layout would otherwise divide by nothing downstream.
  if (words.length === 0) {
    return { lines: [], capHeightPx: requested, fontSize: 1, shrunk: false, overflow: false };
  }

  let last                                                                    = null;
  for (let cap = requested; cap >= floor; cap -= SHRINK_STEP_PX) {
    const fontSize = assFontSize(metrics, cap);
    const { lines, overflow } = wrapGroup(words, {
      metrics,
      fontSize,
      maxWidth,
      maxLines: HEADLINE_MAX_LINES,
    });
    const rendered = lines.map((line) => line.map((index) => words[index] ).join(" "));
    last = { lines: rendered, capHeightPx: cap, fontSize };
    if (!overflow) {
      return { ...last, shrunk: cap < requested, overflow: false };
    }
  }

  // `last` is always set: the loop runs at least once because `floor` is
  // clamped to 1 and `requested` is bounded below by HEADLINE_CAP_MIN's own
  // schema bound, which is larger.
  return { ...last , shrunk: last .capHeightPx < requested, overflow: true };
}

/** The plate's own box in output pixels, centred on the headline's position. */
export function headlinePlate(
  layout                ,
  headline               ,
  frame                                   ,
  metrics             ,
)                                                                               {
  const widest = Math.max(
    0,
    ...layout.lines.map((line) => measureWidth(metrics, line, layout.fontSize)),
  );
  const padX = layout.capHeightPx * HEADLINE_PAD_X_RATIO;
  const width = Math.round(widest + 2 * padX);
  const height = Math.round(headlinePlateHeight(layout.lines.length, layout.capHeightPx));
  const centreY = headline.positionFraction * frame.height;

  // Clamped into the frame rather than trusted to the schema's bands. Those
  // bands bound the WORST case -- HEADLINE_MAX_LINES at the largest cap -- so
  // an in-band template cannot breach this; the clamp is what makes that a
  // property of the drawing rather than of a derivation two files away, and
  // it also catches a caller passing a frame these bands were not derived
  // against, which is exactly what stage 5's other two ratios will be.
  const left = Math.round(Math.min(Math.max((frame.width - width) / 2, 0), frame.width - width));
  const top = Math.round(Math.min(Math.max(centreY - height / 2, 0), frame.height - height));

  // A radius past half the smaller side produces a degenerate path -- the
  // straight edges invert -- rather than a rounder box.
  const radius = Math.round(
    Math.min(headline.cornerRadiusFraction * frame.width, width / 2, height / 2),
  );
  return { left, top, width, height, radius };
}

/**
 * A rounded rectangle in ASS drawing commands, with its own origin at (0,0).
 *
 * `BorderStyle: 3` draws a SQUARE plate and ASS has no corner radius, so this
 * is design 4.3's "one extra Dialogue event drawing a rounded rectangle in
 * ASS vector syntax". Cheap, and only possible because the width is already
 * measured.
 *
 * Integer coordinates at `\p1` (1:1 scale). Sub-pixel precision is available
 * through a higher `\p` exponent and buys nothing on a plate whose smallest
 * dimension is ~90px.
 */
export function roundedRectPath(width        , height        , radius        )         {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    return `m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height} l 0 0`;
  }
  const k = Math.round(r * KAPPA);
  const w = width;
  const h = height;
  return [
    `m ${r} 0`,
    `l ${w - r} 0`,
    `b ${w - r + k} 0 ${w} ${r - k} ${w} ${r}`,
    `l ${w} ${h - r}`,
    `b ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}`,
    `l ${r} ${h}`,
    `b ${r - k} ${h} 0 ${h - r + k} 0 ${h - r}`,
    `l 0 ${r}`,
    `b 0 ${r - k} ${r - k} 0 ${r} 0`,
  ].join(" ");
}

/** The face, layout and plate one text element is drawn with: `headlineParts`'s own, shared with `textElementExtent`. */
function elementGeometry(
  text        ,
  headline               ,
  style                           ,
  frame                                   ,
)   
                          
                   
                       
                         
                                          
  {
  // No style, or the bare plate, is today's headline: the same code path below
  // with every new branch skipped, so the same bytes. A plate that carries its
  // own colour or case is a styled headline, not the bare one.
  const s = style && !isBarePlate(style) ? style : null;
  // The style's face, or the covering face when the text holds a character it
  // cannot draw (never a fontconfig substitute). Laid out and drawn in the
  // same face, so the measured advances are the drawn ones. The cast is only
  // for the schema's font enum, which the style registry is wider than.
  const fontName = s?.font ? coveringFace(s.font, [text]) : headline.font.name;
  const drawn                = s?.font ? { ...headline, font: { kind: "builtin", name: fontName          } } : headline;
  // The brand headline carries no case of its own: it draws the title as
  // written, so a style that does not say upper leaves the text alone.
  const shown = s?.textCase === "upper" ? text.toUpperCase() : text;
  const metrics = fontMetrics(fontName);
  const layout = layoutHeadline(shown, drawn, frame);
  const plate = headlinePlate(layout, drawn, frame, metrics);
  return { s, fontName, metrics, layout, plate };
}

/**
 * How far down the frame one text element reaches, in output pixels: the
 * bottom of the plate `buildTextAss` draws it on, widened by a styled tilt
 * (the plate turns about its centre, so a corner drops by half its width
 * times |sin|). Null when it draws nothing. #293 keeps a stream panel clip's
 * captions below this.
 */
export function textElementExtent(
  element                                                     ,
  frame                                   ,
)                                         {
  const { s, layout, plate } = elementGeometry(element.text, element.settings, element.style, frame);
  if (layout.lines.length === 0) return null;
  const centreY = plate.top + plate.height / 2;
  const rad = ((s?.rot ?? 0) * Math.PI) / 180;
  const half = (plate.height / 2) * Math.abs(Math.cos(rad)) + (plate.width / 2) * Math.abs(Math.sin(rad));
  return { top: centreY - half, bottom: centreY + half };
}

/**
 * One headline's Style line and events, as the bottom element of a file: the
 * plate on layer 0 and each line its own event on layer 1 -- higher layers
 * draw on top. One event PER LINE rather than one event with `\N` breaks, for
 * the reason `buildPositioned` gives: libass derives a line's height from its
 * own glyphs, so its line spacing is not the spacing this file computed, and
 * the plate is sized from that computed spacing. Owning the breaks means
 * owning the positions. `buildTextAss` restacks every element above the
 * first (`stacked`).
 */
function headlineParts(
  text        ,
  headline               ,
  span                                      ,
  frame            ,
  offsetSec        ,
  style                           ,
  part                         ,
)                                                                  {
  const { s, fontName, metrics, layout, plate } = elementGeometry(text, headline, style, frame);
  const { startSec, endSec } = span;
  // A part of a split element (#293, `TextAssElement.part`) runs on its source
  // element's clock: animation windows are clamped inside the whole window,
  // and only the first part plays the entrance. Without a part the clock is
  // the span itself, as it always was.
  const clock = part?.window ?? span;
  const entering = part === undefined || part.index === 0;

  // The style's plate / highlighter default over the brand's.
  const plateCss = s?.plateColour ?? headline.plateColour;
  const ink = s && s.look !== "plate" ? cssToAss(s.textColour) : cssToAss(headlineInk(plateCss));
  const plateColour = cssToAss(plateCss);
  const plateAlpha = opacityToAssAlpha(headline.plateOpacity);

  const lineSpacing = layout.capHeightPx * HEADLINE_LINE_SPACING_RATIO;
  const centreY = plate.top + plate.height / 2;
  const lineY = layout.lines.map((_, index) =>
    Math.round(centreY + (index - (layout.lines.length - 1) / 2) * lineSpacing),
  );
  const centreX = Math.round(plate.left + plate.width / 2);

  // Bold is the drawn face's own measured flag, never a look: the metrics
  // table is measured at faceFor(name).bold, and a style drawn at any other
  // flag would be laid out against a table describing a different face
  // (8.8-11.6% wider on Oswald and DejaVu when bold was assumed). That
  // mismatch shipped once already for one commit and nothing throws or
  // logs when it does -- caption-metrics-probe.test.ts is the only thing
  // that connects the two, and it checks this line too.
  //
  // Alignment 5 (middle-centre) so \pos names each line's own centre; the
  // plate event overrides to \an7 so its \pos names a top-left corner.
  // Outline 0 and Shadow 0: the plate IS the contrast device, and an
  // outline over a plate chosen for contrast only muddies it.
  const styleLine = `Style: headline,${fontName},${layout.fontSize},&H00${ink},&H00000000,&H00000000,${faceFor(fontName).bold},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`;

  const start = assTime(startSec + offsetSec);
  const end = assTime(endSec + offsetSec);
  // The element's length as the ASS file will state it (centisecond-rounded),
  // which is what every animation window below is clamped inside -- the
  // event's own length unless this is a part of a split element.
  const clockStartMs = assToMs(assTime(clock.startSec + offsetSec));
  const eventMs = Math.max(1, assToMs(assTime(clock.endSec + offsetSec)) - clockStartMs);
  // How far into the element's clock this event starts: 0 but for a later part.
  const elapsedMs = assToMs(start) - clockStartMs;
  const events           = [];

  if (!s && layout.lines.length > 0) {
    // \bord0\shad0 on the drawing as well as in the Style: a drawing inherits
    // the style's border, and a bordered plate would draw a second outline
    // one radius outside the rounded path -- square, because a border follows
    // the glyph box rather than the path.
    events.push(
      `Dialogue: 0,${start},${end},headline,,0,0,0,,` +
        `{\\an7\\pos(${plate.left},${plate.top})\\bord0\\shad0` +
        `\\1c&H${plateColour}&\\1a&H${plateAlpha}&\\p1}` +
        `${roundedRectPath(plate.width, plate.height, plate.radius)}{\\p0}`,
    );
    for (const [index, line] of layout.lines.entries()) {
      events.push(
        `Dialogue: 1,${start},${end},headline,,0,0,0,,` +
          `{\\an5\\pos(${centreX},${lineY[index]})}${line}`,
      );
    }
  }

  if (s && layout.lines.length > 0) {
    const ms = within(animMs(ANIM_MS.headlineEntrance, s.speed), eventMs);
    // The tilt turns every event about the plate's centre, so the plate and its
    // lines turn as one sticker. The styled plate is drawn \an5 at that same
    // centre, so the pop's scale (and the tilt) act on it about its centre
    // rather than about a corner, as the lines' own \an5 does for them.
    const plateCx = centreX;
    const plateCy = Math.round(plate.top + plate.height / 2);
    // `rot` is the style's CSS-sense tilt (the mockup's `rotate()`: positive is clockwise).
    // \frz turns the other way -- measured in the worker image's libass, 2026-10-05, and
    // pinned by render-branding.test.ts -- so it is negated here, once.
    const rot = s.rot ? `\\org(${plateCx},${plateCy})\\frz${-s.rot}` : "";
    // A later part of a split element is a hard switch at a cut: it draws the
    // headline as it stands once the entrance is over, so nothing replays.
    const entrance = entering ? s.entrance : "none";
    const enter =
      entrance === "fade" ? `\\fad(${ms},0)`
      : entrance === "pop" ? `\\fscx0\\fscy0\\t(0,${ms},\\fscx100\\fscy100)`
      : "";
    const slideDy = Math.max(1, Math.round(layout.capHeightPx * HEADLINE_SLIDE_CAP_HEIGHTS));
    // libass scales an event about its own \pos, so a wrapped headline whose
    // lines each popped in place would grow as separate strips, the outer ones
    // off the plate (seen in the loop render, 2026-10-05). Under pop each line
    // instead travels from the plate's centre to its resting point over the
    // pop's own linear window: at scale s it sits at C + s(P - C), which is the
    // whole block scaling about C. One line rests on C and needs no travel.
    const popMoves = entrance === "pop" && layout.lines.length > 1;
    const at = (x        , y        ) =>
      entrance === "slide" ? `\\move(${x},${y - slideDy},${x},${y},0,${ms})`
      : popMoves ? `\\move(${plateCx},${plateCy},${x},${y},0,${ms})`
      : `\\pos(${x},${y})`;
    const fx =
      (s.outline
        ? `\\bord${Math.max(1, Math.round(layout.capHeightPx * s.outline.widthRatio))}\\3c&H${cssToAss(s.outline.colour)}&`
        : "\\bord0") + (s.shadow ? shadowTags(s.shadow, layout.capHeightPx) : "\\shad0");
    // The typewriter runs across the whole headline, line after line: one
    // stride from the total character count, a running index across lines.
    const totalChars = layout.lines.reduce((n, line) => n + [...line].length, 0);
    const stride = within(animMs(ANIM_MS.typeStride, s.speed), Math.floor(eventMs / Math.max(1, totalChars)));
    let typed = 0;

    if (s.look === "plate") {
      events.push(
        `Dialogue: 0,${start},${end},headline,,0,0,0,,` +
          `{\\an5${popMoves ? `\\pos(${plateCx},${plateCy})` : at(plateCx, plateCy)}\\bord0\\shad0${rot}${enter}` +
          `\\1c&H${plateColour}&\\1a&H${plateAlpha}&\\p1}` +
          `${roundedRectPath(plate.width, plate.height, plate.radius)}{\\p0}`,
      );
    }
    for (const [index, line] of layout.lines.entries()) {
      const y = lineY[index] ;
      if (s.look === "marker") {
        // A highlighter stroke behind the line, swept open left to right.
        const w = Math.round(measureWidth(metrics, line, layout.fontSize));
        const h2 = Math.round(layout.capHeightPx * 1.3);
        const left = Math.round(centreX - w / 2 - layout.capHeightPx * 0.15);
        const top = y - Math.round(h2 / 2);
        const width = w + Math.round(layout.capHeightPx * 0.3);
        // Under slide the stroke travels with its text: the same \move window,
        // and the clip starts offset by the same distance so it follows the
        // stroke down while it sweeps open (both interpolate over one window).
        const slide = entrance === "slide";
        const sweep = slide ? ms : within(animMs(ANIM_MS.headlineSweep, s.speed), eventMs);
        const dy = slide ? slideDy : 0;
        const open = `\\clip(${left},${top},${left + width},${top + h2})`;
        // A later part draws the stroke already open.
        const stroke = entering
          ? `\\clip(${left},${top - dy},${left},${top - dy + h2})\\t(0,${sweep},${open})`
          : open;
        events.push(
          `Dialogue: 0,${start},${end},headline,,0,0,0,,` +
            `{\\an7${slide ? `\\move(0,${-dy},0,0,0,${ms})` : "\\pos(0,0)"}\\bord0\\shad0\\1c&H${plateColour}&\\1a&H00&` +
            `${stroke}\\p1}` +
            `m ${left} ${top} l ${left + width} ${top} l ${left + width} ${top + h2} l ${left} ${top + h2}{\\p0}`,
        );
      }
      if (s.glow) {
        events.push(`Dialogue: 0,${start},${end},headline,,0,0,0,,{\\an5${at(centreX, y)}${rot}${enter}${glowTags(s.glow, layout.capHeightPx)}}${line}`);
      }
      // `type` is the one entrance longer than a few hundred ms (35 ms a
      // character), so a cut can land inside it: a later part shows what is
      // typed by then and types the rest on the element's own clock.
      const body = s.entrance === "type" ? typeIn(line, typed, stride, eventMs, elapsedMs) : line;
      typed += [...line].length;
      events.push(`Dialogue: 1,${start},${end},headline,,0,0,0,,{\\an5${at(centreX, y)}${rot}${enter}${fx}}${body}`);
    }
  }

  return { styleLine, events, layout };
}

/** One text element to draw (caption styles P3). `span` is clip seconds, lead excluded; null = the headline's own timing. */
                              
               
                          
                                   
                                                    
     
                                                                           
                                                                             
                                                                              
                                                                           
                                                                              
                                
     
                                                                         
  

const STYLES_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";

/**
 * Element k (counted from the bottom, k > 0) restacked over the ones below
 * it (ruling R3): its own Style name, `headline<k+1>`, and its events moved
 * up from layers 0 and 1 to `2k` and `2k+1`. Rewritten on the emitted
 * strings so the per-element emitter -- whose single-element bytes are
 * pinned -- is untouched. Every event starts `Dialogue: <layer>,<start>,<end>,headline,`,
 * and an ASS time holds no comma; an event that does not is a broken emitter
 * and throws, rather than staying on layers 0/1 under `headline`, where it
 * would draw beneath every element stacked over it. Exported for that test only.
 */
export function stacked(
  part                                                                 ,
  k        ,
)                                                                  {
  if (k === 0) return part;
  const name = `headline${k + 1}`;
  return {
    styleLine: part.styleLine.replace("Style: headline,", `Style: ${name},`),
    events: part.events.map((event) => {
      const prefix = /^Dialogue: (\d+),([^,]*),([^,]*),headline,/;
      if (!prefix.test(event)) throw new Error(`text element ${k}: event cannot be restacked: ${event}`);
      return event.replace(
        prefix,
        (_all, layer        , start        , end        ) => `Dialogue: ${Number(layer) + 2 * k},${start},${end},${name},`,
      );
    }),
    layout: part.layout,
  };
}

/**
 * Every text element of one pass in ONE file (caption styles P3, rulings R2
 * and R3), in draw order, bottom first: one `[Script Info]`, one Style line
 * per element, and element k on ASS layers `2k` (plate, marker, glow) and
 * `2k+1` (text), so a higher element's plate covers a lower one's text. The
 * parts of one split element (`part`) count as one element k.
 * Element k's events also come after element k-1's in the file, so libass's
 * Layer order and its file order agree here: the outcome holds under either
 * rule. That libass sorts by Layer first is read from its source
 * (`ass_render.c`'s event sort), not measured. The OUTCOME was measured in
 * the worker image (ffmpeg 5.1.9) on 2026-10-06 (P3a gate): a magenta plate
 * over a cyan `IIII`, dark pixels in a 120x16 strip inside the plate across
 * the `IIII`: 0 of 1920 with the plate on top, 448 of 1920 with the order
 * swapped. Since Layer and file order agree here, that does not tell libass's
 * two rules apart.
 */
export function buildTextAss(
  elements                           ,
  clipDurationSec        ,
  frame            ,
  offsetSec         = 0,
)                                             {
  // k counts source elements: a later part of a split element (`part.index`
  // > 0) stacks on the layers and Style name of the part before it, and adds
  // no Style line of its own (its layout, so its line, is the same).
  let k = -1;
  const parts = elements.map((element) => {
    const continues = element.part !== undefined && element.part.index > 0;
    if (!continues) k += 1;
    const built = stacked(
      headlineParts(
        element.text,
        element.settings,
        element.span ?? headlineWindow(element.settings, clipDurationSec),
        frame,
        offsetSec,
        element.style,
        element.part,
      ),
      k,
    );
    return { ...built, styleLines: continues ? [] : [built.styleLine] };
  });
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    // 2 = no automatic wrapping. `layoutHeadline` already decided the breaks
    // against a measured advance table, and letting libass re-break them
    // would put text where no \pos accounts for it and where the plate --
    // sized from those same breaks -- does not reach.
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    STYLES_FORMAT,
    ...parts.flatMap((part) => part.styleLines),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  return { ass: [...header, ...parts.flatMap((part) => part.events), ""].join("\n"), layouts: parts.map((part) => part.layout) };
}

/**
 * The complete `headline.ass` for one headline: `buildTextAss` with one
 * element on the headline's own timing. Its bytes are pinned
 * (render-headline-styles.test.ts, caption-loops.test.ts's digests, the
 * off-path fixture).
 */
export function buildHeadlineAss(
  text        ,
  headline               ,
  clipDurationSec        ,
  frame            ,
  offsetSec         = 0,
  style                ,
)                                          {
  const { ass, layouts } = buildTextAss([{ text, settings: headline, style, span: null }], clipDurationSec, frame, offsetSec);
  return { ass, layout: layouts[0]  };
}

/** True for a style that is today's headline: the plate, with nothing of its own on it. */
function isBarePlate(s               )          {
  return s.look === "plate" && s.font === null && s.rot === 0 && s.entrance === "none"
    && !s.glow && !s.outline && !s.shadow && s.plateColour === undefined && s.textCase === undefined;
}

/** `H:MM:SS.cc` back to milliseconds, the inverse of `assTime`. */
function assToMs(t        )         {
  const [h, m, rest] = t.split(":");
  const [sec, cs] = rest .split(".");
  return ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(cs) * 10;
}

/**
 * Typewriter: each character invisible until its turn, `stride` ms apart,
 * counting on from `first` characters already typed on earlier lines. Every
 * start is capped so its window ends by the element's own end. An event that
 * starts `elapsedMs` into the element's clock (a later part of a split
 * element) draws the characters already typed plainly and moves the rest's
 * times back by it.
 */
function typeIn(line        , first        , stride        , eventMs        , elapsedMs = 0)         {
  return [...line]
    .map((ch, i) => {
      const at = Math.min((first + i) * stride, Math.max(0, eventMs - 1));
      if (elapsedMs > 0 && at <= elapsedMs) return ch;
      const from = at - elapsedMs;
      return `{\\alpha&HFF&\\t(${from},${from + 1},\\alpha&H00&)}${ch}`;
    })
    .join("");
}
