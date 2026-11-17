// ported from boqo-ai/boqo packages/core/src/publish-posts.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// A partial hand port, not a strip: the file is mostly zod schemas and post vocabulary. Kept here are
// PLATFORM_LIMITS (its `text` and `title` limits; the duration and ratio limits go with the refusals),
// clampCopy and fallbackCopy, verbatim but for the types. This is the rule hosted's Clips page uses to
// write each post's words from a clip's title and hook (`postMany`, apps/web/src/server/publish-posts.ts:
// "a template and not AI"); tests/golden/post-caption.json is boqo's own output for it.
//
// `captionFor` is not boqo's: it calls fallbackCopy and drops a half emoji left at a cut (see there).

/** What each platform takes of a post's words (spec §6.9, plan ruling R12): `text` is the caption (TikTok, Instagram) or the description (YouTube); `title` is YouTube's. */
export const PLATFORM_LIMITS = {
  tiktok: { text: 2200, title: null },
  instagram: { text: 2000, title: null },
  youtube: { text: 5000, title: 100 },
};

/** Cuts copy to the platform's limits (the model's output is trimmed before it is shown, §6.8). */
export function clampCopy(platform, copy) {
  const limits = PLATFORM_LIMITS[platform];
  const text = copy.text.slice(0, limits.text);
  return platform === 'youtube' ? { title: (copy.title ?? '').slice(0, limits.title), text } : { text };
}

/** §6.8's fallback: the hook, the title and the account's hashtags, with nothing invented. */
export function fallbackCopy(platform, clip, tags) {
  const tagLine = tags.map((t) => `#${t}`).join(' ');
  const hook = clip.hook?.trim() || null;
  if (platform === 'youtube') {
    return clampCopy(platform, { title: clip.title.trim(), text: [hook, tagLine].filter(Boolean).join('\n\n') });
  }
  return clampCopy(platform, { text: [hook ?? clip.title.trim(), hook ? clip.title.trim() : null, tagLine].filter(Boolean).join('\n\n') });
}

// A cut by UTF-16 unit can leave the first half of an emoji at the end; a JSON string with half a pair is not text.
const dropHalfPair = (s) => (/[\ud800-\udbff]$/.test(s) ? s.slice(0, -1) : s);

/**
 * fallbackCopy for a skill's post: the same words as hosted writes, except that a cut never ends on half of an
 * emoji (hosted's `slice` can; the half pair is dropped here, one character shorter than hosted's).
 */
export function captionFor(platform, clip, tags) {
  const copy = fallbackCopy(platform, clip, tags);
  return platform === 'youtube' ? { title: dropHalfPair(copy.title), text: dropHalfPair(copy.text) } : { text: dropHalfPair(copy.text) };
}

/** A comma-separated list of tags ("#clips, gaming") as names without the #; a tag with a space or a # inside is an error. */
export function tagsOf(list) {
  const tags = String(list ?? '')
    .split(',')
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t !== '');
  for (const t of tags) if (/[\s#,]/.test(t)) throw new Error(`a tag is one word without a space or #: "${t}"`);
  return tags;
}
