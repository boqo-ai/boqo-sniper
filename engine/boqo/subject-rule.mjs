// ported from boqo-ai/boqo apps/worker/src/render/subject-rule.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Cut: `eq` (drizzle-orm), `Db` and `streamMoments` (@boqo/db) and the `SubjectRule` type import: the skill has no
// database. The one fact the query answered, whether this clip was cut from a Stream Sniper moment, is the caller's
// parameter `fromStreamMoment` (boqo-sniper's clips pass true, boqo-clips' never do), and with no read left the
// function is synchronous.

/**
 * Which face a clip's shots are about: `presence` for a Clips project made
 * from a Stream Sniper moment, `speaker` for every other one. See
 * `SubjectRule` (render/crop.ts) for what each means and the production clip
 * that made the difference.
 *
 * The ONE resolution point. `runRender`, the render harness and the editor
 * backfill all call this rather than each deciding for itself: a harness that
 * computes its own answer renders a different clip from production while
 * reporting the same numbers (finding F64).
 *
 * `stream_moments.clip_project_id` is the marker, and the only one: the
 * watcher inserts a moment's Clips project as `kind: "clips"`,
 * `source_kind: "upload"`, so nothing on the `projects` row says where it came
 * from. The column carries a unique index (`stream_moments_clip_project_idx`),
 * so this is one indexed read per render.
 *
 * The watcher writes `clip_project_id` AFTER it enqueues the project's ingest
 * (read in apps/watcher/src/clip/loop.ts at b6c0a08: `ingestQueue.add` comes
 * before the moment's `status: "clipped", clipProjectId` update), so the link
 * is briefly absent. Render runs after ingest, transcribe and select have all
 * finished, minutes later, so the gap closes long before this is read.
 */
export function resolveSubjectRule({ fromStreamMoment }) {
  return fromStreamMoment ? "presence" : "speaker";
}
