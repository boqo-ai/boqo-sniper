// Captions as an ASS subtitle file: a clip's words and the person's brand in
// one of four presets (karaoke, punch, clean, highlight), plus an optional hook
// title. The render burns it with `ass=captions.ass:fontsdir=<engine/fonts>`.
import { readFileSync } from 'node:fs';
import { PRESETS } from './brand.mjs';

/** @typedef {import('./words.mjs').Word} Word */
/** @typedef {import('./brand.mjs').Brand} Brand */

/**
 * The bundled font for each brand font. `family` is the family name in the
 * TTF's `name` table: libass matches the style's Fontname against it and
 * silently falls back to another font on a mismatch. `bold` is the style's
 * Bold flag (-1 selects the bold file; Anton ships one weight, already heavy).
 * The render copies exactly these files, and their licences, into its fonts dir.
 */
export const FONT_FILES = {
  Inter: { family: 'Inter', file: 'Inter-Bold.ttf', bold: -1, license: 'OFL-Inter.txt' },
  Anton: { family: 'Anton', file: 'Anton-Regular.ttf', bold: 0, license: 'OFL-Anton.txt' },
};

const DEFAULT_FRAME = { w: 1080, h: 1920 };
const MAX_GAP_SEC = 0.6;
const HOOK_SEC = 3;
const CAP_FRACTION = 0.045; // font size, as a fraction of frame height
const PUNCH_SCALE = 1.25;
const HOOK_SCALE = 1.1;
const HOOK_MAX_LINES = 2;
const OUTLINE_FRACTION = 0.004;
const HOOK_Y_FRACTION = 0.12;
const SIDE_MARGIN_FRACTION = 0.055;

// words per group: [min, max]
const GROUP_SIZE = { punch: [1, 2], karaoke: [3, 4], highlight: [3, 4], clean: [1, 6] };

/**
 * `#RRGGBB` as an ASS colour, `&HAABBGGRR` (alpha 0 opaque .. 255 clear).
 * @param {string} hex
 * @param {number} [alpha]
 */
export function assColor(hex, alpha = 0) {
  if (typeof hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    throw new Error(`colour must be #RRGGBB, got ${JSON.stringify(hex)}`);
  }
  const a = Math.min(255, Math.max(0, Math.round(alpha)));
  const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  const x = hex.slice(1).toUpperCase();
  return `&H${h(a)}${x.slice(4, 6)}${x.slice(2, 4)}${x.slice(0, 2)}`;
}

/**
 * Text safe to put in a Dialogue. ASS has no escape for `{`, `}` or `\`, so
 * they become their full-width look-alikes; control characters (a newline
 * would end the Dialogue line) become spaces.
 * @param {string} text
 */
export function assEscape(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\\/g, '＼')
    .trim();
}

// Text width from the bundled TTFs: libass sizes a font so that its win
// ascent + descent equals Fontsize, and a glyph is `advance / (ascent +
// descent) * Fontsize` wide.
const metricsCache = new Map();
function fontMetrics(font) {
  let m = metricsCache.get(font.file);
  if (m) return m;
  const buf = readFileSync(new URL(`./fonts/${font.file}`, import.meta.url));
  const tables = {};
  for (let i = 0, n = buf.readUInt16BE(4); i < n; i++) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] = buf.readUInt32BE(o + 8);
  }
  const nHMetrics = buf.readUInt16BE(tables.hhea + 34);
  const advance = (gid) => buf.readUInt16BE(tables.hmtx + 4 * Math.min(gid, nHMetrics - 1));
  const height = buf.readUInt16BE(tables['OS/2'] + 74) + buf.readUInt16BE(tables['OS/2'] + 76);

  // cmap: prefer format 12 (all of Unicode), else format 4 (the BMP)
  const cm = tables.cmap;
  const subs = [];
  for (let i = 0, n = buf.readUInt16BE(cm + 2); i < n; i++) {
    const o = cm + 4 + i * 8;
    const off = cm + buf.readUInt32BE(o + 4);
    subs.push({ platform: buf.readUInt16BE(o), format: buf.readUInt16BE(off), off });
  }
  const sub = subs.find((x) => x.format === 12) ?? subs.find((x) => x.format === 4);
  const glyphOf = (cp) => {
    if (!sub) return 0;
    const o = sub.off;
    if (sub.format === 12) {
      for (let i = 0, n = buf.readUInt32BE(o + 12); i < n; i++) {
        const g = o + 16 + i * 12;
        const lo = buf.readUInt32BE(g);
        const hi = buf.readUInt32BE(g + 4);
        if (cp >= lo && cp <= hi) return buf.readUInt32BE(g + 8) + (cp - lo);
      }
      return 0;
    }
    if (cp > 0xffff) return 0;
    const segX2 = buf.readUInt16BE(o + 6);
    const ends = o + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2; i += 2) {
      if (cp > buf.readUInt16BE(ends + i)) continue;
      if (cp < buf.readUInt16BE(starts + i)) return 0;
      const ro = buf.readUInt16BE(ranges + i);
      if (ro === 0) return (cp + buf.readUInt16BE(deltas + i)) & 0xffff;
      const g = buf.readUInt16BE(ranges + i + ro + 2 * (cp - buf.readUInt16BE(starts + i)));
      return g === 0 ? 0 : (g + buf.readUInt16BE(deltas + i)) & 0xffff;
    }
    return 0;
  };

  m = { height, glyphOf, advance };
  metricsCache.set(font.file, m);
  return m;
}

