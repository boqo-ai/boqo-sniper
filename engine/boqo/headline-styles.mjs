// ported from boqo-ai/boqo packages/core/src/headline-styles.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * The six headline looks (spec §2.1; mockup `CS.HLS`). `plate` with no effects
 * and no entrance IS today's headline — `buildHeadlineAss` given it, or given no
 * style at all, emits the same bytes (Task 8).
 */
                                                                                         
                                                                          
                             
                        
                
                        
                                                                                                                 
                                    
                                              
                      
                                                    
                     
                                                                                                                                    
                       
                                                             
                                  
                                                   
                                              
                                            
                                 
              
                             
                
  

const h = (key                  , label        , tier                 , o                        )                =>
  ({ key, label, tier, look: "plate", font: null, textColour: "#FFFFFF", rot: 0, entrance: "none", speed: 1, ...o });

export const HEADLINE_STYLES                  = [
  h("plate", "Plate", "free", {}),
  h("outline", "Outline", "free", { look: "text", font: "Anton", outline: { colour: "#000000", widthRatio: 0.12 }, entrance: "pop" }),
  h("neon", "Neon", "plus", { look: "text", font: "Bebas Neue", glow: { colour: "#29E7FF", strength: 0.85 }, entrance: "fade" }),
  h("marker", "Marker", "plus", { look: "marker", font: "Permanent Marker", textColour: "#16131C", plateColour: "#FFE14D", textCase: "preserve", entrance: "slide" }),
  h("tag", "Tag", "plus", { look: "plate", font: "Poppins Black", rot: -3, entrance: "pop" }),
  h("stack", "Shadow Stack", "plus", { look: "text", font: "Archivo Black", shadow: { kind: "hard", colour: "#7C4DFF" }, entrance: "type" }),
];

/** The six keys as a tuple, for `BrandHeadline.style`; a test binds it to the table. */
export const HEADLINE_STYLE_KEYS = ["plate", "outline", "neon", "marker", "tag", "stack"]                                               ;

/** `captionStyleTier`'s twin: a headline style's own `tier`, free for anything unknown. */
export function headlineStyleTier(key                           )                  {
  return HEADLINE_STYLES.find((style) => style.key === key)?.tier ?? "free";
}

                                                                                                     

export function headlineKnobsFor(style               )                 {
  // Text colour only where the style draws text without a plate: on a plate or
  // tag the ink is computed from the plate by `headlineInk` (core headline.ts),
  // the contrast guarantee no knob may undo (P2-R13).
  const k                 = [{ key: "font", label: "Font", kind: "font" }, { key: "size", label: "Size", kind: "range" }, { key: "case", label: "Case", kind: "seg" }];
  if (style.look !== "plate") k.push({ key: "textColour", label: "Text", kind: "colour" });
  if (style.look !== "text") k.push({ key: "plateColour", label: style.look === "marker" ? "Highlighter" : "Plate", kind: "colour" });
  if (style.outline) k.push({ key: "outlineColour", label: "Outline", kind: "colour" });
  if (style.glow) k.push({ key: "glowColour", label: "Glow", kind: "colour" }, { key: "glowStrength", label: "Glow strength", kind: "range" });
  if (style.shadow) k.push({ key: "shadowColour", label: "Shadow", kind: "colour" });
  k.push({ key: "entrance", label: "Entrance", kind: "seg" });
  if (style.entrance !== "none") k.push({ key: "speed", label: "Animation speed", kind: "range" });
  return k;
}

export function headlineStyleFingerprint()         {
  return JSON.stringify(HEADLINE_STYLES.map(({ label: _label, ...rest }) => rest));
}
