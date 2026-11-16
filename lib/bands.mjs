// The score bands (spec §6; boqo's apps/web/src/components/score-grade.ts scoreBand @ bcc9d99cc):
// exceptional >= 85, strong >= 70, decent >= 60, watchable >= 40, weak below 40.
// A local copy of the five thresholds until the engine sync brings the ported score-grade; Task B4b swaps this
// file's import for the engine's and deletes it.

export function scoreBand(score) {
  if (score >= 85) return "exceptional";
  if (score >= 70) return "strong";
  if (score >= 60) return "decent";
  if (score >= 40) return "watchable";
  return "weak";
}
