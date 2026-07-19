// Updates the npm dependencies of a directory (e.g. collect/) to the newest
// stable versions that are at least MIN_AGE_CUTOFF old, then refreshes the
// lockfile. "At least a week old" is enforced by only adopting a version whose
// npm publish time is on or before the cutoff timestamp passed in the
// MIN_AGE_CUTOFF env var (an ISO 8601 string, e.g. 2026-07-12T06:00:00Z).
//
// Usage: MIN_AGE_CUTOFF=<iso> node update-npm-min-age.mjs <dir>
// Prints one line per bumped dependency; exits 0 with "no npm updates" if none.

import fs from "node:fs";
import { execSync } from "node:child_process";

const dir = process.argv[2];
if (!dir) {
  throw new Error("usage: update-npm-min-age.mjs <dir>");
}

const cutoffIso = process.env.MIN_AGE_CUTOFF;
if (!cutoffIso) {
  throw new Error("MIN_AGE_CUTOFF env var (ISO timestamp) is required");
}
const cutoff = new Date(cutoffIso).getTime();
if (Number.isNaN(cutoff)) {
  throw new Error(`MIN_AGE_CUTOFF is not a valid date: ${cutoffIso}`);
}

const pkgPath = `${dir}/package.json`;
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

// Only consider plain x.y.z releases, never prereleases (1.2.3-beta.1 etc.).
const isStable = (v) => /^\d+\.\d+\.\d+$/.test(v);

const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

const currentPinned = (range) => {
  const m = range.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
};

let changed = false;

for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  const deps = pkg[field];
  if (!deps) continue;

  for (const name of Object.keys(deps)) {
    const range = deps[name];
    // Preserve whatever range operator was already in use (^, ~, or exact).
    const prefix = range.startsWith("^") ? "^" : range.startsWith("~") ? "~" : "";

    let times;
    let versions;
    try {
      times = JSON.parse(execSync(`npm view ${name} time --json`, { encoding: "utf8" }));
      versions = JSON.parse(execSync(`npm view ${name} versions --json`, { encoding: "utf8" }));
    } catch (e) {
      console.error(`skip ${name}: ${e.message}`);
      continue;
    }
    if (!Array.isArray(versions)) versions = [versions];

    const eligible = versions.filter(
      (v) => isStable(v) && times[v] && new Date(times[v]).getTime() <= cutoff,
    );
    if (!eligible.length) continue;

    eligible.sort(cmp);
    const latest = eligible[eligible.length - 1];
    const cur = currentPinned(range);

    if (cur && cmp(latest, cur) > 0) {
      deps[name] = `${prefix}${latest}`;
      console.log(`${name}: ${range} -> ${deps[name]}`);
      changed = true;
    }
  }
}

if (changed) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  // Refresh the lockfile to match, without materializing node_modules.
  execSync("npm install --package-lock-only", { cwd: dir, stdio: "inherit" });
} else {
  console.log("no npm updates");
}
