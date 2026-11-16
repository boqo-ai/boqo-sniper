// boqo's thresholdFor (packages/core/src/moments.ts): the z a moment needs at
// each sensitivity, clamped to 30-95. Input: the sensitivities. Output: [{ sensitivity, threshold }].
import { readFileSync } from "node:fs";
import { thresholdFor } from "../../../../packages/core/src/moments";

const input: { sensitivities: number[] } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
console.log(JSON.stringify(input.sensitivities.map((sensitivity) => ({ sensitivity, threshold: thresholdFor(sensitivity) }))));
