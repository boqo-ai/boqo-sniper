// The ported signalLine (lib/boqo/signal-line.mjs), the line under a moment's
// title, against the golden boqo's own TypeScript wrote at the pin.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signalLine } from "../lib/boqo/signal-line.mjs";
import { expectGolden } from "./helpers/golden.mjs";

test("signal-line: the ported signalLine matches boqo's", () => {
  const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", "signal-line.input.json"), "utf8"));
  expectGolden("signal-line", cases.map((c) => ({ ...c, line: signalLine(c.detail, c.signal) })));
});
