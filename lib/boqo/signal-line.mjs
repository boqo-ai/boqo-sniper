// ported from boqo-ai/boqo apps/web/src/components/next/stream/signal-line.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
                                               

/* The line under a moment's title that says what the detector saw (spec §6.4 #3, P4-D20): the top chat
   message and its rate, or the loudness lead of an audio moment. Both chat forms keep the rate; the chatters
   unit (the judge's candidate detector) says so. Null when nothing is known. */
export function signalLine(detail                     , signal        )                {
  if (!detail) return null;
  if (signal === "audio") {
    // An audio moment says nothing of chat: without both loudness figures there is no line (intent).
    if (detail.loudness == null || detail.loudnessBaseline == null) return null;
    const lu = Math.round(detail.loudness - detail.loudnessBaseline);
    return `Audio ${lu < 0 ? "−" : "+"}${Math.abs(lu)} LU`;
  }
  const rate = Math.round(detail.chatPerSec);
  const unit = detail.chatUnit === "chatters" ? "chatters/s" : "/s";
  const perSec = detail.chatUnit === "chatters" ? `${rate} ${unit}` : `${rate}${unit}`;
  if (detail.topMessage) return `${detail.topMessage} ×${detail.topCount} · ${perSec}`;
  return rate > 0 ? perSec : null;
}
