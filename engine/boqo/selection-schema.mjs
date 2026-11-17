// ported from boqo-ai/boqo apps/worker/src/select/anthropic.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Only the wire schema and what normalises its output are taken from that file (lines 46-201 at the pin:
// STANDALONE_DESCRIPTIONS, TITLE_ALTERNATIVES_DESCRIPTION, SelectionResponse, TITLE_ALTERNATIVES,
// clampUtf16, normaliseAlternatives), with the bounds verbatim. The Anthropic call, the retries and the
// scene path are not part of the skill: the person's agent is the model. The `@boqo/core` import
// of CLIP_TITLE_MAX_CHARS is the sibling ./selection.mjs.
import { z } from "zod";
import { CLIP_TITLE_MAX_CHARS } from "./selection.mjs";

/**
 * The wire shape, as the model returns it. snake_case on purpose: this is
 * what the JSON schema declares, and the mapping to boqo's camelCase happens
 * in exactly one place below.
 *
 * The bounds on score/title/hook are a client-side safety net, not something
 * the request enforces structurally: structured outputs only accept a narrow
 * set of JSON Schema keywords, and `zodOutputFormat` below folds anything
 * outside that set (`minimum`, `maximum`, `maxLength`, ...) into the field's
 * `description` as a hint rather than a constraint the API rejects on. The
 * real enforcement is this object's own `.safeParse` in
 * parseSelectionMessage below — the same schema backs both, so a score of
 * 150 or a several-hundred-character title fails validation here instead of
 * reaching the dashboard. `end_sec > start_sec` is deliberately not one of
 * these bounds: snapAndFilter's `rejectMechanically` already discards an
 * inverted clip, after snapping has had a chance to move its edges.
 */
/** The stand-alone fields' descriptions, worded from spec 5.1 (B9 final review, F4). */
export const STANDALONE_DESCRIPTIONS = {
  stands_alone: "whether a stranger who heard nothing but the first sentence could say what is being claimed",
  claim: "what that stranger could say is being claimed, in one plain sentence; empty when they could not",
  bridge_from_sec:
    "when the clip now opens on an earlier bridging line: the LATER start you would otherwise have chosen (greater than start_sec); null otherwise",
  context_line:
    "only when stands_alone is false and no bridging line exists: one line of at most 60 characters in the speaker's words that supplies the missing fact; null otherwise",
}         ;

/** `title_alternatives`' description: the only place "exactly two" is stated to the model besides the rubric. */
export const TITLE_ALTERNATIVES_DESCRIPTION =
  "exactly two more titles for this clip, each a different angle on the same moment, in the transcript's language; never the same as title";