/**
 * Estimated width in pixels of one line of `text` at ASS `Fontsize` `size`.
 * A character the bundled font lacks (emoji, CJK, ...) is drawn by a fallback
 * font; it counts as one em.
 * @param {{ file: string }} font an entry of `FONT_FILES`
 * @param {string} text
 * @param {number} size
 */
export function textWidth(font, text, size) {
  const m = fontMetrics(font);
  let units = 0;
  for (const ch of text) {
    const g = m.glyphOf(ch.codePointAt(0));
    units += g ? m.advance(g) : m.height;
  }
  return (units / m.height) * size;
}

// A usable fraction under 1: kerning and rounding are not measured.
const FIT_SLACK = 0.97;
const MIN_FIT_PCT = 20;

/**
 * The scale (1 = none) that makes every word fit `avail` px on one line, and
 * at most `maxLines` lines when given. Text that fits is left alone.
 * @param {{ file: string }} font
 * @param {string[]} words as drawn
 * @param {number} size ASS Fontsize
 * @param {number} avail pixels between the margins, outline included
 * @param {number} [maxLines]
 */
function fitScale(font, words, size, avail, maxLines = 99) {
  const limit = avail * FIT_SLACK;
  const space = textWidth(font, ' ', size);
  const widths = words.map((x) => textWidth(font, x, size));
  const lines = (room) => {
    let n = 1;
    let used = 0;
    for (const wd of widths) {
      if (wd > room) return Infinity; // one word wider than a line cannot wrap
      if (used > 0 && used + space + wd > room) {
        n++;
        used = wd;
      } else {
        used += used > 0 ? space + wd : wd;
      }
    }
    return n;
  };
  for (let pct = 100; pct > MIN_FIT_PCT; pct--) {
    if (lines(limit / (pct / 100)) <= maxLines) return pct / 100;
  }
  return MIN_FIT_PCT / 100;
}

