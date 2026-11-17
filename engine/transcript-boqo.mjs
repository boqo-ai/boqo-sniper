// boqo's `get_transcript` result as the skill's own files. The result is JSON at a signed link:
//   { language, segments: [{ start, end, text, speaker }], words: [{ w, s, e }] }
// Deepgram's own sentence segments (boqo's normalize.ts: identical to hosted's) with the
// speaker number each segment carries, and the words as engine/words.mjs reads them. The
// payload came over the network from a service the person pays, but it is still text this
// skill did not write, and the agent that reads it has a shell: parseBoqoTranscript checks every
// field, copies only the known ones, and throws one line for anything else.
import { languageFor } from './select-input.mjs';

export const MAX_BYTES = 64 * 1024 * 1024;
export const TIMEOUT_MS = 60_000;
const MAX_WORDS = 2_000_000;
const MAX_SEGMENTS = 500_000;
const MAX_WORD_CHARS = 200;
const MAX_TEXT_CHARS = 100_000;
const MAX_LANGUAGE_CHARS = 35;

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const time = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The checked transcript: `{language, words: [{w, s, e}], segments: [{start, end, text, speaker}]}`.
 * `language` is the tag the select request prints (a value that is not a language tag reads as `en`,
 * as languageFor does everywhere). A segment's `speaker` is a whole number or null. Throws an Error
 * with a one-line message naming the first thing wrong.
 */
export function parseBoqoTranscript(payload) {
  if (!isRecord(payload)) throw new Error('the transcript is not a JSON object');
  const { language, segments, words } = payload;
  if (typeof language !== 'string' || language === '' || language.length > MAX_LANGUAGE_CHARS) throw new Error('the transcript has no language');
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('the transcript has no segments');
  if (!Array.isArray(words) || words.length === 0) throw new Error('the transcript has no words');
  if (segments.length > MAX_SEGMENTS) throw new Error('the transcript has too many segments');
  if (words.length > MAX_WORDS) throw new Error('the transcript has too many words');

  const outSegments = [];
  let last = 0;
  segments.forEach((s, i) => {
    const at = `segment ${i + 1}`;
    if (!isRecord(s)) throw new Error(`${at} is not an object`);
    if (!time(s.start) || !time(s.end)) throw new Error(`${at} needs a start and an end in seconds, 0 or more`);
    if (s.end < s.start) throw new Error(`${at} ends before it starts`);
    if (s.start < last) throw new Error(`${at} starts before the one before it`);
    if (typeof s.text !== 'string' || s.text.length > MAX_TEXT_CHARS) throw new Error(`${at} needs a text`);
    if (s.speaker !== null && !(Number.isInteger(s.speaker) && s.speaker >= 0)) throw new Error(`${at} needs a speaker that is a whole number or null`);
    last = s.start;
    outSegments.push({ start: s.start, end: s.end, text: s.text, speaker: s.speaker });
  });

  const outWords = words.map((w, i) => {
    const at = `word ${i + 1}`;
    if (!isRecord(w)) throw new Error(`${at} is not an object`);
    if (typeof w.w !== 'string' || w.w.length > MAX_WORD_CHARS) throw new Error(`${at} needs a text`);
    if (!time(w.s) || !time(w.e)) throw new Error(`${at} needs a start and an end in seconds, 0 or more`);
    if (w.e < w.s) throw new Error(`${at} ends before it starts`);
    return { w: w.w, s: w.s, e: w.e };
  });

  return { language: languageFor(null, language), words: outWords, segments: outSegments };
}

/** Whether `link` is one this tool downloads: https, or http to this machine (a test server); no credentials in it. */
function allowedUrl(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url;
  return null;
}

/**
 * Downloads and parses the JSON at a signed link. No redirect is followed, the body stops at `maxBytes`
 * and the whole read at `timeoutMs`. The errors never name the link (it is signed).
 */
export async function fetchTranscriptJson(link, { maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const url = allowedUrl(link);
  if (url === null) throw new Error('the link must be an https link');
  const signal = AbortSignal.timeout(timeoutMs);
  let text;
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal });
    if (!res.ok) throw new Error(`the download answered ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`the transcript is larger than ${Math.round(maxBytes / 1048576)} MB`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`the transcript is larger than ${Math.round(maxBytes / 1048576)} MB`);
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    if (signal.aborted) throw new Error('the download did not answer in time');
    if (/^(the download answered|the transcript is larger)/.test(err?.message ?? '')) throw err;
    throw new Error('the download failed');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the download is not valid JSON');
  }
}
