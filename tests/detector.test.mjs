import { test } from "node:test";
import assert from "node:assert/strict";
import { createDetector, thresholdFor } from "../lib/detector.mjs";

// Seeded PRNG so every run sees the same chat. Never Math.random.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUCKET = 10;
const RATE = 2.6; // messages a second

// One bucket per 10 s from t = 0. `shape(t)` may return { mult, lufsAdd, dead }.
function makeStream({ seconds, seed = 1, shape = () => ({}) }) {
  const rand = mulberry32(seed);
  const out = [];
  for (let t = 0; t < seconds; t += BUCKET) {
    const s = shape(t) ?? {};
    const noise = 1 + (rand() * 2 - 1) * 0.2; // +-20%
    const lufsNoise = (rand() * 2 - 1) * 1; // +-1 LU
    let chat = Math.round(RATE * BUCKET * noise * (s.mult ?? 1));
    let chatters = Math.round(chat * 0.6);
    if (s.dead) {
      chat = rand() < 0.4 ? 1 : 0;
      chatters = rand() < 0.3 ? 1 : 0; // mean 0.3 a bucket
    }
    const lufs = s.noAudio ? null : -30 + lufsNoise + (s.lufsAdd ?? 0);
    out.push({ t, chat, chatters, lufs });
  }
  return out;
}

function run(buckets, opts) {
  const d = createDetector(opts);
  const spikes = [];
  for (const b of buckets) {
    const s = d.push(b);
    if (s) spikes.push({ ...s, at: b.t });
  }
  return spikes;
}

const inBurst = (from, to) => (t) => (t >= from && t < to ? { mult: 5 } : {});

test("thresholdFor is linear: 3.6 at 30, 2.4 at 70, 1.65 at 95, clamped", () => {
  assert.equal(thresholdFor(30), 3.6);
  assert.ok(Math.abs(thresholdFor(70) - 2.4) < 1e-9);
  assert.ok(Math.abs(thresholdFor(95) - 1.65) < 1e-9);
  assert.equal(thresholdFor(0), thresholdFor(30));
  assert.equal(thresholdFor(200), thresholdFor(95));
});

test("higher sensitivity lowers the threshold, monotonic over 30, 50, 70, 95", () => {
  const t = [30, 50, 70, 95].map(thresholdFor);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] < t[i - 1], `${t[i]} < ${t[i - 1]}`);
});

test("30 minutes of ordinary chat gives no spike", () => {
  assert.deepEqual(run(makeStream({ seconds: 1800 }), {}), []);
  assert.deepEqual(run(makeStream({ seconds: 1800, seed: 7 }), {}), []);
});

test("a 20 s burst at 5x gives exactly one spike, peaking inside the burst", () => {
  const spikes = run(makeStream({ seconds: 600, shape: inBurst(300, 320) }), {});
  assert.equal(spikes.length, 1);
  const s = spikes[0];
  assert.ok(s.peakAt >= 300 && s.peakAt < 320, `peakAt ${s.peakAt}`);
  assert.equal(s.reason, "chat");
  assert.ok(s.score >= 60 && s.score <= 100, `score ${s.score}`);
  assert.ok(s.chatZ >= 2.4, `chatZ ${s.chatZ}`);
  assert.equal(s.audioZ !== null && s.audioZ < 3.5, true);
});

test("a second burst 40 s after the first ends gives nothing (cooldown)", () => {
  const shape = (t) => (t >= 300 && t < 320) || (t >= 360 && t < 380) ? { mult: 5 } : {};
  const spikes = run(makeStream({ seconds: 600, shape }), {});
  assert.equal(spikes.length, 1);
  assert.ok(spikes[0].peakAt < 320);
});

test("a burst after the cooldown fires again", () => {
  const shape = (t) => (t >= 300 && t < 320) || (t >= 500 && t < 520) ? { mult: 5 } : {};
  const spikes = run(makeStream({ seconds: 700, shape }), {});
  assert.equal(spikes.length, 2);
  assert.ok(spikes[1].peakAt >= 500 && spikes[1].peakAt < 520);
});

test("nothing during warmupSec, even for a huge burst", () => {
  const stream = makeStream({ seconds: 300, shape: inBurst(20, 50) });
  const d = createDetector();
  for (const b of stream.filter((x) => x.t < 60)) assert.equal(d.push(b), null);
  // a custom warmup is honoured too
  const spikes = run(makeStream({ seconds: 600, shape: inBurst(100, 120) }), { warmupSec: 200 });
  assert.deepEqual(spikes, []);
});

test("a loud audio bucket alone gives reason audio, only at sensitivity 70 or more", () => {
  const shape = (t) => (t === 300 ? { lufsAdd: 12 } : {});
  const stream = makeStream({ seconds: 600, shape });
  for (const sensitivity of [70, 95]) {
    const spikes = run(stream, { sensitivity });
    assert.equal(spikes.length, 1, `sensitivity ${sensitivity}`);
    assert.equal(spikes[0].reason, "audio");
    assert.equal(spikes[0].peakAt, 300);
    assert.ok(spikes[0].audioZ >= 3.5);
  }
  for (const sensitivity of [30, 50, 69]) {
    assert.deepEqual(run(stream, { sensitivity }), [], `sensitivity ${sensitivity}`);
  }
  assert.equal(run(stream, {}).length, 1); // default 70
});

test("loud audio with a chat burst in the same buckets is reason both", () => {
  const shape = (t) => (t >= 300 && t < 320 ? { mult: 5, lufsAdd: 12 } : {});
  const spikes = run(makeStream({ seconds: 600, shape }), { sensitivity: 50 });
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].reason, "both");
});

test("dead chat (under 0.5 chatters a bucket) switches chat spikes off", () => {
  const dead = makeStream({ seconds: 600, shape: (t) => (t >= 300 && t < 320 ? { dead: false, mult: 5 } : { dead: true }) });
  // the burst buckets are real chat, but the baseline over the last 5 min was dead
  assert.deepEqual(run(dead.map((b) => ({ ...b, lufs: null })), {}), []);
  // audio still works on a dead chat
  const loud = dead.map((b) => (b.t === 400 ? { ...b, lufs: -18 } : { ...b, lufs: -30 }));
  const spikes = run(loud, {});
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].reason, "audio");
});

test("buckets with no loudness never produce an audio spike or NaN", () => {
  const stream = makeStream({ seconds: 600, shape: (t) => ({ noAudio: true, ...(t >= 300 && t < 320 ? { mult: 5 } : {}) }) });
  const spikes = run(stream, {});
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].audioZ, null);
  assert.ok(Number.isFinite(spikes[0].chatZ));
});

test("a repeated or older bucket is ignored", () => {
  const stream = makeStream({ seconds: 600, shape: inBurst(300, 320) });
  const d = createDetector();
  let n = 0;
  for (const b of stream) {
    if (d.push(b)) n++;
    assert.equal(d.push(b), null); // same bucket again
  }
  assert.equal(n, 1);
});
