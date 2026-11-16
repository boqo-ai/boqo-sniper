// boqo's createMomentDetector (packages/core/src/moments.ts) over a 30-minute
// synthetic tick series (scripts/parity/make-detector-replay.mjs writes the
// input): chat bursts, audio-only bursts, a closed chat socket, a loudness hole.
// Output: every candidate, with the tick it was emitted on, and signal() after
// every tick (null where neither signal could score).
import { readFileSync } from "node:fs";
import { createMomentDetector, type MomentTick } from "../../../../packages/core/src/moments";

type Input = { windowSec: number; sensitivity: number; ticks: MomentTick[] };
const input: Input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const detector = createMomentDetector({ windowSec: input.windowSec, sensitivity: input.sensitivity });
const candidates = [];
const signals: (number | null)[] = [];
for (const tick of input.ticks) {
  const candidate = detector.tick(tick);
  signals.push(detector.signal());
  if (candidate) candidates.push({ emittedAt: tick.at, ...candidate });
}
console.log(JSON.stringify({ candidates, signals }));
