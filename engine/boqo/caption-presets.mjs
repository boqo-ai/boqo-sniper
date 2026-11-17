// ported from boqo-ai/boqo packages/core/src/caption-presets.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut import: REFERENCE_WIDTH and REFERENCE_HEIGHT are `export const REFERENCE_WIDTH = 1080;` and
// `export const REFERENCE_HEIGHT = 1920;` in packages/core/src/constants.ts (the 9:16 reference frame every pixel
// constant was measured against), a module of product limits this skill has no other use for.
export const REFERENCE_WIDTH = 1080;
export const REFERENCE_HEIGHT = 1920;
                                                

                              
             
           
           
               
             
          
     
                                                                        
                                                                             
                                                                     
     
             
                                                                                              
                                                           
                                                          
                                                                                                                   
                  

export const DEFAULT_CAPTION_PRESET_KEY                   = "karaoke";

/**
 * How the word currently being spoken is set apart from the rest of its
 * group.
 *
 * `scale` is the measured behaviour of the reference render: a colour swap
 * plus a size swap, both hard-switched in a single frame (design §2). `box`
 * is BorderStyle 3 with an inline border-alpha pair, which puts a filled
 * block behind the active word only.
 */
                             
                                       
     
                  
                        
                         
         
                                                        
        
                                                                          
                                                                       
                                                                             
                                                                             
                                                                         
                                                                       
                                                                         
                                                        
        
                                                                              
                                                                             
                                                                            
                                                                     
                      
         
                                
         
                                                                              
                                                                          
                                                                            
                                                           
         
                                 
     
                      
                                                          
                                   
                                        
                     

                          
                        
                
  

/**
 * The pre-2026-08-25 renderer, preserved verbatim so `classic` can be proved
 * byte-identical (design §4.3). Nothing new should ever use this branch —
 * it exists to be a control arm, not a starting point.
 */
                                                       
                     
                   
                   
                     
                          
                        
                         
                          
  

                                                           
                         
                   
     
                                                                   
    
                                                                          
                                                                           
                                                                      
                                                                        
                                                                         
                          
     
                      
                     
                                                                                  
                          
                        
                       
                                                                
                     
                            
                                           
                            
                   
                      
                   
                   
                                                                             
                         
                                                                      
                           
                                                                                     
                       
     
                                                                           
                                                                         
                                                                   
     
                      
                                                                                  
                                                                            
                                                                       
                                                      
                         
                                                                                     
                   
                       
                                                                           
                      
                                                                               
                                                                             
                                                                             
                           
                                                                                                                  
                       
                                                                                                                       
                  
                                                                             
                          
                                                 
                               
                                                                                         
                       
                                                       
                                              
                                                               
                                                                                            
                                                          
                                                                 
                   
                                                                
                 
  

                           
                       
                           
                                               

/**
 * CSS `#RRGGBB` to the ASS `&HBBGGRR` byte order.
 *
 * This exists because the reversal has been mistaken for a different colour
 * twice: the shipped `00E5FF` reads as cyan and is amber. Storing CSS and
 * converting once removes the class of error rather than documenting it
 * again.
 */
export function cssToAss(hex        )         {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    throw new Error(`caption colour must be six hex digits, got ${JSON.stringify(hex)}`);
  }
  const upper = raw.toUpperCase();
  return `${upper.slice(4, 6)}${upper.slice(2, 4)}${upper.slice(0, 2)}`;
}

/**
 * An opacity in `[0, 1]` to the two-digit ASS alpha byte, which counts the
 * other way: `&H00&` is opaque and `&HFF&` is invisible.
 *
 * Same reasoning as `cssToAss`. The inversion is exactly the kind of detail
 * that reads as correct while being backwards, and a preset table storing
 * `0.6` rather than `66` cannot express it wrongly.
 */
export function opacityToAssAlpha(opacity        )         {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error(`caption opacity must be within [0, 1], got ${JSON.stringify(opacity)}`);
  }
  return Math.round((1 - opacity) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
}

const KARAOKE                          = {
  key: "karaoke",
  label: "Karaoke",
  emission: "positioned",
  fontName: "Montserrat ExtraBold",
  capHeightPx: 45,
  baseColour: "#FFFFFF",
  accentColours: ["#F8F800", "#00F020"],
  outlineColour: "#000000",
  outlineWidth: 7,
  borderStyle: 1,
  emphasis: { kind: "scale", scalePct: 128 },
  textCase: "upper",
  stripPunctuation: true,
  wordsMin: 3,
  wordsTarget: 4,
  wordsMax: 5,
  maxLines: 3,
  centreFraction: 0.805,
  lineSpacingRatio: 1.711,
  sideMarginPx: 60,
  gapSplitSec: 0.8,
};

