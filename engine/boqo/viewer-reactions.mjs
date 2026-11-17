// ported from boqo-ai/boqo packages/core/src/viewer-reactions.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { sanitiseQuote } from "./quote-text.mjs";


/** A top-level comment as the Data API returns it, before any rule is applied. */


/** At most this many reactions are kept per video (selector-signals spec §5). */
export const REACTION_MAX = 12;
/** A kept comment is cut to this many characters. */
export const REACTION_TEXT_MAX = 120;
/** Reactions this close together (inclusive) are one moment; the most-liked stays. */
export const REACTION_NEIGHBOUR_SEC = 10;
/** A comment with more distinct timestamps than this is a chapter list, not a reaction. */
export const REACTION_MAX_TIMESTAMPS = 3;

// m:ss, mm:ss or h:mm:ss, not part of a longer run of digits and colons.
const TIMESTAMP = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g;

/**
 * The clock times in a comment, in seconds, in the order they appear. A
 * match that cannot be a clock time (seconds of sixty or more, or minutes of
 * sixty or more beside an hours field) is skipped.
 */
export function parseTimestamps(text        )           {
  const found           = [];
  for (const match of text.matchAll(TIMESTAMP)) {
    const hours = match[1] === undefined ? null : Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (seconds >= 60) continue;
    if (hours !== null && minutes >= 60) continue;
    found.push((hours ?? 0) * 3600 + minutes * 60 + seconds);
  }
  return found;
}

/**
 * The moments viewers pointed at, chosen from a video's top comments
 * (selector-signals spec §5): one reaction per comment, at its first
 * timestamp, if that is inside the video; chapter lists dropped; the
 * most-liked kept where several fall within `REACTION_NEIGHBOUR_SEC` of each
 * other; at most `REACTION_MAX`; returned in time order.
 */
export function pickReactions(comments              , durationSec        )                   {
  const candidates                   = [];
  for (const comment of comments) {
    const stamps = parseTimestamps(comment.text);
    if (stamps.length === 0) continue;
    if (new Set(stamps).size > REACTION_MAX_TIMESTAMPS) continue;
    const sec = stamps[0] ;
    if (sec > durationSec) continue;
    const text = sanitiseQuote(comment.text, REACTION_TEXT_MAX);
    if (text === "") continue;
    const likes = Number.isFinite(comment.likes) ? Math.max(0, Math.floor(comment.likes)) : 0;
    candidates.push({ sec, likes, text });
  }

  candidates.sort((a, b) => b.likes - a.likes || a.sec - b.sec);
  const accepted                   = [];
  for (const candidate of candidates) {
    if (accepted.some((kept) => Math.abs(kept.sec - candidate.sec) <= REACTION_NEIGHBOUR_SEC)) continue;
    accepted.push(candidate);
    if (accepted.length === REACTION_MAX) break;
  }
  return accepted.sort((a, b) => a.sec - b.sec);
}
