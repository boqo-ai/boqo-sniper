// The skill's npm packages (package.json `dependencies`: zod and onnxruntime-node) and what a tool says when they are
// not installed: one JSON line naming the install command, instead of Node's stack trace. A v0.1 install updated by
// `git pull` alone has none (v0.2 is the first version with packages), and so does a failed or skipped `npm ci`.
// This file imports only Node's own modules, so it loads without them.
import { readFileSync } from 'node:fs';

// The skill's own name (package.json), so the command names the folder it was cloned into: ~/.boqo-clips,
// ~/.boqo-channel or ~/.boqo-sniper (this file is shared by all three).
export const SKILL = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name || 'boqo-clips';
  } catch {
    return 'boqo-clips';
  }
})();

/** INSTALL.md's one npm command. Windows PowerShell 5.1 has no `&&`; `;` separates two commands there and in Git Bash alike. */
export const npmCi = (platform = process.platform) => `cd "$HOME/.${SKILL}"${platform === 'win32' ? ';' : ' &&'} npm ci --omit=dev --ignore-scripts`;

/**
 * The npm package a failed import names as not installed, or null for any other error. Node's error for a bare
 * specifier that does not resolve is code `ERR_MODULE_NOT_FOUND` with the message `Cannot find package 'zod' imported
 * from <file>` (measured 2026-11-17 on Node 20.19.4, 22.20.0 and 24.22.2); a missing relative file is the same code
 * with `Cannot find module`, which is not a package and stays null.
 */
export function missingPackage(err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return null;
  return /Cannot find package '([^']+)'/.exec(String(err.message))?.[1] ?? null;
}

/** The `{"error"}` text a tool prints when `name` is not installed. */
export const notInstalled = (name, platform = process.platform) => `the skill's packages are not installed (no ${name}): ${npmCi(platform)}`;

/**
 * `importer()`'s modules. When a package they need is not installed, prints `{"error"}` (notInstalled) and ends the
 * process with exit 1 once the line is written; any other error is thrown. A tool loads its engine modules through
 * this, before anything else runs: a static import of a missing package fails before the tool's first line runs, so
 * nothing can print a JSON line (measured 2026-11-17: from a copy with no node_modules, 11 of the 14 tools died with
 * Node's stack trace and no JSON).
 * @template T
 * @param {() => Promise<T>} importer
 * @returns {Promise<T>}
 */
export async function needPackages(importer) {
  try {
    return await importer();
  } catch (err) {
    const name = missingPackage(err);
    if (name === null) throw err;
    // Nothing native is loaded yet, so exiting is safe: the one import of onnxruntime-node is the dynamic one inside
    // engine/blazeface.mjs's loader (grep, 2026-11-17), which runs only when a tool asks for the face model.
    return new Promise(() => {
      process.stdout.write(`${JSON.stringify({ error: notInstalled(name) })}\n`, () => process.exit(1));
    });
  }
}
