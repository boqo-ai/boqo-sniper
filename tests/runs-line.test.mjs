import { test } from "node:test";
import assert from "node:assert/strict";
import { runsLine } from "../lib/runs-line.mjs";
import { scoreBand } from "../lib/bands.mjs";

const at = Date.UTC(2026, 10, 16, 21, 4, 30) / 1000;
const chat = { chatPerSec: 30.2, chatBaseline: 2, loudness: null, loudnessBaseline: null, topMessage: "NO WAY", topCount: 168 };

test("a chat moment: time, score and band, hosted's signal line, title, clips", () => {
  assert.equal(
    runsLine({ peakAt: at, score: 86, signal: "chat", detail: chat, title: 'chat spike — "NO WAY" ×168', clips: 4, utc: true }),
    '21:04 · 86 exceptional · NO WAY ×168 · 30/s · chat spike — "NO WAY" ×168 · 4 clips',
  );
});

test("an audio moment says its loudness lead", () => {
  const detail = { chatPerSec: 1, chatBaseline: 1, loudness: -8, loudnessBaseline: -17, topMessage: null, topCount: 0 };
  assert.equal(
    runsLine({ peakAt: at, score: 72, signal: "audio", detail, title: "audio spike", clips: 2, utc: true }),
    "21:04 · 72 strong · Audio +9 LU · audio spike · 2 clips",
  );
});

test("a hand-made moment has no signal line; one clip is singular; no read is marked", () => {
  assert.equal(
    runsLine({ peakAt: at, score: 100, signal: "manual", detail: null, title: "clipped by hand", clips: 1, noRead: true, utc: true }),
    "21:04 · 100 exceptional · clipped by hand · 1 clip · no read",
  );
  assert.equal(runsLine({ peakAt: at, score: 60, signal: "chat", detail: null, title: "t", clips: 0, utc: true }), "21:04 · 60 decent · t · 0 clips");
});

test("local time is the default", () => {
  const line = runsLine({ peakAt: at, score: 70, signal: "manual", title: "t", clips: 3 });
  const d = new Date(at * 1000);
  assert.ok(line.startsWith(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · 70 strong`), line);
});

test("the five bands, at and one under each threshold (spec §6)", () => {
  const cases = [[100, "exceptional"], [85, "exceptional"], [84, "strong"], [70, "strong"], [69, "decent"], [60, "decent"], [59, "watchable"], [40, "watchable"], [39, "weak"], [0, "weak"]];
  for (const [s, band] of cases) assert.equal(scoreBand(s), band, String(s));
});
