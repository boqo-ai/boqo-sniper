// ported from boqo-ai/boqo packages/core/src/words.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                                      

/**
 * Shortens any word whose `end` runs past the next word's `start`.
 *
 * Deepgram does this on roughly 0.4-2.2% of words, worst case by 3.19s, and
 * it is a real defect rather than a quirk: a caption group is displayed from
 * its first word's start to its last word's end, so one overrunning word
 * leaves its whole caption on screen underneath the next one. That is exactly
 * what "IT'S IT'S AN OBVIOUS" drawn over "BECAUSE YOU / CAN'T JUMP" was —
 * "obvious" claimed 20.46-21.58 while "dance" began at 20.83.
 *
 * A pair the vendor emitted OUT OF ORDER — the next word starting at or
 * before this one — is deliberately left alone. Clamping there would give
 * `end <= start`, and `buildPositioned` drops any such word, so the text
 * would silently disappear from the captions. Four such pairs exist in the
 * 30,735 words measured, all of them overlapping speech between two
 * speakers; a brief overlap is the better of the two failures.
 */
export function clampOverrunningEnds                          (words     )      {
  return words.map((word, index) => {
    const next = words[index + 1];
    if (next === undefined || next.start <= word.start || word.end <= next.start) return word;
    return { ...word, end: next.start };
  });
}

/**
 * Narrows the project's words to one clip and rebases them to zero.
 *
 * The rebase is the part that matters: captions are burned onto an extracted
 * file that starts at zero, so absolute transcript times would place every
 * caption however many minutes into the clip the moment happened to occur.
 *
 * A word straddling a boundary is kept rather than dropped — half a word of
 * silence at a clip edge reads as a bug — and clamped so it cannot start
 * before zero. Overrunning ends are clamped too, by clampOverrunningEnds above.
 */

export function wordsWithin                          (
  words              ,
  startSec        ,
  endSec        ,
)      {
  return clampOverrunningEnds(
    words
      .filter((word) => word.end > startSec && word.start < endSec)
      .map((word) => ({
        ...word,
        start: Math.max(word.start - startSec, 0),
        end: Math.max(word.end - startSec, 0),
      })),
  );
}