/**
 * Oswald rather than Anton, which was the design's first choice and is
 * Latin-only. This product has already rendered a Russian project end to
 * end, and a preset that silently tofus every glyph on Cyrillic content is
 * exactly the "correct in every measurable property, still the wrong video"
 * failure this repo keeps recording. Oswald is condensed and covers Cyrillic.
 */
const PUNCH                          = {
  ...KARAOKE,
  key: "punch",
  label: "Punch",
  fontName: "Oswald",
  capHeightPx: 52,
  accentColours: ["#F8F800"],
  emphasis: { kind: "scale", scalePct: 130 },
};

const CLEAN                          = {
  ...KARAOKE,
  key: "clean",
  label: "Clean",
  fontName: "Inter",
  capHeightPx: 40,
  accentColours: ["#00E5FF"],
  outlineWidth: 4,
  emphasis: { kind: "scale", scalePct: 110 },
};

/**
 * `inactiveBoxOpacity` is 0.6, chosen against rendered frames rather than
 * picked: the plate composited over pure white reads 102/255, which is a
 * 5.7:1 contrast ratio behind white glyphs — clear of WCAG's 4.5:1 for normal
 * text, let alone the 3:1 for text this size. 0.37 was rendered too and gives
 * 2.65:1, below even the large-text bar. The value is not delicate; anything
 * from about 0.5 upward reads on white, and the failure directions are not
 * symmetric — too light is an unreadable caption burned into a clip forever,
 * too dark is slightly more video covered.
 */
const HIGHLIGHT                          = {
  ...KARAOKE,
  key: "highlight",
  label: "Highlight",
  capHeightPx: 43,
  accentColours: ["#FFFFFF"],
  borderStyle: 3,
  outlineWidth: 8,
  emphasis: {
    kind: "box",
    boxColour: "#00F020",
    textColour: "#000000",
    inactiveBoxColour: "#000000",
    inactiveBoxOpacity: 0.6,
  },
};

/**
 * The renderer as it stood before this change, value for value. Do not
 * "clean up" these numbers: the acceptance gate re-renders four real clips
 * under this preset and compares SHA-256 against the pre-change output.
 */
const CLASSIC                      = {
  key: "classic",
  label: "Classic",
  emission: "legacy",
  fontName: "DejaVu Sans",
  fontSize: 84,
  baseColour: "#FFFFFF",
  accentColours: ["#FFE500"],
  outlineColour: "#000000",
  marginVertical: 420,
  maxWordsPerLine: 4,
};

const NONE                = { key: "none", label: "No captions", emission: "none" };

/** Order is display order in the picker. */
export const CAPTION_PRESETS                  = [
  KARAOKE,
  PUNCH,
  CLEAN,
  HIGHLIGHT,
  CLASSIC,
  NONE,
];

/**
 * The captions entry that means "draw this project's captions the way its
 * BRAND TEMPLATE says", rather than the way a preset says.
 *
 * It is the only value of `projects.caption_style` under which a template's
 * caption block reaches the render at all. Every other value -- `karaoke`,
 * `punch`, and the rest -- means the preset's own look, with the template's
 * caption block deliberately unused; the template's logo, headline, ratio,
 * delivery and transitions are untouched either way, which is what makes
 * choosing a preset an opt-out of one thing rather than of the brand.
 *
 * **Deliberately NOT a member of `CAPTION_PRESETS`** (nor of `CAPTION_STYLES`).
 * Three things follow from those tables and none of them is true here: every
 * row is a picker tile pre-rendered as a loop under
 * `apps/web/public/caption-styles` (caption styles P2; the five PNGs this
 * once named are gone), `captionStyleFingerprint` digests the rows against
 * those loops (`tiles.json`'s `styleDigest`), and `POSITIONED_PRESETS` and
 * `captionSizeCeiling` are derived from `CAPTION_PRESETS`. A row here would
 * demand a loop that CANNOT exist -- this entry's appearance depends on the
 * viewer's own brand template, so there is nothing to pre-render -- and
 * would move a size ceiling for a display change. The picker prepends it
 * instead, and only when a template with a caption block is selected.
 *
 * `text` with no CHECK is what makes this free (`projects.caption_style`,
 * migration 0003), and both creation routes take `z.string().max(40)`, so
 * the sentinel needed no migration and no route change.
 */
