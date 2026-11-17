// ported from boqo-ai/boqo apps/worker/src/select/video-context.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)



const isRecord = (value         )                                   =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value         )                  => typeof value === "number" && Number.isFinite(value);

/** A string, or null: the prompt builder throws on anything else. */
const textOrNull = (value         )                => (typeof value === "string" ? value : null);

/**
 * The jsonb columns are typed but come from Postgres, which accepts any JSON,
 * and `buildUserMessage` throws on a non-string it is asked to sanitise. So a
 * value that is not an array is unknown (null) and an entry of the wrong shape
 * is dropped: a malformed row costs its signal, never the select.
 */
function listOrNull   (value         , keep                              )             {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const kept = keep(entry);
    return kept === null ? [] : [kept];
  });
}

const chapterOf = (entry         )                 =>
  isRecord(entry) && isNumber(entry.startSec) && typeof entry.title === "string"
    ? { startSec: entry.startSec, title: entry.title }
    : null;

const reactionOf = (entry         )                        =>
  isRecord(entry) && isNumber(entry.sec) && isNumber(entry.likes) && typeof entry.text === "string"
    ? { sec: entry.sec, likes: entry.likes, text: entry.text }
    : null;

/**
 * What the selector is told about a YouTube video besides its transcript
 * (selector-signals spec §6), or null for a project that has nothing to say.
 *
 * Only `youtube` projects get one: an upload's `title` is a filename it was
 * given, and a stream project's is a generated watch title (`watchTitle`,
 * apps/web/src/server/streams.ts) -- neither is the uploader's own description
 * of the video (spec §13). An empty chapters or reactions list is
 * known-empty and is passed through; `buildUserMessage` writes nothing for it,
 * so the message is the same as for null. Stored values of the wrong shape are
 * treated as unknown or dropped (see `listOrNull`); nothing here throws.
 */
export function videoContextOf(
  project                                                                                                        ,
)                      {
  if (project.sourceKind !== "youtube") return null;
  const context               = {
    title: textOrNull(project.title),
    channelName: textOrNull(project.channelName),
    description: textOrNull(project.description),
    chapters: listOrNull(project.chapters, chapterOf),
    reactions: listOrNull(project.viewerReactions, reactionOf),
  };
  return Object.values(context).every((value) => value === null) ? null : context;
}
