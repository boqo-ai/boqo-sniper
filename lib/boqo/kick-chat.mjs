// ported from boqo-ai/boqo apps/watcher/src/chat/kick.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// (port: boqo's `import { log } from "../logger"` is cut: `log` is the optional `deps.log` below, a no-op when absent.)
import { DEFAULT_BACKOFF_MS, Reconnector } from "./chat-types.mjs";

/**
 * Kick chat over the site's Pusher feed (C1 design §4.4). The channel
 * object at kick.com/api/v2/channels/<slug> carries `chatroom.id` and
 * `livestream` (null offline, `viewer_count` live) -- measured 2026-09-07
 * with a browser user agent from a residential IP; the connection and the
 * `chatrooms.<id>.v2` subscription were measured too (spec §1.5).
 *
 * The message event's name and its `data.content` field were flagged by
 * that spec as NOT observed, because every channel it probed was offline,
 * and the wording came from community documentation rather than a live
 * capture. This session re-probed it directly on 2026-09-08 against a
 * currently-live channel (`kick.com/api/v2/channels/xqc`, chatroom 668,
 * ~12.4k viewers): the site endpoint answered exactly the
 * `{chatroom:{id}, livestream:{viewer_count}}` shape `parseKickChannel`
 * reads, the WSS connection to `KICK_PUSHER_URL` opened and the
 * `chatrooms.668.v2` subscription came back
 * `pusher_internal:subscription_succeeded`, and three real chat frames
 * arrived with `event: "App\\Events\\ChatMessageEvent"` and a `data` field
 * that was itself a JSON-encoded STRING (not an object) whose decoded body
 * carried `content` -- e.g. `content: "WOAH gta 5 pog"` -- confirming both
 * the event name and the field `parsePusherFrame` reads, and confirming
 * `data` arrives as the string case its string-or-object handling exists
 * for. `pusher:ping`/`pusher:pong` were NOT observed live in that same
 * session (the connection's own `activity_timeout` was 120s, longer than
 * the probe window) and are implemented from the Pusher protocol's
 * documented ping/pong shape, not from a live capture -- unlike the three
 * chat frames above, that half is still an inherited, not a measured,
 * claim.
 *
 * Kick's endpoints are undocumented and behind Cloudflare; a break lands
 * here, in one file, behind ChatSource, and degrades the watch to audio
 * alone rather than failing it (design §8, risk 2).
 */
export const KICK_PUSHER_URL =
  "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";

export function kickChannelUrl(slug        )         {
  return `https://kick.com/api/v2/channels/${slug}`;
}

export function parseKickChannel(json         )                                                                           {
  if (json === null || typeof json !== "object") return null;
  const record = json                           ;
  const chatroom = record.chatroom                                       ;
  const id = chatroom?.id;
  if (typeof id !== "number") return null;
  const livestream = record.livestream                                              ;
  const viewers = livestream?.viewer_count;
  return { chatroomId: id, live: livestream != null, viewerCount: typeof viewers === "number" ? viewers : null };
}

