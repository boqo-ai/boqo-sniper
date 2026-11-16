// ported from boqo-ai/boqo packages/core/src/caption-layout.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { assFontSize, fontMetrics, measureWidth,                  } from "./caption-metrics.mjs";
import { scalePreset,                              } from "./caption-presets.mjs";
                                                  
import { coveringFace } from "./caption-faces.mjs";
import { buildEmphasisSet, captionDisplayText, isEmphasised } from "./caption-words.mjs";
// ported from boqo-ai/boqo packages/core/src/caption-edits.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo packages/core/src/illustrated.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Cut imports, copied below verbatim: `paceTime` (caption-edits.ts:159-169; the rest of that module is the
// clip editor's stored caption edits, which a skill has none of, so `timeSpans` is never passed) and
// `isNumberToken` with its NUMBER_WORDS (illustrated.ts:122-148; the rest of that module is the Illustrated
// look's B-roll, SFX and grade, which this skill does not render).

/**
 * Spec §4.3's pace: `s + (t − s0)·(e − s)/(e0 − s0)`, mapping a time in the
 * spoken span `[s0, e0]` onto the shown span `[s, e]`. A zero-length spoken
 * span puts every time at `s`.
 */
function paceTime(t, spoken, shown) {
  const [s0, e0] = spoken;
  const [s, e] = shown;
  if (e0 <= s0) return s;
  return s + ((t - s0) * (e - s)) / (e0 - s0);
}

/**
 * Number words for the key-word rule (spec §5.2): hundred, thousand, million,
 * billion, percent, half, double, triple and their plurals. Digits are caught by
 * `isNumberToken`'s `/\d/` whatever the vendor emits; this list covers the
 * English quantity words, marked H.
 */
const NUMBER_WORDS = new Set([
  "hundred",
  "hundreds",
  "thousand",
  "thousands",
  "million",
  "millions",
  "billion",
  "billions",
  "percent",
  "half",
  "double",
  "triple",
]);

/** True when the token has a digit, or is a number word once case-folded and stripped of punctuation. */
function isNumberToken(raw) {
  if (/\d/.test(raw)) return true;
  const word = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return NUMBER_WORDS.has(word);
}
                                                
                                                      

/**
 * Where every caption line goes: font size, per-line y, per-group word
 * wrapping, and each word's active span.
 *
 * IN `packages/core` RATHER THAN IN THE WORKER, deliberately. `buildPositioned`
 * (`apps/worker/src/render/captions.ts`) used to decide this AND write ASS in
 * one function; the first half is exactly what the clip editor's compositor
 * needs to draw the identical caption track in a browser, and the second is
 * worker-only string building. Splitting them here means the browser runs
 * the SAME layout code the renderer does rather than a second implementation
 * that could silently disagree with it -- two copies of one decision is the
 * failure this repository records most often. libass never decides a line
 * break or a position on this path; it is handed one event per line at an
 * explicit `\pos`, computed here.
 *
 * `captionGroups` and `wrapGroup` moved here with `layoutCaptions` because
 * they are the two decisions inside it, not a separate concern -- both are
 * copied verbatim from `buildPositioned`'s own arithmetic rather than
 * re-derived, since a re-derivation is where byte-identity between the
 * renderer and the compositor would die.
 */

/**
 * Splits `items` into exactly `groupCount` runs, as evenly as the split
 * permits — the first `remainder` runs take one item more than the rest.
 *
 * Even distribution rather than a greedy slice is what removes orphans: a
 * slice-by-4 turns thirteen words into 4,4,4,1, and the lone trailing word
 * reads as a stutter at exactly the moment a thought lands.
 */
