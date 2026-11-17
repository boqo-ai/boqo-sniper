// ported from boqo-ai/boqo packages/core/src/moments.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
/**
 * The moment detector (C1 design §4.6).
 *
 * One tick per wall-clock second in — how many chat messages landed, their
 * texts, and the second's loudest momentary loudness — and a candidate out
 * when a spike has peaked and fallen away. Pure and clock-free: the session
 * owns the sockets and the clock, this owns the judgement, and the fixtures
 * in moments.test.ts are what argue with the defaults below.
 *
 * Per signal, an exponentially-weighted mean and variance whose time
 * constant is the window; a z-score per tick against the baseline as it
 * stood BEFORE the tick (so a spike does not dilute its own measure); a
 * threshold set by sensitivity. Chat is smoothed over five seconds first,
 * because a single loud second is not a moment. Loudness spikes carry a
 * 0.8 weight: they are cheaper to produce than a chat spike.
 */

export const MOMENT_WARMUP_SEC = 60;
export const MOMENT_COOLDOWN_SEC = 45;
/** A chat spike below this absolute rate never scores: 0→1 in a dead chat is not a moment. */
export const MOMENT_MIN_CHAT_RATE = 2;
export const MOMENT_AUDIO_Z_WEIGHT = 0.8;
/** A rise that has not fallen back by now is emitted anyway. */
export const MOMENT_RISE_MAX_SEC = 20;
/** Emitted once the signal falls to this fraction of its peak. */
export const MOMENT_FALL_RATIO = 0.6;

const CHAT_SMOOTH_SEC = 5;
/** Sigma floors keep a flat baseline from turning a tiny bump into a huge z. */
const CHAT_SIGMA_FLOOR = 0.5; // messages per second
const LOUDNESS_SIGMA_FLOOR = 1.5; // LU
const TITLE_HALF_WINDOW_MS = 15_000;
const TEXT_RING_MS = 40_000;
const TITLE_MAX_CHARS = 40;

// export type MomentTick = {
//   /** Epoch milliseconds of the wall-clock second this tick describes. */
//   at: number;
//   chatCount: number;
//   chatTexts: readonly string[];
//   /** The second's maximum momentary loudness in LUFS, or null when unknown. */
//   loudness: number | null;
//   /**
//    * Whether the chat socket was open for this second. A second it was not
//    * (still connecting, reconnecting, unavailable) is not a quiet chat: it
//    * feeds nothing to the chat baseline, it clears the five-second smoothing
//    * window, and the chat signal cannot score until that window again holds
//    * five open seconds. Absent means open, which is how every tick was read
//    * before this field existed.
//    */
//   chatOpen?: boolean;
// };

// export type MomentDetail = {
//   chatPerSec: number;
//   chatBaseline: number;
//   loudness: number | null;
//   loudnessBaseline: number | null;
//   topMessage: string | null;
//   topCount: number;
//   /** Absent means messages, what every moment before the judge recorded; the candidate detector writes `chatters`. */
//   chatUnit?: "messages" | "chatters";
// };

// export type MomentCandidate = {
//   peakAt: number;
//   score: number;
//   signal: "chat" | "audio";
//   title: string;
//   detail: MomentDetail;
// };

// export type DetectorParams = {
//   windowSec: number;
//   sensitivity: number;
//   cooldownSec?: number;
//   warmupSec?: number;
// };

// export type MomentDetector = {
//   tick(t: MomentTick): MomentCandidate | null;
//   configure(p: Partial<Pick<DetectorParams, "windowSec" | "sensitivity">>): void;
//   /**
//    * The number the last tick judged: the larger of the chat z and 0.8 x the
//    * loudness z, which is what a rise is opened on and a moment is scored from.
//    * Null before the first tick and for a second neither signal could score
//    * (the chat window not full or under MOMENT_MIN_CHAT_RATE, and the loudness
//    * unknown). Read by the watcher for the stream view's activity chart; it
//    * does not depend on sensitivity, which only moves the line it is compared
//    * with.
//    */
//   signal(): number | null;
// };

