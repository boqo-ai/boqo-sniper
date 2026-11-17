// Text the caption faces cannot draw, or simple shaping cannot lay out (E2-fix3). The skill's own step over the ASS
// the ported modules write (engine/boqo/captions.mjs, headline-ass.mjs), so the copies stay verbatim.
//
// DELIBERATE DEVIATION FROM HOSTED. boqo's render burns every ASS with ffmpeg's `subtitles` filter and installs no
// Devanagari face (apps/worker/Dockerfile at bcc9d99cc: fonts-dejavu-core, fonts-inter and nine Google Fonts files,
// none of which covers Devanagari). Two defects followed on every Hindi clip the skill rendered, measured 2026-11-16
// with BtbN ffmpeg 8.1 (libass 0x1705000, HarfBuzz 15.0.0):
//   1. The `subtitles` filter shapes with libass's SIMPLE shaper. Its render of an ASS is byte-identical to the `ass`
//      filter's at `shaping=simple` and differs from `shaping=auto` and `shaping=complex` (which agree), so no
//      Indic reordering and no conjuncts: the vowel sign ि drew after its consonant and every conjunct came apart
//      with a bare virama ("सिर्फ", "दिल्ली", "क्रू" read as "सरिफ", "दलिली", "करू"). The `subtitles` filter has no
//      `shaping` option; the `ass` filter has. Which shaper `subtitles` gets depends on the build: on CI
//      (2026-11-16) Ubuntu's apt ffmpeg drew Devanagari unshaped as this one does, while the macOS (Homebrew
//      ffmpeg-full) and Windows (choco ffmpeg-full) builds already shaped it. Asking the `ass` filter for complex
//      shaping by name makes it the same on every build.
//   2. No bundled face draws Devanagari, so libass's glyph fallback took whatever the machine had
//      (`Glyph 0x938 not found, selecting one more font for (Oswald, 700, 0)` ->
//      /usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf here; tofu or nothing on a machine without one).
// So: every run of Devanagari in a caption or headline line is drawn in the bundled Noto Sans Devanagari Bold
// (`routeScriptFaces`, an explicit `\fn` switch around the run and back), and a file holding text of a script that
// needs shaping is burned through the `ass` filter at `shaping=complex` (`needsComplexShaping`, used by
// captions.mjs `subtitlesFilter`). A file with neither is untouched: byte-identical ASS, the same `subtitles` filter,
// so a Latin or Cyrillic clip draws exactly as before (complex shaping kerns Latin: measured the same day, the
// eleven faces' Latin and Cyrillic line drew 117,101 bytes different at `shaping=complex`).
//
// Why a switch around each run and not a covering face for the whole clip, as `coveringFace` does for Cyrillic:
// Hindi speech carries English words ("Vivo V80 का वेट"), which stay in the style's own face this way, and the line
// widths the layout measures stay the style face's (a Devanagari character is its `fallbackAdvance`, as before).

/** The face a run of Devanagari is drawn in, by family, as libass finds it in `fontsdir`. */
export const DEVANAGARI_FACE = 'Noto Sans Devanagari';

/**
 * Faces bundled for a script rather than a caption style, as `BUNDLED_FACES` lists the style faces: file, licence,
 * and the PostScript name libass reports in its `fontselect:` line when the face resolves to the bundled file.
 */
export const SCRIPT_FACES = Object.freeze({
  [DEVANAGARI_FACE]: { file: 'NotoSansDevanagari-Bold.ttf', license: 'OFL-NotoSansDevanagari.txt', postscript: 'NotoSansDevanagari-Bold' },
});

// Devanagari as the bundled face covers it (fc-query of the file: 900-97f 1cd0-1cf6 1cf8-1cf9 a8e0-a8ff). A ZWJ or
// ZWNJ joins a run only between two of its characters, never alone, so an emoji's ZWJ sequence is left whole.
const DEV = '\\u0900-\\u097F\\u1CD0-\\u1CF6\\u1CF8\\u1CF9\\uA8E0-\\uA8FF';
const DEVANAGARI_RUN = new RegExp(`[${DEV}](?:[\\u200C\\u200D]*[${DEV}])*`, 'g');
const HAS_DEVANAGARI = new RegExp(`[${DEV}]`);

// Scripts libass draws wrongly without HarfBuzz: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, the Indic
// block (Devanagari to Sinhala), Thai, Lao, Tibetan, Myanmar, Khmer, Mongolian, Vedic extensions, Devanagari
// Extended, and Arabic presentation forms. Only Devanagari has a bundled face; the others still need one from the
// machine, but at least are shaped.
const COMPLEX = /[֐-ࣿऀ-෿฀-࿿က-႟ក-᢯᳐-᳿꣠-ꣿיִ-﷿ﹰ-﻿]/;