export function distributeEvenly   (items     , groupCount        )        {
  if (items.length === 0 || groupCount <= 0) return [];
  const base = Math.floor(items.length / groupCount);
  let longer = items.length % groupCount;
  const out        = [];
  let cursor = 0;
  for (let n = 0; n < groupCount; n += 1) {
    const size = base + (longer > 0 ? 1 : 0);
    if (longer > 0) longer -= 1;
    if (size > 0) out.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

/**
 * Terminal punctuation, allowing the closers that can follow it: `spot.`,
 * `there?`, `"go home."`, `(now!)`.
 *
 * This is readable at all only because `transcribe/normalize.ts` prefers
 * Deepgram's `punctuated_word` over its bare `word` — the sentence boundary
 * has always been carried on `TranscriptWord.word` and was simply never read
 * here.
 */
const SENTENCE_END = /[.!?\u2026][\u0022\u0027\u201d\u2019)\]\u00bb]*$/;

/**
 * Words ending in a period that do not end a sentence. Two of the three are
 * structural — an initial (`J.`) and a dotted acronym (`U.S.`, `a.m.`) — and
 * the third is a deliberately short list of titles.
 *
 * Short because the two failure directions are not symmetric. Missing an
 * abbreviation strands one word on its own line; wrongly listing one merges
 * two sentences, which is the exact defect this code exists to prevent. So
 * `etc.` and `No.` are left off on purpose: both far more often end a real
 * sentence in speech ("No." is a complete spoken sentence) than abbreviate
 * anything.
 */
const ABBREVIATIONS = [
  /^(?:mr|mrs|ms|dr|prof|sr|jr|vs)\.$/i, // titles
  /^[A-Za-z]\.$/, // an initial
  /^(?:[A-Za-z]\.){2,}$/, // a dotted acronym
];

/**
 * Exported so `captions.ts`'s legacy `captionLines` -- which stays in the
 * worker, since `classic` is the frozen control arm the acceptance gate
 * compares by SHA-256 -- can keep using the identical rule rather than a
 * second copy of it.
 */
export function endsSentence(text        )          {
  if (!SENTENCE_END.test(text)) return false;
  return !ABBREVIATIONS.some((pattern) => pattern.test(text));
}

/**
 * Groups words by cadence rather than by sentence: runs of `target` words,
 * bounded by `min` and `max`, ignoring punctuation entirely.
 *
 * This is deliberately the opposite rule from `captionLines` below, and both
 * are correct for their own preset. `captionLines` exists because a caption
 * reading "best hiding spot. Darius," shows two half-thoughts, and the full
 * stop visible mid-line is what makes it read that way. A positioned preset
 * strips punctuation and uppercases everything, so that cue does not exist
 * for a reader to trip over and what remains is pacing — which is what this
 * function controls. The reference render confirms the practice: it runs
 * "AND TO SAVE HUMANITY" straight into "AND STARTING SEPTEMBER 1ST".
 *
 * A silence longer than `gapSplitSec` ends a group, so a caption never hangs
 * on screen through a pause. That behaviour is chosen on the merits and is
 * NOT observed in the reference, whose speech is continuous throughout.
 *
 * A speaker change ends a group too, and that one is absolute: a caption
 * carrying two voices is wrong however well it is paced. See the comment on
 * the run loop for why, and for what a null `speaker` does.
 */
/**
 * How near an inter-word boundary a scene cut has to land to be treated as
 * falling on it. A cut inside a word is ignored — the same word spans both
 * shots, so the speaker did not change at it — and this is the slack for a
 * cut that lands a frame or two either side of the join.
 */
const CUT_SNAP_SEC = 0.05;

