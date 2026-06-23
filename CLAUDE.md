# Metric Glance — Agent Guide

## What this project is

Metric Glance is a Firefox extension (desktop and Android, MV2) that converts US/imperial units to metric and rounds awkward prices directly on the page. Converted values get a dotted underline; hover (desktop) or tap (mobile) to see the original, switch interpretations, or open a searchable unit picker.

Detection is a deterministic regex engine. The long-term plan is to replace detection only with a small token-classification encoder fine-tuned on user-labeled training examples, slotted into the `proposeSpans()` seam in `converter.js`. The arithmetic always comes from a fixed conversion table and is never touched by the model.

The extension also ships an off-device data pipeline: it logs labeled training examples locally, then (with user consent) uploads them to a Cloudflare Worker + D1 backend.

- Repo: `github.com/ja-ortiz-uniandes/metric-glance`, branch `main`
- Local path: `C:\Users\joral\Git projects\metric-glance` (Windows; LF->CRLF git warnings are harmless)
- Current version: `0.45.1`
- Contact: `metric.glance@proton.me`
- No build step. Plain JavaScript throughout.

---

## Formatting constraint

**Do not use em dashes** in any text output: commit messages, code comments, UI copy, docs, or anything else written for this project. Use commas, parentheses, or separate sentences instead.

---

## Python and notebook conventions

These apply to the `train/` tooling (notebook and scripts).

- **Always type-hint Python code.** Annotate function signatures and variable assignments (e.g. `df: pd.DataFrame = ...`, `n: int = ...`), matching the style already in `train/classifier.ipynb`. When a library returns an untyped value (e.g. `train_test_split` is typed as `list[Any]`), use `typing.cast` so the result has a known type.
- **Imports go at the top of the notebook**, in the first import cell, not scattered in later cells. Add new imports there rather than inline where first used.

---

## Repo structure

```plaintext
extension/          The only thing packaged into the .xpi
  manifest.json     MV2 manifest (version, permissions, background scripts)
  converter.js      Main content script: detection, conversion, hover panel,
                    picker, corrections, training-data logging
  background.js     Desktop right-click menu, keyboard command, onInstalled handler,
                    toolbar-button badge sync, per-site disable-list helpers
  mg-uploader.js    Background uploader: signs and POSTs training records to backend
  mg-privacy-watch.js  Background watcher: polls the published privacy policy and
                    notifies the user when its version marker changes
  popup.html        Toolbar-button menu (open settings, toggle this site off/on)
  popup.js          Script for popup.html (external; inline scripts CSP-blocked)
  options.html      Settings page UI
  options.js        Settings page logic
  welcome.html      First-run onboarding page (opens on install)
  welcome.js        Script for welcome.html (must be external; inline scripts are
                    blocked by the extension CSP)
  styles.css        Content script styles
  icons/            icon-48.png, icon-96.png

collect/            Backend. Never shipped in the add-on.
  worker.js         Cloudflare Worker
  schema.sql        D1 table definition
  wrangler.toml     Cloudflare config
  package.json      npm scripts (login, deploy, tail, count, etc.)

docs/               Live demo/test page published via GitHub Pages from /docs
```

---

## Architecture: data pipeline

### How training data flows

1. `converter.js` logs labeled examples to `browser.storage.local` under the key `mgTraining`, structured as `{ corrected: [], seen: [], auto: [] }`.
   - `corrected` tier: always logged. Every user action (convert-as, interpretation, price correction, not-a-conversion) is recorded here unconditionally.
   - `seen` tier: logged only when `settings.logSamples === true`. Records entries the user hovered but did not correct.
   - `auto` tier: logged only when `settings.logSamples === true`. A random sample (12%) of correct auto-detections, for dataset balance.

2. `mg-uploader.js` runs in the background (alongside `background.js`) and uploads batches to the Worker. It only transmits when `settings.shareData === true`. It is completely inert otherwise.

3. The Worker validates, deduplicates, and stores records in D1.

### Settings that control data collection

Both default to `false` in `DEFAULT_SETTINGS` (converter.js) and `DEFAULTS` (options.js). The welcome page defaults both to `true` for new users.

- `logSamples`: whether to log the `seen` and `auto` tiers locally
- `shareData`: whether to upload stored records to the backend

### Keep the privacy policy in sync (REQUIRED)

Whenever a change affects **what data is collected or how it is used**, update the privacy policy in the same change batch. This includes (non-exhaustively):