export const BRAND_CAPTION_KEY = "default";

/**
 * The window taken out of the 1080x1920 render for one picker tile, in
 * source pixels.
 *
 * 960 is exactly the widest a caption line is ever allowed to be
 * (`REFERENCE_WIDTH - 2 * sideMarginPx`, and `buildCaptions` subtracts the
 * pop's growth from that same budget before wrapping), so a line the
 * renderer considers safe cannot be clipped by the tile. 540 is that width
 * at 16:9 and clears the tallest three-line block with room to spare. Fixed
 * rather than fitted per preset on purpose: the presets differ in cap height
 * by 30% (Inter 40px against Oswald 52px) and that difference is real, so
 * every tile has to be at one scale or the picker stops being a comparison.
 *
 * **Here rather than beside the generator that crops with it, because there
 * are TWO readers.** The loop generator (`caption-loops.ts`, run as
 * `caption-metrics.js --loops`) crops a 960-wide band of this window, as
 * tall as the 216x84 loop's own aspect (373px); the `default` tile cannot be
 * pre-rendered (see `BRAND_CAPTION_KEY`) and is drawn in CSS, so it has to
 * scale its sample by the same window or it sits at a different zoom from
 * every tile beside it and the picker stops being a comparison in the other
 * direction. (`caption-metrics.ts`'s PNG mode cropped the full 960x540; that
 * mode is retired -- caption styles P2 deleted its PNGs.)
 * Two readers of one value drift, and only one of them is the one that
 * draws -- the rule the caption-styles spec refused an env-var font override
 * over (§7.4a).
 */
export const TILE_CROP_W = 960;
export const TILE_CROP_H = 540;

/**
 * A stable string describing everything about the preset table that changes
 * what a preview tile LOOKS like.
 *
 * The loop tiles under `apps/web/public/caption-styles` are rendered from
 * `buildCaptions` by the worker's own generator, which makes them impossible to
 * disagree with the renderer AT THE MOMENT THEY ARE GENERATED — and free to
 * drift from it every moment after. Edit an accent colour or a font here and
 * the pictures keep describing the old style, with nothing to say so: the same
 * two-representations-that-disagree trap the single-pass generator was built to
 * avoid, reintroduced one step later. `captionStyleFingerprint` runs this over
 * the gallery, and `apps/web/tests/caption-style-tiles.test.ts` and
 * `caption-picker.test.ts` compare it against `tiles.json`'s `styleDigest`
 * beside the loops, so a style change fails loudly instead.
 *
 * `label` is excluded deliberately: it is the only field that can change
 * without changing a pixel, and a guard that fires on a wording fix teaches
 * people to regenerate without looking.
 *
 * Keys are sorted rather than taken in declaration order. Most presets are
 * built by spreading `KARAOKE`, so a field's position in the emitted object
 * depends on where it was overridden — reordering two lines with no change in
 * value would otherwise read as a style change.
 *
 * Takes the table as an argument so a test can hand it a mutated copy; nothing
 * in production passes anything.
 */
export function captionPresetFingerprint(
  presets                  = CAPTION_PRESETS,
)         {
  const canonical = (value         )          => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value                           )
        .filter(([key]) => key !== "label")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  };
  return JSON.stringify(presets.map(canonical));
}

/**
 * The presets a brand template's caption block can reach (design §2.2).
 * `classic` is excluded because it exists to be a frozen control arm and
 * carries a raw ASS `fontSize` where this path derives one from a measured
 * cap ratio; `none` has no captions to style.
 */
export const POSITIONED_PRESETS                                     =
  CAPTION_PRESETS.filter(
    (preset)                                    => preset.emission === "positioned",
  );

