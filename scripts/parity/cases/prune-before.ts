// boqo's pruneBefore (apps/watcher/src/watch/buffer.ts): the segments that ended
// before an absolute horizon second. Inputs are synthetic start seconds.
import { readFileSync } from "node:fs";
import { pruneBefore, type Segment } from "../../../watcher/src/watch/buffer";

type Input = { segmentSec: number; starts: number[]; horizons: number[] };
const input: Input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const segments: Segment[] = input.starts.map((startSec) => ({ path: `${startSec}.ts`, startSec, size: 0 }));
console.log(
  JSON.stringify(input.horizons.map((h) => pruneBefore(segments, h, input.segmentSec).map((s) => s.startSec))),
);
