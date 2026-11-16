// boqo's planCut (apps/watcher/src/watch/buffer.ts): the window ending postRollSec
// after the peak, windowSec long, clamped to the listing. Inputs are synthetic.
import { readFileSync } from "node:fs";
import { planCut, type Segment } from "../../../watcher/src/watch/buffer";

type Case = { peakAtMs: number; windowSec: number; postRollSec: number };
type Input = { segmentSec: number; starts: number[]; cases: Case[] };
const input: Input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const segments: Segment[] = input.starts.map((startSec) => ({ path: `${startSec}.ts`, startSec, size: 0 }));
console.log(
  JSON.stringify(
    input.cases.map((c) => {
      const plan = planCut(segments, c.peakAtMs, c.windowSec, c.postRollSec, input.segmentSec);
      return plan === null
        ? null
        : {
            startAt: plan.startAt,
            endAt: plan.endAt,
            starts: plan.segments.map((s) => s.startSec),
            peakOffsetSec: plan.peakOffsetSec,
          };
    }),
  ),
);
