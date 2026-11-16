// A clip's headline plate and logo (spec §7.5 steps 8 and 9): the brand's headline block as one ASS file, and the
// logo as an ffmpeg filter stage. The skill's own orchestrator over the copies in engine/boqo/, in the order the
// hosted render runs them (render/pipeline.ts):
//   headline  `headlineText` (the clip's title or hook, none when empty), `headlineStyleFor(headline)` (the brand's
//             style with its knobs laid over it), `buildHeadlineAss(text, headline, clipDurationSec, frame, leadSec,
//             style)`, one `headline.ass` burned on top of the captions by its own `subtitles` filter;
//   logo      `logoFits` (all or nothing), `logoOverlayPosition`, `logoChain` over the logo, its window moved by the lead
//             when a hook leads the clip (`shiftLogoTiming`).
// Hosted's per-clip text layers, viral text hooks, labels and panel placement have no counterpart in the skill.
//
// Not held by a golden of its own: tests/headline.test.mjs holds `headlineTrack` to boqo's own steps (golden
// build-headline-ass) and `logoStage` to `logoChain` and `logoOverlayPosition` (golden logo-chain). Imports no
// child_process.
import { BrandHeadline, headlineStyleFor, headlineText, headlineWindow } from './boqo/headline.mjs';
import { buildHeadlineAss } from './boqo/headline-ass.mjs';
import { logoChain, logoFits, logoOverlayPosition, shiftLogoTiming } from './boqo/brand-logo.mjs';
import { DEFAULT_OUTPUT } from './captions.mjs';

/**
 * boqo's Default brand template's headline (the `brand_templates` row with `is_platform_preset`, read 2026-11-16; spec
 * §6): a lime plate under the clip's title, in Montserrat ExtraBold, upper case, popping in at 0 s and holding 12 s.
 * (core's `DEFAULT_HEADLINE` is the base a creator starts a new headline from and holds 3 s; the template says 12.)
 */
export const DEFAULT_TEMPLATE_HEADLINE = Object.freeze({
  style: 'plate',
  source: 'title',
  font: Object.freeze({ kind: 'builtin', name: 'Montserrat ExtraBold' }),
  textCase: 'upper',
  plateColour: '#C8FF4D',
  plateOpacity: 1,
  boxWidthFraction: 0.84,
  positionFraction: 0.14,
  capHeightFraction: 0.022,
  cornerRadiusFraction: 0.01,
  timing: Object.freeze({ kind: 'window', startSec: 0, holdSec: 12 }),
  entrance: 'pop',
});

/**
 * boqo's Default template's logo values: bottom-left, a tenth of the frame wide, 8.54% in from the left and 6% up
 * from the bottom, at 35% opacity, the whole clip. The file is the person's own (the brand kit's `logo.file`, none by
 * default); boqo's own mark is never bundled. `key` is the schema's required R2 key and is not read by the chain.
 */
export const DEFAULT_TEMPLATE_LOGO = Object.freeze({
  key: 'logo',
  width: 0.1,
  anchor: 'bottom-left',
  marginX: 0.0854,
  marginY: 0.06,
  opacity: 0.35,
  timing: Object.freeze({ kind: 'whole' }),
});

const fail = (msg) => {
  throw new TypeError(`headline: ${msg}`);
};
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const frameOf = (output) => {
  const f = output ?? DEFAULT_OUTPUT;
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width <= 0 || f.height <= 0) fail('output must be { width, height } in whole pixels');
  return f;
};

// core's `BrandLogo` (packages/core/src/brand.ts) bounds, which that module's zod schema states and this skill does not
// carry (brand.ts also holds the whole brand-settings schema): the anchors, the margin, width and opacity bands, and
// `BrandTiming`'s window bounds.
export const LOGO_ANCHORS = ['top-left', 'top-centre', 'top-right', 'bottom-left', 'bottom-centre', 'bottom-right'];
/** What is wrong with a logo's values, one message each (empty when none): the brand kit's validation and `logoStage` share it. */
export function logoProblems(logo) {
  const within = (x, lo, hi) => finite(x) && x >= lo && x <= hi;
  const bad = [];
  if (!LOGO_ANCHORS.includes(logo?.anchor)) bad.push(`anchor must be one of ${LOGO_ANCHORS.join(', ')}`);
  if (!within(logo?.marginX, 0, 0.45)) bad.push('marginX must be 0 to 0.45');
  if (!within(logo?.marginY, 0, 0.45)) bad.push('marginY must be 0 to 0.45');
  if (!(within(logo?.width, 0, 0.5) && logo.width > 0)) bad.push('width must be above 0 and at most 0.5');
  if (!within(logo?.opacity, 0.05, 1)) bad.push('opacity must be 0.05 to 1');
  const t = logo?.timing;
  if (t?.kind === 'window') {
    if (!within(t.startSec, 0, 60)) bad.push('timing.startSec must be 0 to 60');
    if (!within(t.holdSec, 0.5, 60)) bad.push('timing.holdSec must be 0.5 to 60');
  } else if (t?.kind !== 'whole') bad.push("timing.kind must be 'whole' or 'window'");
  return bad;
}
function checkLogo(logo) {
  const bad = logoProblems(logo);
  if (bad.length > 0) fail(`the logo does not parse: ${bad.join('; ')}`);
}

