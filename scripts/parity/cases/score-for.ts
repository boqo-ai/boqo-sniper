// boqo's scoreFor and sigmaForScore (packages/core/src/moments.ts): a moment's
// 0-100 score from its z and the bar, and the z a score sits at. Synthetic inputs.
import { readFileSync } from "node:fs";
import { scoreFor, sigmaForScore } from "../../../../packages/core/src/moments";

type Input = { scores: { z: number; threshold: number }[]; sigmas: { score: number; threshold: number }[] };
const input: Input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
console.log(
  JSON.stringify({
    scores: input.scores.map((c) => ({ ...c, score: scoreFor(c.z, c.threshold) })),
    sigmas: input.sigmas.map((c) => ({ ...c, sigma: sigmaForScore(c.score, c.threshold) })),
  }),
);
