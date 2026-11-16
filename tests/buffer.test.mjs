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
  SEGMENT_SEC,
  POST_ROLL_SEC,
  PRUNE_MARGIN_SEC,
  WINDOW_SEC,
  HORIZON_SEC,
} from "../lib/buffer.mjs";
import { createDetector } from "../lib/detector.mjs";

test("production constants: 6 s segments, 30 s post-roll, a window plus 60 s kept", () => {
  assert.equal(SEGMENT_SEC, 6);
  assert.equal(POST_ROLL_SEC, 30);
  assert.equal(PRUNE_MARGIN_SEC, 60);
  assert.equal(WINDOW_SEC, 300);
  assert.equal(HORIZON_SEC, 360, "windowSec + 60");
});

// n-th segment opens at t0 = 1000 + 6 n
const segs = (count, start = 1000) => Array.from({ length: count }, (_, n) => ({ n, t0: start + 6 * n }));

test("segmentsCovering: every segment that overlaps [from, to]", () => {
  const s = segs(10); // 1000 .. 1054, the last one ends at 1060
  const got = segmentsCovering(s, 1025, 1052);
  assert.deepEqual(got.map((x) => x.t0), [1024, 1030, 1036, 1042, 1048]);
});

test("segmentsCovering: a segment ending exactly at `from` is out, one starting exactly at `to` is in", () => {
  const s = segs(10);
  assert.deepEqual(segmentsCovering(s, 1030, 1048).map((x) => x.t0), [1030, 1036, 1042, 1048]);
});

test("segmentsCovering: a window outside the buffer is empty", () => {
  assert.deepEqual(segmentsCovering(segs(3), 5000, 5100), []);
  assert.deepEqual(segmentsCovering([], 0, 100), []);
});

test("segmentsCovering honours a custom segment length", () => {
  const s = [{ n: 0, t0: 0 }, { n: 1, t0: 4 }, { n: 2, t0: 8 }];
  assert.deepEqual(segmentsCovering(s, 5, 6, 4).map((x) => x.n), [1]);
});

test("pruneBefore: keeps the newest windowSec + 60 s, returns the older segments", () => {
  const s = segs(80); // newest opens at 1474, ends at 1480
  const old = pruneBefore(s);
  // the horizon is 1480 - 360 = 1120; a segment that ends before 1120 goes, one ending on it stays
  assert.deepEqual(old.map((x) => x.t0), Array.from({ length: 19 }, (_, i) => 1000 + 6 * i));
  assert.equal(s.length - old.length, 61);
  assert.equal(s.at(old.length).t0, 1114, "the segment ending exactly on the horizon is kept");
});

test("pruneBefore: a young buffer prunes nothing; an empty one neither", () => {
  assert.deepEqual(pruneBefore(segs(60)), []);
  assert.deepEqual(pruneBefore(segs(61)), [], "exactly on the horizon: kept");
  assert.deepEqual(pruneBefore(segs(62)).map((x) => x.t0), [1000]);
  assert.deepEqual(pruneBefore([]), []);
});

test("pruneBefore: the horizon is a parameter", () => {
  assert.equal(pruneBefore(segs(10), 30).length, 4);
});

test("planCut: a window of windowSec ending 30 s after the peak, clamped to what the buffer holds", () => {
  const s = segs(100); // 1000 .. 1594 (ends 1600)
  const plan = planCut(s, 1500);
  assert.equal(plan.startAt, 1230, "peak + 30 - 300");
  assert.equal(plan.endAt, 1530);
  assert.equal(plan.segments[0].t0, 1228, "the segment that holds 1230");
  assert.equal(plan.segments.at(-1).t0, 1528);
  assert.equal(plan.peakOffsetSec, 272);
  const short = planCut(s, 1500, 120);
  assert.equal(short.startAt, 1410);
  assert.equal(short.peakOffsetSec, 1500 - short.segments[0].t0);
});

test("planCut: a peak early in the buffer starts at the oldest segment", () => {
  const plan = planCut(segs(100), 1050);
  assert.equal(plan.startAt, 1000);
  assert.equal(plan.segments[0].t0, 1000);
  assert.equal(plan.peakOffsetSec, 50);
});

test("planCut: nothing to cut from an empty buffer or a peak long gone", () => {
  assert.equal(planCut([], 1300), null);
  assert.equal(planCut(segs(5), 9000), null);
});

test("planCut: a gap before the peak starts the cut after it, and the peak offset counts from there", () => {
  // 1000 .. 1114, a 20 s hole, then 1140 .. 1248
  const s = [...segs(20), ...segs(19, 1140)];
  const plan = planCut(s, 1200);
  assert.equal(plan.segments[0].t0, 1140, "nothing from before the hole");
  assert.equal(plan.startAt, 1140);
  assert.equal(plan.segments.at(-1).t0, 1230, "a segment starting exactly at endAt is in");
  assert.equal(plan.peakOffsetSec, 60, "the peak is 60 s into the video the kept segments make");
});

test("planCut: a gap after the peak ends the cut before it", () => {
  const s = [...segs(20), ...segs(19, 1140)];
  const plan = planCut(s, 1110);
  assert.deepEqual([plan.segments[0].t0, plan.segments.at(-1).t0], [1000, 1114], "nothing from after the hole");
  assert.equal(plan.endAt, 1120, "the run ends at 1120, short of the 30 s post-roll");
  assert.equal(plan.peakOffsetSec, 110);
});

