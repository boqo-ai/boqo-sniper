// The hosted moment detector (lib/boqo/moments.mjs, ported from boqo's
// packages/core/src/moments.ts), against goldens boqo's own TypeScript wrote at
// the pin (scripts/parity/golden.mjs), and the two rules the session relies on:
// a closed chat socket teaches the detector nothing, and the cooldown runs 45 s
// from the last peak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOMENT_AUDIO_Z_WEIGHT,
  MOMENT_COOLDOWN_SEC,
  MOMENT_FALL_RATIO,
  MOMENT_MIN_CHAT_RATE,
  MOMENT_RISE_MAX_SEC,
  MOMENT_WARMUP_SEC,
  createMomentDetector,
  scoreFor,
  sigmaForScore,
  thresholdFor,
} from "../lib/boqo/moments.mjs";
import { expectGolden } from "./helpers/golden.mjs";

const input = (name) =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", `${name}.input.json`), "utf8"));

test("threshold-for: the ported thresholdFor matches boqo's (3.6 at 30, 2.4 at 70, 1.65 at 95, clamped)", () => {
  const i = input("threshold-for");
  expectGolden("threshold-for", i.sensitivities.map((sensitivity) => ({ sensitivity, threshold: thresholdFor(sensitivity) })));
});

test("score-for: the ported scoreFor and sigmaForScore match boqo's (60 at the bar, 100 at 2.5x it)", () => {
  const i = input("score-for");
  expectGolden("score-for", {
    scores: i.scores.map((c) => ({ ...c, score: scoreFor(c.z, c.threshold) })),
    sigmas: i.sigmas.map((c) => ({ ...c, sigma: sigmaForScore(c.score, c.threshold) })),
  });
});

test("detector-replay: 30 synthetic minutes give boqo's candidates and boqo's signal every second", () => {
  const i = input("detector-replay");
  const detector = createMomentDetector({ windowSec: i.windowSec, sensitivity: i.sensitivity });
  const candidates = [];
  const signals = [];
  for (const tick of i.ticks) {
    const candidate = detector.tick(tick);
    signals.push(detector.signal());
    if (candidate) candidates.push({ emittedAt: tick.at, ...candidate });
  }
  expectGolden("detector-replay", { candidates, signals });
});

test("the constants are production's, verbatim", () => {
  assert.equal(MOMENT_WARMUP_SEC, 60);
  assert.equal(MOMENT_COOLDOWN_SEC, 45);
  assert.equal(MOMENT_MIN_CHAT_RATE, 2);
  assert.equal(MOMENT_AUDIO_Z_WEIGHT, 0.8);
  assert.equal(MOMENT_RISE_MAX_SEC, 20);
  assert.equal(MOMENT_FALL_RATIO, 0.6);
});

// ---- the series the two rules are tested on (after boqo's moments.test.ts) ----

const T0 = Date.UTC(2026, 10, 16, 20, 0, 0);
const sec = (n) => T0 + n * 1000;

/** A repeating [2,3,4,3,3] chat (mean 3, a flat five-second mean) at -25 LUFS, with overrides. No randomness. */
function series(seconds, override = () => ({})) {
  const pattern = [2, 3, 4, 3, 3];
  return Array.from({ length: seconds }, (_, i) => {
    const chatCount = pattern[i % pattern.length];
    return {
      at: sec(i),
      chatCount,
      chatTexts: Array.from({ length: chatCount }, (_, k) => `msg-${i}-${k}`),
      loudness: -25,
      chatOpen: true,
      ...override(i),
    };
  });
}

/** Every candidate, and signal() after every tick. */
function trace(ticks) {
  const detector = createMomentDetector({ windowSec: 300, sensitivity: 70 });
  const candidates = [];
  const signals = [];
  for (const t of ticks) {
    const c = detector.tick(t);
    signals.push(detector.signal());
    if (c) candidates.push(c);
  }
  return { candidates, signals };
}

/** `rate` messages a second over [from, from + length), 70% of them one text. */
const burst = (from, length, rate, text = "NO WAY") => (i) => {
  if (i < from || i >= from + length) return {};
  const same = Math.round(rate * 0.7);
  return {
    chatCount: rate,
    chatTexts: [...Array.from({ length: same }, () => text), ...Array.from({ length: rate - same }, (_, k) => `o-${i}-${k}`)],
  };
};

