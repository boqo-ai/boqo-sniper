// ported from boqo-ai/boqo packages/core/src/caption-words.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
/**
 * How a transcript word becomes a caption word, and which caption words a
 * keyword highlighter marks (stage 8a).
 *
 * IN `packages/core` RATHER THAN IN THE WORKER, deliberately. The renderer
 * burns these decisions into the video and `apps/web` describes them back to
 * the creator -- today through `brand/caption-tile-preview.tsx`, and until
 * §5.5 through the clip editor's transcript panel -- so the two must agree
 * exactly. A surface that showed a different word from the one the render
 * highlights would be lying about the output, which is the one thing every
 * such surface's design rule forbids. Two copies of this normalisation, one
 * per app, is precisely the "two representations of one thing maintained in
 * two places" failure this repository records most often.
 *
 * Pure string work: no Node builtins, so `packages/core`'s own allow-list
 * test (node-builtins.test.ts) stays satisfied and Turbopack can bundle this
 * into a client component.
 */

// ported from boqo-ai/boqo packages/core/src/audio-enhance.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut import: `maskWord` (audio-enhance.ts:75-109, with its MASK_CYCLES and LETTER_OR_DIGIT) is copied below
// verbatim, so `captionDisplayText` draws a censored word as hosted does; the rest of audio-enhance.ts is the B4
// Audio Enhance schemas this skill does not use. The skill censors nothing today, so `mask` is never set.
/**
 * The cycle each mask fills a censored word from, after its first letter
 * (spec §2): "fuck" -> f***, f#*!, f@!@.
 */
const MASK_CYCLES = { stars: "*", hash: "#*!", at: "@!" };

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * One censored caption word, masked.
 *
 * Keeps every character that is not a letter or digit where it is -- leading
 * and trailing punctuation, and an inner "&" or hyphen -- and the word's first
 * letter or digit, in its own case. Every later letter or digit becomes the
 * next character of the mask's cycle. So the mask is the word's own length in
 * code points (spec §2's deliberate change from the owner's five-character
 * examples), and "fuck," is "f***," with its comma still in place.
 *
 * NFC first: a decomposed "й" is two code points, and the second, a combining
 * mark, would otherwise survive as a stray accent on a mask character.
 */
function maskWord(word, mask) {
  const cycle = MASK_CYCLES[mask];
  let keptFirst = false;
  let next = 0;
  let out = "";
  for (const char of word.normalize("NFC")) {
    if (!LETTER_OR_DIGIT.test(char)) {
      out += char;
    } else if (!keptFirst) {
      keptFirst = true;
      out += char;
    } else {
      out += cycle.charAt(next % cycle.length);
      next += 1;
    }
  }
  return out;
}

/**
 * Punctuation removed from a caption: terminal and clause marks, plus the
 * quote family. `'` and `-` are deliberately absent — they are handled below
 * by position, not by identity.
 *
 * EVERY QUOTE IN EVERY REGEX IN THIS FILE IS A UNICODE ESCAPE, AND MUST STAY
 * ONE — here and in `captionText`'s two edge-stripping expressions below.
 * Written literally, a `"` or `'` inside a character class desyncs
 * `packages/core/tests/node-builtins-scanner.ts`, which does not model regex
 * literals and reads that quote as opening a string — after which it skips
 * the rest of the file, imports included, and the Node-builtins allow-list
 * silently stops guarding this module.
 *
 * That guard caught this itself, twice, with an error naming the byte offset
 * and the likely cause, rather than passing vacuously — which is the whole
 * difference between a check and a decoration. Do not "tidy" the escapes back
 * into literals; the worker's own copy could carry them because nothing scans
 * `apps/worker`, and this file cannot.
 *
 * The class covers, by codepoint: U+0022 U+201C U+201D U+2018 U+2026
 * U+00AB U+00BB, plus . , ! ? ; : ( ) [ ].
 */
const STRIPPABLE = /[.,!?;:\u2026\u0022\u201C\u201D\u2018()\[\]\u00AB\u00BB]/g;

/**
 * The display form of one transcript word.
 *
 * MUST be applied after grouping, never before. `captionLines` reads exactly
 * the characters this removes, so stripping first would silently reinstate
 * the defect fixed in bc5af8f — a caption carrying the tail of one sentence
 * and the head of the next.
 *
 * An apostrophe or hyphen BETWEEN two word characters survives, because the
 * reference render keeps YOU'VE and BRAND-NEW intact and removing the mark
 * changes the word rather than tidying it. One at an edge is a quote or a
 * dangling dash and goes.
 */
export function captionText(
  raw        ,
  opts                                                                         ,
)         {
  let text = raw;
  if (opts.stripPunctuation) {
    const stripped = text
      .replace(STRIPPABLE, "")
      .replace(/^[-\u0027\u2019]+/, "")
      .replace(/[-\u0027\u2019]+$/, "");
    // A word that was nothing but punctuation keeps its original form: an
    // empty span would drop a highlight step without dropping its event.
    if (stripped.length > 0) text = stripped;
  }
  if (opts.textCase === "upper") text = text.toUpperCase();
  if (opts.textCase === "lower") text = text.toLowerCase();
  return text;
}

