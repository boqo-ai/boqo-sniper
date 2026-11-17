// The ported hosted buffer arithmetic (lib/boqo/buffer.mjs), against goldens
// that boqo's own TypeScript wrote at the pin (scripts/parity/golden.mjs).
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planCut, pruneBefore, segmentsCovering } from "../lib/boqo/buffer.mjs";
import { expectGolden } from "./helpers/golden.mjs";

const input = (name) =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", `${name}.input.json`), "utf8"));
const listing = (starts) => starts.map((startSec) => ({ path: `${startSec}.ts`, startSec, size: 0 }));

test("segments-covering: the ported segmentsCovering matches boqo's", () => {
  const i = input("segments-covering");
  const segments = listing(i.starts);
  expectGolden(
    "segments-covering",
    i.windows.map((w) => segmentsCovering(segments, w.startAtMs, w.endAtMs, i.segmentSec).map((s) => s.startSec)),
  );
});

test("prune-before: the ported pruneBefore matches boqo's", () => {
  const i = input("prune-before");
  const segments = listing(i.starts);
  expectGolden(
    "prune-before",
    i.horizons.map((h) => pruneBefore(segments, h, i.segmentSec).map((s) => s.startSec)),
  );
});

test("plan-cut: the ported planCut matches boqo's", () => {
  const i = input("plan-cut");
  const segments = listing(i.starts);
  expectGolden(
    "plan-cut",
    i.cases.map((c) => {
      const plan = planCut(segments, c.peakAtMs, c.windowSec, c.postRollSec, i.segmentSec);
      return plan === null
        ? null
        : { startAt: plan.startAt, endAt: plan.endAt, starts: plan.segments.map((s) => s.startSec), peakOffsetSec: plan.peakOffsetSec };
    }),
  );
});
