// The images the agent may look at in a rolling hour (spec §7.7, `visionPerHour`, default 600). Each read of
// frames asks for its count first: `take(n)` is true and spends n, or false and spends nothing.
// `now` is a clock in seconds (epoch or any steady one); tests pass their own.
//
// `file` makes it a SESSION's hour: the moment run is one process per moment, and a watcher can restart, so the
// spends live in `<session>/vision.json` (lib/session.mjs visionFile), a list of [t, n] read on every call and
// pruned and written (temp file, then rename) on every spend. A missing or corrupt file counts as empty. Moments
// run one at a time, so two processes taking at the same instant is not guarded against.

import fs from "node:fs";

export const VISION_WINDOW_SEC = 3600;

function readSpent(file) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isInteger(e[1]) && e[1] > 0).map((e) => [e[0], e[1]]);
}

/** True when the file now holds `spent`. */
function writeSpent(file, spent) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(spent));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, JSON.stringify(spent)); // Windows can refuse a rename onto a file being read
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

export function visionBudget({ perHour = 600, now = () => Date.now() / 1000, file = null } = {}) {
  let spent = []; // [t, n], oldest first
  let failedWrites = false;

  function load(t) {
    // a file that cannot be written keeps the instance's own list; one that can is the truth
    if (file && !failedWrites) spent = readSpent(file);
    // a reading older than an hour is out; one of exactly an hour is still in
    spent = spent.filter(([at]) => t - at <= VISION_WINDOW_SEC);
    return spent.reduce((sum, [, n]) => sum + n, 0);
  }

  return {
    take(n) {
      if (!Number.isInteger(n) || n <= 0) return false;
      const t = now();
      const used = load(t);
      if (used + n > perHour) return false;
      spent.push([t, n]);
      if (file) failedWrites = !writeSpent(file, spent);
      return true;
    },
    used() {
      return load(now());
    },
  };
}
