# Metric Glance

A Firefox extension (desktop and Android) that converts non-metric units to metric and rounds awkward prices, right on the page. Converted values get a dotted underline; hover (desktop) or tap (mobile) to see the original value, switch between similarly-named units, or open a searchable unit picker.

**[Install from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/metric-glance/)**

## What it does

- Converts units inline as you read: lengths, weights, volumes, areas, temperature, speed, and dimension lists like `4 x 3 x 1 in`.
- Rounds near-whole prices (e.g. `$1.99 -> $2`) by a configurable threshold.
- Lets you correct anything: hover a converted value to pick a different interpretation (e.g. the three kinds of fluid ounce), mark a false positive, or browse the full unit list.
- Works on pages that split a number and its unit across elements, and on offscreen/duplicated price markup (e.g. Amazon).
- A toolbar button turns conversion off for the current site (and back on), enters a "mark a missed unit" mode, or opens settings.

## Install

Needs **Firefox 140+** (desktop) or **Firefox for Android 142+**.

**[Install from addons.mozilla.org](https://addons.mozilla.org/firefox/addon/metric-glance/)**

iPhone/iPad are not supported: Firefox on iOS can't run extensions (an Apple restriction).

### Using it

Converted values get a dotted underline. Hover (desktop) or tap (mobile) to see the original, switch units, or fix a mistake. Press **Ctrl+Alt+M** (**Cmd+Alt+M** on Mac) to open the unit picker for selected text.

## How it works

Detection today is a **deterministic regex engine**, not a model. For each block of text the scanner concatenates its inline content into one string (so a number and a linked or element-split unit are seen together), runs unit/price/dimension regexes over it, applies your settings and correction rules, and resolves overlaps. All arithmetic comes from a fixed conversion table, so a detection mistake can only mis-mark a span, never produce wrong math.

`proposeSpans(text)` is the seam where a future detection model plugs in: it currently returns the regex candidates unchanged, and is designed so a trained classifier can later decide *what* to convert (and which unit it is) while the deterministic table keeps doing the math. See **Roadmap** below.

## Usage

- **Read:** converted values are underlined. Hover (desktop) or tap (mobile) to open the panel.
- **Correct an interpretation:** the panel lists similarly-named alternatives (e.g. US customary / US food-label / imperial fluid ounce) with an info icon explaining when to use each, plus a live preview.
- **Convert something it missed, or pick an unusual unit:** select the text, then right-click -> *Convert selection to metric* -> a common unit or *More units... (search)*, or press the keyboard shortcut (default **Ctrl+Alt+M**, **Cmd+Alt+M** on Mac) to open the searchable picker. The shortcut is a real, customizable command; remap it in Firefox's *Manage Extension Shortcuts*. You can also use the toolbar button's *mark a missed unit* mode to point straight at skipped text.
- **Toolbar button:** turn conversion off for the current site (or back on), enter *mark a missed unit* mode, or open all settings. The button shows an **OFF** badge when the current site is disabled.
- **Settings** (`about:addons` -> Metric Glance -> Preferences): price rounding and its threshold; number formatting (maximum decimal places, thousands separator); which metric prefixes appear inline versus in the hover panel; the list of disabled sites; your saved corrections; and whether to log a sample of correct conversions for training data.

## File layout

The repo has four top-level directories. Only `extension/` is packaged into the xpi.

| Directory    | Role                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `extension/` | **The shipped add-on.** Everything packaged into the xpi (detailed below).                                                        |
| `collect/`   | Cloudflare Worker + D1 backend that receives training records. Never shipped.                                                     |
| `train/`     | Model-training tooling: D1 export and the exploration/training notebook. Never shipped. See [`train/README.md`](train/README.md). |
| `docs/`      | Live demo and privacy policy, published via GitHub Pages (`index.html`, `privacy.html`).                                          |

Inside `extension/`:

| File                          | Role                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.json`               | Extension manifest (MV2): permissions, content script, background scripts, the keyboard command, the toolbar button.                       |
| `converter.js`                | **The main code.** Content script: detection, conversion, the hover panel, the searchable picker, corrections, and training-data logging.  |
| `background.js`               | Desktop right-click menu, keyboard command, toolbar-button badge sync, and per-site disable-list helpers.                                  |
| `mg-uploader.js`              | Background script: batches and uploads training records to the collection Worker (consent-gated).                                          |
| `popup.html` / `popup.js`     | Toolbar-button menu: open settings, or turn the extension off/on for the current site.                                                     |
| `options.html` / `options.js` | Settings page.                                                                                                                             |
| `welcome.html` / `welcome.js` | First-run page: introduces the extension and lets the user configure data sharing.                                                         |
| `styles.css`                  | Underlines, panel, picker, and toolbar styles (picker follows Firefox's light/dark theme).                                                 |
| `icons/`                      | Toolbar/listing icons.                                                                                                                     |

Root files: `CHANGELOG.md` (version-by-version history), `CLAUDE.md` (agent/contributor guide), `build-zip.ps1` (local zip builder), `LICENSE`.

Plain JavaScript; there is no build step.

## Releasing

Releases are automated by a GitHub Actions workflow (`.github/workflows/release.yml`). Pushing a version tag does everything:

```bash
# bump the version in extension/manifest.json first, then:
git tag v0.45.0
git push origin v0.45.0
```

The workflow checks the tag matches the manifest version, lints with `web-ext`, submits the add-on to Firefox Add-ons (AMO), and creates a GitHub release with the packaged files attached. It needs two repo secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, from your [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/). To build a zip locally without releasing, run `./build-zip.ps1`.

## Training data and privacy

Corrections and (optionally) a sample of correct conversions are stored locally in the browser's extension storage. On first install a welcome page lets you choose whether to share these examples with a private backend to help train a better detection model. You can change this at any time in Preferences.

Data sent to the backend is anonymized: hostname only (never the full URL), text snippets from the page, and a random install ID not linked to any account. See the [privacy policy](https://ja-ortiz-uniandes.github.io/metric-glance/privacy.html) for the full field-by-field breakdown.

## Roadmap: a detection classifier

The regex is intended as a temporary detector that also bootstraps training data. The plan is to replace detection (only) with a small open-source token-classification model (BERT-family encoder, fine-tuned on the logged examples) that runs in the browser via transformers.js. The model would predict the specific unit for each quantity, using page context the regex cannot see (site locale, nearby words, currency, "Nutrition Facts", etc.), while the deterministic table continues to do all arithmetic. Because inference needs WebGPU (not yet available in Firefox for Android), the likely rollout is desktop-first with regex remaining the mobile path. The labels the extension logs now (`auto:<unit>`, `interpretation:<unit>`, `convert-as:<unit>`, `not_a_conversion`) are already in the shape that model needs.

## License

MIT, see `LICENSE`.
