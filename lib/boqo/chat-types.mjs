// ported from boqo-ai/boqo apps/watcher/src/chat/types.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// (port: the three type declarations and the StreamChannel import are kept as `//` copies or cut; Reconnector's
// parameter property `private readonly backoffMs` is spelled out, which strip-only mode cannot erase.)

// export type ChatMessage = { at: number; text: string; author: string | null };
// export type ChatState = "connecting" | "open" | "unavailable";

/**
 * One interface for both platforms (C1 design §4.4). A source reconnects on
 * its own with backoff and NEVER throws into the session: a chat that cannot
 * be reached leaves the detector with the audio signal alone and reports
 * `unavailable`, which the session writes to `stream_watches.chat_state`.
 */
// export type ChatSource = {
//   onMessage(cb: (message: ChatMessage) => void): void;
//   onState(cb: (state: ChatState) => void): void;
//   state(): ChatState;
//   close(): void;
// };

export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/** Consecutive failures before a source reports unavailable (it keeps retrying). */
export const UNAVAILABLE_AFTER = 5;

/** The reconnect bookkeeping both sources share. */
export class Reconnector {
  failures = 0;
  current = "connecting";
  stateListeners = [];
  timer = null;
  closedFlag = false;

  constructor(backoffMs) {
    this.backoffMs = backoffMs; // (port: boqo's `private readonly backoffMs` parameter property)
  }

  state() {
    return this.current;
  }

  onState(cb) {
    this.stateListeners.push(cb);
  }

  set(state) {
    if (this.current === state) return;
    this.current = state;
    for (const cb of this.stateListeners) cb(state);
  }

  opened() {
    this.failures = 0;
    this.set("open");
  }

  /** Schedules `reconnect` after the backoff for this failure; flips to unavailable past the threshold. */
  failed(reconnect) {
    if (this.closedFlag) return;
    this.failures += 1;
    this.set(this.failures >= UNAVAILABLE_AFTER ? "unavailable" : "connecting");
    const delay = this.backoffMs[Math.min(this.failures - 1, this.backoffMs.length - 1)] ?? 30000;
    // Not currently reachable (nothing calls `failed()` twice without an
    // intervening `close()` or `opened()`), but an uncleared prior timer
    // would survive `close()` and stack a second socket if that ever
    // changed -- cheap to remove the class of bug now.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(reconnect, delay);
  }

  close() {
    this.closedFlag = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
