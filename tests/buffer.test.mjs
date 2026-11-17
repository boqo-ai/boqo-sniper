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
  segmentFileName,
  parseSegmentNumber,
  parseSegmentList,
  createCaptureClock,
  GAP_SEC,
  SEGMENT_SEC,
  POST_ROLL_SEC,
  PRUNE_MARGIN_SEC,
  WINDOW_SEC,
  HORIZON_SEC,
} from "../lib/buffer.mjs";

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
  assert.equal(MIN_FREE_BYTES, 5e9, "retuned for 300 s cuts: a full house is about 4.1 GB (10 queued, 3 listed, buffer, a cut, working files) and the floor is that plus about 1 GB");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: 50e9 }), null);
  assert.equal(skipCut({ unclaimed: 9, freeBytes: 5e9 }), null);
  assert.equal(skipCut({ unclaimed: 10, freeBytes: 50e9 }), "queue");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: 5e9 - 1 }), "disk");
  assert.equal(skipCut({ unclaimed: 12, freeBytes: 0 }), "queue", "the queue is named first");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: null }), null, "free space unknown: cut");
  assert.equal(skipCut({ unclaimed: 2, freeBytes: 50e9 }, { maxQueue: 2 }), "queue");
  assert.equal(skipCut({ unclaimed: 0, freeBytes: 5e9 }, { minFreeBytes: 6e9 }), "disk");
});

// ---- the buffer's names (a counter) and times (the capture's segment list) ----

test("segmentFileName and parseSegmentNumber: a counter, six digits, nothing from the clock", () => {
  assert.equal(segmentFileName(0), "seg_000000.ts");
  assert.equal(segmentFileName(42), "seg_000042.ts");
  assert.equal(segmentFileName(1234567), "seg_1234567.ts");
  assert.equal(parseSegmentNumber("seg_000042.ts"), 42);
  assert.equal(parseSegmentNumber("seg_20261116073944.ts"), 20261116073944, "a 14-digit name reads as a counter, which is why a replay's stamped names are only read by parseSegmentName");
  assert.equal(parseSegmentNumber("seg_42.ts"), null);
  assert.equal(parseSegmentNumber("cut-1.txt"), null);
  assert.equal(parseSegmentNumber("capture-1.csv"), null);
});

test("parseSegmentList: whole csv lines only; a line ffmpeg is still writing, and junk, are not rows", () => {
  const text = "seg_000007.ts,0.000000,6.023222\nseg_000008.ts,6.023222,12.023222\r\nnot a row\nseg_000009.ts,x,1\nseg_000010.ts,12.02";
  assert.deepEqual(parseSegmentList(text), [
    { name: "seg_000007.ts", start: 0, end: 6.023222 },
    { name: "seg_000008.ts", start: 6.023222, end: 12.023222 },
  ]);
  assert.deepEqual(parseSegmentList(""), []);
  assert.deepEqual(parseSegmentList("seg_000001.ts,0,6"), [], "no newline yet: the row is not written");
});

const row = (i, len = 6) => ({ name: segmentFileName(i), start: i * len, end: (i + 1) * len });

test("createCaptureClock: read live, one row a segment, a segment's t0 is the second it opened (read time less its length)", () => {
  const c = createCaptureClock();
  for (let i = 0; i < 5; i++) c.observe(row(i), 1006 + 6 * i); // each row is read as its segment closes
  for (let i = 0; i < 5; i++) assert.equal(c.t0(row(i).start), 1000 + 6 * i);
});

test("createCaptureClock: read late (a few seconds of jitter), the anchor only moves earlier, to the least-late reading", () => {
  const c = createCaptureClock();
  c.observe(row(0), 1009); // 3 s late
  assert.equal(c.t0(0), 1003);
  c.observe(row(1), 1012); // on time: the stream is 3 s nearer live than the first row said
  assert.equal(c.t0(0), 1000);
  c.observe(row(2), 1022); // 4 s late: no move
  assert.equal(c.t0(0), 1000);
  assert.equal(c.t0(row(2).start), 1012);
});