test("planCut: starts up to GAP_SEC apart are one run, further apart are two", () => {
  assert.equal(GAP_SEC, 25);
  const joined = [{ n: 0, t0: 1000 }, { n: 1, t0: 1025 }, { n: 2, t0: 1035 }];
  assert.equal(planCut(joined, 1037).segments.length, 3);
  const split = [{ n: 0, t0: 1000 }, { n: 1, t0: 1026 }, { n: 2, t0: 1036 }];
  assert.deepEqual(planCut(split, 1037).segments.map((x) => x.t0), [1026, 1036]);
  assert.equal(planCut(split, 1037).peakOffsetSec, 11);
  // unsorted input is fine
  assert.deepEqual(planCut([...split].reverse(), 1005).segments.map((x) => x.t0), [1000]);
});

test("planCut: a live capture's jittery starts are one run, and the cut keeps its post-roll", () => {
  // seg_ names from a live yt-dlp capture (jynxzi, 2026-11-16): every file is 10.0-10.2 s long, but the
  // starts land 4 to 14 s apart as the stream arrives in bursts. None of it is a hole.
  const starts = [5934, 5938, 5944, 5954, 10004, 10016, 10026, 10036, 10048, 10056, 10106, 10120, 10128, 10138, 10148, 10200];
  const t = (hhmmss) => 1794790000 + Math.floor(hhmmss / 10000) * 3600 + (Math.floor(hhmmss / 100) % 100) * 60 + (hhmmss % 100);
  const live = starts.map((x, n) => ({ n, t0: t(x), cap: 1 }));
  const peak = t(10111);
  const plan = planCut(live, peak);
  assert.ok(plan.endAt >= peak + 30, `the cut ends ${plan.endAt - peak} s after the peak, not 30`);
  assert.ok(plan.segments.at(-1).t0 >= t(10138));
});

test("planCut: a new capture is a new run, however close its first start is", () => {
  const s = [
    ...segs(10).map((x) => ({ ...x, cap: 1 })), // 1000 .. 1054
    ...segs(10, 1060).map((x, i) => ({ ...x, n: 10 + i, cap: 2 })), // 1060 .. 1114, right after
  ];
  assert.deepEqual(planCut(s, 1110).segments.map((x) => x.cap), Array(10).fill(2), "nothing from the first capture");
  assert.equal(planCut(s, 1110).peakOffsetSec, 50);
  assert.ok(planCut(s, 1050).segments.every((x) => x.cap === 1));
  // segments with no capture number (a replay) join by time alone
  assert.equal(planCut(segs(20), 1100).segments.length, 20);
});

test("chatWindowEnd: the next segment's start, but never more than SEGMENT_SEC + 1 past this one's", () => {
  assert.equal(chatWindowEnd({ t0: 1000 }, { t0: 1006 }), 1006);
  assert.equal(chatWindowEnd({ t0: 1000 }, { t0: 1007 }), 1007);
  assert.equal(chatWindowEnd({ t0: 1000 }, { t0: 1030 }), 1007, "a 24 s hole is not this segment's chat");
  assert.equal(chatWindowEnd({ t0: 1000 }, undefined), 1007);
});

test("an 18 s capture gap does not fire a moment on ordinary chat (the review's gap simulation)", () => {
  // ~1.2 messages a second from 300 regulars, as the review simulated it
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const msgs = [];
  for (let t = 0; t < 3600; t += 1) {
    const k = rnd() < 0.2 ? 2 : 1;
    for (let j = 0; j < k; j++) msgs.push({ t: t + rnd(), user: "u" + Math.floor(rnd() * 300) });
  }
  const uniq = (a, b) => new Set(msgs.filter((m) => m.t >= a && m.t < b).map((m) => m.user)).size;
  // segment starts: every 6 s, with an 18 s hole after the one at 900
  const starts = [];
  for (let t = 0; t < 1800; t += t === 900 ? 24 : 6) starts.push(t);
  const run = (windowEnd) => {
    const d = createDetector({ sensitivity: 70 });
    const spikes = [];
    for (let i = 0; i < starts.length; i++) {
      const seg = { t0: starts[i] };
      const next = i + 1 < starts.length ? { t0: starts[i + 1] } : undefined;
      const sp = d.push({ t: seg.t0 + 3, chat: 0, chatters: uniq(seg.t0, windowEnd(seg, next)), lufs: -20 + rnd() });
      if (sp) spikes.push(sp);
    }
    return spikes;
  };
  const unclamped = run((seg, next) => (next ? next.t0 : seg.t0 + 6));
  assert.ok(unclamped.some((sp) => sp.peakAt === 903), "the old window (up to the next start) fires on the hole");
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

test("skipCut: a full queue or a short disk skips the moment", async () => {
  const { skipCut, MAX_QUEUE, MIN_FREE_BYTES } = await import("../lib/buffer.mjs");
  assert.equal(MAX_QUEUE, 10);
  assert.equal(MIN_FREE_BYTES, 3e9);
  assert.equal(skipCut({ unclaimed: 0, freeBytes: 50e9 }), null);
  assert.equal(skipCut({ unclaimed: 9, freeBytes: 3e9 }), null);
  assert.equal(skipCut({ unclaimed: 10, freeBytes: 50e9 }), "queue");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: 3e9 - 1 }), "disk");
  assert.equal(skipCut({ unclaimed: 12, freeBytes: 0 }), "queue", "the queue is named first");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: null }), null, "free space unknown: cut");
  assert.equal(skipCut({ unclaimed: 2, freeBytes: 50e9 }, { maxQueue: 2 }), "queue");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: 5e9 }, { minFreeBytes: 6e9 }), "disk");
});
