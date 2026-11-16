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
  chatWindowEnd,
  GAP_SEC,
} from "../lib/buffer.mjs";
import { createDetector } from "../lib/detector.mjs";

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

test("planCut: a gap before the peak starts the cut after it, and the peak offset counts from there", () => {
  // 1000 .. 1190, a 20 s hole, then 1220 .. 1400
  const s = [...segs(20), ...segs(19, 1220)];
  const plan = planCut(s, 1300);
  assert.equal(plan.segments[0].t0, 1220, "nothing from before the hole");
  assert.equal(plan.startAt, 1220);
  assert.equal(plan.segments.at(-1).t0, 1330);
  assert.equal(plan.peakOffsetSec, 80, "the peak is 80 s into the video the kept segments make");
});

test("planCut: a gap after the peak ends the cut before it", () => {
  const s = [...segs(20), ...segs(19, 1220)];
  const plan = planCut(s, 1185);
  assert.deepEqual([plan.segments[0].t0, plan.segments.at(-1).t0], [1060, 1190], "nothing from after the hole");
  assert.equal(plan.endAt, 1200, "the run ends at 1200, short of the 30 s post-roll");
  assert.equal(plan.peakOffsetSec, 125);
});

test("planCut: starts up to GAP_SEC apart are one run, further apart are two", () => {
  assert.equal(GAP_SEC, 13);
  const joined = [{ n: 0, t0: 1000 }, { n: 1, t0: 1013 }, { n: 2, t0: 1023 }];
  assert.equal(planCut(joined, 1025).segments.length, 3);
  const split = [{ n: 0, t0: 1000 }, { n: 1, t0: 1014 }, { n: 2, t0: 1024 }];
  assert.deepEqual(planCut(split, 1025).segments.map((x) => x.t0), [1014, 1024]);
  assert.equal(planCut(split, 1025).peakOffsetSec, 11);
  // unsorted input is fine
  assert.deepEqual(planCut([...split].reverse(), 1005).segments.map((x) => x.t0), [1000]);
});

test("chatWindowEnd: the next segment's start, but never more than SEGMENT_SEC + 1 past this one's", () => {
  assert.equal(chatWindowEnd({ t0: 1000 }, { t0: 1010 }), 1010);
  assert.equal(chatWindowEnd({ t0: 1000 }, { t0: 1011 }), 1011);
  assert.equal(chatWindowEnd({ t0: 1000 }, { t0: 1030 }), 1011, "a 20 s hole is not this segment's chat");
  assert.equal(chatWindowEnd({ t0: 1000 }, undefined), 1011);
});

test("a 20 s capture gap does not fire a moment on ordinary chat (the review's gap simulation)", () => {
  // ~1.2 messages a second from 300 regulars, as the review simulated it
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const msgs = [];
  for (let t = 0; t < 3600; t += 1) {
    const k = rnd() < 0.2 ? 2 : 1;
    for (let j = 0; j < k; j++) msgs.push({ t: t + rnd(), user: "u" + Math.floor(rnd() * 300) });
  }
  const uniq = (a, b) => new Set(msgs.filter((m) => m.t >= a && m.t < b).map((m) => m.user)).size;
  // segment starts: every 10 s, with a 20 s hole after the one at 900
  const starts = [];
  for (let t = 0; t < 1800; t += t === 900 ? 30 : 10) starts.push(t);
  const run = (windowEnd) => {
    const d = createDetector({ sensitivity: 70 });
    const spikes = [];
    for (let i = 0; i < starts.length; i++) {
      const seg = { t0: starts[i] };
      const next = i + 1 < starts.length ? { t0: starts[i + 1] } : undefined;
      const sp = d.push({ t: seg.t0 + 5, chat: 0, chatters: uniq(seg.t0, windowEnd(seg, next)), lufs: -20 + rnd() });
      if (sp) spikes.push(sp);
    }
    return spikes;
  };
  const unclamped = run((seg, next) => (next ? next.t0 : seg.t0 + 10));
  assert.ok(unclamped.some((sp) => sp.peakAt === 905), "the old window (up to the next start) fires on the hole");
  assert.deepEqual(run(chatWindowEnd), [], "the clamped window does not");
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