test("createCaptureClock: a 60 s backlog read in one instant is spaced by stream time, not stacked on one second", () => {
  const c = createCaptureClock();
  const rows = Array.from({ length: 10 }, (_, i) => row(i));
  for (const r of rows) c.observe(r, 5000); // all ten rows are read at the same second
  const t0s = rows.map((r) => c.t0(r.start));
  assert.deepEqual(t0s, rows.map((_, i) => 4940 + 6 * i), "6 s apart, the last one ending at the read time");
  assert.equal(new Set(t0s).size, 10);
});

test("a cut over segments written in a burst covers the stream span around the peak", () => {
  // ten 6.02 s segments arrive in one instant (a stalled stream catching up); the stream's own times are the spacing
  const len = 6.023222;
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: segmentFileName(i), start: i * len, end: (i + 1) * len }));
  const c = createCaptureClock();
  for (const r of rows) c.observe(r, 8000);
  const burst = rows.map((r, n) => ({ n, name: r.name, t0: c.t0(r.start), s: r.start, cap: 1 }));
  // the peak is 31 s into the stream; a 20 s window ending 6 s after it
  const peakStream = 31;
  const peakAt = burst[0].t0 + peakStream;
  const plan = planCut(burst, peakAt, 20, 6);
  assert.ok(plan);
  // the window is stream [17, 37]: the segments overlapping it, contiguous, and nothing else
  const want = rows.filter((r) => r.start < 37 && r.end > 17).map((r) => r.name);
  assert.deepEqual(plan.segments.map((x) => x.name), want);
  assert.deepEqual(want, ["seg_000002.ts", "seg_000003.ts", "seg_000004.ts", "seg_000005.ts", "seg_000006.ts"]);
  const first = rows.find((r) => r.name === want[0]);
  assert.ok(Math.abs(plan.peakOffsetSec - (peakStream - first.start)) < 1e-6, `peak ${plan.peakOffsetSec} s into the cut`);
  // and the same peak a moment later, read from a new capture's segments only (a restart is a hole)
  const second = [{ n: 10, name: segmentFileName(10), t0: peakAt + 100, s: 0, cap: 2 }];
  assert.deepEqual(planCut([...burst, ...second], peakAt, 20, 6).segments.map((x) => x.name), want, "the cut stays in the capture that holds the peak");
  // prune: the horizon runs back from the newest end
  assert.equal(pruneBefore(burst, 20).length, 6, "segments that ended more than 20 s before the newest end go");
});

// ---- a hole inside one capture, and a catch-up, told apart by how the lag ends ----

/** What the watcher does with a row: stamp it from the clock, move the previous row if the clock split, restamp the capture. */
function feedRows(clock, reads) {
  const segs = [];
  for (const { row, at } of reads) {
    const r = clock.observe(row, at);
    const seg = { n: segs.length, name: row.name, s: row.start, epoch: r.epoch, cap: `1.${r.epoch}`, readAt: at, splitBack: r.splitBack };
    if (r.splitBack) {
      segs.at(-1).epoch = r.epoch;
      segs.at(-1).cap = seg.cap;
    }
    segs.push(seg);
    for (const x of segs) x.t0 = clock.t0(x.s, x.epoch);
  }
  return segs;
}
/** 6 s rows by stream time: row i is [6i, 6i + 6). */
const rowAt = (i) => ({ name: segmentFileName(i), start: 6 * i, end: 6 * i + 6 });

