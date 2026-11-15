import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIrc, handshake, randomNick, connectChat } from "../lib/twitch-chat.mjs";

const TAGGED =
  "@badge-info=;badges=;color=#1E90FF;display-name=Some_Viewer;emotes=25:0-4,6-10/1902:12-16;" +
  "id=abc;mod=0;room-id=1;tmi-sent-ts=1;user-id=2 :some_viewer!some_viewer@some_viewer.tmi.twitch.tv " +
  "PRIVMSG #zackrawrr :Kappa Kappa Keepo hello";
const PLAIN = ":nick!nick@nick.tmi.twitch.tv PRIVMSG #xqc :hello there: world";

test("parseIrc: tagged PRIVMSG uses display-name and counts emote ranges", () => {
  assert.deepEqual(parseIrc(TAGGED), { kind: "msg", user: "Some_Viewer", text: "Kappa Kappa Keepo hello", emotes: 3 });
});

test("parseIrc: untagged PRIVMSG uses the prefix nick, emotes 0", () => {
  assert.deepEqual(parseIrc(PLAIN), { kind: "msg", user: "nick", text: "hello there: world", emotes: 0 });
});

test("parseIrc: missing display-name falls back to the prefix nick; empty emotes tag is 0", () => {
  const line = "@display-name=;emotes= :bob!bob@bob.tmi.twitch.tv PRIVMSG #c :yo";
  assert.deepEqual(parseIrc(line), { kind: "msg", user: "bob", text: "yo", emotes: 0 });
});

test("parseIrc: tag values are unescaped", () => {
  const line = "@display-name=A\\sB :ab!ab@ab.tmi.twitch.tv PRIVMSG #c :x";
  assert.equal(parseIrc(line).user, "A B");
});

test("parseIrc: PING carries its argument", () => {
  assert.deepEqual(parseIrc("PING :tmi.twitch.tv"), { kind: "ping", arg: "tmi.twitch.tv" });
});

test("parseIrc: everything else is other", () => {
  assert.deepEqual(parseIrc(":tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!"), { kind: "other" });
  assert.deepEqual(parseIrc(":x!x@x.tmi.twitch.tv JOIN #c"), { kind: "other" });
  assert.deepEqual(parseIrc(""), { kind: "other" });
});

test("handshake: exact lines, channel lowercased", () => {
  assert.deepEqual(handshake("ZackRawrr", "justinfan12345"), [
    "CAP REQ :twitch.tv/tags",
    "PASS SCHMOOPIIE",
    "NICK justinfan12345",
    "JOIN #zackrawrr",
  ]);
});

test("randomNick: justinfan plus 5 digits, from the injected random", () => {
  assert.equal(randomNick(() => 0), "justinfan00000");
  assert.equal(randomNick(() => 0.99999), "justinfan99999");
  assert.match(randomNick(), /^justinfan\d{5}$/);
});

// --- fake socket and timers ---

function makeFakes() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.l = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
    }
    addEventListener(type, fn) { this.l[type].push(fn); }
    send(s) { this.sent.push(s); }
    close() { this.closed = true; }
    open() { this.l.open.forEach((f) => f({})); }
    recv(data) { this.l.message.forEach((f) => f({ data })); }
    drop() { this.l.error.forEach((f) => f({})); this.l.close.forEach((f) => f({})); }
  }
  const timers = [];
  let clock = 0;
  const opts = {
    WebSocketImpl: FakeWS,
    random: () => 0.5,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  };
  const fire = () => { const t = timers.find((x) => x.live); assert.ok(t, "a timer is pending"); t.live = false; t.fn(); return t.ms; };
  return { sockets, timers, opts, fire, advance: (ms) => { clock += ms; } };
}

test("connectChat: dials the endpoint, sends the handshake in order on open", () => {
  const f = makeFakes();
  connectChat("ZackRawrr", () => {}, f.opts);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, "wss://irc-ws.chat.twitch.tv:443");
  assert.deepEqual(f.sockets[0].sent, []);
  f.sockets[0].open();
  assert.deepEqual(f.sockets[0].sent, [
    "CAP REQ :twitch.tv/tags",
    "PASS SCHMOOPIIE",
    "NICK justinfan50000",
    "JOIN #zackrawrr",
  ]);
});

test("connectChat: one frame with several lines delivers each message and answers PING", () => {
  const f = makeFakes();
  const got = [];
  connectChat("c", (m) => got.push(m), f.opts);
  const ws = f.sockets[0];
  ws.open();
  ws.sent.length = 0;
  ws.recv(`${TAGGED}\r\nPING :tmi.twitch.tv\r\n${PLAIN}\r\n`);
  assert.deepEqual(got.map((m) => m.user), ["Some_Viewer", "nick"]);
  assert.deepEqual(ws.sent, ["PONG :tmi.twitch.tv"]);
});

test("connectChat: reconnects with 1, 2, 5, 10, 30, 30 s backoff", () => {
  const f = makeFakes();
  connectChat("c", () => {}, f.opts);
  const delays = [];
  for (let i = 0; i < 6; i++) {
    f.sockets.at(-1).drop(); // error + close: still one reconnect
    delays.push(f.fire());
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000, 30000]);
  assert.equal(f.sockets.length, 7);
});

test("connectChat: a reconnect re-sends the handshake", () => {
  const f = makeFakes();
  connectChat("c", () => {}, f.opts);
  f.sockets[0].open();
  f.sockets[0].drop();
  f.fire();
  f.sockets[1].open();
  assert.equal(f.sockets[1].sent.length, 4);
  assert.equal(f.sockets[1].sent[3], "JOIN #c");
});

test("connectChat: backoff resets after a connection that lived 60 s", () => {
  const f = makeFakes();
  connectChat("c", () => {}, f.opts);
  f.sockets[0].drop(); f.fire(); // 1 s
  f.sockets[1].drop(); f.fire(); // 2 s
  f.sockets[2].open();
  f.advance(60000);
  f.sockets[2].drop();
  assert.equal(f.fire(), 1000);
  f.sockets[3].open();
  f.advance(59999); // short life: no reset
  f.sockets[3].drop();
  assert.equal(f.fire(), 2000);
});

test("connectChat: close() stops reconnecting, cancels a pending timer, closes the socket", () => {
  const f = makeFakes();
  const chat = connectChat("c", () => {}, f.opts);
  f.sockets[0].drop();
  assert.equal(f.timers.filter((t) => t.live).length, 1);
  chat.close();
  assert.equal(f.timers.filter((t) => t.live).length, 0);
  assert.equal(f.sockets.length, 1);

  const g = makeFakes();
  const chat2 = connectChat("c", () => {}, g.opts);
  g.sockets[0].open();
  chat2.close();
  assert.equal(g.sockets[0].closed, true);
  g.sockets[0].drop(); // the close event after close(): no reconnect
  assert.equal(g.timers.filter((t) => t.live).length, 0);
  assert.equal(g.sockets.length, 1);
});

test("connectChat: a constructor that throws is retried with backoff", () => {
  const f = makeFakes();
  let n = 0;
  const Flaky = class extends f.opts.WebSocketImpl { constructor(u) { if (n++ === 0) throw new Error("boom"); super(u); } };
  connectChat("c", () => {}, { ...f.opts, WebSocketImpl: Flaky });
  assert.equal(f.fire(), 1000);
  assert.equal(f.sockets.length, 1);
});