export function captionGroups                          (
  words     ,
  bounds                                              ,
  gapSplitSec        ,
  cutSec                    = [],
)        {
  if (words.length === 0) return [];

  const runs        = [];
  let run      = [];
  for (const current of words) {
    const previous = run[run.length - 1];
    // Two reasons end a run, tested as one condition because there is one
    // decision to make. Writing them as two consecutive ifs is behaviourally
    // identical, not merely close: a word triggering both pushes an empty run
    // between them, and `distributeEvenly` returns [] for an empty array, so
    // that run is absorbed and never becomes a caption. Verified by mutation
    // — the two-if form passes every test in this file. Said explicitly
    // because the single condition looks like it is carrying a safety
    // property it is not; the emptiness guarantee lives in distributeEvenly.
    //
    // The speaker half mirrors normalize.ts, which already fences transcript
    // *segments* the same way and for the same reason: "a segment spanning
    // two speakers is wrong for both the transcript UI and the selection
    // prompt." It is wrong on screen too, and more visibly — a positioned
    // preset strips the punctuation that would otherwise hint at the seam, so
    // "THE WAVE I MEAN" reads as one person saying all four words when it is
    // the end of the host's sentence and the start of the guest's.
    //
    // The sentence half is the floor under the speaker half, and it exists
    // because diarization is wrong often enough to matter. The clip that
    // prompted this carries "YEAH YEAH AND YET" — a guest's two backchannels
    // and the host's next sentence, which Deepgram (nova-3, its best model)
    // labelled as ONE speaker in both its word and its paragraph output. No
    // speaker rule can split what the data says is continuous. A speaker turn
    // does land on a sentence boundary though, so ending a run at every full
    // stop guarantees the property the speaker rule can only approximate.
    //
    // It is a deliberate deviation from the reference this preset was
    // reverse-engineered from, which runs sentences together ("AND TO SAVE
    // HUMANITY" straight into "AND STARTING SEPTEMBER 1ST"). Taken knowingly
    // and by the product owner: a caption carrying two voices is a worse
    // defect than a caption of three words. It costs roughly 7-28% more
    // groups and moves the mode from four words toward three.
    //
    // The scene-cut half is the second floor, and it is the only signal here
    // that does not come from the transcript at all. An edited interview cuts
    // to whoever is talking, so a cut landing on a word boundary is a speaker
    // change the words may not record — which is exactly the reported case:
    // the camera cuts to the guest at t=10.32 and his "Yeah." starts at
    // t=10.30, while the host's interrupted "…of time" carries no full stop
    // for the sentence rule to catch. It costs almost nothing because most
    // cuts already land on a boundary the other rules found: +1 group of 64
    // on the podcast, +0 of 23 on the vlog, +4 of 43 on the chaos clip.
    //
    // A gap threshold was measured as an alternative to this and rejected —
    // at a sentence end, same-speaker gaps run 0.000-1.195s and
    // speaker-change gaps 0.000-3.360s, both with a median of 0.000, so no
    // threshold separates them.
    //
    // `!==` also fences a word the vendor declined to attribute (`speaker`
    // null) off from its labelled neighbours, because its speaker is unknown
    // and grouping it with either one is a guess that can produce the very
    // defect this rule prevents. A transcript with NO diarization at all is
    // untouched: every word is null, null !== null is false, and grouping
    // falls through to cadence exactly as before.
    const ended =
      previous !== undefined &&
      (current.start - previous.end > gapSplitSec ||
        current.speaker !== previous.speaker ||
        endsSentence(previous.word) ||
        cutSec.some(
          (cut) => cut >= previous.end - CUT_SNAP_SEC && cut <= current.start + CUT_SNAP_SEC,
        ));
    if (ended) {
      runs.push(run);
      run = [];
    }
    run.push(current);
  }
  runs.push(run);

  return runs.flatMap((items) => {
    // Round rather than ceil: eleven words at a target of four is three
    // groups of 4,4,3, not 4,4,3 arrived at via a fourth empty one.
    let groupCount = Math.max(1, Math.round(items.length / bounds.target));
    // Rounding down can leave a group over `max`; walk up until it cannot.
    while (Math.ceil(items.length / groupCount) > bounds.max) groupCount += 1;
    return distributeEvenly(items, groupCount);
  });
}

/**
 * Breaks one caption group into lines that fit `maxWidth`.
 *
 * boqo computes this itself instead of letting libass wrap, and that is not
 * a preference. libass derives a line's height from the largest glyph on it,
 * so the active word's inline \fscy grows its line and reflows the whole
 * block — measured at 68px against 78px of baseline spacing as the highlight
 * walked a two-line group. The reference render's baselines do not move, and
 * fixing them means owning the line breaks (design §3.1).
 *
 * Tries the fewest lines first, and within a line count picks the split that
 * minimises the WIDEST line rather than filling greedily — a greedy fill
 * leaves a long tail word alone on the last line, which is the same stutter
 * `distributeEvenly` exists to avoid.
 *
 * Keep in step with `wrapGroupMeasured` below: same search, other measure.
 */