const endsSentence = (w) => /[.!?]["'”’)\]]*$/.test(w);

/**
 * Words in on-screen groups. A group never spans a gap over 0.6 s and never
 * crosses a sentence end (`.`, `!`, `?`). Each run between those breaks is
 * cut into the fewest groups the preset's maximum allows, evenly, so a run
 * never ends in a one-word orphan. A run shorter than the preset's minimum
 * stays one short group.
 * @param {Word[]} words
 * @param {'karaoke'|'punch'|'clean'|'highlight'} preset
 * @returns {Word[][]}
 */
export function groupWords(words, preset) {
  const size = GROUP_SIZE[preset];
  if (!size) throw new Error(`unknown caption preset ${JSON.stringify(preset)}`);
  const max = size[1];

  const runs = [];
  let run = [];
  for (const w of words) {
    const prev = run.at(-1);
    if (prev && w.s - prev.e > MAX_GAP_SEC + 1e-9) {
      runs.push(run);
      run = [];
    }
    run.push(w);
    if (endsSentence(w.w)) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  const groups = [];
  for (const r of runs) {
    const k = Math.ceil(r.length / max);
    const base = Math.floor(r.length / k);
    const extra = r.length % k;
    let at = 0;
    for (let i = 0; i < k; i++) {
      const n = base + (i < extra ? 1 : 0);
      groups.push(r.slice(at, at + n));
      at += n;
    }
  }
  return groups;
}

// centiseconds, floored (with a nudge for 1.15 * 100 = 114.999...) so a time
// never lands past the word it came from
const cs = (sec) => Math.max(0, Math.floor(sec * 100 + 1e-6));
function stamp(centis) {
  const h = Math.floor(centis / 360000);
  const m = Math.floor((centis % 360000) / 6000);
  const s = Math.floor((centis % 6000) / 100);
  const c = centis % 100;
  const p = (n) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

// black or white, whichever reads on this colour (the highlight box's text)
function contrastOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#000000' : '#FFFFFF';
}

// a colour inside an override tag: \1c wants &HBBGGRR& (no alpha digits)
const tagColor = (hex) => `${assColor(hex).replace(/^&H00/, '&H')}&`;

// one `Style:` line; the outline colour is also BorderStyle 3's box colour
function styleLine(name, font, size, { primary, outlineColor = '#000000', borderStyle = 1, outline, alignment = 5 }, side) {
  return [
    `Style: ${name}`, font.family, size, primary, primary, assColor(outlineColor), assColor('#000000'),
    font.bold, 0, 0, 0, 100, 100, 0, 0, borderStyle, outline, 0, alignment, side, side, 0, 1,
  ].join(',');
}

/**
 * The ASS file for a clip.
 * @param {Word[]} words rebased to the clip (see `wordsInRange`)
 * @param {Brand} brand
 * @param {{ w: number, h: number }} [frame] default 1080x1920
 * @param {string} [hook] a title shown at the top for the first 3 s
 * @returns {string}
 */
export function assFor(words, brand, frame = DEFAULT_FRAME, hook) {
  const { w, h } = frame ?? DEFAULT_FRAME;
  const preset = brand.captions.preset;
  if (!PRESETS.includes(preset)) throw new Error(`unknown caption preset ${JSON.stringify(preset)}`);
  const font = FONT_FILES[brand.font];
  if (!font) throw new Error(`unknown brand font ${JSON.stringify(brand.font)}`);

  const text = assColor(brand.colors.text);
  const size = Math.round(CAP_FRACTION * h * brand.captions.size);
  const outline = Math.round(OUTLINE_FRACTION * h);
  const side = Math.round(SIDE_MARGIN_FRACTION * w);
  const x = Math.round(w / 2);
  const y = Math.round(brand.captions.position * h);
  const place = `\\an5\\pos(${x},${y})`;
  // pixels a line may take: between the margins, with room for the outline
  // (and, in highlight, the box padding) on both sides
  const avail = w - 2 * side - 4 * outline;
  // the same percentage on both axes: a long word shrinks, it is not squashed
  const fsc = (f) => (f < 1 ? `\\fscx${Math.round(f * 100)}\\fscy${Math.round(f * 100)}` : '');

  const sorted = [...words].sort((a, b) => a.s - b.s);
  const hookText = typeof hook === 'string' ? assEscape(hook) : '';

  const styles = [styleLine('Default', font, size, { primary: text, outline }, side)];
  const punchSize = Math.round(size * PUNCH_SCALE);
  if (preset === 'punch') styles.push(styleLine('Punch', font, punchSize, { primary: text, outline }, side));
  if (preset === 'highlight') {
    // BorderStyle 3 draws the outline colour as a box; its width is the padding
    const box = { primary: text, outlineColor: brand.colors.accent, borderStyle: 3, outline: outline * 2 };
    styles.push(styleLine('Box', font, size, box, side));
  }
  const hookSize = Math.round(size * HOOK_SCALE);
  if (hookText) styles.push(styleLine('Hook', font, hookSize, { primary: text, outline, alignment: 8 }, side));

  const events = [];
  const add = (style, startSec, endSec, body) => {
    const a = cs(startSec);
    const b = cs(endSec);
    if (b <= a) return;
    events.push(`Dialogue: 0,${stamp(a)},${stamp(b)},${style},,0,0,0,,${body}`);
  };

  if (hookText) {
    const last = sorted.at(-1);
    const end = last ? Math.min(HOOK_SEC, last.e) : HOOK_SEC;
    // at most two lines; longer is scaled down to fit
    const f = fitScale(font, hookText.split(' '), hookSize, avail, HOOK_MAX_LINES);
    add('Hook', 0, end, `{\\an8\\pos(${x},${Math.round(HOOK_Y_FRACTION * h)})${fsc(f)}\\fad(150,150)}${hookText}`);
  }

  const shown = (word) => assEscape(preset === 'punch' ? word.w.toUpperCase() : word.w);
  for (const group of groupWords(sorted, preset)) {
    // one scale for the whole group, so a karaoke group does not jump between
    // its per-word Dialogues; only a word too wide for a line ever shrinks it
    const f = fitScale(font, group.map(shown), preset === 'punch' ? punchSize : size, avail);
    const scale = fsc(f);
    if (preset === 'clean') {
      add('Default', group[0].s, group.at(-1).e, `{${place}${scale}}${group.map(shown).join(' ')}`);
    } else if (preset === 'punch') {
      const pop = `\\fscx${Math.round(f * 85)}\\fscy${Math.round(f * 85)}\\t(0,100,\\fscx${Math.round(f * 100)}\\fscy${Math.round(f * 100)})`;
      add('Punch', group[0].s, group.at(-1).e, `{${place}${pop}}${group.map(shown).join(' ')}`);
    } else {
      // karaoke and highlight: the whole group stays up, one Dialogue per
      // spoken word, each running to the next word's start
      const accent = tagColor(brand.colors.accent);
      const plain = tagColor(brand.colors.text);
      const boxText = tagColor(contrastOn(brand.colors.accent));
      group.forEach((spoken, i) => {
        const parts = group.map((word) => {
          if (word !== spoken) return shown(word);
          return preset === 'karaoke'
            ? `{\\1c${accent}}${shown(word)}{\\1c${plain}}`
            : `{\\rBox\\3c${accent}\\1c${boxText}${scale}}${shown(word)}{\\r${scale}}`;
        });
        add('Default', spoken.s, i < group.length - 1 ? group[i + 1].s : spoken.e, `{${place}${scale}}${parts.join(' ')}`);
      });
    }
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    '',
  ].join('\n');
}
