// The ported hosted loudness line parser (lib/boqo/loudness-line.mjs), against
// the golden boqo's own parseLoudnessLine wrote at the pin.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLoudnessLine } from "../lib/boqo/loudness-line.mjs";
import { expectGolden } from "./helpers/golden.mjs";

test("parse-loudness-line: the ported parseLoudnessLine matches boqo's", () => {
  const lines = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", "parse-loudness-line.input.json"), "utf8"),
  );
  expectGolden(
    "parse-loudness-line",
    lines.map((line) => ({ line, parsed: parseLoudnessLine(line) })),
  );
});
