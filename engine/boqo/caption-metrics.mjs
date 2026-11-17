// ported from boqo-ai/boqo packages/core/src/caption-metrics.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { CAPTION_METRICS } from "./caption-metrics-table.mjs";

                           
                                                                
                   
                                                                              
                                  
                                                                                    
                          
                                                                     
                    
  

/**
 * Measured in the built image by apps/worker/src/scripts/caption-metrics.ts.
 *
 * This lives in `core` rather than in the worker because the clip editor
 * composites captions in the browser and must break lines exactly where the
 * renderer breaks them. Two copies of a measured table is the drift this
 * repository records most often; `caption-overrides.ts` already carried a
 * partial copy of the cap ratios for want of this module, and Task 3 deletes
 * it.
 *
 * Throwing on an unknown font is deliberate: guessing a width would produce
 * line breaks that are wrong in a way nothing downstream can detect.
 */
export function fontMetrics(fontName        )              {
  const found = CAPTION_METRICS[fontName];
  if (!found) {
    throw new Error(
      `no caption metrics for font ${JSON.stringify(fontName)}; ` +
        `regenerate packages/core/src/caption-metrics-table.ts inside the built image`,
    );
  }
  return found;
}

/**
 * The ASS `Fontsize` that renders `capHeightPx`.
 *
 * ASS `Fontsize` is not em size and the ratio is a property of the font
 * file — the measured spread is 0.46 to 0.63 across four faces, 37%. Presets
 * therefore declare the cap height they want and this resolves it.
 */
export function assFontSize(metrics             , capHeightPx        )         {
  return Math.max(1, Math.round(capHeightPx / metrics.capRatio));
}

/** Rendered width of `text` at `fontSize`, in output pixels. */
export function measureWidth(metrics             , text        , fontSize        )         {
  let sum = 0;
  for (const ch of text) sum += metrics.advance[ch] ?? metrics.fallbackAdvance;
  return sum * fontSize;
}

export { CAPTION_METRICS };
