// One line of runs.md per moment (spec §7.7):
//
//   21:04 · 86 exceptional · NO WAY ×168 · 30/s · chat spike — "NO WAY" ×168 · 4 clips
//   21:07 · 100 exceptional · clipped by hand · 1 clip · no read
//
// time (HH:MM, local), the score and its band word, the signal line, the title, the clip count, and `no read` when
// the vision budget was spent and a clip went without its panels and judgment reads. The signal line is hosted's
// (lib/boqo/signal-line.mjs): the top chat message with its count and the rate, `NO WAY ×168 · 30/s`, or
// `Audio +9 LU`; a hand-made moment has none and the part is left out. (The spec's `"<top>" ×n · N msg/s` is not
// what hosted prints; the golden wins.)

import { scoreBand } from "./bands.mjs";
import { signalLine } from "./boqo/signal-line.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** `peakAt` is epoch seconds; `utc` shows UTC instead of the machine's local time (tests). */
export function runsLine({ peakAt, score, signal, detail = null, title, clips, noRead = false, utc = false }) {
  const d = new Date(peakAt * 1000);
  const time = utc ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parts = [time, `${score} ${scoreBand(score)}`];
  const sig = signal === "manual" ? null : signalLine(detail, signal);
  if (sig) parts.push(sig);
  parts.push(title, `${clips} ${clips === 1 ? "clip" : "clips"}`);
  if (noRead) parts.push("no read");
  return parts.join(" · ");
}
