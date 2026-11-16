import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FRAME_OFFSETS, chatRates, frameName, frameTimes, normalizeChat, parseOffsets, topChat, wordLines } from "../lib/moment.mjs";
import { toolEnv } from "../engine/env.mjs";

const MOMENT = fileURLToPath(new URL("../tools/moment.mjs", import.meta.url));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOMENT, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "sniper-moment-"));
}

/** A small mp4 of `seconds` (testsrc + sine). */
function makeVideo(file, seconds) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=320x180:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
    ],
    { encoding: "utf8", env: toolEnv() },
  );
  assert.equal(r.status, 0, r.stderr);
}

/** Chat over 100 s: "hello" every second, a burst of "LUL LUL LUL" and "NO SHOT" around 50 s. */
function sampleChat() {
  const chat = [];
  for (let t = 0; t < 100; t++) chat.push({ t, user: `u${t % 5}`, text: "hello", emotes: 0 });
  for (let i = 0; i < 12; i++) chat.push({ t: 48 + i * 0.5, user: `f${i}`, text: "LUL LUL LUL", emotes: 3 });
  for (let i = 0; i < 3; i++) chat.push({ t: 47 + i, user: `g${i}`, text: "lul", emotes: 1 });
  for (let i = 0; i < 5; i++) chat.push({ t: 52 + i, user: `h${i}`, text: "NO   SHOT", emotes: 0 });
  chat.push({ t: 90, user: "late", text: "LUL", emotes: 1 }); // outside the peak window
  return chat.sort((a, b) => a.t - b.t);
}

test("normalizeChat lower-cases, squeezes spaces and counts a repeated word once", () => {
  assert.equal(normalizeChat("LUL LUL  LUL"), "lul");
  assert.equal(normalizeChat("NO   SHOT"), "no shot");
  assert.equal(normalizeChat("W W cop W"), "w cop w");
  assert.equal(normalizeChat("   "), "");
  assert.equal(normalizeChat(undefined), "");
  assert.equal(normalizeChat("lol \u034F"), "lol", "the duplicate-filter dodge is invisible");
  assert.equal(normalizeChat("lol \u{E0000}"), "lol");
  assert.equal(normalizeChat("w\u200Bw cop"), "ww cop");
  assert.equal(normalizeChat("\u2800"), "");
  assert.equal(normalizeChat("Café"), "café", "letters are kept");
});

test("topChat counts the window only, most first, at most 8", () => {
  const top = topChat(sampleChat(), 35, 75);
  assert.deepEqual(top, [
    { text: "hello", count: 40 },
    { text: "lul", count: 15 },
    { text: "no shot", count: 5 },
  ]);
  const many = Array.from({ length: 20 }, (_, i) => ({ t: 1, user: "x", text: `m${i}` }));
  assert.equal(topChat(many).length, 8);
  // ties go to the message seen first
  assert.deepEqual(topChat([{ t: 5, text: "b" }, { t: 1, text: "a" }]).map((x) => x.text), ["a", "b"]);
});

test("chatRates gives messages a second per 10 s, sized by the length when known", () => {
  const chat = [{ t: 0 }, { t: 1 }, { t: 9.9 }, { t: 10 }, { t: 25 }];
  assert.deepEqual(chatRates(chat, 30), [0.3, 0.1, 0.1]);
  assert.deepEqual(chatRates(chat, 40), [0.3, 0.1, 0.1, 0]);
  assert.deepEqual(chatRates(chat), [0.3, 0.1, 0.1], "without a length, up to the last message");
  assert.deepEqual(chatRates([], null), []);
});

test("wordLines breaks at sentence ends, pauses and 8 s, with exact times", () => {
  const w = (text, s, e) => ({ w: text, s, e });
  const words = [
    w("He's", 85.36, 85.56), w("leaving", 85.56, 85.91), w("his", 85.91, 86.06), w("king.", 86.06, 87.27),
    w("All", 91.84, 92.0), w("right,", 92.0, 92.3), // pause before: new line
    w("so", 92.3, 92.5), w("I'm", 92.5, 92.7), w("gonna", 92.7, 93.0), w("do", 93.0, 93.2), w("this", 93.2, 93.84),
    w("and", 93.9, 94.0), w("then", 94.1, 95.0), w("go", 95.1, 96.0), w("on", 96.1, 99.9), w("forever", 100.0, 100.2),
  ];
  const lines = wordLines(words);
  assert.equal(lines[0], "[1:25] He's leaving his king. (85.36-87.27)");
  assert.equal(lines[1], "[1:31] All right, so I'm gonna do this and then go on (91.84-99.90)", "a pause starts a line");
  assert.equal(lines[2], "[1:40] forever (100.00-100.20)", "the 8 s cap starts a new line with no pause");
  assert.equal(lines.length, 3);
});

test("wordLines with --around keeps the words within span/2 of that second", () => {
  const words = Array.from({ length: 100 }, (_, i) => ({ w: `w${i}.`, s: i, e: i + 0.5 }));
  const lines = wordLines(words, { around: 50, span: 10 });
  assert.equal(lines.length, 11);
  assert.equal(lines[0], "[0:45] w45. (45.00-45.50)");
  assert.equal(lines.at(-1), "[0:55] w55. (55.00-55.50)");
  assert.deepEqual(wordLines([{ w: " ", s: 1, e: 2 }, { w: "x", s: NaN, e: 1 }]), [], "blank and broken words are dropped");
});

test("frameTimes: four stills by default, from 12 s before the peak to 2 s after, clamped into the file", () => {
  assert.deepEqual(FRAME_OFFSETS, [-12, -6, 0, 2]);
  assert.deepEqual(frameTimes(125, 160), [113, 119, 125, 127]);
  assert.deepEqual(frameTimes(3, 4), [0, 0, 3, 3.9]);
  assert.deepEqual(frameTimes(500, 160), [159.9, 159.9, 159.9, 159.9]);
  assert.deepEqual(frameTimes(-10, 160), [0, 0, 0, 0]);
  assert.deepEqual(frameTimes(60, 160, [-20, 5]), [40, 65]);
});

