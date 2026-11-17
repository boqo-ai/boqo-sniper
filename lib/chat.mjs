// The chat client for the channel's platform, with one interface (hosted's ChatSource, apps/watcher/src/chat/):
//   startChat({ platform, slug, onMessage, onOpenChange, fetch, WebSocket })
// `onMessage({ user, text, emotes })` for each chat line; `onOpenChange(open)` when the chat's open flag flips, which
// is what the tick feed turns into `chatOpen` (lib/ticks.mjs). Open means the platform confirmed the join (Twitch's
// JOIN echo or 366, Kick's pusher_internal:subscription_succeeded), not that a socket exists; a drop is
// `onOpenChange(false)` at once, and the client reconnects by itself and says `true` again when it rejoins.
// Resolves to `{ close(), state(), isOpen() }`. Kick's first channel lookup is tried up to 3 times when the answer is
// a temporary one (429, a 5xx, a network error, no answer in 15 s), 2 s then 5 s apart. Kick rejects with
// KickRefused(status) when the channel API refuses (any other status but 200, at once; a 429 or 5xx on every try), or
// KickLookupTimeout when no try answered in time: the watch cannot know the chatroom, and says so instead of running
// on audio alone without a word (or waiting for ever). A network error on every try is left to the chat client, which
// keeps trying as hosted's does.
// `fetch` and `WebSocket` are injected (default: Node's globals), so tests never touch the network.

import { connectChat } from "./twitch-chat.mjs";
import { createKickChat, kickChannelUrl } from "./boqo/kick-chat.mjs";

/**
 * The user agent boqo's watcher sends to Kick (apps/watcher/src/http.ts BROWSER_UA @ bcc9d99cc): its Kick probe of
 * 2026-09-07 used a plain Chrome string, and the channel API answered 200 with it from a residential IP.
 */
export const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/**
 * The channel API (kick.com/api/v2/channels/<slug>) answered something other than 200: `status` is what it said, after
 * `tries` tries. A 403 says what it means for the person: kick.com answers through Cloudflare (a plain request from this
 * box's network was answered 403, the ledger's Task B3 probe, 2026-11-16) and refuses some networks.
 */
export class KickRefused extends Error {
  constructor(status, tries = 1) {
    const why =
      status === 403
        ? " (kick.com, behind Cloudflare, turned this network away; Kick support is experimental)"
        : tries > 1
          ? ` (${tries} tries)`
          : "";
    super(`kick refused: ${status}${why}`);
    this.name = "KickRefused";
    this.status = status;
  }
}

/**
 * How long the channel lookup (the request and its body) may take: hosted's `fetchJson` default, 15 s
 * (apps/watcher/src/http.ts `options.timeoutMs ?? 15_000` @ bcc9d99cc). A Cloudflare tarpit answers nothing.
 */
export const KICK_LOOKUP_TIMEOUT_MS = 15_000;

/** The channel API did not answer within the timeout, on any try: no chatroom to join, said once, and the watch stops. */
export class KickLookupTimeout extends Error {
  constructor(tries = 1) {
    super(`kick lookup timed out${tries > 1 ? ` (${tries} tries)` : ""}`);
    this.name = "KickLookupTimeout";
  }
}

/**
 * The waits between the start's tries of the channel lookup, when an answer was a temporary one: a 429 (too many
 * requests), a 5xx, a network error or no answer in time. Three tries, about 7 s of waiting; with the 15 s timeout on
 * each, at most about 52 s.
 */
export const KICK_START_BACKOFF_MS = [2000, 5000];

/** An answer worth another try: too many requests, a server error. Any other status but 200 is a refusal. */
const temporary = (status) => status === 429 || (status >= 500 && status <= 599);

/** The start's lookup: tried again after each wait in `backoffMs` while the answer is temporary. */
async function startLookup(fetch, slug, timeoutMs, backoffMs) {
  const tries = backoffMs.length + 1;
  for (let i = 0; ; i++) {
    try {
      return { json: await lookup(fetch, slug, timeoutMs) };
    } catch (err) {
      const last = i + 1 >= tries;
      if (err instanceof KickRefused) {
        if (!temporary(err.status)) throw err;
        if (last) throw new KickRefused(err.status, tries);
      } else if (err instanceof KickLookupTimeout) {
        if (last) throw new KickLookupTimeout(tries);
      } else if (last) {
        return null; // the network: the chat client tries again by itself
      }
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs[i]));
  }
}

async function lookup(fetch, slug, timeoutMs) {
  const controller = new AbortController();
  let timer;
  // a ref'd timer and a race, not AbortSignal.timeout alone: a fetch that ignores its signal must not hang the start
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new KickLookupTimeout());
      controller.abort();
    }, timeoutMs);
  });
  const work = (async () => {
    const res = await fetch(kickChannelUrl(slug), {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status !== 200) throw new KickRefused(res.status);
    return res.json();
  })();
  work.catch(() => {}); // after a timeout the aborted request's own rejection is not heard
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startChat({
  platform,
  slug,
  onMessage,
  onOpenChange,
  fetch = globalThis.fetch,
  WebSocket = globalThis.WebSocket,
  // tests: shorten the reconnect steps and the idle probes
  backoffMs,
  idleTimeoutMs,
  pingGraceMs,
  log,
  lookupTimeoutMs = KICK_LOOKUP_TIMEOUT_MS,
  startBackoffMs = KICK_START_BACKOFF_MS,
}) {
  const name = String(slug).toLowerCase();
  let open = false;
  const setOpen = (next) => {
    if (next === open) return;
    open = next;
    onOpenChange(next);
  };

  if (platform === "twitch") {
    const chat = connectChat(name, onMessage, { WebSocketImpl: WebSocket, onState: (state) => setOpen(state === "open") });
    return { close: () => chat.close(), state: () => chat.state(), isOpen: () => open };
  }
  if (platform !== "kick") throw new Error(`no chat for platform ${JSON.stringify(platform)}`);

  // The first lookup is made here so a refusal or a timeout stops the start with its one-line cause, after the
  // tries a temporary answer gets. A network error on every try (or a page that is not JSON) is what hosted retries
  // with backoff for as long as it watches, so it is left to createKickChat's own lookup (which also times out, and
  // retries).
  let preloaded = await startLookup(fetch, name, lookupTimeoutMs, startBackoffMs);
  const chat = createKickChat(name, {
    fetchJson: async () => {
      if (preloaded) {
        const { json } = preloaded;
        preloaded = null;
        return json;
      }
      return lookup(fetch, name, lookupTimeoutMs);
    },
    openSocket: (url) => new WebSocket(url),
    clock: () => Date.now(),
    backoffMs,
    idleTimeoutMs,
    pingGraceMs,
    log,
  });
  chat.onMessage((m) => onMessage({ user: m.author ?? "", text: m.text, emotes: 0 }));
  chat.onState((state) => setOpen(state === "open"));
  return { close: () => chat.close(), state: () => chat.state(), isOpen: () => open };
}
