import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCH_BOUNDS, defaultSettings, isAutoMoment, normalizePrompt, resolveSettings } from "../lib/settings.mjs";
import { HORIZON_SEC, WINDOW_SEC } from "../lib/buffer.mjs";
import { thresholdFor } from "../lib/boqo/moments.mjs";

test("the defaults are the hosted watch's", () => {
  assert.deepEqual(defaultSettings(), {
    sensitivity: 70, autoClip: true, autoClipMinScore: 80, windowSec: 300, prompt: null, visionPerHour: 600,
  });
  assert.equal(WINDOW_SEC, 300);
  assert.equal(HORIZON_SEC, 360, "the buffer keeps windowSec + 60");
});

test("the bounds are boqo's WATCH_BOUNDS at the pin", () => {
  assert.deepEqual(WATCH_BOUNDS.windowSec, { min: 120, max: 600, default: 300 });
  assert.deepEqual(WATCH_BOUNDS.sensitivity, { min: 30, max: 95, default: 70 });
  assert.deepEqual(WATCH_BOUNDS.autoClipMinScore, { min: 50, max: 95, default: 80 });
});

test("each end of each range is accepted and one past it is refused, as hosted's withinBound", () => {
  for (const [key, b] of Object.entries(WATCH_BOUNDS)) {
    assert.equal(resolveSettings({ [key]: b.min })[key], b.min);
    assert.equal(resolveSettings({ [key]: b.max })[key], b.max);
    for (const bad of [b.min - 1, b.max + 1, 70.5, "70", NaN]) {
      assert.throws(
        () => resolveSettings({ [key]: bad }),
        new RegExp(`^Error: config.json: ${key} must be a whole number between ${b.min} and ${b.max}.$`),
        `${key}=${bad}`,
      );
    }
  }
});

test("a flag overrides the file and is checked too", () => {
  assert.equal(resolveSettings({ sensitivity: 40 }, { sensitivity: 90 }).sensitivity, 90);
  assert.equal(resolveSettings({ sensitivity: 40 }, { sensitivity: undefined }).sensitivity, 40);
  assert.throws(() => resolveSettings({}, { sensitivity: 20 }), /^Error: sensitivity must be a whole number between 30 and 95\.$/);
});

test("autoClip is a boolean; the prompt is normalised and capped at 300", () => {
  assert.equal(resolveSettings({ autoClip: false }).autoClip, false);
  assert.throws(() => resolveSettings({ autoClip: "off" }), /autoClip must be true or false/);
  assert.throws(() => resolveSettings({ prompt: 5 }), /prompt must be text/);
  assert.equal(resolveSettings({ prompt: "  funny \n\n  fails\t" }).prompt, "funny fails");
  assert.equal(resolveSettings({ prompt: "   " }).prompt, null);
  assert.equal(Array.from(resolveSettings({ prompt: "x".repeat(400) }).prompt).length, 300);
  assert.equal(Array.from(normalizePrompt("😀".repeat(301))).length, 300, "code points, so no half emoji");
});

test("the detector's bar comes from sensitivity through thresholdFor", () => {
  assert.equal(thresholdFor(resolveSettings({ sensitivity: 30 }).sensitivity), 3.6);
  assert.equal(thresholdFor(resolveSettings({ sensitivity: 95 }).sensitivity), 1.65);
});

test("a moment goes to the agent when it is hand-made, or autoClip is on and the score reaches the bar", () => {
  const s = defaultSettings();
  assert.equal(isAutoMoment({ score: 80, signal: "chat" }, s), true);
  assert.equal(isAutoMoment({ score: 79, signal: "chat" }, s), false);
  assert.equal(isAutoMoment({ score: 100, signal: "manual" }, { ...s, autoClip: false }), true);
  assert.equal(isAutoMoment({ score: 99, signal: "chat" }, { ...s, autoClip: false }), false);
  assert.equal(isAutoMoment({ score: 60, signal: "chat" }, { ...s, autoClipMinScore: 50 }), true);
  assert.equal(isAutoMoment({}, s), false);
});
