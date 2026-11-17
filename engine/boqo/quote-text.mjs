// ported from boqo-ai/boqo packages/core/src/quote-text.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Makes text somebody else wrote safe to put inside one quoted prompt line
 * (selector-signals spec §6): a title, a description, a chapter name or a
 * viewer's comment.
 *
 * It removes what could break out of a line or a quote, or point the model
 * somewhere: control characters and line breaks, URLs, runs of three or more
 * angle brackets (the prompt's own `<<< … >>>` markers), and double quotes.
 * Then it cuts to `maxChars` code points -- not UTF-16 units, so an emoji is
 * never split -- with an ellipsis that counts toward the limit.
 *
 * Idempotent: the prompt builder runs it again on what ingest stored, and a
 * second pass must change nothing.
 */
export function sanitiseQuote(text        , maxChars        )         {
  if (maxChars < 1) return "";
  const cleaned = text
    .replace(CONTROL, " ")
    // Unpaired surrogates (\p{Cs} with the u flag matches only those; an emoji
    // pair survives). Postgres jsonb rejects them, measured 2026-09-30 -- see
    // LONE_SURROGATE in apps/worker/src/ingest/metadata.ts.
    .replace(/\p{Cs}/gu, "")
    .replace(URL_LIKE, " ")
    .replace(/\s+/g, " ")
    .replace(/<{3,}/g, "<")
    .replace(/>{3,}/g, ">")
    // \u0022 is a double quote. Written as an escape because the import scanner
    // in packages/core/tests/node-builtins-scanner.ts does not model regex
    // literals (read from that file), so a raw quote here desyncs it.
    .replace(/\u0022/g, "'")
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}
