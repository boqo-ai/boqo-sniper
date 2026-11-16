// A clip's captions (spec §7.5 step 7): its words, through its window and pause cuts, in the brand's caption style,
// as one ASS file that libass draws with the bundled fonts (`fontsdir` = engine/fonts, each face found by family).
//
// The skill's own orchestrator over the copies in engine/boqo/, in the order the hosted render runs them
// (render/pipeline.ts):
//   1. words     `captionWordsFor` (core clip-enhance.ts): the window's words (`wordsWithin`, each with its index in
//                the transcript), moved onto the clip's timeline through the snapped pause cuts (`wordsThroughCuts`).
//                Hosted's plan also drops the words `fillers.json` names and masks censored ones; the skill has no
//                filler marks and censors nothing, so the plan reduces to its cuts;
//   2. style     `resolveProjectCaptions(BRAND_CAPTION_KEY, captions)`: the brand's `style` with its knobs laid over
//                it, as a project on the brand's captions (`default`) resolves; boqo's Default template when the
//                brand has none;
//   3. emphasis  the selection's emphasis words, each also given the clip's own spelling of it when the two differ
//                only by case, punctuation or quote marks (`emphasisForWords`);
//   4. build     `buildCaptions(words, preset, output, sceneCuts, emphasis)`.
// Hosted's caption edits, hook replays and per-clip overrides have no counterpart in the skill.
//
// Not held by a golden of its own: tests/captions.test.mjs holds `captionsTrack` to boqo's own steps 1, 2 and 4
// (golden caption-track). Imports no child_process.
import { fileURLToPath } from 'node:url';
import { BrandCaptions, resolveProjectCaptions } from './boqo/caption-overrides.mjs';
import { BRAND_CAPTION_KEY } from './boqo/caption-presets.mjs';
import { emphasisKey } from './boqo/caption-words.mjs';
import { buildCaptions } from './boqo/captions.mjs';
import { wordsThroughCuts } from './boqo/cut-map.mjs';
import { wordsWithin } from './boqo/words.mjs';

/** The folder of bundled fonts, for libass's `fontsdir`. */
export const FONTS_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));

/**
 * boqo's Default brand template's captions (the `brand_templates` row with `is_platform_preset`, read 2026-11-16;
 * spec §6): Punch, the keyword in #E900FA, centred at 0.7 of the frame height.
 */
export const DEFAULT_TEMPLATE_CAPTIONS = Object.freeze({ style: 'punch', accentColours: Object.freeze(['#E900FA']), positionFraction: 0.7 });

/** The 9:16 frame a brand without a ratio renders at (core output-size.ts `REFERENCE_SIZE`). */
export const DEFAULT_OUTPUT = Object.freeze({ width: 1080, height: 1920 });

/**
 * Each face `CAPTION_FACES` can draw, as bundled in engine/fonts: its file, its licence and the PostScript name libass
 * reports in its `fontselect:` line when the face resolves to that file (engine/fonts/SOURCES.md has the sources).
 */
export const BUNDLED_FACES = Object.freeze({
  'Montserrat ExtraBold': { file: 'Montserrat-ExtraBold.ttf', license: 'OFL-Montserrat.txt', postscript: 'Montserrat-ExtraBold' },
  Oswald: { file: 'Oswald-Bold.ttf', license: 'OFL-Oswald.txt', postscript: 'Oswald-Bold' },
  Inter: { file: 'Inter-Bold.otf', license: 'OFL-Inter.txt', postscript: 'Inter-Bold' },
  'DejaVu Sans': { file: 'DejaVuSans-Bold.ttf', license: 'LICENSE-DejaVu.txt', postscript: 'DejaVuSans-Bold' },
  Anton: { file: 'Anton-Regular.ttf', license: 'OFL-Anton.txt', postscript: 'Anton-Regular' },
  'Bebas Neue': { file: 'BebasNeue-Regular.ttf', license: 'OFL-BebasNeue.txt', postscript: 'BebasNeue-Regular' },
  Bangers: { file: 'Bangers-Regular.ttf', license: 'OFL-Bangers.txt', postscript: 'Bangers-Regular' },
  'Poppins Black': { file: 'Poppins-Black.ttf', license: 'OFL-Poppins.txt', postscript: 'Poppins-Black' },
  'Archivo Black': { file: 'ArchivoBlack-Regular.ttf', license: 'OFL-ArchivoBlack.txt', postscript: 'ArchivoBlack-Regular' },
  'Luckiest Guy': { file: 'LuckiestGuy-Regular.ttf', license: 'LICENSE-LuckiestGuy.txt', postscript: 'LuckiestGuy-Regular' },
  'Permanent Marker': { file: 'PermanentMarker-Regular.ttf', license: 'LICENSE-PermanentMarker.txt', postscript: 'PermanentMarker-Regular' },
});