test("a 60 s hole in the content: the segments after it are placed at their live time, and a cut across it splits", () => {
  // read 8 s after their stream time (T0 = 1000); after stream time 102 the source drops for 60 s and resumes, so the
  // later rows are read 60 s later, and ffmpeg's list shows them contiguous
  const reads = [];
  for (let i = 0; i < 40; i++) reads.push({ row: rowAt(i), at: 1000 + 8 + 6 * i + 6 + (i >= 17 ? 60 : 0) });
  const c = createCaptureClock();
  const segs = feedRows(c, reads);
  // every segment is within one segment of the second it really opened (read time less its length)
  for (const s of segs) assert.ok(Math.abs(s.t0 - (s.readAt - 6)) <= 6, `${s.name}: placed ${s.t0}, opened ${s.readAt - 6}`);
  const split = segs.filter((s) => s.splitBack);
  assert.equal(split.length, 1, "one split");
  assert.equal(split[0].name, segmentFileName(18), "found at the second row read after the hole");
  assert.equal(segs[17].cap, segs[18].cap, "the first row read after the hole moves to the new run with it");
  assert.notEqual(segs[16].cap, segs[17].cap);
  // a moment just after the hole is cut from the segments after it, one just before from those before it, never across
  const afterPeak = segs[20].t0 + 3;
  const afterPlan = planCut(segs, afterPeak, 300, 30);
  assert.ok(afterPlan.segments.every((s) => s.n >= 17), afterPlan.segments.map((s) => s.name).join());
  const beforePeak = segs[15].t0 + 3;
  const beforePlan = planCut(segs, beforePeak, 300, 30);
  assert.ok(beforePlan.segments.every((s) => s.n <= 16), beforePlan.segments.map((s) => s.name).join());
  // without the split the whole 40 segments are one run and the later ones sit 60 s early: the defect this pins
  const flat = segs.map((s) => ({ ...s, cap: "1.0", t0: 1008 + s.s }));
  assert.ok(Math.abs(flat[20].t0 - (flat[20].readAt - 6)) > 50);
  assert.ok(planCut(flat, flat[20].t0 + 3, 300, 30).segments.some((s) => s.n < 17), "one run spans the hole");
});

test("a stall followed by a burst is not a hole: the backlog read in one instant leaves the anchor where it was", () => {
  const reads = [];
  for (let i = 0; i < 17; i++) reads.push({ row: rowAt(i), at: 1008 + 6 * i + 6 }); // live to stream 102
  // the stream stalls for 60 s; its backlog, rows 17 to 26 (stream 102 to 162), arrives at once when it is back live
  for (let i = 17; i < 27; i++) reads.push({ row: rowAt(i), at: 1008 + 162 });
  for (let i = 27; i < 35; i++) reads.push({ row: rowAt(i), at: 1008 + 6 * i + 6 });
  const c = createCaptureClock();
  const segs = feedRows(c, reads);
  assert.equal(segs.filter((s) => s.splitBack).length, 0);
  assert.ok(segs.every((s) => s.epoch === 0));
  assert.deepEqual(segs.map((s) => s.t0), segs.map((s) => 1008 + s.s), "the anchor never left 1008");
});

test("a steady stream never splits: read times jitter by up to 20 s, and two rows arrive in one scan now and then", () => {
  const reads = [];
  let at = 0;
  for (let i = 0; i < 400; i++) {
    const jitter = ((i * 7919) % 21) - 0; // 0..20 s late, a fixed scramble
    at = Math.max(at, 1008 + 6 * i + 6 + jitter);
    reads.push({ row: rowAt(i), at: i % 5 === 4 ? reads[i - 1].at : at }); // every fifth shares the previous scan
  }
  const c = createCaptureClock();
  const segs = feedRows(c, reads);
  assert.equal(segs.filter((s) => s.splitBack).length, 0);
  assert.ok(segs.every((s) => s.epoch === 0));
});

test("createCaptureClock: a lag that stays above GAP_SEC for two rows is a shift; one row is not", () => {
  const c = createCaptureClock();
  c.observe(rowAt(0), 1006);
  assert.equal(c.observe(rowAt(1), 1012 + GAP_SEC + 5).splitBack, 0, "one late row");
  assert.equal(c.observe(rowAt(2), 1018).splitBack, 0, "and it is over");
  const d = createCaptureClock();
  d.observe(rowAt(0), 1006);
  d.observe(rowAt(1), 1012 + 40);
  const r = d.observe(rowAt(2), 1018 + 40);
  assert.deepEqual([r.epoch, r.splitBack], [1, 1]);
  assert.equal(d.t0(rowAt(1).start, 1), 1000 + 40 + 6, "the new epoch's anchor is the two rows' own");
});
