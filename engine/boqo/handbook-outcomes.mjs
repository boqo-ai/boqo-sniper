// ported from the deleted boqo-ai/boqo file apps/web/src/components/clips/handbook-outcomes.ts, its last version
// (the parent of f28d1217e, which deleted the clips page; a962e174e changed it last). It is not in the tree at the pin
// bcc9d99cc, so scripts/boqo-drift.mjs has no blob to compare and this header is not in its format on purpose.
// The wording is still current: apps/web/content/studio/boqo-studio-mockup.html `cvChips` at the pin carries it.
// Cuts: `@boqo/core` becomes the sibling copies (./replay.mjs, ./standalone.mjs and `parseStranger` from
// ./rank.mjs, a stated subset), and the type-only import of `MontageChip` is dropped (its shape is in the JSDoc below).
import { parseReplay } from "./replay.mjs";
import { parseStandaloneTest } from "./standalone.mjs";
import { parseStranger } from "./rank.mjs";

/** @typedef {{ key: string, tone: "go" | "warn", text: string, reason: string | null }} MontageChip  one read-only chip */
                                                      

/**
 * The Stranger chip's lead sentence (spec §7.1), with the stored frame count in
 * place of the spec's "twelve": a clip under about a minute is judged from fewer
 * (B9 final review). The stored `why` follows on its own line.
 */
const strangerLead = (frames        ) =>
  `A model's guess from ${frames} frames and the words, 1 to 5, of whether a stranger keeps watching to the end. It helps order this list and is a little better than chance.`;

/**
 * The three signals on a clip card (spec §7.1), in the order Replay, Stranger,
 * stand-alone; copy matches the /studio mockup's `cvChips`. Each column is
 * parsed with its total reader, so a NULL or malformed column gives no chip.
 */
export function handbookChips(clip                                                                                   )                {
  const out                = [];

  const replay = parseReplay(clip.replay);
  if (replay !== null && typeof replay.pct === "number") {
    // Never "top 0%": a clip at the very top of the curve still reads top 1%.
    const top = Math.max(1, Math.round((1 - replay.pct) * 100));
    out.push({
      key: "replay",
      // B9 final review: the upper half of the curve reads go, the lower half warn.
      tone: replay.pct >= 0.5 ? "go" : "warn",
      text: `Replayed · top ${top}%`,
      reason: `Viewers of the full video rewound this part more than ${100 - top}% of it. From YouTube's most-replayed graph, with the intro and chapter starts discounted. One of the two signals that order this list.`,
    });
  }

  const stranger = parseStranger(clip.stranger);
  if (stranger !== null) {
    out.push({
      key: "stranger",
      tone: stranger.judgment >= 3 ? "go" : "warn",
      text: `Keeps watching · ${stranger.judgment}/5`,
      reason: `${strangerLead(stranger.frames)}\n${stranger.why}`,
    });
  }

  const test = parseStandaloneTest(clip.standaloneTest);
  if (test !== null) {
    if (test.outcome === "bridged") {
      // `bridgeFromSec` is the start the clip would have had without the bridging line (spec §5.1),
      // the LATER start; the stored `startSec` is the bridged, earlier one. A null bridge is
      // unreachable from `deriveStandaloneTest` (packages/core/src/standalone.ts:112, read 2026-10-19:
      // `bridged` only when the bridge is non-null) and is kept as a total reading of the column.
      const earlier = test.bridgeFromSec === null ? "earlier" : `${Math.round(test.bridgeFromSec - clip.startSec)} s earlier`;
      out.push({ key: "standalone", tone: "go", text: "Opens on context", reason: `Starts ${earlier} so a stranger gets the fact. Claim: "${test.claim}"` });
    } else if (test.outcome === "context" && test.drawn === true) {
      // B9 final review F1: only once a render has shipped the line (`drawn`,
      // written by the worker's ready landing). A `context` test with no
      // `drawn`, or `drawn` false, shows no stand-alone chip: nothing says the
      // line is on the file.
      const off = test.plan?.on === false ? " Off in this clip's plan." : "";
      out.push({ key: "standalone", tone: "go", text: "Context line added", reason: `Shown over the first seconds: "${test.contextLine ?? ""}"${off}` });
    } else if (test.outcome === "fails") {
      out.push({
        key: "standalone",
        tone: "warn",
        text: "Needs context",
        reason: "A stranger could not say what is claimed from the first sentence, and no earlier line or context line supplies it. Listed after clips that stand alone.",
      });
    }
  }

  return out;
}
