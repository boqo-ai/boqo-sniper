// The 1 s ticks the hosted moment detector is fed (lib/boqo/moments.mjs).
//
// Mirrored, not ported: in boqo this bookkeeping is inline in the async session
// loop (apps/watcher/src/watch/session.ts @ bcc9d99cc, the judge-off branch of
// "Every complete second since the last tick feeds the detector once"), so there
// is no function to copy. The same steps, pure, keep in step by hand:
//   - chat texts and momentary loudness readings are keyed by the wall-clock
//     second they arrive in (boqo's SecondBuckets, lib/boqo/buckets.mjs);
//   - each drain feeds every complete second since the last one, once: the
//     second's raw messages (count and texts), its loudest reading or null, and
//     whether the chat socket was open for all of it;
//   - a second is open only if the socket opened at or before its start and has
//     not dropped since, so the second it opens in is not, nor the one it drops
//     in (boqo's `chatOpenSince <= second * 1000`). A feed started while the
//     chat is already open counts it as opening then, as a hosted watch that
//     joins a running capture does;
//   - the second the feed starts in is partial and never fed; buckets older
//     than 60 s are dropped at every drain.
// Times are epoch milliseconds, as the detector's ticks are.

import { SecondBuckets } from "./boqo/buckets.mjs";

/**
 * `detector` is a createMomentDetector; `nowMs` the clock when the capture
 * phase starts; `chatOpen` whether the chat socket is open then.
 * `drain(nowMs)` returns the candidates the fed seconds produced, oldest first.
 */
export function createTickFeed({ detector, nowMs, chatOpen = false }) {
  const chatBuckets = new SecondBuckets();
  const loudBuckets = new SecondBuckets();
  let chatOpenSince = chatOpen ? nowMs : null;
  let second = Math.floor(nowMs / 1000);

  return {
    /** A chat message's text, at the clock it arrived. */
    chat(atMs, text) {
      chatBuckets.add(atMs, text);
    },
    /** One momentary loudness reading (LUFS), at the clock it arrived. */
    loudness(atMs, momentary) {
      loudBuckets.add(atMs, momentary);
    },
    /** The chat socket's state changed at `atMs`: "open", or anything else for not open. */
    chatState(state, atMs) {
      chatOpenSince = state === "open" ? atMs : null;
    },
    drain(nowMs) {
      const nowSec = Math.floor(nowMs / 1000);
      const candidates = [];
      while (second < nowSec - 1) {
        second += 1;
        const louds = loudBuckets.take(second);
        const loudness = louds.length > 0 ? Math.max(...louds) : null;
        const chatOpen = chatOpenSince !== null && chatOpenSince <= second * 1000;
        const texts = chatBuckets.take(second);
        const candidate = detector.tick({ at: second * 1000, chatCount: texts.length, chatTexts: texts, loudness, chatOpen });
        if (candidate) candidates.push(candidate);
      }
      chatBuckets.dropBefore(nowSec - 60);
      loudBuckets.dropBefore(nowSec - 60);
      return candidates;
    },
  };
}