/**
 * The band a brand template may set `wordsTarget` to. The two ends come from
 * different authorities, and the asymmetry is the point rather than an
 * oversight — it mirrors the one `applyCaptionOverrides` already documents
 * for `positionFraction`.
 *
 * The CEILING is derived, never typed by hand: `wordsMax` is read at render
 * (`captionGroups` walks `groupCount` up until `ceil(n / groupCount)` no
 * longer exceeds it), so it is a real constraint, and computing it means a
 * future preset with a wider band moves the schema, the UI control and the
 * validator together instead of silently reinterpreting every template
 * already stored.
 *
 * The FLOOR is 1, and it is deliberately NOT `min(...wordsMin)`, which was
 * what this constant read until 2026-09-04. `wordsMin` is read by NOTHING at
 * render — `captionGroups` takes `{min, target, max}` and `bounds.min` has
 * zero references in `apps/worker/src/render/captions.ts` — so a floor
 * derived from it bounded a value against a constraint the renderer does not
 * have. What the renderer does require is `target >= 1`: it divides the word
 * count by the target, so 0 is a division by zero and a caption of fewer than
 * one word is not a caption. That is the whole floor, and 1 is it.
 *
 * The product consequence is the reason this changed: at a target of 1 every
 * caption carries a single word, which is a real look the presets' own 3-5
 * band was never able to express and which the renderer produces correctly.
 */
export const CAPTION_WORDS_MIN = 1;
export const CAPTION_WORDS_MAX = Math.max(...POSITIONED_PRESETS.map((p) => p.wordsMax));

/**
 * The band `positionFraction` may occupy, from the geometry rather than from
 * taste: the tallest block any positioned preset produces still clears the
 * frame at both ends. At 0.9, measured on the worst of them (`punch`), the
 * spare is 70.03px at 9:16 and 39.88px at 1:1 and 16:9. At 0.1 -- the floor
 * since caption styles P3 (ruling R5, amended 2026-10-06: the caption is
 * dragged on the stage, and the 0.5 middle snap must not be the floor) -- the
 * tallest block at the largest size clears the top by 14.23px, worst `punch`
 * at 1:1 (measured 2026-10-06, every positioned preset and gallery style,
 * every ratio). Both ends are pinned by tests in caption-overrides.test.ts,
 * swept across ASPECT_RATIOS, so a future preset with more lines fails there
 * rather than off the edge of a rendered clip.
 *
 * Defined HERE rather than in caption-overrides.ts, where it lived until
 * 2026-09-05, so `captionSizeCeiling` below can be derived from it instead of
 * from a second copy of the same number.
 */
export const CAPTION_POSITION_MIN = 0.1;
export const CAPTION_POSITION_MAX = 0.9;

/**
 * A preset's pixel values are measured against the 9:16 reference frame.
 * This restates them for the frame actually being rendered: cap height and
 * outline scale with HEIGHT, side margin with WIDTH.
 *
 * The height basis is the decision of design §3, and it is what makes
 * `captionSizeCeiling` below ratio-independent -- the frame height cancels.
 * The cost is real and was taken knowingly: at 1:1 and 16:9 a karaoke cap is
 * 25px rather than 45, and the size slider (1.4 at most) cannot get it back.
 * The lever, if that reads too small, is the reference cap heights above --
 * raising them moves all three ratios together and keeps the ceiling
 * invariant. It is NOT the basis.
 *
 * At the reference size both factors are exactly 1 and `x * 1 === x` for
 * every finite x, so this returns values identical to its input -- which is
 * the whole of the byte-identity argument for the 9:16 control arm. The early
 * return makes that identity rather than merely equality, and is redundant
 * with the arithmetic on purpose.
 *
 * `round` is a parameter, and the two callers below are the only two there
 * will ever be. There is exactly ONE returned object literal here, shared
 * between them, and that sharing is load-bearing rather than tidy: it is what
 * makes a half-converted geometry (drop `outlineWidth` from this literal)
 * visible to `captionSizeCeiling`'s own test. A ceiling computed from its own
 * private copy of this arithmetic would keep passing while the renderer drew
 * the wrong thing, which is precisely the failure design §6 exists to catch.
 * Do not "simplify" this into two functions.
 */
function scaled(
  preset                         ,
  output            ,
  round                       ,
)                          {
  const v = output.height / REFERENCE_HEIGHT;
  const h = output.width / REFERENCE_WIDTH;
  if (v === 1 && h === 1) return preset;
  return {
    ...preset,
    capHeightPx: round(preset.capHeightPx * v),
    outlineWidth: round(preset.outlineWidth * v),
    sideMarginPx: round(preset.sideMarginPx * h),
  };
}

/**
 * What the RENDERER draws with: integer pixel fields.
 *
 * `Math.round` is deliberate. ASS `Fontsize`, `Outline` and the margins are
 * integer fields libass consumes, and rounding here rather than at each call
 * site means every consumer sees the same number -- the alternative is two
 * consumers rounding the same quantity in two places and disagreeing about a
 * pixel, which is a class of bug rather than a single one.
 */
