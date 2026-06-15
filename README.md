# Metric Glance

A Firefox extension (desktop and Android) that converts US/imperial units to metric, and rounds awkward prices, directly on the page. Converted values get a dotted underline; hover them on desktop or tap them on mobile to see the original value, switch between similarly-named units, or open a searchable unit picker.

## What it does

- Converts units inline as you read: lengths, weights, volumes, areas, temperature, speed, and dimension lists like `4 x 3 x 1 in`.
- Rounds near-whole prices (e.g. `$1.99 -> $2`) by a configurable threshold.
- Lets you correct anything: hover a converted value to pick a different interpretation (e.g. the three kinds of fluid ounce), mark a false positive, or browse the full unit list.
- Works on pages that split a number and its unit across elements, and on offscreen/duplicated price markup (e.g. Amazon).

## How it works

Detection today is a **deterministic regex engine**, not a model. For each block of text the scanner concatenates its inline content into one string (so a number and a linked or element-split unit are seen together), runs unit/price/dimension regexes over it, applies your settings and correction rules, and resolves overlaps. All arithmetic comes from a fixed conversion table, so a detection mistake can only mis-mark a span, never produce wrong math.

`proposeSpans(text)` is the seam where a future detection model plugs in: it currently returns the regex candidates unchanged, and is designed so a trained classifier can later decide *what* to convert (and which unit it is) while the deterministic table keeps doing the math. See **Roadmap** below.

## Install (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on...** and choose `manifest.json` from this folder.
3. Visit any page (or open `test-page.html`). Click **Reload** in about:debugging after code changes, then hard-refresh the page.

For Android testing use `web-ext run --target=firefox-android`. Permanent distribution requires signing through addons.mozilla.org.

## Usage

- **Read:** converted values are underlined. Hover (desktop) or tap (mobile) to open the panel.
- **Correct an interpretation:** the panel lists similarly-named alternatives (e.g. US customary / US food-label / imperial fluid ounce) with an info icon explaining when to use each, plus a live preview.
- **Convert something it missed, or pick an unusual unit:** select the text, then right-click -> *Convert selection to metric* -> a common unit or *More units... (search)*, or press the keyboard shortcut (default **Ctrl+Alt+M**, **Cmd+Alt+M** on Mac) to open the searchable picker. The shortcut is a real, customizable command, remap it in Firefox's *Manage Extension Shortcuts*.
- **Settings** (`about:addons` -> Metric Glance -> Preferences): toggle price rounding and its threshold, and optionally log a sample of correct conversions for training data.

## File layout

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (MV2): permissions, content script, background, the keyboard command. |
| `converter.js` | **The main code.** Content script: detection, conversion, the hover panel, the searchable picker, corrections, and training-data logging. |
| `background.js` | Builds the desktop right-click menu, handles the keyboard command, reports the current shortcut. |
| `options.html` / `options.js` | Settings page. |
| `styles.css` | Underlines, panel, picker, and toolbar styles (picker follows Firefox's light/dark theme). |
| `icons/` | Toolbar/listing icons. |
| `test-page.html` | A controlled page exercising the tricky cases. |
| `CHANGELOG.md` | Version-by-version history. |

Plain JavaScript; there is no build step.

## Training data and privacy

Corrections and (optionally) a sample of correct conversions are stored **locally** in the browser's extension storage on the user's own device. Nothing is transmitted anywhere, and there is no server. The data can be exported as JSON from the settings page by the person who owns that browser. If this is ever changed to transmit data off-device, it will require explicit user consent, a manifest data-collection declaration, and a privacy policy.

## Roadmap: a detection classifier

The regex is intended as a temporary detector that also bootstraps training data. The plan is to replace detection (only) with a small open-source token-classification model (BERT-family encoder, fine-tuned on the logged examples) that runs in the browser via transformers.js. The model would predict the specific unit for each quantity, using page context the regex cannot see (site locale, nearby words, currency, "Nutrition Facts", etc.), while the deterministic table continues to do all arithmetic. Because inference needs WebGPU (not yet available in Firefox for Android), the likely rollout is desktop-first with regex remaining the mobile path. The labels the extension logs now (`auto:<unit>`, `interpretation:<unit>`, `convert-as:<unit>`, `not_a_conversion`) are already in the shape that model needs.

## License

MIT, see `LICENSE`.
