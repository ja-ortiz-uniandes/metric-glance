// Bumps the patch number of the extension version in extension/manifest.json
// (0.47.0 -> 0.47.1) and appends a matching "## vX.Y.Z" maintenance section to
// the bottom of CHANGELOG.md so release.yml has notes to publish. Only the
// version digits in the manifest are touched; the rest of the file is left
// byte-for-byte intact. Prints the new version (and nothing else) to stdout so
// the workflow can capture it.

import fs from "node:fs";

const manifestPath = "extension/manifest.json";
let manifest = fs.readFileSync(manifestPath, "utf8");

const m = manifest.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/);
if (!m) {
  throw new Error("could not find a version field in extension/manifest.json");
}
const newVersion = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
manifest = manifest.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${newVersion}$2`);
fs.writeFileSync(manifestPath, manifest);

const changelogPath = "CHANGELOG.md";
let changelog = fs.readFileSync(changelogPath, "utf8");

if (!changelog.includes(`## v${newVersion}`)) {
  const section = [
    "",
    `## v${newVersion}`,
    "",
    "### Maintenance",
    "",
    "Routine upkeep release to keep the add-on current on its listing. The",
    "development tooling (the collect/ backend and train/ pipeline) was refreshed",
    "to recent dependency versions, each at least a week old, and the extension",
    "version was bumped. The extension's behavior is unchanged, and there is no",
    "change to what data is collected or how it is shared.",
    "",
  ].join("\n");

  if (!changelog.endsWith("\n")) changelog += "\n";
  changelog += section;
  fs.writeFileSync(changelogPath, changelog);
}

process.stdout.write(newVersion);
