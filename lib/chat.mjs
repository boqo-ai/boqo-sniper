// The chat client for the channel's platform, with one interface (hosted's ChatSource, apps/watcher/src/chat/):
//   startChat({ platform, slug, onMessage, onOpenChange, fetch, WebSocket })
// `onMessage({ user, text, emotes })` for each chat line; `onOpenChange(open)` when the chat's open flag flips, which
// is what the tick feed turns into `chatOpen` (lib/ticks.mjs). Open means the platform confirmed the join (Twitch's
// JOIN echo or 366, Kick's pusher_internal:subscription_succeeded), not that a socket exists; a drop is
// `onOpenChange(false)` at once, and the client reconnects by itself and says `true` again when it rejoins.
// Resolves to `{ close(), state(), isOpen() }`. Kick rejects with KickRefused(status) when the channel API does not
// answer 200: the watch cannot know the chatroom, and says so instead of running on audio alone without a word.
// `fetch` and `WebSocket` are injected (default: Node's globals), so tests never touch the network.

import { connectChat } from "./twitch-chat.mjs";
import { createKickChat, kickChannelUrl } from "./boqo/kick-chat.mjs";

/**
 * The user agent boqo's watcher sends to Kick (apps/watcher/src/http.ts BROWSER_UA @ bcc9d99cc): its Kick probe of
 * 2026-09-07 used a plain Chrome string, and the channel API answered 200 with it from a residential IP.
 */
export const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** The channel API (kick.com/api/v2/channels/<slug>) answered something other than 200: `status` is what it said. */
export class KickRefused extends Error {
  constructor(status) {
    super(`kick refused: ${status}`);
    this.name = "KickRefused";
    this.status = status;
  }
}

async function lookup(fetch, slug) {
  const res = await fetch(kickChannelUrl(slug), { headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
  if (res.status !== 200) throw new KickRefused(res.status);
  return res.json();
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

  // The first lookup is made here so a refusal stops the start with its status. Any other failure (the network, a
  // page that is not JSON) is what hosted retries with backoff, so it is left to createKickChat's own lookup.
  let preloaded = null;
  try {
    preloaded = { json: await lookup(fetch, name) };
  } catch (err) {
    if (err instanceof KickRefused) throw err;
  }
  const chat = createKickChat(name, {
    fetchJson: async () => {
      if (preloaded) {
        const { json } = preloaded;
        preloaded = null;
        return json;
      }
      return lookup(fetch, name);
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