export function wrapGroup(
  texts          ,
  opts                                                                                ,
)                                           {
  if (texts.length === 0) return { lines: [], overflow: false };

  const widthOf = (indices          ) =>
    measureWidth(opts.metrics, indices.map((i) => texts[i]).join(" "), opts.fontSize);

  const all = texts.map((_, index) => index);
  const maxLines = Math.max(1, Math.min(opts.maxLines, texts.length));

  let best                                               = null;
  for (let lineCount = 1; lineCount <= maxLines; lineCount += 1) {
    const candidate = bestSplit(all, lineCount, widthOf);
    if (best === null || candidate.widest < best.widest) best = candidate;
    if (candidate.widest <= opts.maxWidth) {
      return { lines: candidate.lines, overflow: false };
    }
  }
  // Nothing fits. Emit the narrowest arrangement found and say so — a
  // caption clipped at the frame edge is a wrong video that passes every
  // automated check, and this repo's own history says an unlogged fallback
  // is indistinguishable from one that never fires.
  return { lines: best .lines, overflow: true };
}

/**
 * `wrapGroup` over per-word widths, for a style whose key words are drawn in another face.
 * Keep in step with `wrapGroup`: both search the same splits and differ only in how a line is measured.
 */
export function wrapGroupMeasured(
  texts          ,
  widthOfWord                       ,
  space        ,
  opts                                        ,
)                                           {
  if (texts.length === 0) return { lines: [], overflow: false };
  const widthOf = (indices          ) => indices.reduce((sum, i, j) => sum + widthOfWord(i) + (j > 0 ? space : 0), 0);
  const all = texts.map((_, index) => index);
  const maxLines = Math.max(1, Math.min(opts.maxLines, texts.length));
  let best                                               = null;
  for (let lineCount = 1; lineCount <= maxLines; lineCount += 1) {
    const candidate = bestSplit(all, lineCount, widthOf);
    if (best === null || candidate.widest < best.widest) best = candidate;
    if (candidate.widest <= opts.maxWidth) return { lines: candidate.lines, overflow: false };
  }
  return { lines: best .lines, overflow: true };
}

/**
 * Exhaustive over the break points, which is affordable because a group is
 * at most five words and a line count at most three: fewer than ten splits.
 */
function bestSplit(
  indices          ,
  lineCount        ,
  widthOf                               ,
)                                        {
  if (lineCount === 1) {
    return { lines: [indices], widest: widthOf(indices) };
  }
  let best                                               = null;
  // Every line must be non-empty, so the first break sits in [1, n-lineCount+1].
  for (let cut = 1; cut <= indices.length - lineCount + 1; cut += 1) {
    const head = indices.slice(0, cut);
    const rest = bestSplit(indices.slice(cut), lineCount - 1, widthOf);
    const widest = Math.max(widthOf(head), rest.widest);
    if (best === null || widest < best.widest) {
      best = { lines: [head, ...rest.lines], widest };
    }
  }
  return best ;
}

                                 
               
                       
                   
                                                                                                                
                            
                                                                                      
            
  

                                  
                                                                            
                             
                                                  
                    
                                                                        
                  
                                                                         
                                                                   
                    
                                                                                                                                                       
                            
                                                                                                                   
                           
  

                             
                                                                               
                   
                                                                               
                   
                      
                  
                               
                         
                          
                                                                                           
                             
                                                                          
                             
                                                                                    
                        
  

/**
 * Which of a group's words are key words (spec §5.2, #192). A word's own key
 * mark from the clip's caption edits (ruling R9) wins over every rule; past
 * it, a word is key when the emphasis list names it or, under `numbersKey`,
 * when it is a number token.
 *
 * `keyMax` then caps the RULE-derived key words: number tokens first, then
 * emphasis matches, each in order of appearance; the rest go unflagged. An
 * explicit `key: true` is the creator's choice, so it is always kept and does
 * not spend the budget; an explicit `key: false` stays false.
 *
 * With neither field set this is `word.key ?? isEmphasised(word.word, set)`,
 * the expression the layout used before, and every preset that predates the
 * Illustrated look sets neither (caption-styles.test.ts pins both facts, and
 * caption-layout-styles.test.ts pins main's layouts by digest).
 */