export function subscribeFrame(chatroomId        )         {
  return JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${chatroomId}.v2` } });
}

export function pongFrame()         {
  return JSON.stringify({ event: "pusher:pong", data: {} });
}

/**
 * The client-initiated ping this module now sends on its own idle deadline
 * (I2, round 2 of the task-14 review): rather than assuming Kick's server
 * will proactively ping an idle client -- this file's own header comment
 * above already records that server-initiated ping/pong was NOT observed
 * live in this session -- this module asks itself, on the same documented
 * Pusher ping/pong shape `pongFrame` above already relies on. Intent, not a
 * fresh measurement: Kick's own reply latency to a client-sent ping has not
 * been observed either.
 */
export function pingFrame()         {
  return JSON.stringify({ event: "pusher:ping", data: {} });
}

                         
                                                            
                    
                          
                      

export function parsePusherFrame(raw        )              {
  let frame                         ;
  try {
    const parsed          = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { kind: "other" };
    frame = parsed                           ;
  } catch {
    return { kind: "other" };
  }
  if (frame.event === "pusher:ping") return { kind: "ping" };
  if (frame.event === "pusher_internal:subscription_succeeded") return { kind: "subscribed" };
  if (frame.event === "App\\Events\\ChatMessageEvent") {
    let data          = frame.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return { kind: "other" };
      }
    }
    const record = data                                  ;
    const content = record?.content;
    const sender = record?.sender                                       ;
    const author = typeof sender?.username === "string" ? sender.username : null;
    // sender.username is not in the recording this module was verified against
    // (see the header); the gate checks a real frame, and a missing field
    // falls back to author null (C2 judge spec §6.1).
    return typeof content === "string" ? { kind: "message", text: content, author } : { kind: "other" };
  }
  return { kind: "other" };
}

                             
                           
                
                                                                                                                
  
                                                        

/**
 * How long this module waits with NO inbound frame at all before probing
 * with its own ping (I2 in the task-14 review, round 2). Read from this
 * file's own header comment rather than measured fresh: the live
 * connection's `activity_timeout` was 120s (measured 2026-09-08, above).
 * Doubled so one skipped server-initiated ping/pong round-trip is tolerated
 * before this module starts asking itself.
 */
export const KICK_IDLE_TIMEOUT_MS = 2 * 120_000;

/**
 * How long this module waits for ANY inbound frame after sending its own
 * `pusher:ping` before declaring the link dead (I2, round 2 of the task-14
 * review). This is intent, not a measured claim -- Kick's own ping/pong
 * round-trip latency has not been measured in this session (kick.ts's own
 * header comment already records that server-initiated ping/pong was not
 * observed live at all). Generous for any real network round trip, and
 * still a small fraction of the multi-minute wait a dead TCP connection
 * would otherwise take to surface on its own.
 */
export const KICK_PING_GRACE_MS = 20_000;

export function createKickChat(
  channel        ,
  deps   
                                                 
                           
                        
                                  
                           
                         
   ,
)             {
  const reconnector = new Reconnector(deps.backoffMs ?? DEFAULT_BACKOFF_MS);
  const idleTimeoutMs = deps.idleTimeoutMs ?? KICK_IDLE_TIMEOUT_MS;
  const pingGraceMs = deps.pingGraceMs ?? KICK_PING_GRACE_MS;
  // (port: boqo imports `log` from ../logger; here it is the optional `deps.log(fields, message)`, a no-op when absent.)
  const log = deps.log ?? (() => {});
  const listeners                               = [];
  let socket                       = null;
  let chatroomId                = null;
  // I2 (round 2): close() must be able to clear the idle/ping-grace timers
  // DETERMINISTICALLY, without depending on any socket event ever arriving.
  // A graceful WebSocket close() on a link that died without a close frame
  // never fires "close" (measured directly against this repo's own Node
  // v22.20.0 global WebSocket, bundled undici: after close() on a peer that
  // completes the handshake and then never replies, readyState stayed 2
  // (CLOSING) and no "close" event fired within 5s), so routing teardown
  // through the close listener alone -- as the previous round's fix did --
  // leaks these timers past close(). Reassigned on every connect() attempt
  // to point at that attempt's own clearTimers, so close() always reaches
  // the CURRENT pair.
  let clearActivityTimers                      = null;
  // C2 judge spec §6.4: a Kick message with no `sender.username` becomes
  // author null, and the chat gate then counts that second's MESSAGES as its
  // chatters (chat-gate.ts, `chatters`). Said once per chat source, not once
  // per message, which on a busy channel would be one line per chat line.
  // channel-feed.ts's `startGeneration` builds one source per capture
  // generation of a channel (`deps.chat(feed.channel)`, read 2026-10-15), so
  // with shared captures that is once per channel per generation, not per
  // watch; this flag survives the source's own reconnects.
  let loggedMissingSender = false;

  async function connect()                {
    if (reconnector.closedFlag) return;
    let settled = false;
    let idleTimer                                       = null;
    let pingGraceTimer                                       = null;
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (pingGraceTimer) clearTimeout(pingGraceTimer);
      pingGraceTimer = null;
    };
    clearActivityTimers = clearTimers;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket = null;
      reconnector.failed(() => void connect());
    };
    if (chatroomId === null) {
      try {
        const parsed = parseKickChannel(await deps.fetchJson(kickChannelUrl(channel)));
        if (parsed === null) throw new Error("channel object had no chatroom id");
        chatroomId = parsed.chatroomId;
      } catch {
        fail();
        return;
      }
    }
    if (reconnector.closedFlag) return;
    let current               ;
    try {
      current = deps.openSocket(KICK_PUSHER_URL);
    } catch {
      fail();
      return;
    }
    socket = current;
    const id = chatroomId;
    // I2 (round 2): on a link that goes silent, a graceful current.close()
    // alone cannot detect death -- see clearActivityTimers's own comment
    // above for the measurement. So the idle deadline calls fail() DIRECTLY
    // once its own ping goes unanswered, rather than only asking politely
    // and hoping a close event eventually arrives; current.close() is still
    // called first, as the polite ask, in case the peer is alive.
    const declareDead = () => {
      current.close();
      fail();
    };
    const armPingGrace = () => {
      pingGraceTimer = setTimeout(declareDead, pingGraceMs);
    };
    const resetIdle = () => {
      clearTimers();
      idleTimer = setTimeout(() => {
        // No inbound frame for idleTimeoutMs: probe with this module's OWN
        // ping rather than assuming Kick's server will send one -- see
        // KICK_IDLE_TIMEOUT_MS's own comment. Without this, a quiet channel
        // would reconnect every idleTimeoutMs forever, and each successful
        // resubscribe calls opened(), which resets `failures` -- silently
        // reproducing I1's defect on Kick through a different door.
        //
        // Round 3 (Important): grace is armed BEFORE the send, and the send
        // itself is guarded against throwing. The idle timer above is armed
        // right after openSocket() returns, before "open" fires, so this
        // callback can run while the socket is still CONNECTING (readyState
        // 0) if the peer stalls the WebSocket upgrade after accepting the
        // TCP connection. send() on a CONNECTING socket throws a synchronous
        // DOMException ("Sent before connected.") -- measured directly
        // against this repo's own Node v22.20.0 global WebSocket on
        // 2026-09-08 -- and thrown from inside a setTimeout callback it is
        // uncaught (main.ts registers only SIGTERM/SIGINT), crashing the
        // whole watcher process and every concurrent watch with it. Arming
        // the grace first, and catching the throw, means a pre-open or
        // closing socket still gets declared dead on schedule instead of
        // taking the process down with it.
        armPingGrace();
        try {
          current.send(pingFrame());
        } catch {
          // Pre-open or closing: the grace timer above still declares the
          // link dead on schedule.
        }
      }, idleTimeoutMs);
    };
    current.addEventListener("open", () => current.send(subscribeFrame(id)));
    current.addEventListener("error", fail);
    current.addEventListener("close", fail);
    current.addEventListener("message", (event) => {
      // Round 3 (R3): declareDead()/fail() mark this attempt settled
      // without detaching this listener from its (now stale) socket. A
      // frame arriving afterwards would otherwise still run resetIdle()
      // and re-arm a timer pair clearActivityTimers no longer points at,
      // or -- worse -- a stale subscription_succeeded would call
      // reconnector.opened() while a newer attempt is still connecting.
      // Guard so a settled attempt's socket is inert once declared dead.
      if (settled) return;
      resetIdle();
      const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
      const parsed = parsePusherFrame(raw);
      if (parsed.kind === "subscribed") reconnector.opened();
      else if (parsed.kind === "ping") current.send(pongFrame());
      else if (parsed.kind === "message") {
        if (parsed.author === null && !loggedMissingSender) {
          loggedMissingSender = true;
          log(
            { platform: "kick", channel },
            "kick chat message carried no sender; chatters fall back to message count for this session",
          );
        }
        const message = { at: deps.clock(), text: parsed.text, author: parsed.author };
        for (const cb of listeners) cb(message);
      }
    });
    resetIdle();
  }

  void connect();

  return {
    onMessage: (cb) => listeners.push(cb),
    onState: (cb) => reconnector.onState(cb),
    state: () => reconnector.state(),
    close: () => {
      reconnector.close();
      clearActivityTimers?.();
      socket?.close();
    },
  };
}
