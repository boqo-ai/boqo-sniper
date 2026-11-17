// ported from boqo-ai/boqo packages/core/src/stranger.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";

/** The prompt generation the judgment ran under; `annotate.py` is its source. */
export const STRANGER_PROMPT_VERSION = "annotate-2026-10-16";

// Field names, literal values and their order are ported from the pydantic
// `Annotation` class, docs/research/scripts/annotate.py:27-48 (read, 2026-10-18).
export const HOOK_TYPES = ["spoken_claim", "spoken_question", "spoken_story", "visual_action", "on_screen_text", "cold_open_mid_sentence", "none_slow_start"]         ;
export const NARRATIVE_ARCS = ["setup_tension_payoff", "payoff_first_then_context", "list_or_tips", "single_statement", "rant_or_reaction", "montage_no_speech", "unclear"]         ;
export const ENDS_WITH = ["punchline_or_payoff", "cliffhanger_or_question", "loop_back_to_start", "fades_or_trails_off", "cut_mid_sentence", "call_to_action"]         ;
export const SHARE_TRIGGERS = ["identity_or_relatable", "humour", "outrage_or_controversy", "utility_or_lesson", "awe_or_surprise", "emotion_or_inspiration", "none_evident"]         ;
export const ANNOTATION_CAPTION_STYLES = ["none", "word_by_word_highlight", "phrase_blocks", "full_sentences", "burned_in_platform_style"]         ;
export const ANNOTATION_CAPTION_POSITIONS = ["none", "top", "center", "lower_third", "bottom"]         ;
export const BROLL_LEVELS = ["none", "a_few", "frequent"]         ;
export const LAYOUTS = ["single_speaker_crop", "two_speakers_split_or_stack", "wide_or_fit_with_bars", "gameplay_plus_cam", "mixed_or_other"]         ;
export const ZOOM_LEVELS = ["none", "some", "many"]         ;
export const MUSIC_GUESSES = ["unknown", "likely_music_under_voice", "music_only", "no_music"]         ;
export const EMOTIONAL_PEAKS = ["none", "laughter", "shock", "anger", "tears_or_tenderness", "awe", "tension"]         ;

/** The vision pass's structured answer about one clip. Model judgments, never measured facts. */
export const AnnotationSchema = z.object({
  hook_type: z.enum(HOOK_TYPES).describe("what carries the first 1-3 seconds"),
  hook_text: z.string().describe("the opening line or on-screen text, verbatim if visible, <= 25 words"),
  hook_promises_payoff: z.boolean().describe("does the opening set up a question, claim or tension the rest must resolve"),
  time_to_payoff_s: z.number().nullable().describe("seconds until the main payoff lands, if it does; null if no clear payoff"),
  narrative_arc: z.enum(NARRATIVE_ARCS),
  ends_with: z.enum(ENDS_WITH),
  comprehensible_without_context: z.number().int().min(1).max(5).describe("1 = a stranger is lost, 5 = fully self-contained"),
  share_trigger: z.enum(SHARE_TRIGGERS),
  comment_bait: z.boolean().describe("an open question, a disputed claim, or an invitation that would provoke comments"),
  caption_style: z.enum(ANNOTATION_CAPTION_STYLES),
  caption_position: z.enum(ANNOTATION_CAPTION_POSITIONS),
  title_card_or_headline: z.boolean().describe("a persistent title/headline text separate from captions"),
  on_screen_text_other: z.boolean().describe("other text overlays: labels, arrows, stats, memes"),
  broll_or_cutaways: z.enum(BROLL_LEVELS).describe("inserted footage/images other than the speakers"),
  layout: z.enum(LAYOUTS),
  visible_zoom_punches_or_jumpcuts: z.enum(ZOOM_LEVELS).describe("inferred from frame-to-frame framing changes"),
  music_present_guess: z.enum(MUSIC_GUESSES).describe("from visual cues and transcript only; the audio is not provided, so default to unknown"),
  emotional_peak: z.enum(EMOTIONAL_PEAKS),
  overall_quality_judgment: z.number().int().min(1).max(5).describe("your guess of how compelling this is as a short, 1-5; a judgment, not a fact"),
  one_line_why: z.string().describe("in one sentence: what would make a stranger keep watching or stop"),
});
                                                          

/** The `stranger` column: one cold-viewer judgment of a clip, with the run that produced it. */
export const StrangerSchema = z.object({
  v: z.literal(1),
  promptVersion: z.string(),
  model: z.string(),
  selectionModel: z.string(),
  effort: z.string(),
  frames: z.number(),
  fileVersion: z.string(),
  judgment: z.number().int().min(1).max(5),
  why: z.string(),
  annotation: AnnotationSchema,
  costUsd: z.number(),
  sha: z.string().nullable(),
  judgedAt: z.string(),
});
                                                      

/** Total, like every jsonb reader here. */
export function parseStranger(raw         )                  {
  const parsed = StrangerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
