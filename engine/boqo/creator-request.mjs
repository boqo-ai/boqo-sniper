// ported from boqo-ai/boqo apps/worker/src/creator-request.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * The creator's own words, quoted into a model's USER message (My projects v2
 * spec §4 Phase 3) -- never into a cached system prompt, where one
 * per-project value would silently disable caching on every call.
 *
 * Marked off between two fixed lines, in the transcript's own marker style
 * (`<<< most-replayed region begins >>>`), with every run of three or more
 * angle brackets inside it cut down to two, so the creator's text can never
 * forge a marker line. A prompt is one line by the time it gets here --
 * `normalizePrompt` folds line breaks -- so it cannot start a line of its
 * own either.
 */
export const REQUEST_BEGIN = "<<< the creator's request begins >>>";
export const REQUEST_END = "<<< the creator's request ends >>>";

export function neutraliseFences(text        )         {
  return text.replace(/<{3,}/g, "<<").replace(/>{3,}/g, ">>");
}

/** The block: a lead line, the opening marker, the request, the closing marker. */
export function requestLines(lead        , prompt        )           {
  return [lead, REQUEST_BEGIN, neutraliseFences(prompt), REQUEST_END];
}
