// Kick chat: the ported pure parts against goldens boqo's own TypeScript wrote at the pin, then the client
// (lib/chat.mjs startChat over lib/boqo/kick-chat.mjs) on a fake fetch and a fake WebSocket. No network.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KICK_PUSHER_URL,
  kickChannelUrl,
  parseKickChannel,
  parsePusherFrame,
  pingFrame,
  pongFrame,
  subscribeFrame,
} from "../lib/boqo/kick-chat.mjs";
import { KickLookupTimeout, KickRefused, startChat } from "../lib/chat.mjs";
import { expectGolden } from "./helpers/golden.mjs";

const input = (name) =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", `${name}.input.json`), "utf8"));

test("parse-kick-channel: the ported channel reader, URL and frames match boqo's", () => {
  const i = input("parse-kick-channel");
  expectGolden("parse-kick-channel", {
    pusherUrl: KICK_PUSHER_URL,
    urls: i.slugs.map((slug) => ({ slug, url: kickChannelUrl(slug) })),
    channels: i.channels.map((json) => ({ json, parsed: parseKickChannel(json) })),
    subscribe: i.chatroomIds.map((id) => ({ id, frame: subscribeFrame(id) })),
    ping: pingFrame(),
    pong: pongFrame(),
  });
});

test("parse-pusher-frame: the ported frame reader matches boqo's on messages, pings, subscriptions and junk", () => {
  expectGolden("parse-pusher-frame", input("parse-pusher-frame").frames.map((raw) => ({ raw, event: parsePusherFrame(raw) })));
});

// ---- the client on fakes ----

// a chat that is still open when a test fails would hold its idle timer, and the whole file, open: close them all
const started = [];
afterEach(() => {
  for (const chat of started.splice(0)) chat.close();
});
const start = async (options) => {
  const chat = await startChat(options);
  started.push(chat);
  return chat;
};

const CHANNEL = { chatroom: { id: 668 }, livestream: { viewer_count: 12400 } };

function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(calls.length);
  };
  return { fetch, calls };
}
const ok = (json) => ({ status: 200, ok: true, json: async () => json });
const refused = (status) => ({ status, ok: false, json: async () => ({}) });

function fakeSockets() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.l = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
    }
    addEventListener(type, fn) { this.l[type].push(fn); }
    send(s) { this.sent.push(s); }
    close() { this.closed = true; }
    open() { this.l.open.forEach((f) => f({})); }
    recv(obj) { this.l.message.forEach((f) => f({ data: typeof obj === "string" ? obj : JSON.stringify(obj) })); }
    drop() { this.l.error.forEach((f) => f({})); this.l.close.forEach((f) => f({})); }
  }
  return { sockets, FakeWS };
}
const SUBSCRIBED = { event: "pusher_internal:subscription_succeeded", data: "{}", channel: "chatrooms.668.v2" };
const MESSAGE = (content) => ({ event: "App\\Events\\ChatMessageEvent", data: JSON.stringify({ content, sender: { username: "v" } }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 2000) => {
  for (let t = 0; t < ms; t += 5) {
    if (pred()) return;
    await wait(5);
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("a 403 from the channel API rejects startChat with KickRefused(403), and no socket is opened", async () => {
  const f = fakeFetch(() => refused(403));
  const s = fakeSockets();
  await assert.rejects(
    start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: s.FakeWS }),
    (err) => err instanceof KickRefused && err.status === 403 && /kick refused: 403/.test(err.message),
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://kick.com/api/v2/channels/xqc");
  assert.match(f.calls[0].init.headers["user-agent"] ?? f.calls[0].init.headers["User-Agent"], /^Mozilla\/5\.0/);
  assert.equal(s.sockets.length, 0);
});

test("a channel lookup that never answers rejects startChat with KickLookupTimeout: kick lookup timed out, no socket", async () => {
  const s = fakeSockets();
  let signal = null;
  // never resolves, and never looks at its signal: the timeout must not depend on fetch cooperating
  const fetch = (url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  };
  const t0 = Date.now();
  await assert.rejects(
    start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch, WebSocket: s.FakeWS, lookupTimeoutMs: 60, startBackoffMs: [] }),
    (err) => err instanceof KickLookupTimeout && err.message === "kick lookup timed out",
  );
  assert.ok(Date.now() - t0 >= 55 && Date.now() - t0 < 1500, `rejected after ${Date.now() - t0} ms`);
  assert.equal(signal.aborted, true, "the request is aborted too");
  assert.equal(s.sockets.length, 0);
});

test("a temporary answer at the start (429, a 5xx, a network error, a timeout) is tried again after a wait; then the chat opens", async () => {
  const answers = [
    () => refused(429),
    () => refused(503),
    () => {
      throw new TypeError("fetch failed");
    },
    () => ok(CHANNEL),
  ];
  const f = fakeFetch((n) => answers[n - 1]());
  const s = fakeSockets();
  const t0 = Date.now();
  await start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: s.FakeWS, startBackoffMs: [30, 30, 30] });
  assert.equal(f.calls.length, 4, "every temporary answer was tried again");
  assert.ok(Date.now() - t0 >= 85, `waited between tries: ${Date.now() - t0} ms`);
  await until(() => s.sockets.length === 1, "the socket");

  // a lookup that timed out once
  let n = 0;
  const slowOnce = (url, init) => (++n === 1 ? new Promise(() => {}) : Promise.resolve(ok(CHANNEL)));
  const s2 = fakeSockets();
  await start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: slowOnce, WebSocket: s2.FakeWS, lookupTimeoutMs: 40, startBackoffMs: [5] });
  assert.equal(n, 2);
  await until(() => s2.sockets.length === 1, "the socket after a timeout");
});