test("frameName names a still by its offset; parseOffsets reads the list", () => {
  assert.equal(frameName(-12), "frame-m12.jpg");
  assert.equal(frameName(0), "frame-0.jpg");
  assert.equal(frameName(2), "frame-2.jpg");
  assert.equal(frameName(-1.5), "frame-m1.5.jpg");
  assert.deepEqual(parseOffsets("-12,-6,0,2"), [-12, -6, 0, 2]);
  assert.deepEqual(parseOffsets(" -3 , 4 "), [-3, 4]);
  assert.deepEqual(parseOffsets("-6,-6,1"), [-6, 1], "a repeat is one still");
  for (const bad of ["", "a", "1,,2", "-6,x"]) assert.throws(() => parseOffsets(bad), /--offsets/, bad);
});

test("read: meta, the top chat around the peak, chat rates and the video's length", { timeout: 60000 }, async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ peakOffsetSec: 50, score: 80, reason: "chat" }));
    await fs.writeFile(path.join(dir, "chat.json"), JSON.stringify(sampleChat()));
    const noVideo = await run(["read", dir]);
    assert.equal(noVideo.code, 0, noVideo.stdout);
    assert.equal(noVideo.stdout.trim().split("\n").length, 1);
    assert.deepEqual(Object.keys(noVideo.json).sort(), ["chatPerSec", "durationSec", "meta", "topChat"]);
    assert.equal(noVideo.json.meta.score, 80);
    assert.equal(noVideo.json.durationSec, null, "no video.mp4: no length");
    assert.deepEqual(noVideo.json.topChat[0], { text: "hello", count: 40 });
    assert.deepEqual(noVideo.json.topChat[1], { text: "lul", count: 15 }, "the LUL at 90 s is outside the window");
    assert.equal(noVideo.json.chatPerSec.length, 10);
    assert.equal(noVideo.json.chatPerSec[4], 1.7, "40-50 s: 10 hello, 4 of the LUL burst, 3 lul");
    assert.equal(noVideo.json.chatPerSec[5], 2.3, "50-60 s: 10 hello, 8 of the LUL burst, 5 no shot");

    makeVideo(path.join(dir, "video.mp4"), 3);
    const withVideo = await run(["read", dir]);
    assert.equal(withVideo.code, 0, withVideo.stdout);
    assert.ok(Math.abs(withVideo.json.durationSec - 3) < 0.2, `durationSec ${withVideo.json.durationSec}`);
    assert.equal(withVideo.json.chatPerSec.length, 1, "rates cover the file's own length");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("read: a moment with no meta.json is an error", async () => {
  const dir = await tmp();
  try {
    const r = await run(["read", dir]);
    assert.equal(r.code, 1);
    assert.match(r.json.error, /meta/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("words: the CLI prints the lines as one JSON line; bad flags are errors", async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, "words.json");
    await fs.writeFile(file, JSON.stringify([{ w: "Hello", s: 1, e: 1.4 }, { w: "there.", s: 1.4, e: 2 }]));
    const r = await run(["words", file, "--around", "1", "--span", "30"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { lines: ["[0:01] Hello there. (1.00-2.00)"] });
    assert.equal((await run(["words", file, "--around", "x"])).code, 1);
    assert.equal((await run(["words", file, "--nope", "1"])).code, 1);
    assert.equal((await run(["words"])).code, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("frames: a still per offset, named by it, times clamped into the video, even for a peak past its end", { timeout: 60000 }, async () => {
  const dir = await tmp();
  try {
    const video = path.join(dir, "video.mp4");
    makeVideo(video, 20);
    const out = path.join(dir, "out dir");
    const r = await run(["frames", video, "--at", "14", "--out", out]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.frames.map((f) => f.at), [2, 8, 14, 16]);
    assert.deepEqual(r.json.frames.map((f) => f.offset), [-12, -6, 0, 2]);
    assert.deepEqual(r.json.frames.map((f) => path.basename(f.file)), ["frame-m12.jpg", "frame-m6.jpg", "frame-0.jpg", "frame-2.jpg"]);
    for (const f of r.json.frames) assert.ok((await fs.stat(f.file)).size > 0, f.file);

    const more = await run(["frames", video, "--at", "14", "--offsets", "-9,1", "--out", out]);
    assert.equal(more.code, 0, more.stdout);
    assert.deepEqual(more.json.frames.map((f) => [path.basename(f.file), f.at]), [["frame-m9.jpg", 5], ["frame-1.jpg", 15]]);
    assert.deepEqual((await fs.readdir(out)).sort(), ["frame-0.jpg", "frame-1.jpg", "frame-2.jpg", "frame-m12.jpg", "frame-m6.jpg", "frame-m9.jpg"], "a second call adds, it does not replace");
    assert.equal((await run(["frames", video, "--at", "1", "--offsets", "x", "--out", out])).code, 1);

    const late = await run(["frames", video, "--at", "100", "--out", out]);
    assert.equal(late.code, 0, late.stdout);
    for (const f of late.json.frames) assert.ok((await fs.stat(f.file)).size > 0);

    const missing = await run(["frames", path.join(dir, "nope.mp4"), "--at", "1", "--out", out]);
    assert.equal(missing.code, 1);
    assert.match(missing.json.error, /no video/);
    assert.equal((await run(["frames", video, "--out", out])).code, 1, "--at is required");
    assert.equal((await run(["frames", video, "--at", "1"])).code, 1, "--out is required");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
