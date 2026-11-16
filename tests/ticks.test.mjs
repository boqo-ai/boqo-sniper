// The tick feed (lib/ticks.mjs): the 1 s ticks the hosted detector is fed,
// mirrored from boqo's session loop (apps/watcher/src/watch/session.ts @ bcc9d99cc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTickFeed } from "../lib/ticks.mjs";
import { createMomentDetector } from "../lib/boqo/moments.mjs";

const T = 1_800_000_000; // an epoch second
const ms = (sec) => sec * 1000;

/** A feed over a detector that records every tick and emits nothing. */
function recording(o) {
  const ticks = [];
  const feed = createTickFeed({ detector: { tick: (t) => (ticks.push(t), null) }, ...o });
  return { feed, ticks };
}

test("every complete second is fed once, in order, with its raw messages and its loudest reading", () => {
  const { feed, ticks } = recording({ nowMs: ms(T) + 400, chatOpen: true });
  feed.chat(ms(T) + 900, "too early"); // the second the feed starts in is partial: never fed
  feed.chat(ms(T + 1) + 10, "a");
  feed.chat(ms(T + 1) + 999, "b");
  feed.loudness(ms(T + 1) + 100, -30);
  feed.loudness(ms(T + 1) + 500, -21.5);
  feed.loudness(ms(T + 1) + 900, -26);
  feed.chat(ms(T + 3) + 1, "c");
  feed.chat(ms(T + 4) + 1, "d");
  assert.deepEqual(feed.drain(ms(T + 4) + 300), []);
  assert.deepEqual(
    ticks.map((t) => [t.at, t.chatCount, t.chatTexts, t.loudness, t.chatOpen]),
    [
      [ms(T + 1), 2, ["a", "b"], -21.5, true],
      [ms(T + 2), 0, [], null, true],
      [ms(T + 3), 1, ["c"], null, true],
    ],
    "second T+4 is still running: it waits",
  );
  feed.drain(ms(T + 4) + 800);
  assert.equal(ticks.length, 3, "a drain inside the same second feeds nothing");
  feed.drain(ms(T + 6));
  assert.deepEqual(ticks.slice(3).map((t) => [t.at, t.chatTexts]), [[ms(T + 4), ["d"]], [ms(T + 5), []]]);
});

test("a second is chat-open only if the socket opened at or before its start and has not dropped since", () => {
  const { feed, ticks } = recording({ nowMs: ms(T), chatOpen: false });
  feed.chat(ms(T + 1) + 200, "sent before the join was confirmed");
  feed.chatState("open", ms(T + 2) + 300); // opens inside T+2: T+2 is not open
  feed.drain(ms(T + 5) + 100); // feeds T+1 .. T+4
  feed.chatState("connecting", ms(T + 5) + 700); // drops inside T+5: T+5 is not open
  feed.drain(ms(T + 7) + 100); // T+5, T+6
  feed.chatState("open", ms(T + 7)); // reopens exactly at T+7's start: T+7 is open
  feed.drain(ms(T + 9) + 100); // T+7, T+8
  assert.deepEqual(
    ticks.map((t) => [(t.at - ms(T)) / 1000, t.chatOpen]),
    [[1, false], [2, false], [3, true], [4, true], [5, false], [6, false], [7, true], [8, true]],
  );
  assert.equal(ticks[0].chatCount, 1, "the count is still handed over: the detector ignores it");
});

test("a drop that lands before a finished second is fed takes that second too, the safe way", () => {
  // boqo's loop feeds a second at its first wake after it ends; a drop between the
  // end and the wake makes the fully open second go in as not open.
  const { feed, ticks } = recording({ nowMs: ms(T), chatOpen: true });
  feed.drain(ms(T + 3) + 50); // T+1, T+2
  feed.chatState("connecting", ms(T + 3) + 200); // T+3 ended open, but is not fed yet
  feed.drain(ms(T + 4) + 600); // T+3
  assert.deepEqual(ticks.map((t) => t.chatOpen), [true, true, false]);
});

test("a feed started while the chat is open counts it as opening then", () => {
  const { feed, ticks } = recording({ nowMs: ms(T) + 500, chatOpen: true });
  feed.drain(ms(T + 3));
  assert.deepEqual(ticks.map((t) => [t.at, t.chatOpen]), [[ms(T + 1), true], [ms(T + 2), true]]);
});

test("drain hands back the detector's candidates, oldest first", () => {
  const detector = createMomentDetector({ windowSec: 300, sensitivity: 70 });
  const feed = createTickFeed({ detector, nowMs: ms(T), chatOpen: true });
  const candidates = [];
  for (let s = 1; s <= 400; s++) {
    const n = s >= 300 && s < 308 ? 40 : 3;
    for (let k = 0; k < n; k++) feed.chat(ms(T + s) + k, s >= 300 && s < 308 ? "NO WAY" : `m${s}-${k}`);
    feed.loudness(ms(T + s) + 500, -25);
    candidates.push(...feed.drain(ms(T + s + 1) + 100));
  }
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].signal, "chat");
  assert.ok(candidates[0].peakAt >= ms(T + 300) && candidates[0].peakAt < ms(T + 308));
  assert.match(candidates[0].title, /NO WAY/);
});
