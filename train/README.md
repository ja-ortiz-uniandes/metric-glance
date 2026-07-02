# Training

Tooling for the Metric Glance span-detection classifier. `classifier.ipynb`
exports labeled records from the D1 backend, explores them, trains a baseline
model, and exports it to ONNX for the `proposeSpans()` seam in
`extension/converter.js` (behind the `useEncoder` flag).

## Setup

```bash
# from train/
uv sync
uv run jupyter notebook classifier.ipynb
```

## What the notebook does

Sections, in run order:

1. **Export from D1**: checks wrangler auth, then pulls fresh rows via
   `refresh_data.py` in a separate process (falls back to the cached
   `data/submissions.json` if the pull fails or `REFRESH_ON_RUN` is off).
2. **Trusted installs**: per-row sample weights from `.env`
   (trusted install 5x, corrected 3x, seen 1x, auto 0.5x).
3. **Explore the labels**: aggregate-only counts and plots.
4. **Prepare features**: target `y` is the `unit_id`, or `__none__` for
   `not_a_conversion` rows; text feature is `before_ctx [ span ] after_ctx`;
   stratified 80/20 split.
5. **Train**: TF-IDF (word 1-2 grams, single-character tokens kept) +
   multinomial logistic regression, fit with the sample weights. Prints
   accuracy, macro F1, a per-class report, and every test confusion.
6. **Export to ONNX**: converts the pipeline with skl2onnx, then runs the
   exported model with onnxruntime and checks it agrees with sklearn on the
   whole test split (expect 100%).
7. **Track metrics**: appends one row per run to `metrics-history.csv`.

## Outputs

| File | Where | Committed? |
| --- | --- | --- |
| `mg-classifier.onnx` | `train/data/` | No (derived from private data) |
| `mg-classifier-labels.json` | `train/data/` | No (class order of the probability tensor) |
| `metrics-history.csv` | `train/` | Yes (aggregate percentages and counts only) |

The model takes one string per row (the bracketed-context text, built exactly
like the notebook's `text` feature) and returns the predicted label plus a
per-class probability tensor whose column order is `mg-classifier-labels.json`.

## When is the model good enough?

Plain accuracy is not the gate: the data is dominated by `price`, so a model
that is only good at prices already scores ~0.86. The numbers tracked in
`metrics-history.csv`, and the bar for each, are:

- `f1_macro`: averages F1 over classes equally, so rare units count as much as
  `price`. Primary metric. Bar: **>= 0.80**.
- `none_recall`: recall on `__none__`, the share of user-flagged false
  positives the model catches. Vetoing bad detections is the model's main job
  inside `proposeSpans()`. Bar: **>= 0.90**.
- `accuracy` / `accuracy_weighted`: tracked for context, never gated on alone.
- `onnx_parity`: sklearn vs exported-model agreement. Anything below ~1.0
  means the export is broken, independent of model quality.

Both bars should be met on a test split of roughly 1,000+ rows (so per-class
support is out of the single digits). Meeting them still does not mean
shipping blind: the encoder first runs in parallel with the regex engine and
disagreements are logged, and that disagreement rate is the real acceptance
test before the regex engine is removed.

## Keep data out of git (required, one-time per clone)

This repo is public. Two things must never be committed: the raw export
(`train/data/`, gitignored) and notebook cell outputs (which embed real
`install_id`s and hostnames inside the `.ipynb`).

Notebook outputs are stripped automatically by an `nbstripout` git filter, but
the filter definition lives in your local `.git/config`, not in the repo. After
cloning, activate it once:

```bash
# from train/
uv run python -m nbstripout --install --attributes ../.gitattributes
```

Without this step git still sees the `*.ipynb filter=nbstripout` rule in
`.gitattributes` but has no filter defined, so it silently passes outputs
through unstripped. Verify it is active:

```bash
git config --get filter.nbstripout.clean   # should print a python -m nbstripout path
```

(On Windows, invoking the bare `nbstripout` shim can be blocked by Application
Control; the `python -m nbstripout` form above avoids that.)

## Private config

Your own `install_id` (used to weight your corrections higher during training)
goes in `train/.env`, which is gitignored. Copy `.env.example` to `.env` and fill
it in. Find your id in the extension background console:

```js
(await browser.storage.local.get("mgInstallId")).mgInstallId
```