/**
 * The display form of a caption word that may be censored (B4 Audio
 * Enhance). An unmasked word is exactly `captionText`. A masked word is
 * stripped as the preset strips (its own punctuation goes, as any word's
 * would), THEN masked, THEN cased -- so the mask's own characters are never
 * taken for punctuation: `f#*!` would otherwise lose its `!` and `f@!@`
 * its `!` under every preset that strips.
 */
export function captionDisplayText(
  word                                     ,
  opts                                                                         ,
)         {
  if (word.mask === undefined) return captionText(word.word, opts);
  const bare = captionText(word.word, { textCase: "preserve", stripPunctuation: opts.stripPunctuation });
  const masked = maskWord(bare, word.mask);
  return opts.textCase === "upper" ? masked.toUpperCase() : opts.textCase === "lower" ? masked.toLowerCase() : masked;
}

/**
 * Words never worth highlighting, however confidently the model returns one.
 *
 * The rubric asks for content words and a model that returns "the" would
 * highlight a third of a clip, at which point the second colour stops
 * carrying information. The rubric cannot be trusted alone for this: it is
 * guidance to a model, and this is the guard.
 *
 * DELIBERATELY SHORT, and deliberately only English and Russian — the two
 * languages this product has actually rendered. The failure directions are
 * not symmetric, which is what sets the size: a stopword this list misses
 * over-highlights ONE word and is visible on screen, while a word wrongly
 * listed silently drops a real keyword and looks exactly like the model not
 * having chosen it. So it errs small.
 *
 * Not a general-purpose stopword list, and not to be grown into one without
 * a reason from watched output.
 */
const STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "he", "i", "in", "is", "it", "its", "of", "on", "or", "she", "that",
  "the", "they", "this", "to", "was", "we", "were", "with", "you",
  // Russian
  "а", "в", "во", "все", "вы", "да", "для", "до", "его", "если", "есть",
  "еще", "же", "за", "и", "из", "как", "к", "меня", "мы", "на", "не",
  "но", "о", "он", "она", "они", "от", "по", "с", "со", "так", "то",
  "ты", "у", "что", "это", "я",
]);

/**
 * The form two words are compared in.
 *
 * Punctuation is stripped and case folded **unconditionally**, regardless of
 * what the caption preset does for DISPLAY. That asymmetry is deliberate and
 * is the whole point of this function:
 *
 *   - The model returns a word as the transcript spells it, which may carry a
 *     trailing comma or a sentence-initial capital that the same word lacks
 *     elsewhere. Matching strictly on those would fail on the accidents of
 *     where a word happened to fall in a sentence.
 *   - A preset with `stripPunctuation: false` and `textCase: "preserve"`
 *     still means the same word by "Fire," as by "fire".
 *
 * So display normalisation and match normalisation are different questions,
 * and conflating them was the available mistake here. `captionText` is reused
 * rather than reimplemented so the punctuation rules cannot drift apart from
 * the ones the renderer actually applies.
 */
export function emphasisKey(raw        )         {
  return captionText(raw, { textCase: "preserve", stripPunctuation: true })
    .trim()
    .toLocaleLowerCase();
}

/**
 * The set a clip's caption words are tested against.
 *
 * `null` — the clip's selection predates stage 8a — and `[]` — 8a ran and the
 * model found nothing — both yield an empty set, because at render time they
 * mean the same thing: highlight nothing. The distinction between them is
 * real and is preserved in the column, in the log and in the interface (see
 * `clips.emphasisWords`); it simply has no consequence here.
 */
export function buildEmphasisSet(words                                      )              {
  if (!words) return new Set();
  const set = new Set        ();
  for (const word of words) {
    const key = emphasisKey(word);
    // Only a whitespace-only entry reaches this, because captionText returns
    // the ORIGINAL when stripping would empty a word -- so "..." stays "..."
    // and never lands here. Measured, not assumed: the first version of this
    // guard's test used "..." and the guard could be deleted with every test
    // still green.
    if (key.length === 0) continue;
    if (STOPWORDS.has(key)) continue;
    set.add(key);
  }
  return set;
}

/**
 * Whether one transcript word should be emphasised.
 *
 * EVERY occurrence of a listed word matches, not the one the model had in
 * mind. A verbatim word list carries no position, so this is inherent to the
 * signal's shape rather than a shortcut taken here — design §2.4 chose the
 * word list over indices or timestamps knowingly, and records that the
 * escalation, if repeated-word highlighting reads badly when watched, is to
 * change the SIGNAL rather than to add heuristics at this end.
 *
 * Do not "fix" this by matching only the first occurrence: which occurrence
 * the model meant is not recoverable from what it returned.
 */
export function isEmphasised(raw        , set                     )          {
  if (set.size === 0) return false;
  return set.has(emphasisKey(raw));
}