test("a 5xx or a timeout on every try ends the start with the last answer; the default waits are 2 s and 5 s", async () => {
  const { KICK_START_BACKOFF_MS } = await import("../lib/chat.mjs");
  assert.deepEqual(KICK_START_BACKOFF_MS, [2000, 5000], "three tries, about 7 s of waiting");
  const f = fakeFetch(() => refused(502));
  await assert.rejects(
    start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: fakeSockets().FakeWS, startBackoffMs: [5, 5] }),
    (err) => err instanceof KickRefused && err.status === 502 && err.message === "kick refused: 502 (3 tries)",
  );
  assert.equal(f.calls.length, 3);
  let calls = 0;
  const hang = () => {
    calls++;
    return new Promise(() => {});
  };
  await assert.rejects(
    start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: hang, WebSocket: fakeSockets().FakeWS, lookupTimeoutMs: 20, startBackoffMs: [5, 5] }),
    (err) => err instanceof KickLookupTimeout && err.message === "kick lookup timed out (3 tries)",
  );
  assert.equal(calls, 3);
});

test("a refusal (403, 404) is not tried again: the start ends at once, a 403 saying plainly that kick.com turned this network away", async () => {
  for (const status of [403, 404]) {
    const f = fakeFetch(() => refused(status));
    await assert.rejects(
      start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: fakeSockets().FakeWS, startBackoffMs: [5, 5] }),
      (err) => err instanceof KickRefused && err.status === status,
    );
    assert.equal(f.calls.length, 1, `${status}: one try`);
  }
  const f = fakeFetch(() => refused(403));
  const err = await start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: fakeSockets().FakeWS }).catch((e) => e);
  assert.equal(err.message, "kick refused: 403 (kick.com, behind Cloudflare, turned this network away; Kick support is experimental)");
});

test("the default lookup timeout is hosted's 15 s", async () => {
  const { KICK_LOOKUP_TIMEOUT_MS } = await import("../lib/chat.mjs");
  assert.equal(KICK_LOOKUP_TIMEOUT_MS, 15000);
});

test("the chat opens on the subscription's confirmation, counts messages, and answers a ping", async () => {
  const f = fakeFetch(() => ok(CHANNEL));
  const s = fakeSockets();
  const opens = [];
  const got = [];
  const chat = await start({
    platform: "kick", slug: "XQC", onMessage: (m) => got.push(m), onOpenChange: (o) => opens.push(o), fetch: f.fetch, WebSocket: s.FakeWS,
  });
  assert.equal(f.calls[0].url, "https://kick.com/api/v2/channels/xqc", "the slug is lowercased");
  assert.equal(s.sockets.length, 1);
  assert.equal(s.sockets[0].url, KICK_PUSHER_URL);
  s.sockets[0].open();
  assert.deepEqual(s.sockets[0].sent, [subscribeFrame(668)]);
  assert.deepEqual(opens, [], "dialling and subscribing is not open yet");
  s.sockets[0].recv(SUBSCRIBED);
  assert.deepEqual(opens, [true]);
  assert.equal(chat.state(), "open");
  s.sockets[0].recv(MESSAGE("NO WAY"));
  s.sockets[0].recv({ event: "pusher:ping", data: {} });
  assert.deepEqual(got.map((m) => [m.user, m.text, m.emotes]), [["v", "NO WAY", 0]]);
  assert.equal(s.sockets[0].sent.at(-1), pongFrame());
  chat.close();
});

