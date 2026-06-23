# Training

Tooling for the Metric Glance span-detection classifier. Exports labeled records
from the D1 backend, explores them, and (eventually) trains a model that slots
into `proposeSpans()` in `extension/converter.js`.

## Setup

```bash
# from train/
uv sync
uv run jupyter notebook classifier.ipynb
```

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
