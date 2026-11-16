// ported from boqo-ai/boqo apps/worker/src/select/peaks.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)



/**
 * Seconds of context added to each side of a peak bin. A heatmap bin on a
 * one-hour video is tens of seconds wide and its edges are arbitrary — the
 * sentence that made people replay usually starts before the bin does.
 */
const PEAK_PAD_SEC = 15;

/** Padded regions closer than this merge into one. */
export const PEAK_MERGE_GAP_SEC = 30;

/**
 * Cap on regions handed to the prompt. Every region is annotation the model
 * pays for; past a dozen the "most replayed" signal stops being selective.
 */
export const MAX_PEAK_REGIONS = 12;



function usableBins(heatmap                )        {
  return heatmap.filter(
    (entry)               =>
      Number.isFinite(entry.startTime) &&
      Number.isFinite(entry.endTime) &&
      Number.isFinite(entry.value),
  );
}

/**
 * Local maxima in YouTube's most-replayed graph, merged into candidate
 * regions (spec §5.3 step 1).
 *
 * Returns an empty array for every "no usable signal" case — absent heatmap,
 * too few bins, flat graph. That is what keeps §5.3's promise of one code
 * path: the caller never branches on whether a heatmap exists, it just gets
 * no annotations.
 */
export function findPeakRegions(
  heatmap                       ,
  durationSec        ,
)               {
  if (!heatmap) return [];

  const bins = usableBins(heatmap);
  if (bins.length < 3) return [];

  const values = bins.map((b) => b.value);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  // A flat graph has no peaks, and without this guard every bin clears a
  // mean-plus-nothing threshold and the whole video becomes one region.
  if (stdDev === 0) return [];

  const threshold = mean + stdDev;
  const peaks               = [];

  // Endpoints are excluded on purpose: bin 0 spikes on almost every YouTube
  // video because viewers re-watch the intro, which is rarely a good clip.
  for (let i = 1; i < bins.length - 1; i += 1) {
    const bin = bins[i] ;
    const prev = bins[i - 1] ;
    const next = bins[i + 1] ;

    // `>` on the left and `>=` on the right makes a plateau report its first
    // bin exactly once, rather than every bin or none of them.
    if (bin.value <= prev.value) continue;
    if (bin.value < next.value) continue;
    if (bin.value < threshold) continue;

    peaks.push({
      startSec: Math.max(0, bin.startTime - PEAK_PAD_SEC),
      endSec: Math.min(durationSec, bin.endTime + PEAK_PAD_SEC),
      value: bin.value,
    });
  }

  return capAndOrder(merge(peaks));
}

/** Collapses overlapping or near-adjacent regions, keeping the taller value. */
function merge(regions              )               {
  const sorted = [...regions].sort((a, b) => a.startSec - b.startSec);
  const merged               = [];

  for (const region of sorted) {
    const last = merged.at(-1);
    if (last && region.startSec - last.endSec <= PEAK_MERGE_GAP_SEC) {
      last.endSec = Math.max(last.endSec, region.endSec);
      last.value = Math.max(last.value, region.value);
      continue;
    }
    merged.push({ ...region });
  }

  return merged;
}

/** Keeps the tallest regions, then restores transcript order for the prompt. */
function capAndOrder(regions              )               {
  return [...regions]
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_PEAK_REGIONS)
    .sort((a, b) => a.startSec - b.startSec);
}
