// The ported SecondBuckets (lib/boqo/buckets.mjs), which the watcher drains one
// second per detector tick, against the golden boqo's own TypeScript wrote at
// the pin (scripts/parity/golden.mjs).
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecondBuckets } from "../lib/boqo/buckets.mjs";
import { expectGolden } from "./helpers/golden.mjs";

test("second-buckets: the ported SecondBuckets matches boqo's", () => {
  const ops = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", "second-buckets.input.json"), "utf8"));
  const buckets = new SecondBuckets();
  const taken = [];
  for (const o of ops) {
    if (o.op === "add") buckets.add(o.atMs, o.value);
    else if (o.op === "take") taken.push({ second: o.second, values: buckets.take(o.second) });
    else buckets.dropBefore(o.second);
  }
  expectGolden("second-buckets", taken);
});