// Every quote-like mark, folded to one before two spellings are compared. A3 sanitises the selection request's text
// (`"` became `'`, and a transcript may carry typographic quotes), so an emphasis word the agent copied from it can
// differ from the clip's word by its quote marks alone.
const QUOTE_MARKS = /["'`´‘’‚‛“”„‟′″‹›«»]/g;

/** The form two spellings are compared in here: NFKC, every quote mark one `'`, then hosted's `emphasisKey`. */
export function tolerantKey(raw) {
  return emphasisKey(String(raw).normalize('NFKC').replace(QUOTE_MARKS, "'"));
}

/**
 * The emphasis list as the clip's own words spell it. Every entry is kept, and each clip word that matches an entry
 * by `tolerantKey` but not by hosted's own `emphasisKey` is added in its own spelling, so hosted's matcher (exact on
 * `emphasisKey`, every occurrence) then finds it. An entry no clip word matches stays as it is, and highlights
 * nothing, as hosted. `null` stays `null`.
 * @param {readonly string[] | null | undefined} emphasis
 * @param {readonly { word: string }[]} words
 * @returns {string[] | null}
 */
export function emphasisForWords(emphasis, words) {
  if (emphasis === null || emphasis === undefined) return null;
  const out = [...emphasis];
  const have = new Set(emphasis.map((e) => emphasisKey(e)));
  const wanted = new Set(emphasis.map((e) => tolerantKey(e)).filter((k) => k.length > 0));
  for (const w of words) {
    const exact = emphasisKey(w.word);
    if (have.has(exact) || !wanted.has(tolerantKey(w.word))) continue;
    have.add(exact);
    out.push(w.word);
  }
  return out;
}

const fail = (msg) => {
  throw new TypeError(`captions: ${msg}`);
};
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** The skill's `{ w, s, e }` words (engine/words.mjs) as the `{ word, start, end }` the copies read; hosted's pass through. */
function hostedWord(x, i) {
  const word = x?.w ?? x?.word;
  const start = x?.s ?? x?.start;
  const end = x?.e ?? x?.end;
  if (typeof word !== 'string' || !finite(start) || !finite(end)) fail(`words[${i}] needs a text and finite times`);
  return { word, start, end };
}

/**
 * The clip's caption track: `{ ass, overflowGroups, emphasisMatched, fallbackUsed, preset, words }`. `ass` is the
 * file, `fallbackUsed` says the clip's text needed a covering face (a Cyrillic clip in a Latin-only display face),
 * `preset` is the style as drawn and `words` the words on the clip's timeline.
 *
 * - `words`: the transcript (or any superset of the window), `{ w, s, e }` or `{ word, start, end }`, ascending, on
 *   the source's own clock, as `prepareWindow` takes them.
 * - `clipStart`, `clipEnd`: the window on that clock (prepareWindow's `startSec` and settled `endSec`).
 * - `cuts`: prepareWindow's `cuts`, the snapped pause cuts in window time (0 at `clipStart`); `[]` for none.
 * - `sceneCuts`: clip seconds where a shot starts, every shot but the first (`cutSecFromShots`); captions never hold
 *   a group across one.
 * - `emphasis`: the selection's emphasis words (`null` or `[]` for none).
 * - `brandCaptions`: the brand's caption block (zod `BrandCaptions`; boqo's Default template's when absent).
 * - `output`: the frame, `{ width, height }` (9:16 when absent).
 * - `preset`: optional, the resolved style to draw instead of resolving `brandCaptions` (a caller that adjusts it,
 *   as the stream panels' `panelsCaptionStyle` does, passes the adjusted one).
 */
export function captionsTrack(o) {
  const { clipStart, clipEnd } = o ?? {};
  if (!Array.isArray(o?.words)) fail('words must be an array');
  if (!finite(clipStart) || !finite(clipEnd) || !(clipEnd > clipStart)) fail(`a clip needs clipStart < clipEnd, got ${clipStart}..${clipEnd}`);
  const cuts = o.cuts ?? [];
  if (!Array.isArray(cuts) || cuts.some((c) => !finite(c?.start) || !finite(c?.end) || !(c.end > c.start))) fail('cuts must be [{ start, end }] with start < end');
  // Sorted and disjoint, as planCuts returns them: the cut map (windowToClipSec) walks them in order, and an unsorted or
  // overlapping list moves every word after it to the wrong second without an error.
  for (let i = 1; i < cuts.length; i++) if (cuts[i].start < cuts[i - 1].end) fail(`cuts must be sorted and disjoint: cuts[${i}] (${cuts[i].start}..${cuts[i].end}) starts before cuts[${i - 1}] ends (${cuts[i - 1].end})`);
  const sceneCuts = o.sceneCuts ?? [];
  if (!Array.isArray(sceneCuts) || !sceneCuts.every(finite)) fail('sceneCuts must be an array of seconds');
  const emphasis = o.emphasis ?? null;
  if (emphasis !== null && !(Array.isArray(emphasis) && emphasis.every((e) => typeof e === 'string'))) fail('emphasis must be an array of words or null');
  const output = o.output ?? DEFAULT_OUTPUT;
  if (!Number.isInteger(output?.width) || !Number.isInteger(output?.height) || output.width <= 0 || output.height <= 0) fail('output must be { width, height } in whole pixels');

  const preset = o.preset ?? brandCaptionPreset(o.brandCaptions);

  // captionWordsFor's `indexedWindow`: every word overlapping the window, with its index, then wordsWithin's filter,
  // rebase and overrun clamp; then the cut map.
  const indexed = [];
  o.words.forEach((x, index) => {
    const w = hostedWord(x, index);
    if (w.end > clipStart && w.start < clipEnd) indexed.push({ ...w, index });
  });
  const words = wordsThroughCuts(wordsWithin(indexed, clipStart, clipEnd), cuts);
  const built = buildCaptions(words, preset, output, sceneCuts, emphasisForWords(emphasis, words));
  return { ...built, preset, words };
}

/**
 * The style a brand's caption block draws in: `resolveProjectCaptions(BRAND_CAPTION_KEY, captions)`, as a project on
 * the brand's captions resolves; boqo's Default template's when `brandCaptions` is absent. Throws a TypeError naming
 * every problem when the block does not parse.
 */
export function brandCaptionPreset(brandCaptions) {
  const parsed = BrandCaptions.safeParse(brandCaptions ?? DEFAULT_TEMPLATE_CAPTIONS);
  if (!parsed.success) fail(`the brand's captions do not parse: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(block)'}: ${i.message}`).join('; ')}`);
  return resolveProjectCaptions(BRAND_CAPTION_KEY, parsed.data).preset;
}

/**
 * The clip's captions as one ASS file (`captionsTrack(o).ass`): no `[Fonts]` section, every style naming its face by
 * family, for libass to find in `fontsdir` = `FONTS_DIR`. Empty only for a style that draws no captions.
 */
export function captionsAss(o) {
  return captionsTrack(o).ass;
}

/**
 * A path as an ffmpeg filter option value, escaped for both levels ffmpeg parses a filtergraph at: the graph (which
 * reads `\ ' [ ] , ;` specially) and the filter's own options (`\ ' :`). Backslashes become `/` first, which Windows
 * accepts, so a drive letter's `:` is the only colon left to escape there.
 */
export function filterPath(path) {
  const options = String(path).replace(/\\/g, '/').replace(/[\\':]/g, (c) => `\\${c}`);
  return options.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** The `subtitles` filter that burns `assPath` with the faces in `fontsDir` (both escaped by `filterPath`). */
export function subtitlesFilter(assPath, fontsDir = FONTS_DIR) {
  return `subtitles=filename=${filterPath(assPath)}:fontsdir=${filterPath(fontsDir)}`;
}

/**
 * The lines of an ffmpeg log (at `-loglevel verbose` or above) that show libass drawing with a face other than the
 * bundled one: a `fontselect:` line resolving a family to anything but its bundled face (a system font by its path,
 * another face, the wrong instance), or naming a family with no bundled face, or saying it found no fallback; a glyph
 * the face lacks (`Glyph 0x… not found, selecting one more font`, after which libass draws it from some other font);
 * a font file libass could not open. Empty when every face came from `fontsdir`. libass logs no error for the first
 * two, and the caption still renders, in the wrong face (measured 2026-11-16 with BtbN ffmpeg 8.1: a family missing
 * from `fontsdir` resolved to `/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf` with nothing else logged).
 * @param {string} log
 */
export function fontFallbacks(log) {
  const out = [];
  for (const line of String(log).split(/\r?\n/)) {
    const m = /fontselect: \((.+), (\d+), (\d+)\) -> (.*), (-?\d+), (.*)$/.exec(line);
    if (m) {
      const face = BUNDLED_FACES[m[1]];
      if (!face || m[4].trim() !== face.postscript || m[6].trim() !== face.postscript) out.push(line.trim());
    } else if (/fontselect:|Glyph 0x[0-9A-Fa-f]+ not found|Error opening font/.test(line)) {
      out.push(line.trim());
    }
  }
  return out;
}
