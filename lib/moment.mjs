// The moment in hand, read for the agent (tools/moment.mjs is its CLI): the
// chat it repeated, its rate, the words as lines, the still times. Not part of
// the vendored engine.

import { spawnSync } from "node:child_process";

export const TOP_CHAT = 8;
export const BEFORE_PEAK_SEC = 15;
export const AFTER_PEAK_SEC = 25;
export const BUCKET_SEC = 10;
/** Stills from 12 s before the peak to 2 s after: chat reacts 2 to 10 s late, so the cause can sit 8 to 15 s back. */
export const FRAME_OFFSETS = [-12, -6, 0, 2];
const LINE_MAX_SEC = 8;
const PAUSE_SEC = 0.7;

/**
 * "LUL  LUL lul KEKW" -> "lul kekw": lower case, a word repeated in a row once,
 * and no invisible characters. Chatters add one (U+034F, U+E0000 and the like)
 * to send the same message twice past Twitch's duplicate filter: "lol ͏" was
 * counted apart from "lol" in a live chat (jynxzi, 2026-11-15).
 */
export function normalizeChat(text) {
  return String(text ?? "")
    .replace(/[\p{Cf}\u034F\u2800\u{E0000}]/gu, "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w, i, a) => w && w !== a[i - 1])
    .join(" ")
    .slice(0, 80);
}

/** The most repeated messages in [from, to), most first; ties go to the one seen first. */
export function topChat(chat, from = -Infinity, to = Infinity, n = TOP_CHAT) {
  const seen = new Map();
  for (const c of chat) {
    if (!(c.t >= from && c.t < to)) continue;
    const text = normalizeChat(c.text);
    if (!text) continue;
    const e = seen.get(text) ?? { text, count: 0, first: c.t };
    e.count++;
    e.first = Math.min(e.first, c.t);
    seen.set(text, e);
  }
  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, n)
    .map(({ text, count }) => ({ text, count }));
}

/** Messages a second in each BUCKET_SEC of the file (as many buckets as the length, or the last message, needs). */
export function chatRates(chat, durationSec = null) {
  const lastT = chat.reduce((m, c) => (Number.isFinite(c.t) ? Math.max(m, c.t) : m), -1);
  const span = durationSec ?? lastT + 1e-9;
  const n = Math.max(0, Math.ceil(span / BUCKET_SEC));
  const counts = new Array(n).fill(0);
  for (const c of chat) {
    const i = Math.floor(c.t / BUCKET_SEC);
    if (i >= 0 && i < n) counts[i]++;
  }
  return counts.map((k) => Math.round((k / BUCKET_SEC) * 10) / 10);
}

const mss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const sec2 = (s) => (Math.round(s * 100) / 100).toFixed(2);

/** Words as readable lines, each "[m:ss] text (start-end)". */
export function wordLines(words, { around = null, span = 30 } = {}) {
  let list = words
    .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && String(x.w ?? "").trim())
    .sort((a, b) => a.s - b.s);
  if (around !== null) list = list.filter((x) => Math.abs(x.s - around) <= span / 2);
  const lines = [];
  let cur = null;
  const close = () => {
    if (cur) lines.push(`[${mss(cur.s)}] ${cur.text.join(" ")} (${sec2(cur.s)}-${sec2(cur.e)})`);
    cur = null;
  };
  for (const x of list) {
    if (cur) {
      const prev = cur.last;
      const sentenceEnd = /[.?!]["')\]]*$/.test(String(prev.w).trim());
      if (sentenceEnd || x.s - prev.e > PAUSE_SEC || x.s - cur.s >= LINE_MAX_SEC) close();
    }
    if (!cur) cur = { s: x.s, e: x.e, text: [], last: x };
    cur.text.push(String(x.w).trim());
    cur.e = Math.max(cur.e, x.e);
    cur.last = x;
  }
  close();
  return lines;
}

/** Seconds of media in a file, by ffprobe. */
export function durationOf(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error) throw new Error(`ffprobe could not run: ${r.error.code ?? r.error.message}`);
  const d = Number(String(r.stdout).trim());
  if (r.status !== 0 || !Number.isFinite(d) || d <= 0) {
    throw new Error(`ffprobe found no length in ${file}: ${String(r.stderr).trim().slice(-200) || "no output"}`);
  }
  return d;
}

/** The still times for a peak, one per offset, clamped into [0, duration - 0.1]. */
export function frameTimes(at, durationSec, offsets = FRAME_OFFSETS) {
  const last = Math.max(0, durationSec - 0.1);
  return offsets.map((o) => Math.round(Math.min(last, Math.max(0, at + o)) * 100) / 100);
}

/** A still's file name, by its offset from --at: -12 is frame-m12.jpg, 2 is frame-2.jpg. */
export function frameName(offset) {
  return `frame-${offset < 0 ? `m${-offset}` : offset}.jpg`;
}

/** "-12,-6,0,2" as numbers, a repeat once; throws on anything else. */
export function parseOffsets(text) {
  const parts = String(text ?? "").split(",").map((p) => p.trim());
  const out = [];
  for (const p of parts) {
    const n = Number(p);
    if (p === "" || !Number.isFinite(n)) throw new Error(`--offsets must be seconds separated by commas, like "-12,-6,0,2": ${text}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