/** True when `text` (an ASS file, or any text) holds a character of a script that needs libass's complex shaping. */
export function needsComplexShaping(text) {
  return COMPLEX.test(String(text));
}

/** The fields of a `Format:` line, trimmed. */
const formatOf = (line) => line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim());

/** An ASS Bold field or `\b` value as the `\b` tag that restores it (-1 is true, 0 false, a weight itself). */
const boldTag = (v) => {
  const s = String(v).trim();
  return s === '0' ? '0' : /^\d{3}$/.test(s) ? s : '1';
};

/**
 * One Dialogue's text with every Devanagari run wrapped in `{\b1\fn<DEVANAGARI_FACE>}…{\fn<face>\b<bold>}`, `<face>`
 * and `<bold>` being what the line draws in at that point: its style's, as `\fn`, `\b` and `\r` override them.
 * Override blocks are copied as they are, and so is text drawn as a shape (`\p1` and up). `\b1` because the bundled
 * face is the Bold: asked at weight 400 (a style with Bold 0), libass prefers any Regular the machine has. The order
 * matters too: libass looks a face up at every `\fn` and `\b` tag, in order, and a `\fn` before the `\b1` looked up
 * the Devanagari face at 400 and resolved it to the machine's NotoSansDevanagari-Regular.ttf (measured 2026-11-16 in
 * the burn test's log, a Bangers line); `\b1` first, and `\fn` first on the way back, look up only bundled faces.
 */
function routeText(text, lineStyle, styles) {
  let font = lineStyle.font;
  let bold = boldTag(lineStyle.bold);
  let drawing = false;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const close = text.indexOf('}', i);
      if (close !== -1) {
        const block = text.slice(i, close + 1);
        for (const m of block.matchAll(/\\(?:fn([^\\}]*)|r([^\\}]*)|b(\d+)|p(\d+))/g)) {
          if (m[1] !== undefined) font = m[1].trim() || lineStyle.font;
          else if (m[2] !== undefined) {
            const to = styles.get(m[2].trim()) ?? lineStyle;
            font = to.font;
            bold = boldTag(to.bold);
          } else if (m[3] !== undefined) bold = boldTag(m[3]);
          else drawing = m[4] !== '0';
        }
        out += block;
        i = close + 1;
        continue;
      }
    }
    const next = text.indexOf('{', i + 1);
    const end = next === -1 ? text.length : next;
    const chunk = text.slice(i, end);
    out += drawing ? chunk : chunk.replace(DEVANAGARI_RUN, (run) => `{\\b1\\fn${DEVANAGARI_FACE}}${run}{\\fn${font}\\b${bold}}`);
    i = end;
  }
  return out;
}

/**
 * The ASS with every Devanagari run of every Dialogue drawn in `DEVANAGARI_FACE` (see `routeText`). An ASS with no
 * Devanagari comes back as it is, the same string.
 * @param {string} ass
 */
export function routeScriptFaces(ass) {
  if (!HAS_DEVANAGARI.test(ass)) return ass;
  const styles = new Map();
  let section = '';
  let styleFormat = null;
  let eventFormat = null;
  return ass
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^\[.*\]$/.test(t)) {
        section = t.toLowerCase();
        return line;
      }
      if (/^Format:/i.test(t)) {
        if (section === '[events]') eventFormat = formatOf(t);
        else styleFormat = formatOf(t);
        return line;
      }
      if (/^Style:/i.test(t) && styleFormat !== null) {
        const f = formatOf(t);
        const at = (name) => f[styleFormat.findIndex((x) => x.toLowerCase() === name)];
        styles.set(at('name'), { font: at('fontname'), bold: at('bold') ?? '0' });
        return line;
      }
      if (/^Dialogue:/i.test(line) && eventFormat !== null) {
        // Text is the last field and may hold commas: split off the others only.
        const head = line.indexOf(':') + 1;
        let cut = head;
        for (let k = 0; k < eventFormat.length - 1; k++) cut = line.indexOf(',', cut) + 1;
        if (cut <= head) return line;
        const fields = line.slice(head, cut - 1).split(',');
        const styleName = fields[eventFormat.findIndex((x) => x.toLowerCase() === 'style')]?.trim();
        const lineStyle = styles.get(styleName) ?? styles.get('Default') ?? { font: 'Arial', bold: '0' };
        return line.slice(0, cut) + routeText(line.slice(cut), lineStyle, styles);
      }
      return line;
    })
    .join('\n');
}
