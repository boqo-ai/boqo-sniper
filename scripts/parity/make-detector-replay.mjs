#!/usr/bin/env node
// node scripts/parity/make-detector-replay.mjs > tests/fixtures/parity/detector-replay.input.json
//   Writes the detector-replay case's input: 30 minutes of synthetic 1 s ticks
//   (boqo's MomentTick shape) from a seeded PRNG, so the series is the same on
//   every run. Synthetic text only; no real chat.
//
//   Ordinary chat: 1-5 messages a second (mean about 3), every text different;
//   loudness -25 LUFS, +-1.5 LU. On top of it, by second:
//      20-27  a chat burst inside the warm-up (60 s): never a moment
//     300-307  chat burst, 30/s, 70% "NO WAY"
//     340-341  chat burst 2 s, 40/s, inside the cooldown of the one above
//     500-502  audio only: -8 LUFS, chat flat
//     700-707  chat burst, 25/s, every text different (the title names the rate)
//     900-989  chat socket closed (chatOpen false, nothing counted), with an audio
//              spike at 940-942 and loudness unknown at 960-969 inside it;
//              a 40/s burst at 990-993 as the socket reopens, scored only once
//              five open seconds fill the window
//    1060-1067  chat burst after the reopen, 30/s, 70% "CLIP IT"
//    1200-1229  loudness unknown (null): a capture hole
//    1215-1222  chat burst inside the hole, 30/s, 70% "W"
//    1400-1429  a chat rate climbing 15% a second from 5/s (the 20 s rise cap)
//    1600-1605  chat burst 30/s ("LETS GO") with loudness -10 in the same seconds
//    1750-1752  a loud bang (-5 LUFS): a plain audio moment
const T0 = 1_800_000_000_000;
const SECONDS = 1800;

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

const rand = mulberry32(20261116);
const round1 = (x) => Math.round(x * 10) / 10;

function burstTexts(rate, text, i) {
  const same = Math.round(rate * 0.7);
  return [...Array.from({ length: same }, () => text), ...Array.from({ length: rate - same }, (_, k) => `other-${i}-${k}`)];
}

const ticks = [];
for (let i = 0; i < SECONDS; i++) {
  const chatCount = 1 + Math.floor(rand() * 5);
  let chatTexts = Array.from({ length: chatCount }, (_, k) => `m${i}-${k}`);
  let loudness = round1(-25 + (rand() * 2 - 1) * 1.5);
  let chatOpen = true;

  const inside = (from, to) => i >= from && i <= to;
  if (inside(20, 27)) chatTexts = burstTexts(30, "EARLY", i);
  if (inside(300, 307)) chatTexts = burstTexts(30, "NO WAY", i);
  if (inside(340, 341)) chatTexts = burstTexts(40, "AGAIN", i);
  if (inside(500, 502)) loudness = -8;
  if (inside(700, 707)) chatTexts = Array.from({ length: 25 }, (_, k) => `unique-${i}-${k}`);
  if (inside(900, 989)) {
    chatOpen = false;
    chatTexts = [];
  }
  if (inside(940, 942)) loudness = -8;
  if (inside(960, 969)) loudness = null;
  if (inside(990, 993)) chatTexts = burstTexts(40, "BACK", i);
  if (inside(1060, 1067)) chatTexts = burstTexts(30, "CLIP IT", i);
  if (inside(1200, 1229)) loudness = null;
  if (inside(1215, 1222)) chatTexts = burstTexts(30, "W", i);
  if (inside(1400, 1429)) chatTexts = burstTexts(Math.round(5 * 1.15 ** (i - 1400)), "climb", i);
  if (inside(1600, 1605)) {
    chatTexts = burstTexts(30, "LETS GO", i);
    loudness = -10;
  }
  if (inside(1750, 1752)) loudness = -5;

  ticks.push({ at: T0 + i * 1000, chatCount: chatTexts.length, chatTexts, loudness, chatOpen });
}

const input = { windowSec: 300, sensitivity: 70, ticks };
process.stdout.write(`{"windowSec":${input.windowSec},"sensitivity":${input.sensitivity},"ticks":[\n`);
process.stdout.write(ticks.map((t) => JSON.stringify(t)).join(",\n"));
process.stdout.write("\n]}\n");