export function scalePreset(
  preset                         ,
  output            ,
)                          {
  return scaled(preset, output, Math.round);
}

/**
 * What a BOUND is computed from, and nothing else. The renderer must never
 * call this -- its `capHeightPx` is fractional (25.3125 at 1:1) and libass
 * takes integers.
 *
 * The split is honest rather than a fudge, and the distinction is the whole
 * reason it exists: a ceiling is a geometric bound on a continuous quantity,
 * while `capHeightPx` and `outlineWidth` are integer fields. Rounding a bound
 * would make it disagree with itself at ratios that differ only by rounding
 * direction -- measured, the rounded basis gives 1.6091 / 1.6220 / 1.6220, a
 * 0.0129 spread from rounding alone.
 *
 * That is NOT the same basis as the 0.0474 a genuinely half-converted
 * geometry opens -- 0.0474 is measured against the exact, invariant 1.609087,
 * so setting it directly against the 0.0129 rounded-basis spread is not like
 * for like. Held to one basis instead, at the ratio the defect actually
 * shows: the rounded-basis gap is 0.0468, and 0.0339 of that is the defect's
 * own contribution once the 0.0129 of rounding noise already inside that
 * basis is subtracted back out -- still 2.6x the noise, so a separating
 * tolerance genuinely exists. It is just narrow enough that invariance (exact
 * equality across ratios), not a clearance tolerance, is the test that ships.
 * Exported only so the test that cross-checks the bound against the drawn
 * geometry can use the same basis the bound does.
 */
export function scalePresetExact(
  preset                         ,
  output            ,
)                          {
  return scaled(preset, output, (n) => n);
}

/**
 * The block's half-height as a multiple of `capHeightPx`, from the geometry
 * `buildPositioned` actually draws: `maxLines` lines spaced
 * `capHeightPx * lineSpacingRatio` apart, centred on `centreFraction`. It is
 * the same arithmetic the position band rests on (design §3.2's table), and
 * naming it once is what lets the size band below be derived from it rather
 * than guessed beside it.
 */
const blockHalfHeightRatio = (preset                         ) =>
  ((preset.maxLines - 1) * preset.lineSpacingRatio + 1) / 2;

/**
 * How far the tallest positioned preset could be scaled before its block, sat
 * at the LOWEST position the schema allows, leaves the frame.
 *
 * Derived, never typed by hand, and it exists because a size control and the
 * position band are not independent: a creator may set both to their extremes
 * at once. At `positionFraction` 0.9 there is a tenth of the frame between
 * the block's centre and the bottom edge, and a block of half-height
 * `ratio * capHeightPx * scale + outlineWidth` has to fit inside it.
 *
 * Was a constant, `CAPTION_SIZE_CEILING`, until stage 5 made the output frame
 * a variable. Under `scalePreset`'s height basis the frame height cancels
 * algebraically, so this is the SAME NUMBER at every ratio -- and its test
 * asserts that equality rather than merely that it clears CAPTION_SIZE_MAX.
 * The difference is not pedantic: a half-converted geometry (cap height
 * scaled, outline left absolute) yields 1.5617 at a 1080-tall frame, which
 * clears 1.4 and would ship silently. Clearance is blind to exactly the
 * defect this conversion is most likely to produce.
 *
 * Today the binding preset is `punch` (the largest `capHeightPx`, 52) at
 * ~1.609. A test pins this, so a future preset with more lines, looser
 * spacing or a bigger cap fails loudly rather than pushing captions off the
 * bottom of a rendered clip -- the same construction, and the same reason, as
 * the test that pins the position band itself.
 */
export function sizeCeilingOf(preset                         , output            )         {
  const p = scalePresetExact(preset, output);
  return (
    (output.height * (1 - CAPTION_POSITION_MAX) - p.outlineWidth) /
    (blockHalfHeightRatio(p) * p.capHeightPx)
  );
}

export function captionSizeCeiling(output            )         {
  return Math.min(...POSITIONED_PRESETS.map((preset) => sizeCeilingOf(preset, output)));
}