test("a socket that closes mid-session: onOpenChange(false), a reconnect after the backoff, onOpenChange(true) on resubscribe", async () => {
  const f = fakeFetch(() => ok(CHANNEL));
  const s = fakeSockets();
  const opens = [];
  const chat = await start({
    platform: "kick", slug: "xqc", onMessage() {}, onOpenChange: (o) => opens.push(o), fetch: f.fetch, WebSocket: s.FakeWS, backoffMs: [40],
  });
  s.sockets[0].open();
  s.sockets[0].recv(SUBSCRIBED);
  assert.deepEqual(opens, [true]);

  const droppedAt = Date.now();
  s.sockets[0].drop(); // error then close: still one drop
  assert.deepEqual(opens, [true, false]);
  assert.equal(chat.state(), "connecting");
  assert.equal(s.sockets.length, 1, "not before the backoff");
  await until(() => s.sockets.length === 2, "the reconnect");
  assert.ok(Date.now() - droppedAt >= 35, `reconnected after ${Date.now() - droppedAt} ms, the backoff is 40`);
  assert.equal(f.calls.length, 1, "the chatroom id is kept: no second lookup");
  s.sockets[1].open();
  assert.deepEqual(s.sockets[1].sent, [subscribeFrame(668)], "resubscribes to the same room");
  assert.deepEqual(opens, [true, false], "still closed until the subscription is confirmed");
  s.sockets[1].recv(SUBSCRIBED);
  assert.deepEqual(opens, [true, false, true]);
  chat.close();
  assert.equal(s.sockets[1].closed, true);
});

test("a silent link is probed with a ping, then dropped and reported not open", async () => {
  const f = fakeFetch(() => ok(CHANNEL));
  const s = fakeSockets();
  const opens = [];
  const chat = await start({
    platform: "kick", slug: "xqc", onMessage() {}, onOpenChange: (o) => opens.push(o), fetch: f.fetch, WebSocket: s.FakeWS,
    backoffMs: [1000], idleTimeoutMs: 20, pingGraceMs: 20,
  });
  s.sockets[0].open();
  s.sockets[0].recv(SUBSCRIBED);
  await until(() => s.sockets[0].sent.includes(pingFrame()), "the idle ping");
  await until(() => opens.at(-1) === false, "the link declared dead");
  assert.deepEqual(opens, [true, false]);
  chat.close();
});

test("a network error on the first lookup is not a refusal: startChat resolves and the lookup is tried again", async () => {
  const f = fakeFetch((n) => {
    if (n === 1) throw new Error("ECONNRESET");
    return ok(CHANNEL);
  });
  const s = fakeSockets();
  const chat = await start({
    platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: s.FakeWS, backoffMs: [5], startBackoffMs: [5],
  });
  await until(() => s.sockets.length === 1, "the socket after the second lookup");
  assert.equal(f.calls.length, 2);
  chat.close();
});

test("a network error on every try at the start is not a refusal either: the start goes on and the chat client keeps trying, as hosted's does", async () => {
  const f = fakeFetch((n) => {
    if (n <= 4) throw new TypeError("fetch failed");
    return ok(CHANNEL);
  });
  const s = fakeSockets();
  await start({ platform: "kick", slug: "xqc", onMessage() {}, onOpenChange() {}, fetch: f.fetch, WebSocket: s.FakeWS, backoffMs: [5], startBackoffMs: [5, 5] });
  assert.ok(f.calls.length >= 3, `the start's three tries, then the chat client's own: ${f.calls.length}`);
  await until(() => s.sockets.length === 1, "the socket once the network is back");
  assert.equal(f.calls.length, 5);
});

test("Twitch: the same onOpenChange, true on the join's confirmation and false on a drop", async () => {
  const s = fakeSockets();
  const opens = [];
  const got = [];
  const chat = await start({
    platform: "twitch", slug: "xqc", onMessage: (m) => got.push(m), onOpenChange: (o) => opens.push(o), fetch: async () => assert.fail("no fetch for Twitch"), WebSocket: s.FakeWS,
  });
  assert.equal(s.sockets[0].url, "wss://irc-ws.chat.twitch.tv:443");
  s.sockets[0].open();
  assert.deepEqual(opens, []);
  s.sockets[0].recv(":j!j@j.tmi.twitch.tv JOIN #xqc\r\n");
  assert.deepEqual(opens, [true]);
  s.sockets[0].recv(":a!a@a.tmi.twitch.tv PRIVMSG #xqc :hello\r\n");
  assert.deepEqual(got.map((m) => m.text), ["hello"]);
  s.sockets[0].drop();
  assert.deepEqual(opens, [true, false]);
  chat.close();
});