export const SelectionResponse = z.object({
  clips: z.array(
    z.object({
      start_sec: z.number(),
      end_sec: z.number(),
      title: z.string().min(1).max(CLIP_TITLE_MAX_CHARS),
      hook: z.string().min(1).max(500),
      score: z.number().min(0).max(100),
      // Required rather than optional. Structured outputs constrain
      // generation to this schema, so a missing axis means the response
      // shape changed underneath us, not that the model chose to skip one.
      // The nullable columns in Postgres exist for the rows that predate
      // this change, not as a runtime fallback path.
      //
      // These bounds carry the same caveat as `score` above: zodOutputFormat
      // folds min/max into the field's description as a hint, so the real
      // enforcement is this object's own safeParse below.
      hook_score: z.number().min(0).max(100),
      flow_score: z.number().min(0).max(100),
      standalone_score: z.number().min(0).max(100),
      value_score: z.number().min(0).max(100),
      /**
       * The words a keyword highlighter should emphasise (stage 8a), verbatim
       * from the transcript. Matched against caption words at render by
       * `render/emphasis.ts`, never used to alter the clip's boundaries.
       *
       * REQUIRED, not optional-with-a-default, and the difference is
       * load-bearing rather than stylistic. An empty array is a valid and
       * meaningful answer -- "this clip has no keywords" -- so a `.default([])`
       * would make a genuine schema regression indistinguishable from that
       * answer: every clip would silently render with no emphasis and nothing
       * would say why. That is the same shape as `captionOverrides` reading 0
       * and `fragmentRetries` reading 0, which this repository has been bitten
       * by three times. Required means the shape change fails loudly instead.
       *
       * The `max` is a client-side ceiling, not a target -- see the note above
       * on why zodOutputFormat folds it into the description as a hint and
       * this object's own safeParse is the real enforcement. It exists because
       * an unbounded list lets the model highlight everything, at which point
       * "highlighted" means nothing.
       */
      emphasis_words: z.array(z.string().min(1).max(60)).max(12),
      /**
       * The stand-alone question (B9 spec 5.1): does the clip make sense to a
       * stranger who has seen nothing before it, and if not, what repairs it.
       * The outcome is NOT asked of the model; `deriveStandaloneTest` in core
       * derives it from these four fields.
       *
       * All four are REQUIRED, for `emphasis_words`' reason above: `null` and
       * `""` are valid answers ("no bridge", "no claim needed"), so a
       * `.optional()` or `.default()` would make a schema regression
       * indistinguishable from that answer, and every clip would silently
       * read as standing alone. A missing field is a shape change and fails
       * loudly instead.
       *
       * No `max` on `claim` or `context_line`, deliberately. A missing field
       * is a shape change and fails loudly; a length overflow is the model
       * not following the rubric, and refusing it here would fail a whole
       * billed selection terminally over one sentence. `deriveStandaloneTest`
       * clamps the claim and drops an over-long line downstream, the way it
       * handles the inconsistency rule.
       *
       * Each carries a `.describe()` from spec 5.1, which `zodOutputFormat`
       * sends as the field's description (pinned by a test). The one that
       * matters most is `bridge_from_sec`'s direction: it is the LATER start,
       * and `deriveStandaloneTest` drops a bridge at or before the clip's start
       * (B9 final review, F4).
       */
      stands_alone: z.boolean().describe(STANDALONE_DESCRIPTIONS.stands_alone),
      claim: z.string().describe(STANDALONE_DESCRIPTIONS.claim),
      bridge_from_sec: z.number().nullable().describe(STANDALONE_DESCRIPTIONS.bridge_from_sec),
      context_line: z.string().nullable().describe(STANDALONE_DESCRIPTIONS.context_line),
      /**
       * Two more titles for the same moment (Clips page Phase 3, Task 3.4;
       * controller ruling P3-D6). REQUIRED, for `emphasis_words`' reason
       * above: a missing field is a shape change and fails loudly.
       *
       * No length bound on the array or its strings, deliberately, for
       * `claim`'s reason above: one alternative too many, too few, or too
       * long is the model not following the rubric, and refusing it here
       * would fail a whole billed selection over one title. "Exactly two" is
       * said in the description only; `normaliseAlternatives` below keeps
       * what is usable.
       */
      title_alternatives: z.array(z.string()).describe(TITLE_ALTERNATIVES_DESCRIPTION),
    }),
  ),
});

/** How many alternatives a clip keeps; the stored title is the third. */
export const TITLE_ALTERNATIVES = 2;

/**
 * `text` cut to at most `max` UTF-16 units -- the unit a JavaScript string's
 * `.length`, and so zod's `.max()` on the title PATCH, counts -- whole code
 * points only, so a surrogate pair is never split at the cut.
 */
function clampUtf16(text        , max        )         {
  let out = "";
  for (const point of text) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out;
}

/**
 * The model's alternatives, made storable (ruling P3-D6): each trimmed and
 * clamped to CLIP_TITLE_MAX_CHARS UTF-16 units (the PATCH's `max(200)`, so a
 * picked one is always accepted); empty ones, any equal to the clip's own
 * title (ignoring case) and repeats dropped; the first two kept. Fewer than
 * two is kept as what survives, 0-2.
 */
export function normaliseAlternatives(title        , alternatives                   )           {
  const seen = new Set([title.trim().toLocaleLowerCase()]);
  const kept           = [];
  for (const raw of alternatives) {
    const text = clampUtf16(raw.trim(), CLIP_TITLE_MAX_CHARS).trim();
    const key = text.toLocaleLowerCase();
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === TITLE_ALTERNATIVES) break;
  }
  return kept;
}