/**
 * The clip's headline: `{ ass, layout, text }`, or `null` when it draws none (no headline block, or the chosen
 * source is empty: a `hook` template on a clip with no hook draws nothing rather than an empty plate).
 *
 * - `title`, `hook`: the clip's text (`hook` may be null).
 * - `headline`: the brand's headline block (zod `BrandHeadline`; boqo's Default template's when absent, `null` for no
 *   headline).
 * - `durationSec`: the clip's length in seconds, lead excluded; the headline's window is clamped into it.
 * - `leadSec`: where the clip's own first frame sits in the file when a hook leads it (0 for none).
 * - `output`: the frame, `{ width, height }` (9:16 when absent).
 * `layout.overflow` says the text did not fit its box even at the smallest size; `layout.shrunk` that it was shrunk.
 */
export function headlineTrack(o) {
  const { title, hook = null, durationSec } = o ?? {};
  if (typeof title !== 'string') fail('title must be a string');
  if (hook !== null && typeof hook !== 'string') fail('hook must be a string or null');
  if (!finite(durationSec) || !(durationSec > 0)) fail(`durationSec must be positive, got ${durationSec}`);
  const leadSec = o.leadSec ?? 0;
  if (!finite(leadSec) || leadSec < 0) fail(`leadSec must be 0 or more, got ${leadSec}`);
  const frame = frameOf(o.output);
  const block = o.headline === undefined ? DEFAULT_TEMPLATE_HEADLINE : o.headline;
  if (block === null) return null;
  const parsed = BrandHeadline.safeParse(block);
  if (!parsed.success) fail(`the brand's headline does not parse: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(block)'}: ${i.message}`).join('; ')}`);
  const text = headlineText(parsed.data, { title, hook });
  if (text === null) return null;
  const { ass, layout } = buildHeadlineAss(text, parsed.data, durationSec, frame, leadSec, headlineStyleFor(parsed.data));
  return { ass, layout, text };
}

/**
 * The clip's headline as a text element for the render: `{ text, settings, style, span }`, the shape boqo's
 * pipeline.ts hands `panelsTextElements` and `buildTextAss` (its `drawable` over the clip's one text element, the
 * brand headline: `range` null, so its span is `elementSpan`'s, the headline's own window), or `null` when it draws
 * none: no headline block, an empty source, or a window with nothing inside the clip (`elementSpan` null).
 * `buildTextAss([element], durationSec, output)` on it writes the file `headlineTrack` writes.
 *
 * Takes `headlineTrack`'s `title`, `hook`, `headline` and `durationSec`.
 */
export function headlineElement(o) {
  const { title, hook = null, durationSec } = o ?? {};
  if (typeof title !== 'string') fail('title must be a string');
  if (hook !== null && typeof hook !== 'string') fail('hook must be a string or null');
  if (!finite(durationSec) || !(durationSec > 0)) fail(`durationSec must be positive, got ${durationSec}`);
  const block = o.headline === undefined ? DEFAULT_TEMPLATE_HEADLINE : o.headline;
  if (block === null) return null;
  const parsed = BrandHeadline.safeParse(block);
  if (!parsed.success) fail(`the brand's headline does not parse: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(block)'}: ${i.message}`).join('; ')}`);
  const text = headlineText(parsed.data, { title, hook });
  if (text === null) return null;
  // text-layers.ts `elementSpan` for an element with `range` null: the headline's window, or null when it is empty.
  const span = headlineWindow(parsed.data, durationSec);
  if (!(span.startSec < span.endSec)) return null;
  return { text, settings: parsed.data, style: headlineStyleFor(parsed.data), span };
}

/**
 * The logo's filter stage: `{ chain, x, y, enableFromSec? }` for the render's `[1:v]…[blogo]` input (the looped
 * still) and its `overlay` position, or `null` when the clip is too short for a windowed logo (all or nothing: a logo
 * that fades in and is cut off mid-hold reads as a rendering fault). A caller with no logo file draws no logo and
 * does not call this.
 *
 * - `logo`: the values (zod `BrandLogo`; boqo's Default template's when absent).
 * - `durationSec`, `leadSec`, `output`: as `headlineTrack`. Behind a hook a windowed logo's fades move by the lead and
 *   the overlay is enabled only from the lead, so a whole-clip logo covers the clip and not the hook.
 */
export function logoStage(o) {
  const { durationSec } = o ?? {};
  if (!finite(durationSec) || !(durationSec > 0)) fail(`durationSec must be positive, got ${durationSec}`);
  const leadSec = o.leadSec ?? 0;
  if (!finite(leadSec) || leadSec < 0) fail(`leadSec must be 0 or more, got ${leadSec}`);
  const frame = frameOf(o.output);
  const logo = o.logo ?? DEFAULT_TEMPLATE_LOGO;
  checkLogo(logo);
  if (!logoFits(durationSec, logo)) return null;
  const position = logoOverlayPosition(logo, frame);
  return {
    chain: logoChain(leadSec === 0 ? logo : shiftLogoTiming(logo, leadSec), frame),
    x: position.x,
    y: position.y,
    ...(leadSec > 0 && { enableFromSec: leadSec }),
  };
}