/**
 * The band a template may scale caption size within, as a multiple of
 * whichever preset the project chose.
 *
 * RELATIVE, not an absolute cap height, and that is the decision rather than a
 * detail: the four positioned presets deliberately differ in size (`punch` is
 * 52px against `clean`'s 40), so an absolute value would flatten a difference
 * the presets exist to express. A multiple preserves it and still means the
 * same thing on every preset — "a fifth bigger than whatever this is".
 *
 * It scales `capHeightPx`, which is safe for exactly the reason design §4.2
 * refuses a raw ASS `Fontsize` override: `buildPositioned` derives the font
 * size (`assFontSize(metrics, capHeightPx)`), the line spacing
 * (`capHeightPx * lineSpacingRatio`) and every width measurement from this one
 * number, so scaling it moves all three together. Overriding `Fontsize`
 * directly would move the glyphs and leave the spacing behind.
 *
 * The ceiling SHIPPED is 1.4, comfortably under the ~1.609 `captionSizeCeiling`
 * above computes -- at EVERY ratio, since the frame height cancels out of it,
 * which is why this stayed a flat number when the output frame stopped being
 * one. A bound that moved per ratio would have to be `min(1.4, ceiling(r))`,
 * and a bound that moves is what dropped a whole brand block on 2026-09-05.
 * The gap is margin because the two failure directions are not symmetric: too
 * large is a clipped caption burned into a clip forever and unrecoverable per
 * clip (`requeue-render.js` skips `ready` clips), while too small is merely
 * small.
 * The margin also covers the horizontal axis, which is not expressible as a
 * clean bound — `wrapGroup` absorbs a wider line by adding lines until
 * `maxLines`, and only then overflows.
 */
export const CAPTION_SIZE_MIN = 0.7;
export const CAPTION_SIZE_MAX = 1.4;

/**
 * The phrase every picker tile shows: mixed case, with a mark the four
 * positioned presets strip and `classic` keeps.
 *
 * An all-uppercase phrase was the first version and it MISREPRESENTED two of
 * the six. `classic` is `textCase: "preserve"` and the other four are
 * `"upper"`; feed them uppercase and that difference vanishes, so a user
 * choosing `classic` for a mixed-case transcript sees a tile promising
 * something the render will not do. The terminal stop does the same job for
 * `stripPunctuation`. Both are axes the user is choosing between, and a tile
 * silent on them is a tile that misleads about an irreversible choice.
 *
 * FOUR words, not five, and that is load-bearing rather than incidental.
 * `captionLines` splits a five-word sentence 3+2, so `classic`'s tile would
 * show three words and the mark would land on the second line, unrendered at
 * the capture instant — the punctuation difference invisible again, by a
 * different route. Four words is one line for `classic` (`maxWordsPerLine` 4)
 * and one group for the positioned presets (`round(4 / wordsTarget) === 1`).
 *
 * The wording is then bounded by width. Montserrat ExtraBold at a 45px cap is
 * the widest face in the table and `karaoke` pops the widest word by 28%, so
 * the budget is the tightest there: measured, this phrase plans 764px against
 * 875px, where "Watch the captions pop." plans 936 and wraps to two lines. A
 * wrapped karaoke beside five unwrapped siblings is a font consequence
 * masquerading as a style difference.
 *
 * **Here rather than beside the generator, for the reason `TILE_CROP_W`
 * gives:** the `default` tile is drawn in CSS from these words, and the
 * retired PNG mode of `caption-metrics.ts` rendered its tiles from them. The
 * loop tiles that replaced the PNGs in caption styles P2 render their own
 * sample (`LOOP_WORDS`, apps/worker/src/scripts/caption-loops.ts), so today
 * the `default` tile does say something different from the loops beside it.
 */
export const TILE_SAMPLE_WORDS = ["This", "is", "your", "caption."];

/**
 * Which word a tile shows mid-highlight, so every tile shows the accent
 * colour and the emphasis rather than a line of plain base-colour text.
 * Third rather than first because `karaoke` cycles two accent colours per
 * word and an interior word proves the cycle is running, and rather than
 * last because the last word carries the stop — highlighting it would put
 * the one mark that distinguishes `classic` inside the emphasis, where the
 * colour change is what the eye reads instead.
 */
export const TILE_ACTIVE_INDEX = 2;

/**
 * Mid grey rather than black. Captions are drawn with a black outline whose
 * whole job is to separate the text from video underneath it; on black that
 * outline is invisible, so a black tile would hide the one property the
 * presets differ in most (`clean` outlines at 4px, `karaoke` at 7,
 * `highlight` not at all — it uses a filled box instead).
 *
 * CSS form. The generator converts it to ffmpeg's `0x` spelling at the one
 * place it builds a `color=` source, rather than each reader keeping its own
 * literal.
 */
export const TILE_BACKGROUND = "#4A4A4A";
