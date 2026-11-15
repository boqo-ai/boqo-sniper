import { test } from "node:test";
import assert from "node:assert/strict";
import {
  segmentsCovering,
  pruneBefore,
  planCut,
  concatList,
  concatArgs,
  segmentName,
  parseSegmentName,
} from "../lib/buffer.mjs";

// n-th segment opens at t0 = 1000 + 10 n
const segs = (count, start = 1000) => Array.from({ length: count }, (_, n) => ({ n, t0: start + 10 * n }));

test("segmentsCovering: every segment that overlaps [from, to]", () => {
  const s = segs(10); // 1000 .. 1090, the last one ends at 1100
  const got = segmentsCovering(s, 1025, 1052);
  assert.deepEqual(got.map((x) => x.t0), [1020, 1030, 1040, 1050]);
});

test("segmentsCovering: a segment ending exactly at `from` is out, one starting exactly at `to` is in", () => {
  const s = segs(10);
  assert.deepEqual(segmentsCovering(s, 1030, 1050).map((x) => x.t0), [1030, 1040, 1050]);
});

test("segmentsCovering: a window outside the buffer is empty", () => {
  assert.deepEqual(segmentsCovering(segs(3), 5000, 5100), []);
  assert.deepEqual(segmentsCovering([], 0, 100), []);
});

test("segmentsCovering honours a custom segment length", () => {
  const s = [{ n: 0, t0: 0 }, { n: 1, t0: 4 }, { n: 2, t0: 8 }];
  assert.deepEqual(segmentsCovering(s, 5, 6, 4).map((x) => x.n), [1]);
});

test("pruneBefore: keeps the newest 720 s, returns the older segments", () => {
  const s = segs(80); // newest opens at 1790, ends at 1800
  const old = pruneBefore(s);
  // keep window is [1080, 1800]; a segment that ends at or before 1080 goes
  assert.deepEqual(old.map((x) => x.t0), Array.from({ length: 8 }, (_, i) => 1000 + 10 * i));
  assert.equal(s.length - old.length, 72);
});

test("pruneBefore: a young buffer prunes nothing; an empty one neither", () => {
  assert.deepEqual(pruneBefore(segs(72)), []);
  assert.deepEqual(pruneBefore([]), []);
});

test("pruneBefore: the horizon is a parameter", () => {
  assert.equal(pruneBefore(segs(10), 50).length, 5);
});

test("planCut: [peak-120, peak+30] clamped to what the buffer holds", () => {
  const s = segs(40); // 1000 .. 1390 (ends 1400)
  const plan = planCut(s, 1300);
  assert.equal(plan.startAt, 1180);
  assert.equal(plan.endAt, 1330);
  assert.equal(plan.segments[0].t0, 1180);
  assert.equal(plan.segments.at(-1).t0, 1330);
  assert.equal(plan.peakOffsetSec, 120);
});

test("planCut: a peak early in the buffer starts at the oldest segment", () => {
  const plan = planCut(segs(40), 1050);
  assert.equal(plan.startAt, 1000);
  assert.equal(plan.segments[0].t0, 1000);
  assert.equal(plan.peakOffsetSec, 50);
});

test("planCut: nothing to cut from an empty buffer or a peak long gone", () => {
  assert.equal(planCut([], 1300), null);
  assert.equal(planCut(segs(5), 9000), null);
});

test("concatList escapes single quotes and ends each line", () => {
  assert.equal(concatList(["a.ts", "it's.ts"]), "file 'a.ts'\nfile 'it'\\''s.ts'\n");
});

test("concatArgs: stream copy to mp4 with the list read relative to its own folder", () => {
  const a = concatArgs("cut.txt", "out.mp4");
  assert.ok(a.includes("-c") && a[a.indexOf("-c") + 1] === "copy");
  assert.ok(a.includes("aac_adtstoasc"));
  assert.equal(a.at(-1), "out.mp4");
  assert.equal(a[a.indexOf("-i") + 1], "cut.txt");
});

test("segment names are UTC wall-clock, no colons, and round-trip", () => {
  const t0 = 1_800_000_123;
  const name = segmentName(t0);
  assert.match(name, /^seg_\d{14}\.ts$/);
  assert.equal(parseSegmentName(name), t0);
  assert.equal(parseSegmentName("seg_000001.ts"), null);
  assert.equal(parseSegmentName("cut.txt"), null);
});
