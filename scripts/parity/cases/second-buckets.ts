// boqo's SecondBuckets (apps/watcher/src/watch/buckets.ts), which the session
// drains one second per detector tick: a list of add / take / dropBefore ops,
// and what each take returned. Synthetic values.
import { readFileSync } from "node:fs";
import { SecondBuckets } from "../../../watcher/src/watch/buckets";

type Op = { op: "add"; atMs: number; value: number | string } | { op: "take" | "dropBefore"; second: number };
const ops: Op[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const buckets = new SecondBuckets<number | string>();
const taken: { second: number; values: (number | string)[] }[] = [];
for (const o of ops) {
  if (o.op === "add") buckets.add(o.atMs, o.value);
  else if (o.op === "take") taken.push({ second: o.second, values: buckets.take(o.second) });
  else buckets.dropBefore(o.second);
}
console.log(JSON.stringify(taken));
