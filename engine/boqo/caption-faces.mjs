// ported from boqo-ai/boqo packages/core/src/caption-faces.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { CAPTION_METRICS } from "./caption-metrics-table.mjs";

/**
 * Every face a caption or headline can be DRAWN in, and how. Wider than
 * `CAPTION_FONTS` (the faces a user may pick today) on purpose: P1 teaches the
 * renderer the pack, P2 decides what users pick from it.
 *
 * `bold` is the ASS Bold flag the face is measured AND drawn at. Measured
 * 2026-10-05 with `fc-query` on the pinned files: the six display faces with
 * bold 0 ship a single weight-400 instance. Asking libass for bold on one
 * synthesises it, which smears the glyphs: measured in boqo-render:latest
 * (2026-10-05, Bold -1 against 0 at size 100 over a 27-character line), ink
 * grew +9.8% on Anton, +11.5% on Bangers and +7.8% on Luckiest Guy, while the
 * advances moved by at most 1 px across the whole run (the final review's A/B,
 * reproduced the same day at +9.9/+11.7/+8.0% and 0/1/0 px). So Bold 0 is what
 * keeps the faces' designed weight; it is not what keeps the measured advances
 * right, which a synthetic bold barely moves. Poppins
 * Black is a real 900 instance, so -1 asks for nothing it lacks.
 *
 * `fallback` is the face drawn instead when a caption's text has a character
 * this face cannot draw. None of the seven covers Cyrillic (0/33 each, same
 * measurement), and boqo already renders Russian projects -- the reason
 * `punch` is Oswald and not Anton. Condensed faces fall back to condensed.
 */
                           
               
               
              
                    
     
                                                                        
                                                                             
                                                                        
                                                                            
                                                                              
                                                                                
    
                                                                              
                                                                              
                                                                       
                                                                                   
                                                             
                                                                    
                                                                     
                                                                               
                                                                              
                                                                              
                                                                         
                                                                           
                                                                             
                                                                              
                                                      
     
                      
                          
  

const face = (name        , bold        , css        , cssWeight        , cssCapPerEm        , fallback               )              =>
  ({ name, bold, css, cssWeight, cssCapPerEm, fallback });

export const CAPTION_FACES                                        = {
  "Montserrat ExtraBold": face("Montserrat ExtraBold", -1, "Montserrat", 800, 0.7, null),
  Oswald: face("Oswald", -1, "Oswald", 700, 0.81, null),
  Inter: face("Inter", -1, "Inter", 700, 0.7273, null),
  "DejaVu Sans": face("DejaVu Sans", -1, "DejaVu Sans", 700, 0.729, null),
  Anton: face("Anton", 0, "Anton", 400, 0.8594, "Oswald"),
  "Bebas Neue": face("Bebas Neue", 0, "Bebas Neue", 400, 0.7, "Oswald"),
  Bangers: face("Bangers", 0, "Bangers", 400, 0.721, "Montserrat ExtraBold"),
  "Poppins Black": face("Poppins Black", -1, "Poppins", 900, 0.713, "Montserrat ExtraBold"),
  "Archivo Black": face("Archivo Black", 0, "Archivo Black", 400, 0.688, "Montserrat ExtraBold"),
  "Luckiest Guy": face("Luckiest Guy", 0, "Luckiest Guy", 400, 0.6953, "Montserrat ExtraBold"),
  "Permanent Marker": face("Permanent Marker", 0, "Permanent Marker", 400, 0.7402, "Montserrat ExtraBold"),
};

export const NEW_CAPTION_FACES                    = [
  "Anton", "Bebas Neue", "Bangers", "Poppins Black", "Archivo Black", "Luckiest Guy", "Permanent Marker",
];

export function faceFor(name        )              {
  const found = CAPTION_FACES[name];
  if (!found) throw new Error(`no caption face ${JSON.stringify(name)}`);
  return found;
}

/**
 * The face a caption is actually drawn in: this one, unless some text holds a
 * character it was measured as missing (the generator records every probed
 * character that rendered no ink). Decided once per clip, not per word, so a
 * caption never mixes faces mid-line on a stray character.
 *
 * A character counts as missing when it OR its upper case is in the list: the
 * generator probes the Cyrillic capitals only, and a face that lacks "П" lacks
 * "п" too -- a lower-case Russian clip must fall back as surely as a capital
 * one (ruling R1; the probe set is not widened because that would change the
 * four existing faces' table entries).
 */
export function coveringFace(name        , texts                   )         {
  const f = faceFor(name);
  if (f.fallback === null) return name;
  const missing = new Set(CAPTION_METRICS[name]?.missing ?? []);
  if (missing.size === 0) return name;
  for (const t of texts) for (const ch of t) if (missing.has(ch) || missing.has(ch.toUpperCase())) return f.fallback;
  return name;
}