test("seconds with chatOpen false change neither the chat baseline nor the 5 s window", () => {
  // The socket is closed 300-359. What the closed seconds carry never reaches
  // the detector: 80 messages a second there and 0 there give the same signal
  // every second after, and no moment.
  const closedWith = (fill) => (i) => (i >= 300 && i < 360 ? { ...fill, chatOpen: false } : {});
  const empty = trace(series(600, closedWith({ chatCount: 0, chatTexts: [] })));
  const spam = trace(series(600, closedWith({ chatCount: 80, chatTexts: Array.from({ length: 80 }, () => "SPAM") })));
  assert.deepEqual(spam, empty);
  assert.deepEqual(empty.candidates, []);

  // The baseline: a burst at 420 is judged against the chat from before the
  // drop, 3 a second. The same sixty empty seconds fed as open ones drag it down.
  const later = burst(420, 8, 40);
  const closed = trace(series(600, (i) => ({ ...closedWith({ chatCount: 0, chatTexts: [] })(i), ...later(i) })));
  const openZeros = trace(series(600, (i) => ({ ...(i >= 300 && i < 360 ? { chatCount: 0, chatTexts: [] } : {}), ...later(i) })));
  assert.equal(closed.candidates.length, 1);
  assert.ok(Math.abs(closed.candidates[0].detail.chatBaseline - 3) < 0.05, `baseline ${closed.candidates[0].detail.chatBaseline}`);
  assert.equal(openZeros.candidates.length, 1);
  assert.ok(openZeros.candidates[0].detail.chatBaseline < 2.7, `open zeros: baseline ${openZeros.candidates[0].detail.chatBaseline}`);

  // The window: a burst cut off by the drop is not scored again when the chat
  // reopens, and chat scores only on five open seconds. Loudness unknown, so
  // signal() is the chat's alone: null until the fifth open second (364).
  const ticks = series(600, (i) => ({
    loudness: null,
    ...(i >= 300 && i < 360 ? { chatCount: 0, chatTexts: [], chatOpen: false } : burst(295, 5, 40)(i)),
  }));
  const reopened = trace(ticks);
  assert.equal(reopened.candidates.length, 1, "the burst's moment only, none at the reopen");
  assert.ok(reopened.candidates[0].peakAt >= sec(295) && reopened.candidates[0].peakAt < sec(300));
  assert.deepEqual(reopened.signals.slice(300, 364), Array(64).fill(null), "closed, then four open seconds: no chat z");
  assert.ok(Number.isFinite(reopened.signals[364]), "the fifth open second is scored");
});

test("cooldown: a second burst 40 s after a peak is not a moment, and one 50 s after is", () => {
  // One-second bursts, so nothing of the second is left in the five-second
  // window once 45 s have passed: chat (200 messages in a second) and sound
  // (a -5 LUFS bang) alike, since the cooldown runs from the last peak
  // whichever signal made it.
  const kinds = {
    chat: (at) => (i) => (i === at ? { chatCount: 200, chatTexts: Array.from({ length: 200 }, () => "NO WAY") } : {}),
    audio: (at) => (i) => (i === at ? { loudness: -5 } : {}),
  };
  for (const [kind, spike] of Object.entries(kinds)) {
    const first = trace(series(600, spike(300))).candidates;
    assert.equal(first.length, 1, kind);
    assert.equal(first[0].signal, kind);
    const peak = (first[0].peakAt - T0) / 1000;

    const both = (gap) => trace(series(600, (i) => ({ ...spike(300)(i), ...spike(peak + gap)(i) }))).candidates;
    const at40 = both(40);
    assert.deepEqual(at40.map((c) => c.peakAt), [first[0].peakAt], `${kind}: 40 s after the peak is inside the cooldown`);
    const at50 = both(50);
    assert.deepEqual(at50.map((c) => c.peakAt), [first[0].peakAt, sec(peak + 50)], `${kind}: 50 s after the peak is a moment`);
    assert.equal(at50[1].signal, kind);
  }
});
