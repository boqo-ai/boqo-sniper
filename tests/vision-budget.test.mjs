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
