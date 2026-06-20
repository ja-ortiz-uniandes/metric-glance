# Metric Glance — Agent Guide

## What this project is

Metric Glance is a Firefox extension (desktop and Android, MV2) that converts US/imperial units to metric and rounds awkward prices directly on the page. Converted values get a dotted underline; hover (desktop) or tap (mobile) to see the original, switch interpretations, or open a searchable unit picker.

Detection is a deterministic regex engine. The long-term plan is to replace detection only with a small token-classification encoder fine-tuned on user-labeled training examples, slotted into the `proposeSpans()` seam in `converter.js`. The arithmetic always comes from a fixed conversion table and is never touched by the model.

The extension also ships an off-device data pipeline: it logs labeled training examples locally, then (with user consent) uploads them to a Cloudflare Worker + D1 backend.

- Repo: `github.com/ja-ortiz-uniandes/metric-glance`, branch `main`
- Local path: `C:\Users\joral\Git projects\metric-glance` (Windows; LF->CRLF git warnings are harmless)
- Current version: `0.40.0`
- Contact: `metric.glance@proton.me`
- No build step. Plain JavaScript throughout.

---

## Formatting constraint

**Do not use em dashes** in any text output: commit messages, code comments, UI copy, docs, or anything else written for this project. Use commas, parentheses, or separate sentences instead.

---

## Repo structure

```plaintext
extension/          The only thing packaged into the .xpi
  manifest.json     MV2 manifest (version, permissions, background scripts)
  converter.js      Main content script: detection, conversion, hover panel,
                    picker, corrections, training-data logging
  background.js     Desktop right-click menu, keyboard command, onInstalled handler
  mg-uploader.js    Background uploader: signs and POSTs training records to backend
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

// Temporarily enable sharing (until options UI sets it)
await browser.storage.local.set({ shareData: true })
```

### Backend commands (run from collect/)

```bash
npm run count    // row count and most recent received_at
npm run tail     // stream live Worker logs
npm run deploy   // deploy the Worker
npx wrangler d1 execute metric-glance --remote --command "DELETE FROM submissions"
```

### Version bumps

One bump per change batch. A batch equals an AMO upload + GitHub release + repo commit. Verify each feature before bumping.

### Committing

`CLIENT_SECRET` in `mg-uploader.js` is the live HMAC secret and is intentionally kept in source (the secret ships in the .xpi and is extractable regardless). It is fine to commit as-is.

---

## Roadmap

### Done

| Item | Description |
| ------ | ------------- |
| #2 | Deploy Cloudflare Worker + D1 backend |
| #6 | Race-safe hard-delete uploader (mg-uploader.js) |
| #5 | Settings toggles: logSamples and shareData, with options UI and nudge banner |
| #4 | First-run consent: welcome.html opens on install, both features default on, user can turn either off before confirming |

### Remaining

### #3: Privacy policy + AMO disclosure (release gate)

This is the only thing blocking a public AMO release that transmits data.

- Publish a privacy policy at a URL. Describe exactly what the pipeline sends (the record fields in the client/server contract above), that the URL is hostname-only, the per-install random ID, retention, and how to opt out.
- Change `data_collection_permissions` in `manifest.json` from `["none"]` to the correct categories (at minimum `websiteContent`). Verify the current Mozilla allowed enum at submission time.
- Complete the AMO data-collection disclosure during submission.

Until #3 is done: do not submit a version to AMO that contains the uploader. Keep released builds as local-only by leaving `shareData` defaulting to off in any build that goes to AMO, or hold the release entirely.

### Commit and version bump to 0.38.0

The current working tree contains all the pipeline work. Batch it into one commit and bump.

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