export function keyFlagsFor(
  group                                            ,
  emphasisSet                     ,
  preset                                           ,
)            {
  const numbers = preset.numbersKey === true;
  const flags = group.map(
    (word) => word.key ?? (isEmphasised(word.word, emphasisSet) || (numbers && isNumberToken(word.word))),
  );
  if (preset.keyMax === undefined) return flags;
  const ruled = flags.flatMap((flag, i) => (flag && group[i] .key === undefined ? [i] : []));
  const ranked = [
    ...ruled.filter((i) => isNumberToken(group[i] .word)),
    ...ruled.filter((i) => !isNumberToken(group[i] .word)),
  ];
  for (const i of ranked.slice(Math.max(0, preset.keyMax))) flags[i] = false;
  return flags;
}

/**
 * Decides where every caption line goes: font size, per-line y, per-group
 * word wrapping, and each word's active span -- everything a renderer needs
 * to draw a caption track, and everything the clip editor's compositor needs
 * to draw the identical one in a browser.
 *
 * This is `buildPositioned`'s own arithmetic, lifted out unchanged rather
 * than re-derived -- a re-derivation is where byte-identity between the
 * renderer and the compositor would die. `buildPositioned` is now an emitter
 * over this function's own output.
 */
export function layoutCaptions(
  words               ,
  preset                         ,
  output            ,
  cutSec                   ,
  emphasisWords                          ,
  /**
   * The texts the covering face is decided from, when that is not this call's
   * own words: a hook segment is laid out on its own, and must name the same
   * face as the clip it is merged into, so the caller passes the clip's texts.
   */
  coverTexts                    ,
  /**
   * Caption styles P3 (ruling R10): a clip's stored caption timings, keyed by
   * a group's first word index. A group whose first word is a key has its
   * words paced into that span; a key that starts no group is ignored. Only
   * the clip's own occurrence gets these -- hook replays regroup.
   */
  timeSpans                                             ,
)                {
  // Scaled ONCE, exactly as buildPositioned did -- never scalePresetExact,
  // whose fractional capHeightPx libass would accept silently.
  const scaled = scalePreset(preset, output);
  // The face that can draw this clip's words (spec §2.3; review focus 1). A
  // legacy preset's face covers everything it is ever given (fallback null),
  // so this is the identity for every existing clip.
  const texts = coverTexts ?? words.map((w) => w.word);
  const fontName = coveringFace(scaled.fontName, texts);
  const keyFontName = scaled.keyFont ? coveringFace(scaled.keyFont, texts) : null;
  const fallbackUsed = fontName !== scaled.fontName || (keyFontName !== null && keyFontName !== scaled.keyFont);
  const metrics = fontMetrics(fontName);
  const fontSize = assFontSize(metrics, scaled.capHeightPx);
  const keyMetrics = keyFontName ? fontMetrics(keyFontName) : null;
  const keyFontSize = keyMetrics ? assFontSize(keyMetrics, Math.round(scaled.capHeightPx * ((scaled.keyScalePct ?? 100) / 100))) : null;
  const lineSpacing = Math.round(scaled.capHeightPx * scaled.lineSpacingRatio);
  const centreY = Math.round(output.height * scaled.centreFraction);
  const maxWidth = output.width - scaled.sideMarginPx * 2;

  const emphasisSet = buildEmphasisSet(emphasisWords);
  let overflowGroups = 0;
  let emphasisMatched = 0;
  let keyOrdinal = 0;
  const groups                       = [];

  for (const spokenGroup of captionGroups(
    words,
    { min: scaled.wordsMin, target: scaled.wordsTarget, max: scaled.wordsMax },
    scaled.gapSplitSec,
    cutSec,
  )) {
    // Grouped on the SPOKEN times (ruling R10): a group is what the preset, the
    // pauses, the speakers and the cuts made of the words as said, and a stored
    // span only moves that group's words in time. `captionGroups` never returns
    // an empty group (distributeEvenly), so [0] exists.
    const first = spokenGroup[0] ;
    const spoken                   = [first.start, spokenGroup[spokenGroup.length - 1] .end];
    const firstIndex = first.index ?? null;
    const shown = firstIndex === null ? undefined : timeSpans?.[firstIndex];
    const group =
      shown === undefined
        ? spokenGroup
        : spokenGroup.map((w) => ({ ...w, start: paceTime(w.start, spoken, shown), end: paceTime(w.end, spoken, shown) }));
    const groupTexts = group.map((w) =>
      captionDisplayText(w, { textCase: scaled.textCase, stripPunctuation: scaled.stripPunctuation }),
    );
    // Key words are known before wrapping now: a key word drawn in another
    // face has another width, and the wrap has to measure it. A word's own
    // key mark (the clip's caption edits, ruling R9) wins over the list.
    const keyFlags = keyFlagsFor(group, emphasisSet, scaled);
    const widthOfWord = (i        ) =>
      keyFlags[i] && keyMetrics && keyFontSize
        ? measureWidth(keyMetrics, groupTexts[i] , keyFontSize)
        : measureWidth(metrics, groupTexts[i] , fontSize);

    // The active word renders at scalePct and libass wrapping is off, so a
    // line that fits unpopped clips at the frame edge the moment the popped
    // word grows past the margin. W + G <= output.width is the real
    // constraint; budget for the group's WIDEST word, since wrapGroup has
    // not chosen lines yet and any word can be the active one.
    const popGrowth =
      scaled.emphasis.kind === "scale"
        ? (scaled.emphasis.scalePct / 100 - 1) * Math.max(0, ...groupTexts.map((_, i) => widthOfWord(i)))
        : 0;

    const { lines, overflow } = keyMetrics
      ? wrapGroupMeasured(groupTexts, widthOfWord, measureWidth(metrics, " ", fontSize), {
          maxWidth: maxWidth - popGrowth,
          maxLines: scaled.maxLines,
        })
      : wrapGroup(groupTexts, {
          metrics,
          fontSize,
          maxWidth: maxWidth - popGrowth,
          maxLines: scaled.maxLines,
        });
    if (overflow) overflowGroups += 1;

    const lineY = lines.map((_, index) =>
      Math.round(centreY + (index - (lines.length - 1) / 2) * lineSpacing),
    );

    // Each line is centred on its own measured width; a word's left edge is
    // the running sum of the words (in their own faces) and spaces before it.
    const space = measureWidth(metrics, " ", fontSize);
    const xOf = new Map                ();
    for (const line of lines) {
      const total = line.reduce((sum, i, j) => sum + widthOfWord(i) + (j > 0 ? space : 0), 0);
      let x = output.width / 2 - total / 2;
      for (const i of line) {
        xOf.set(i, Math.round(x));
        x += widthOfWord(i) + space;
      }
    }

    const wordLayouts                      = group.map((word, i) => {
      const keyword = keyFlags[i] ;
      if (keyword) emphasisMatched += 1;
      return { text: groupTexts[i] , word, keyword, keyOrdinal: keyword ? keyOrdinal++ : null, x: xOf.get(i) ?? 0 };
    });

    const steps = group.map((active, wordIndex) => {
      // Held until the next word takes over so the gap between them is
      // covered; the group's last word keeps its own end, which clears the
      // caption before the next group appears.
      const next = group[wordIndex + 1];
      return {
        wordIndex,
        startSec: active.start,
        endSec: next ? Math.max(active.end, next.start) : active.end,
      };
    });

    groups.push({ words: wordLayouts, lines, lineY, steps, overflow, firstIndex, spoken });
  }

  return {
    fontName,
    fontSize,
    lineSpacing,
    centreY,
    groups,
    overflowGroups,
    emphasisMatched,
    keyFontName,
    keyFontSize,
    fallbackUsed,
  };
}
