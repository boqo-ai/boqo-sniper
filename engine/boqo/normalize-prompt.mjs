// ported from boqo-ai/boqo packages/core/src/prompt.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * A creator's prompt (My projects v2 spec §3 I, §4 Phase 3; D4, D5): the few
 * words that tell selection, or a watch's judge, what to look for. One
 * normaliser for every writer and reader -- the three creation routes, the
 * composer deciding whether to send a key at all, the select stage and the
 * judge -- so they cannot disagree on what a prompt is.
 *
 * No regex in this file contains a quote character: packages/core's barrel is
 * walked by tests/node-builtins-scanner.ts, which does not model regex
 * literals and reads a quote inside one as the start of a string (engineering
 * record, "Brand templates, stage 8a").
 */
export const PROMPT_MAX = 300;

const WHITESPACE_RUN = /\s+/gu;
const CONTROL = /\p{Cc}/gu;
const SPACE_RUN = / {2,}/g;

/**
 * In order: every whitespace run (line breaks included) becomes one space,
 * control characters are dropped, runs of spaces collapse, the ends are
 * trimmed, and the text is capped at PROMPT_MAX code points -- code points,
 * so the cap never leaves half an emoji -- then trimmed again. Empty is null.
 * Idempotent: normalising a normalised prompt changes nothing.
 */
export function normalizePrompt(raw                           )                {
  if (raw === null || raw === undefined) return null;
  const folded = raw.replace(WHITESPACE_RUN, " ").replace(CONTROL, "").replace(SPACE_RUN, " ").trim();
  const capped = Array.from(folded).slice(0, PROMPT_MAX).join("").trimEnd();
  return capped === "" ? null : capped;
}

/** A prompt's length as the cap counts it, for the logs; 0 for none. */
export function promptChars(prompt               )         {
  return prompt === null ? 0 : Array.from(prompt).length;
}
