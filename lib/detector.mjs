// The spike detector (after boqo's hosted watcher).
//
// Pure and clock-free: one 10 s bucket in, a spike out when a rise has peaked
// and fallen away. The watcher owns the sockets and the clock; this owns the
// judgement. No I/O.
//
// Per signal, an exponentially-weighted mean and variance over the baseline
// window. A bucket is scored against the baseline as it stood BEFORE the
// bucket, so a spike does not dilute its own measure. The chat signal is
// unique chatters a second (one spammer is not a moment); the audio signal is
// the bucket's loudness in LUFS. A rise opens when a signal crosses its
// threshold and is emitted once it has fallen to 60% of its peak, or after
// 20 s, whichever comes first.

/** Chat z at sensitivity 70, the default: thresholdFor(70). */
export const CHAT_Z = 2.4;
/** Audio z needed to count as loud. */
export const AUDIO_Z = 3.5;
/** A chat rise needs at least this many unique chatters a second; 0 to 1 in a quiet chat is not a moment. */
export const CHATTER_FLOOR = 2;
/** Mean chatters a bucket, over the baseline, under which the chat is dead and cannot spike. */
export const DEAD_CHAT_CHATTERS = 0.5;
/** Loudness alone (chat flat) may spike only at or above this sensitivity. */
export const AUDIO_ALONE_MIN_SENSITIVITY = 70;
/** A rise that has not fallen back by now is emitted anyway. */
export const RISE_MAX_SEC = 20;
/** Emitted once the signal falls to this fraction of its peak. */
export const FALL_RATIO = 0.6;

// Sigma floors keep a flat baseline from turning a tiny bump into a huge z.
const CHAT_SIGMA_FLOOR = 0.5; // chatters a second
const LOUDNESS_SIGMA_FLOOR = 1.5; // LU

/** Linear: 3.6 at sensitivity 30, 1.65 at 95, 2.4 at the default of 70. Clamped to 30-95. */
export function thresholdFor(sensitivity) {
  const s = Math.min(95, Math.max(30, sensitivity));
  return 3.6 - ((s - 30) / 65) * (3.6 - 1.65);
}

