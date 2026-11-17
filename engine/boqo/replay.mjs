// ported from boqo-ai/boqo packages/core/src/replay.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";

/**
 * The `Replay` blob a clip carries from selection (B9, #190): where its window
 * sits on the video's most-replayed curve. Null `pct`/`pctRaw`/`heat` mean the
 * video had no heatmap. The curve itself comes with a later task.
 */
export const ReplaySchema = z.object({
  v: z.literal(1),
  pct: z.number().nullable(),
  pctRaw: z.number().nullable(),
  heat: z.number().nullable(),
  discounted: z.boolean(),
  bins: z.number(),
  factor: z.number(),
  introBins: z.number(),
  chapterBins: z.number(),
  sha: z.string().nullable(),
});


/** Total, like every jsonb reader here. */
export function parseReplay(raw         )                {
  const parsed = ReplaySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * One bin of YouTube's most-replayed graph. Structurally `@boqo/db`'s
 * `HeatmapEntry`; core cannot import db.
 */


/** A bin with its raw value kept beside the discounted `value`. */


















export const DEFAULT_REPLAY_TUNABLES                 = {
  factor: 0.5,
  introBins: 2,
  chapterBins: 1,
};

/**
 * The usable-bin filter and flat-graph rule of
 * `apps/worker/src/select/peaks.ts:22-29,57`: three finite bins at least, and
 * a non-zero standard deviation.
 */
export function discountHeatmap(
  heatmap                           ,
  chapterStartsSec                   ,
  t                ,
)                     {
  if (!heatmap) return null;
  const usable = heatmap.filter(
    (b) =>
      Number.isFinite(b.startTime) &&
      Number.isFinite(b.endTime) &&
      Number.isFinite(b.value),
  );
  if (usable.length < 3) return null;

  const mean = usable.reduce((s, b) => s + b.value, 0) / usable.length;
  const variance =
    usable.reduce((s, b) => s + (b.value - mean) ** 2, 0) / usable.length;
  if (Math.sqrt(variance) === 0) return null;

  // A Set, so a bin that is both intro and chapter is discounted once.
  const discounted = new Set        ();
  for (let i = 0; i < Math.min(t.introBins, usable.length); i++) {
    discounted.add(i);
  }
  for (const start of chapterStartsSec) {
    if (!(start > 0)) continue;
    const at = usable.findIndex(
      (b) => b.startTime <= start && start < b.endTime,
    );
    if (at < 0) continue;
    for (let i = at; i < Math.min(at + t.chapterBins, usable.length); i++) {
      discounted.add(i);
    }
  }

  return {
    bins: usable.map((b, i) => ({
      startTime: b.startTime,
      endTime: b.endTime,
      raw: b.value,
      value: discounted.has(i) ? b.value * t.factor : b.value,
      artefact: discounted.has(i),
    })),
    factor: t.factor,
    introBins: t.introBins,
    chapterBins: t.chapterBins,
  };
}

/** The discounted bins as plain `HeatBin`s, what `findPeakRegions` consumes. */
export function curveBins(curve             )            {
  return curve.bins.map((b) => ({
    startTime: b.startTime,
    endTime: b.endTime,
    value: b.value,
  }));
}

/**
 * `docs/research/scripts/align.py:127-134`'s arithmetic, on discounted and raw
 * values: the window's bins, their mean heat, and the share of all bins at or
 * below it.
 */
export function replayOf(
  curve                    ,
  window                                      ,
  t                ,
  sha               ,
)         {
  const base = {
    v: 1         ,
    pct: null,
    pctRaw: null,
    heat: null,
    discounted: false,
    factor: t.factor,
    introBins: t.introBins,
    chapterBins: t.chapterBins,
    sha,
  };
  if (!curve) return { ...base, bins: 0 };

  const inWindow = curve.bins.filter(
    (b) => b.endTime > window.startSec && b.startTime < window.endSec,
  );
  if (inWindow.length === 0) return { ...base, bins: curve.bins.length };

  const share = (
    pick                          ,
  )                                => {
    const mean = inWindow.reduce((s, b) => s + pick(b), 0) / inWindow.length;
    // Mirrors align.py:131's round(…, 3), applied before the comparison.
    const heat = Math.round(mean * 1000) / 1000;
    const at = curve.bins.filter((b) => pick(b) <= heat).length;
    return { heat, pct: at / curve.bins.length };
  };
  const discounted = share((b) => b.value);
  const raw = share((b) => b.raw);

  return {
    ...base,
    pct: discounted.pct,
    pctRaw: raw.pct,
    heat: discounted.heat,
    discounted: inWindow.some((b) => b.artefact),
    bins: curve.bins.length,
  };
}
