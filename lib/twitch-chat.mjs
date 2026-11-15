// Anonymous Twitch chat (after boqo's hosted watcher).
//
// Read-only IRC over WebSocket: no token, no account. `parseIrc` turns one IRC
// line into a message, a ping or nothing; `connectChat` keeps a socket open
// and reconnects with backoff. The watcher counts what comes out.

export const ENDPOINT = "wss://irc-ws.chat.twitch.tv:443";
/** Seconds between reconnect attempts; the last step repeats. */
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** A connection that lived this long starts the backoff over. */
export const STABLE_MS = 60000;
/** Silence this long (Twitch PINGs about every 5 min) means the link is dead. */
export const IDLE_MS = 8 * 60 * 1000;

const TAG_ESCAPES = { ":": ";", s: " ", r: "\r", n: "\n", "\\": "\\" };

function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const value = part.slice(eq + 1).replace(/\\(.)/g, (_, c) => TAG_ESCAPES[c] ?? c);
    tags[part.slice(0, eq)] = value;
  }
  return tags;
}

/** Every position range in an `emotes` tag: `25:0-4,6-10/1902:12-16` is 3. */
function countEmotes(tag) {
  if (!tag) return 0;
  let n = 0;
  for (const group of tag.split("/")) {
    const colon = group.indexOf(":");
    if (colon < 0) continue;
    n += group.slice(colon + 1).split(",").filter(Boolean).length;
  }
  return n;
}

/** One IRC line in; a chat message, a ping, or `other` out. */
export function parseIrc(line) {
  let rest = String(line).replace(/[\r\n]+$/, "");
  let tags = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return { kind: "other" };
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1).trimStart();
  }
  const ping = /^PING\s+:?(.*)$/.exec(rest);
  if (ping) return { kind: "ping", arg: ping[1] };
  const m = /^:([^!@\s]+)(?:![^@\s]*)?(?:@\S*)?\s+PRIVMSG\s+#\S+\s+:(.*)$/.exec(rest);
  if (!m) return { kind: "other" };
  return { kind: "msg", user: tags["display-name"] || m[1], text: m[2], emotes: countEmotes(tags.emotes) };
}

/** The lines to send after the socket opens, in order. */
export function handshake(channel, nick) {
  const name = String(channel).replace(/^#/, "").toLowerCase();
  return ["CAP REQ :twitch.tv/tags", "PASS SCHMOOPIIE", `NICK ${nick}`, `JOIN #${name}`];
}

/** `justinfan` + 5 digits: the nick Twitch accepts for anonymous read-only chat. */
export function randomNick(random = Math.random) {
  return `justinfan${String(Math.floor(random() * 100000)).padStart(5, "0")}`;
}

/**
 * Connect, join, and call `onMsg({ user, text, emotes })` for every chat
 * message. Answers PING, reconnects when the socket drops. `close()` stops it.
 * Options: idleMs; for tests WebSocketImpl, random, now, setTimer, clearTimer.
 */
export function connectChat(channel, onMsg, o = {}) {
  const WS = o.WebSocketImpl ?? globalThis.WebSocket;
  const random = o.random ?? Math.random;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t));
  const idleMs = o.idleMs ?? IDLE_MS;
  let closed = false;
  let attempt = 0;
  let ws = null;
  let timer = null;
  let stopCurrentIdle = () => {};

  function connect() {
    timer = null;
    if (closed) return;
    let openedAt = null;
    let settled = false;
    let idle = null;
    const stopIdle = () => {
      if (idle !== null) clearTimer(idle);
      idle = null;
    };
    // No frame for idleMs: the link died without a FIN, or the dial hung.
    const armIdle = () => {
      stopIdle();
      idle = setTimer(() => {
        idle = null;
        try { sock.close(); } catch {}
        lost();
      }, idleMs);
    };
    const lost = () => {
      if (settled) return;
      settled = true;
      stopIdle();
      if (ws === sock) ws = null;
      if (closed) return;
      if (openedAt !== null && now() - openedAt >= STABLE_MS) attempt = 0;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt++;
      timer = setTimer(connect, delay);
    };
    let sock;
    try {
      sock = new WS(ENDPOINT);
    } catch {
      sock = null;
      lost();
      return;
    }
    ws = sock;
    stopCurrentIdle = stopIdle;
    armIdle();
    sock.addEventListener("open", () => {
      openedAt = now();
      for (const line of handshake(channel, randomNick(random))) sock.send(line);
    });
    sock.addEventListener("message", (ev) => {
      if (settled || closed) return;
      armIdle();
      for (const line of String(ev.data).split("\r\n")) {
        if (!line) continue;
        const ev2 = parseIrc(line);
        if (ev2.kind === "ping") {
          try { sock.send(`PONG :${ev2.arg}`); } catch {}
        } else if (ev2.kind === "msg") onMsg({ user: ev2.user, text: ev2.text, emotes: ev2.emotes });
      }
    });
    sock.addEventListener("error", lost);
    sock.addEventListener("close", lost);
  }

  connect();

  return {
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      stopCurrentIdle();
      try { ws?.close(); } catch {}
    },
  };
}