/** 60 at the threshold, 100 at two and a half times it, clamped to 0-100. */
function scoreFor(z, threshold) {
  const raw = 60 + (40 * (z - threshold)) / (1.5 * threshold);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * An exponentially-weighted mean and variance, bias-corrected so a young
 * baseline is the weighted average of what it has actually seen (both sums
 * start at zero beside a weight sum, and every read divides by it). `z` reads
 * the baseline before `update` moves it.
 */
class Ewma {
  constructor(alpha) {
    this.alpha = alpha;
    this.sum = 0;
    this.sumSq = 0;
    this.weight = 0;
  }
  mean() {
    return this.sum / this.weight;
  }
  baseline() {
    return this.weight === 0 ? null : this.mean();
  }
  z(x, sigmaFloor) {
    if (this.weight === 0) return 0;
    return (x - this.mean()) / Math.max(Math.sqrt(this.sumSq / this.weight), sigmaFloor);
  }
  update(x) {
    const delta = this.weight === 0 ? 0 : x - this.mean();
    this.sum = (1 - this.alpha) * this.sum + this.alpha * x;
    this.sumSq = (1 - this.alpha) * (this.sumSq + this.alpha * delta * delta);
    this.weight = (1 - this.alpha) * this.weight + this.alpha;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Bucket = { t: seconds, chat: messages, chatters: unique chatters, lufs: number | null }, one per bucketSec.
 * Spike  = { peakAt, score (0-100), chatZ, audioZ (null when loudness is unknown), reason: "chat" | "audio" | "both" }.
 */
export function createDetector(o = {}) {
  const sensitivity = o.sensitivity ?? 70;
  const baselineSec = o.baselineSec ?? 300;
  const bucketSec = o.bucketSec ?? 10;
  const cooldownSec = o.cooldownSec ?? 60;
  const warmupSec = o.warmupSec ?? 60;

  const alpha = 1 - Math.exp(-bucketSec / baselineSec);
  const chatEwma = new Ewma(alpha);
  const loudEwma = new Ewma(alpha);
  const chatThreshold = thresholdFor(sensitivity);
  const audioAlone = sensitivity >= AUDIO_ALONE_MIN_SENSITIVITY;

  let firstT = null;
  let lastT = null;
  // Cooldown runs from the end of the last bucket that was still above its
  // threshold, so it covers the whole surge and not just its peak.
  let lastActiveEndT = null;
  let rise = null; // { startedAt, peak }
  // A surge out of a dead chat stays suppressed for its whole length: its own
  // first bucket lifts the baseline, which must not wake the chat for the next.
  let surgeSuppressed = false;

  function push(b) {
    const t = b?.t;
    if (typeof t !== "number" || !Number.isFinite(t)) return null;
    if (lastT !== null && t <= lastT) return null; // a repeat or an older bucket
    lastT = t;
    if (firstT === null) firstT = t;

    const chatters = num(b.chatters);
    const perSec = chatters / bucketSec;
    const lufs = typeof b.lufs === "number" && Number.isFinite(b.lufs) ? b.lufs : null;

    // Read both baselines before this bucket moves them.
    const meanChatters = chatEwma.baseline();
    const dead = meanChatters === null ? true : meanChatters * bucketSec < DEAD_CHAT_CHATTERS;
    const chatZ = chatEwma.z(perSec, CHAT_SIGMA_FLOOR);
    const audioZ = lufs === null ? null : loudEwma.z(lufs, LOUDNESS_SIGMA_FLOOR);
    chatEwma.update(perSec);
    if (lufs !== null) loudEwma.update(lufs);

    const chatSurge = perSec >= CHATTER_FLOOR && chatZ >= chatThreshold;
    const chatDead = dead || (surgeSuppressed && chatSurge);
    surgeSuppressed = chatSurge && chatDead;
    const chatFires = chatSurge && !chatDead;
    const audioLoud = audioZ !== null && audioZ >= AUDIO_Z;

    let now = null;
    if (chatFires) {
      const reason = audioLoud ? "both" : "chat";
      const scores = [scoreFor(chatZ, chatThreshold)];
      if (audioLoud) scores.push(scoreFor(audioZ, AUDIO_Z));
      const strength = Math.max(chatZ / chatThreshold, audioLoud ? audioZ / AUDIO_Z : -Infinity);
      now = { peakAt: t, score: Math.max(...scores), chatZ, audioZ, reason, strength };
    } else if (audioLoud && audioAlone) {
      now = { peakAt: t, score: scoreFor(audioZ, AUDIO_Z), chatZ, audioZ, reason: "audio", strength: audioZ / AUDIO_Z };
    }

    if (rise === null) {
      const warm = t - firstT >= warmupSec;
      const cool = lastActiveEndT === null || t - lastActiveEndT >= cooldownSec;
      if (warm && cool && now !== null) {
        rise = { startedAt: t, peak: now };
        lastActiveEndT = t + bucketSec;
      }
      return null;
    }

    if (now !== null) {
      lastActiveEndT = t + bucketSec;
      if (now.strength > rise.peak.strength) rise.peak = now;
    }
    const strength = now === null ? -Infinity : now.strength;
    const fallen = strength <= FALL_RATIO * rise.peak.strength;
    const overdue = t - rise.startedAt >= RISE_MAX_SEC;
    if (!fallen && !overdue) return null;

    const p = rise.peak;
    rise = null;
    return {
      peakAt: p.peakAt,
      score: p.score,
      chatZ: round2(p.chatZ),
      audioZ: p.audioZ === null ? null : round2(p.audioZ),
      reason: p.reason,
    };
  }

  return { push };
}
