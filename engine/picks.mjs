// Picks: the moments the agent chose. checkPicks rejects a bad set with a
// reason the agent can act on; snapPick moves a pick's edges onto word
// boundaries so a clip starts and ends on whole words.

/** @typedef {import('./words.mjs').Word} Word */
/** @typedef {{ s: number, e: number, title: string, hook?: string }} Pick */

const SNAP_SEC = 0.3;
/** An edge never moves further than this when snapping. */
export const SNAP_MAX_SEC = 1.5;
const MIN_SNAPPED_SEC = 1;
const EPS = 1e-9;

const round3 = (x) => Math.round(x * 1000) / 1000;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Check a set of picks. Errors are short sentences naming the pick by its
 * 1-based index in the array given.
 * @param {Pick[]} picks
 * @param {{ duration: number, minSec?: number, maxSec?: number, countMin?: number, countMax?: number }} o
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkPicks(picks, o) {
  const { duration, minSec = 15, maxSec = 90, countMin = 1, countMax = 10 } = o;
  if (!Array.isArray(picks)) return { ok: false, errors: ['picks must be an array'] };

  const errors = [];
  if (picks.length < countMin) errors.push(`${picks.length} picks, under the ${countMin} minimum`);
  if (picks.length > countMax) errors.push(`${picks.length} picks, over the ${countMax} maximum`);

  const usable = [];
  picks.forEach((p, i) => {
    const n = i + 1;
    if (!p || typeof p !== 'object' || !isNum(p.s) || !isNum(p.e)) {
      errors.push(`pick ${n} needs numeric s and e in seconds`);
      return;
    }
    if (p.e <= p.s) {
      errors.push(`pick ${n} ends before it starts`);
      return;
    }
    const len = round3(p.e - p.s);
    if (p.s < 0) errors.push(`pick ${n} starts before 0 s`);
    if (p.e > duration) errors.push(`pick ${n} ends at ${round3(p.e)} s, past the video end at ${round3(duration)} s`);
    if (len < minSec) errors.push(`pick ${n} is ${len} s, under the ${minSec} s minimum`);
    if (len > maxSec) errors.push(`pick ${n} is ${len} s, over the ${maxSec} s maximum`);
    if (typeof p.title !== 'string' || p.title.trim() === '') errors.push(`pick ${n} has an empty title`);
    usable.push({ n, s: p.s, e: p.e });
  });

  // Overlap, in time order; compare with the pick that reaches furthest so a
  // long pick containing a short one is still caught.
  usable.sort((a, b) => a.s - b.s || a.n - b.n);
  let reach = null;
  for (const cur of usable) {
    if (reach && cur.s < reach.e) errors.push(`pick ${cur.n} overlaps pick ${reach.n}`);
    if (!reach || cur.e > reach.e) reach = cur;
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Snap a pick's edges to whole words, moving an edge at most `SNAP_MAX_SEC`.
 * Start: a word straddling `s` (and started at most 1.5 s earlier) backs `s`
 * up to its start; otherwise `s` moves to the first word starting at or after
 * `s - 0.3`, if that word starts within `s + 1.5`. End, mirrored: a word
 * straddling `e` (and ending at most 1.5 s later) extends `e` to its end;
 * otherwise `e` moves to the last word ending at or before `e + 0.3`, if that
 * word ends at or after `e - 1.5`. An edge with no such word stays. If snapping
 * would leave under 1 s, the pick is returned unchanged.
 * @param {Pick} p
 * @param {Word[]} words sorted by `s`
 * @returns {Pick}
 */
export function snapPick(p, words) {
  if (!Array.isArray(words) || words.length === 0) return { ...p };

  let s = p.s;
  const startWord = words.reduce(
    (best, x) => (x.s < p.s && p.s < x.e && p.s - x.s <= SNAP_MAX_SEC + EPS && (!best || x.s > best.s) ? x : best),
    null,
  );
  if (startWord) {
    s = startWord.s;
  } else {
    const first = words.find((x) => x.s >= p.s - SNAP_SEC - EPS);
    if (first && first.s <= p.s + SNAP_MAX_SEC + EPS) s = first.s;
  }

  let e = p.e;
  const endWord = words.reduce(
    (best, x) => (x.s < p.e && p.e < x.e && x.e - p.e <= SNAP_MAX_SEC + EPS && (!best || x.e < best.e) ? x : best),
    null,
  );
  if (endWord) {
    e = endWord.e;
  } else {
    let last = null;
    for (const x of words) if (x.e <= p.e + SNAP_SEC + EPS && (last === null || x.e > last.e)) last = x;
    if (last && last.e >= p.e - SNAP_MAX_SEC - EPS) e = last.e;
  }

  if (e - s < MIN_SNAPPED_SEC - EPS) return { ...p };
  return { ...p, s: round3(s), e: round3(e) };
}