- adding, removing, or changing a record field (see `toWire()` in `mg-uploader.js` and the worker's validation)
- changing a collection tier, default, or consent gate (`logSamples`, `shareData`, the welcome-page defaults)
- changing retention, the backend destination, or who the data is shared with
- changing the `install_id` or any other identifier behavior

When that happens, do all of the following together:

1. Edit `docs/privacy.html`: update the relevant text (e.g. the field table) **and** bump the visible "Last updated" date.
2. Bump the `<meta name="mg-privacy-version">` content in `docs/privacy.html` to that same new "Last updated" date.
3. Update `CURRENT_PRIVACY_VERSION` in `extension/mg-privacy-watch.js` to match the new marker exactly.

The marker and `CURRENT_PRIVACY_VERSION` must always be equal at release time. The watcher fetches the published page, compares the marker against the version the install last saw, and notifies the user on a change (system notification + a banner in Preferences). If the marker is not bumped, existing users are not told the policy changed.

### Security model (proportionate to a training set, not money)

- HMAC-SHA256 over `timestamp + "." + rawBody`, plus a +/- 5 min timestamp window
- Strict server-side per-record validation
- Per-install daily cap (2000 rows / 24h via D1 COUNT query)
- UNIQUE `dedup_key` makes client retries idempotent
- The secret ships in the extension and is extractable (acknowledged). Defense is layered validation and human review before any fine-tune.

### Live infrastructure

- Endpoint: `https://mg-collect.metric-glance.workers.dev`
- D1 database: `metric-glance`, id `3bd689b6-26a8-466d-ad94-fd37b4d9677a`, region ENAM
- HMAC secret: set on the Worker via `wrangler secret put MG_HMAC_SECRET`. Must equal `CLIENT_SECRET` in `mg-uploader.js`. Not in source control.

### Client/server contract

POST `{ install_id, records: [...] }` with headers `X-MG-Ts` (epoch seconds) and `X-MG-Sig` (HMAC-SHA256 hex). Success response: `{ ok: true, inserted, skipped }`. On `ok: true`, the uploader hard-deletes the sent records from local storage (race-safe set-difference re-read).

---

## Key seams for future work

- `proposeSpans()` in `converter.js`: where the regex engine currently runs. Slot a trained encoder here when ready. The `useEncoder` and `encoderModelUrl` settings keys are already in `DEFAULT_SETTINGS` as placeholders.
- `logTrainingExample()` in `converter.js`: the single function that writes all training records. All tiers flow through here.
- `runCycle()` in `mg-uploader.js`: the upload cycle. Called on the hourly `mg-upload` alarm and ~15s after background wake.

---

## Development workflow

### Loading the extension

1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" and select `extension/manifest.json`
3. On install, `welcome.html` opens automatically as a tab

### Testing the uploader manually

Open the background page console (click Inspect on the Metric Glance row in about:debugging):

```js
// Check stored training data
(await browser.storage.local.get({mgTraining:{}})).mgTraining

// Force an upload cycle
await browser.runtime.sendMessage({ type: "mg-upload-now" })

// Force-enable sharing without going through Preferences
await browser.storage.local.set({ shareData: true })
```

### Backend commands (run from collect/)

```bash
npm run count    // row count and most recent received_at
npm run tail     // stream live Worker logs
npm run deploy   // deploy the Worker
npx wrangler d1 execute metric-glance --remote --command "DELETE FROM submissions"
```

### Releasing (automated)

**NEVER push a version tag (`git tag v*` / `git push origin v*`) without the owner's explicit instruction, every single time.** A tag triggers a real AMO submission and public release, so it is never implied by "ship it", "release it", finishing a feature, or bumping the version. Bumping the manifest and committing is fine when asked; the tag push is a separate step that always requires its own explicit go-ahead. The same applies to manually dispatching the release workflow (it also does a real AMO submission).

Releases run through `.github/workflows/release.yml`. One bump per change batch (a batch is one AMO upload + GitHub release + repo commit); verify each feature before bumping. To release: bump the version in `extension/manifest.json`, commit, then push a tag:

```bash
git tag v<version> && git push origin v<version>
```

Pushing a `v*` tag runs the workflow, which:

1. Checks the tag (minus the `v`) matches the manifest version, then lints with `web-ext lint`.
2. Builds the unsigned source zip (contents of `extension/` with `manifest.json` at the root, same as `build-zip.ps1`).
3. Submits to AMO on the **listed** channel via `web-ext sign`. Listed is what updates the public AMO listing; unlisted does not, so we always use listed. AMO validates and signs, and web-ext downloads the signed `.xpi`.
4. Creates a GitHub release with auto-generated notes, attaching both the source `.zip` and the signed `.xpi`.

Notes:

- Required repo secrets (Settings -> Secrets and variables -> Actions): `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, from addons.mozilla.org/developers/addon/api/key. Unrelated to the HMAC secret in `mg-uploader.js`.
- The workflow can also be run manually (workflow_dispatch). A manual run lints and submits to AMO but skips the tag guard and the GitHub release. It still does a **real AMO submission** of the current manifest version, so do not dispatch a version you are not ready to ship, and do not later tag that same version (AMO rejects a duplicate).
- Node 24 (current Active LTS) is pinned in the workflow.
- `build-zip.ps1` still builds a local zip by hand without releasing.

#### Pre-releases and release notes

The workflow derives each GitHub release's visibility from the version number:

- **Pre-release ("Developer preview")**: the entire `0.x` series, and any version with a non-zero patch (`x.y.1`, `x.y.2`, ...). These are marked as pre-release (so GitHub does not flag them "Latest") and titled `vX.Y.Z - Developer preview` (a plain hyphen, never an em dash, per the formatting rule).
- **Full "Latest" release**: only `major >= 1` with a `.0` patch (e.g. `v1.0.0`, `v1.3.0`).

While the project is in `0.x`, every release is a developer preview. The rule lives in the "Create GitHub release" step of `release.yml`.

Release notes are prose pulled from `CHANGELOG.md`. The workflow takes everything between a heading that exactly matches the tag (`## vX.Y.Z`) and the next `##` heading, and uses it as the release body. The workflow never writes prose itself: if there is no matching section it silently falls back to GitHub's auto-generated commit list. **So the changelog section is a required, human-written step, not something the pipeline produces.** (The older `v1.x` headings in that file are internal feature milestones, not release tags, and are not used by the workflow.)

##### How to write the changelog entry (do this every release, before tagging)

When bumping the version, write the `## v<version>` section like this:

1. Find the previous release tag (`git tag --sort=-v:refname | head`) and review what actually changed since it: `git log v<prev>..HEAD --oneline` and `git diff v<prev>..HEAD` for the substance.
2. Summarize **only the changes that matter to a user or to a maintainer reading later**. Skip version bumps, internal refactors, CI tweaks, formatting, and anything invisible in use. A release with nothing user-facing can say so in one line.
3. Write **prose**, not a raw bullet dump of commit subjects. Group related changes, explain what changed and why it matters, and call out any migration or one-time consent re-prompt. Past entries in this file are the style reference.
4. No em dashes (see the formatting constraint at the top of this file).
5. Add the section **before** creating the tag. The workflow reads `CHANGELOG.md` at the tagged commit, so a section added after tagging is not picked up.

### Committing

`CLIENT_SECRET` in `mg-uploader.js` is the live HMAC secret and is intentionally kept in source (the secret ships in the .xpi and is extractable regardless). It is fine to commit as-is.

---

## Roadmap

The data pipeline (backend, uploader, consent UI, privacy policy, AMO disclosure) is complete and live. Remaining work is the detection classifier.

### Accumulate training data

Once the extension is live with collection enabled, let corrections and seen-entries accumulate in D1. Run `npm run count` periodically from `collect/` to monitor.

### Train the classifier

When enough labeled data exists (hundreds to low thousands of corrected examples is a reasonable starting point):

- Export from D1
- Fine-tune a token-classification encoder (e.g. a small BERT variant) on the span-detection task
- Export to ONNX for browser inference

### Integrate the classifier

- Load the ONNX model via `encoderModelUrl`
- Slot inference into `proposeSpans()` behind the `useEncoder` flag
- Run the regex engine and the encoder in parallel during a transition period, log disagreements as training signal
- Remove the regex engine once the encoder is reliable

---

## Gotchas

- **Inline scripts are blocked** by the extension CSP. All JS must be in external `.js` files referenced via `<script src="...">`. This is why `welcome.js` is a separate file.
- **Non-persistent background page** (`"persistent": false`). The background page can be unloaded between events. Do not rely on in-memory state across alarm firings.
- **`browser.storage.local` has no transactions**. The uploader uses a race-safe set-difference pattern: re-read fresh after server ack, remove only confirmed keys. Never write back a stale snapshot.
- **`window.close()` does not work** for tabs opened via `tabs.create`. Use `tabs.query({ active: true, currentWindow: true })` + `tabs.remove()` instead, or just show a "you can close this" message.
- The `collect/` directory has its own `.gitignore` that re-includes `package.json` and `package-lock.json` (the root `.gitignore` would otherwise exclude them).
- LF->CRLF git warnings on Windows are harmless; do not add `.gitattributes` to suppress them without checking the team's preference first.
