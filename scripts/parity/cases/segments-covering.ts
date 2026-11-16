// boqo's segmentsCovering (apps/watcher/src/watch/buffer.ts): which segments
// overlap a window. Inputs are synthetic: segment start seconds and windows.
import { readFileSync } from "node:fs";
import { segmentsCovering, type Segment } from "../../../watcher/src/watch/buffer";

type Input = { segmentSec: number; starts: number[]; windows: { startAtMs: number; endAtMs: number }[] };
const input: Input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const segments: Segment[] = input.starts.map((startSec) => ({ path: `${startSec}.ts`, startSec, size: 0 }));
console.log(
  JSON.stringify(
    input.windows.map((w) => segmentsCovering(segments, w.startAtMs, w.endAtMs, input.segmentSec).map((s) => s.startSec)),
  ),
);
