import { test } from "node:test";
import assert from "node:assert/strict";
import { visionBudget } from "../lib/vision-budget.mjs";

test("the 601st image in an hour is refused, and accepted 3,601 s after the first", () => {
  let now = 1000;
  const b = visionBudget({ perHour: 600, now: () => now });
  assert.equal(b.take(1), true); // the first image, at t = 1000
  now = 1100;
  for (let i = 1; i < 600; i++) assert.equal(b.take(1), true, `image ${i + 1}`);
  assert.equal(b.used(), 600);
  assert.equal(b.take(1), false, "the 601st");
  assert.equal(b.used(), 600, "a refusal uses nothing");
  now = 1000 + 3600; // the first image is exactly an hour old: still counted
  assert.equal(b.take(1), false);
  now = 1000 + 3601;
  assert.equal(b.used(), 599, "only the first fell out");
  assert.equal(b.take(1), true);
  assert.equal(b.used(), 600);
});

test("take(n) is all or nothing", () => {
  const b = visionBudget({ perHour: 10, now: () => 0 });
  assert.equal(b.take(7), true);
  assert.equal(b.take(4), false);
  assert.equal(b.used(), 7);
  assert.equal(b.take(3), true);
  assert.equal(b.take(1), false);
});

test("the default is 600 an hour; 0 refuses everything; bad n is refused", () => {
  const b = visionBudget({ now: () => 0 });
  assert.equal(b.take(600), true);
  assert.equal(b.take(1), false);
  const none = visionBudget({ perHour: 0, now: () => 0 });
  assert.equal(none.take(1), false);
  for (const n of [0, -1, 1.5, NaN, "2"]) assert.equal(visionBudget({ now: () => 0 }).take(n), false, String(n));
});

test("a clock that steps back does not free the budget", () => {
  let now = 5000;
  const b = visionBudget({ perHour: 2, now: () => now });
  b.take(2);
  now = 100;
  assert.equal(b.take(1), false);
});

// ---- persistence: one hour per session, shared by every process and kept over a restart ----

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-vision-"));
  return { dir, file: path.join(dir, "vision.json") };
}

test("two budgets on one file share the count", () => {
  const { dir, file } = tmpFile();
  try {
    const a = visionBudget({ perHour: 10, now: () => 100, file });
    const b = visionBudget({ perHour: 10, now: () => 100, file });
    assert.equal(a.take(6), true);
    assert.equal(b.used(), 6, "the second process sees what the first spent");
    assert.equal(b.take(5), false, "6 + 5 is over 10");
    assert.equal(b.take(4), true);
    assert.equal(a.used(), 10);
    assert.equal(a.take(1), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart (a new instance) keeps the hour; the hour still rolls", () => {
  const { dir, file } = tmpFile();
  try {
    let now = 1000;
    visionBudget({ perHour: 600, now: () => now, file }).take(600);
    const again = visionBudget({ perHour: 600, now: () => now + 60, file });
    assert.equal(again.used(), 600);
    assert.equal(again.take(1), false, "a restart does not refill it");
    now = 1000 + 3601;
    assert.equal(visionBudget({ perHour: 600, now: () => now, file }).take(1), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file is a list of [t, n], pruned on write, and written whole (no temp file left)", () => {
  const { dir, file } = tmpFile();
  try {
    let now = 0;
    const b = visionBudget({ perHour: 100, now: () => now, file });
    b.take(3);
    now = 100;
    b.take(4);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [[0, 3], [100, 4]]);
    now = 3650; // the first fell out
    b.take(2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [[100, 4], [3650, 2]], "pruned on write");
    assert.deepEqual(fs.readdirSync(dir), ["vision.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or corrupt file counts as empty, and nothing throws", () => {
  const { dir, file } = tmpFile();
  try {
    const b = visionBudget({ perHour: 5, now: () => 0, file });
    assert.equal(b.used(), 0, "missing");
    for (const junk of ["{half", "null", '{"a":1}', '[[1],["x",2],[3,-4],[0,2]]', ""]) {
      fs.writeFileSync(file, junk);
      const c = visionBudget({ perHour: 5, now: () => 0, file });
      assert.doesNotThrow(() => c.used(), junk);
      assert.equal(c.take(5), junk === '[[1],["x",2],[3,-4],[0,2]]' ? false : true, junk);
    }
    // an unwritable place is no reason to refuse or crash: the instance keeps its own count
    const lost = visionBudget({ perHour: 2, now: () => 0, file: path.join(dir, "no", "such", "dir", "vision.json") });
    assert.equal(lost.take(2), true);
    assert.equal(lost.take(1), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