/** Linear: 3.6 at sensitivity 30, 1.65 at 95, 2.4 at the default of 70. Clamped. */
export function thresholdFor(sensitivity        )         {
  const s = Math.min(95, Math.max(30, sensitivity));
  return 3.6 - ((s - 30) / 65) * (3.6 - 1.65);
}

/** 60 at the threshold, 100 at two and a half times it, clamped to 0-100. */
export function scoreFor(z        , threshold        )         {
  const raw = 60 + (40 * (z - threshold)) / (1.5 * threshold);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * The z at which a moment scores `score` under `threshold`: scoreFor's own
 * line solved for z, without its rounding or its clamp. So 60 is the threshold
 * itself and 100 two and a half times it. The stream view's activity chart
 * draws the Auto-clip line here, on the same axis as the Sensitivity line.
 */
export function sigmaForScore(score        , threshold        )         {
  return threshold * (1 + (1.5 * (score - 60)) / 40);
}

function normalise(text        )         {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The most repeated text (normalised), reported in its first spelling. Ties go to the first seen. */
export function topMessage(texts                   )                                         {
  const counts = new Map                                         ();
  for (const raw of texts) {
    const key = normalise(raw);
    if (key === "") continue;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { text: raw.trim(), count: 1 });
  }
  let best                                         = null;
  for (const entry of counts.values()) {
    if (best === null || entry.count > best.count) best = entry;
  }
  return best;
}

export function momentTitle(signal                             , detail              )         {
  if (signal === "manual") return "clipped by hand";
  if (signal === "audio") return "audio spike";
  if (detail.topMessage !== null && detail.topCount >= 3) {
    const text =
      detail.topMessage.length > TITLE_MAX_CHARS
        ? `${detail.topMessage.slice(0, TITLE_MAX_CHARS - 1)}…`
        : detail.topMessage;
    return `chat spike — "${text}" ×${detail.topCount}`;
  }
  return `chat spike — ${Math.round(detail.chatPerSec)}/s`;
}

/**
 * An exponentially-weighted mean and variance. `z` reads the baseline before
 * `update` moves it.
 *
 * Bias-corrected, the way Adam corrects its moments: both sums start at zero
 * beside a weight sum, and every read divides by it. After n updates at a
 * constant alpha the weight is `1 - (1 - alpha)^n`; once `setWindow` has
 * changed alpha it is no longer that, but it is still the total weight the
 * samples carry, so the reads stay a weighted average of them (checked
 * against explicit weights by the 2026-09-21 review, to 1.8e-14). So a young
 * baseline is the weighted average of what it has actually seen, and a warm
 * one (weight → 1) is the plain EWMA it always was.
 *
 * It used to start from its first sample with a zero variance and close the
 * gap at the window's own time constant. The detector is rebuilt at every
 * capture phase, and the warm-up (60 s) is a fifth of the default window
 * (300 s). By arithmetic, 1 - e^(-60/300) put the variance at ~18% of its
 * steady value when the gate opened, sigma ~2.3x low. Measured on Gaussian
 * noise it was somewhat less bad: at 60 s the old variance stood at a median
 * 25% and a mean 32% of the true one, sigma ~2.0x low at the median (20,000
 * seeded runs, 2026-09-21). Every z inflated with it.
 * Measured in production (2026-09-21, 315 moments over 36 phases): 63
 * moments/h in a detector's first minute after warm-up against 8/h in
 * phases older than 40 min, and 26 of ddg's 30 audio moments that day came
 * from a detector under 10 min old. On stationary noise the correction
 * takes the first-minute audio rate from 45/h to 4/h, against 3.5/h warm
 * (docs/superpowers/ledgers/2026-09-21-stream-sniper-noise-investigation.md).
 *
 * The price, kept on purpose: each early sample carries about 1/n of the
 * weight, so a transient in a young detector's first seconds is remembered
 * for minutes. Measured by the 2026-09-21 review on 200 seeded runs of
 * loudness N(-30, 3), and re-run for this comment: a real +12 LU event at
 * t=20-30 s leaves a later +9 LU probe detected 2% of the time at age 65 s
 * and 61% at 300 s (the old baseline: 70-86% at every age); a silent intro
 * (8 s at -70) leaves the detector deaf until ~600 s (1% at 300 s, 44% at
 * 600 s), where the old one was deaf too (24% at 65 s, then 0% through
 * 600 s). The chat's own startup transient, the empty seconds while its
 * socket connects, is kept out by MomentTick.chatOpen instead. A robust
 * update would bound the rest and trades against level shifts; it is not
 * done here.
 */
export class EwmaStat {
          sum = 0;
          sumSq = 0;
          weight = 0;
          alpha        ;
  // (port: boqo's `constructor(private alpha: number) {}`, spelled out)
  constructor(alpha        ) {
    this.alpha = alpha;
  }

  setWindow(windowSec        )       {
    this.alpha = 1 - Math.exp(-1 / windowSec);
  }

          mean()         {
    return this.sum / this.weight;
  }

  z(x        , sigmaFloor        )         {
    if (this.weight === 0) return 0;
    return (x - this.mean()) / Math.max(Math.sqrt(this.sumSq / this.weight), sigmaFloor);
  }

  baseline()                {
    return this.weight === 0 ? null : this.mean();
  }

  update(x        )       {
    // The same recursions as the plain EWMA, the deviation taken from the
    // mean as it stood before this sample; only the reads divide by
    // `weight`. The first sample has nothing to deviate from.
    const delta = this.weight === 0 ? 0 : x - this.mean();
    this.sum = (1 - this.alpha) * this.sum + this.alpha * x;
    this.sumSq = (1 - this.alpha) * (this.sumSq + this.alpha * delta * delta);
    this.weight = (1 - this.alpha) * this.weight + this.alpha;
  }
}

// type Peak = {
//   at: number;
//   z: number;
//   signal: "chat" | "audio";
//   chatPerSec: number;
//   chatBaseline: number;
//   loudness: number | null;
//   loudnessBaseline: number | null;
// };

export function createMomentDetector(params                )                 {
  const alpha = 1 - Math.exp(-1 / params.windowSec);
  const chatEwma = new EwmaStat(alpha);
  const loudEwma = new EwmaStat(alpha);
  let threshold = thresholdFor(params.sensitivity);
  const cooldownMs = (params.cooldownSec ?? MOMENT_COOLDOWN_SEC) * 1000;
  const warmupMs = (params.warmupSec ?? MOMENT_WARMUP_SEC) * 1000;

  const recentCounts           = [];
  const textRing                                             = [];
  let firstAt                = null;
  let lastPeakAt                = null;
  let rise                                           = null;
  let lastSignal                = null;

  function textsAround(peakAt        )           {
    return textRing
      .filter((entry) => Math.abs(entry.at - peakAt) <= TITLE_HALF_WINDOW_MS)
      .flatMap((entry) => entry.texts);
  }

  function emit(peak      )                  {
    const top = peak.signal === "chat" ? topMessage(textsAround(peak.at)) : null;
    const detail               = {
      chatPerSec: peak.chatPerSec,
      chatBaseline: peak.chatBaseline,
      loudness: peak.loudness,
      loudnessBaseline: peak.loudnessBaseline,
      topMessage: top?.text ?? null,
      topCount: top?.count ?? 0,
    };
    return {
      peakAt: peak.at,
      score: scoreFor(peak.z, threshold),
      signal: peak.signal,
      title: momentTitle(peak.signal, detail),
      detail,
    };
  }

  return {
    signal() {
      return lastSignal;
    },

    configure(p) {
      if (p.sensitivity !== undefined) threshold = thresholdFor(p.sensitivity);
      if (p.windowSec !== undefined) {
        chatEwma.setWindow(p.windowSec);
        loudEwma.setWindow(p.windowSec);
      }
    },

    tick(t) {
      if (firstAt === null) firstAt = t.at;

      const chatOpen = t.chatOpen !== false;
      if (chatOpen) {
        recentCounts.push(t.chatCount);
        if (recentCounts.length > CHAT_SMOOTH_SEC) recentCounts.shift();
      } else {
        // Cleared, not frozen: a window kept across the gap reopens holding
        // the seconds from before the drop and scores them a second time.
        // Measured 2026-09-21 on 10514fa's detector: a 40/s burst cut off at
        // 305 fired again at a reopen at 400, score 100 (moments.test.ts,
        // "does not replay the window it held before the chat dropped...").
        recentCounts.length = 0;
      }
      // The window is empty while the chat is not open and before it first
      // is; 0 keeps MomentDetail.chatPerSec a number rather than 0/0, and is
      // what an audio moment during an outage records.
      const chatPerSec = recentCounts.length === 0 ? 0 : recentCounts.reduce((a, b) => a + b, 0) / recentCounts.length;

      textRing.push({ at: t.at, texts: t.chatTexts });
      while (textRing.length > 0 && t.at - textRing[0] .at > TEXT_RING_MS) textRing.shift();

      // The `?? chatPerSec` applies while chatEwma has never updated (its
      // `weight === 0` case): on tick zero, and on every tick up to and
      // including the first one the chat is open for. It keeps
      // chatBaseline's type `number` rather than `number | null` -- Task 5
      // stores MomentDetail as a jsonb column, so that type is a database
      // contract. An audio moment while the chat has never been open does
      // read this, as 0 (the empty window's chatPerSec). Pinned by "gives an
      // audio moment zero chat, not NaN" in moments.test.ts.
      const chatBaseline = chatEwma.baseline() ?? chatPerSec;
      // Chat scores only on a full window of open seconds. A closed second
      // empties the window, so a full one implies the chat is open, and that
      // chatEwma has already been updated on the four seconds before this
      // one: chat never reaches EwmaStat.z's `weight === 0` case (loudness can;
      // "keeps a chat peak that lands on the second the loudness first
      // becomes known"). At a stream start the refill's four seconds fall
      // inside the default warm-up (MOMENT_WARMUP_SEC); after a reopen, a
      // partial window would read one second as a five-second rate ("judges
      // a reopened chat on five open seconds").
      const zChat =
        recentCounts.length === CHAT_SMOOTH_SEC && chatPerSec >= MOMENT_MIN_CHAT_RATE
          ? chatEwma.z(chatPerSec, CHAT_SIGMA_FLOOR)
          : Number.NEGATIVE_INFINITY;
      if (chatOpen) chatEwma.update(chatPerSec);

      let zAudio = Number.NEGATIVE_INFINITY;
      let loudnessBaseline                = null;
      if (t.loudness !== null) {
        loudnessBaseline = loudEwma.baseline();
        zAudio = loudEwma.z(t.loudness, LOUDNESS_SIGMA_FLOOR) * MOMENT_AUDIO_Z_WEIGHT;
        loudEwma.update(t.loudness);
      }

      const signal                   = zChat >= zAudio ? "chat" : "audio";
      const z = Math.max(zChat, zAudio);
      // -Infinity is "neither signal could score", which the chart draws as a gap.
      lastSignal = Number.isFinite(z) ? z : null;
      const peakNow       = { at: t.at, z, signal, chatPerSec, chatBaseline, loudness: t.loudness, loudnessBaseline };

      if (rise === null) {
        const warm = t.at - firstAt >= warmupMs;
        const cool = lastPeakAt === null || t.at - lastPeakAt >= cooldownMs;
        if (warm && cool && z >= threshold) rise = { startedAt: t.at, peak: peakNow };
        return null;
      }

      if (z > rise.peak.z) rise.peak = peakNow;
      const fallen = z <= MOMENT_FALL_RATIO * rise.peak.z;
      const overdue = t.at - rise.startedAt >= MOMENT_RISE_MAX_SEC * 1000;
      if (!fallen && !overdue) return null;

      const candidate = emit(rise.peak);
      lastPeakAt = rise.peak.at;
      rise = null;
      return candidate;
    },
  };
}
