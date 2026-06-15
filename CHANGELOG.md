# Changelog

Version-by-version history of Metric Glance. Newest entries are at the bottom of each section.

---

# Metric Glance

A Firefox extension (desktop and Android) that converts imperial units to metric directly on the page. Converted values get a dotted underline. Hover over them on desktop, or tap them on mobile, to see the original imperial value in a tooltip.

## Supported units

| Imperial | Metric |
|---|---|
| inches, in., ″ | cm |
| feet, ft, ′ | m (or cm when small) |
| yards, yd | m |
| miles, mi. | km |
| mph, miles per hour | km/h |
| sq ft, square feet | m² |
| sq mi, square miles | km² |
| ounces, oz | g |
| pounds, lbs | kg (or g when small) |
| stone | kg |
| fluid ounces, fl oz | ml / L |
| pints, pt. | ml / L |
| quarts, qt | L |
| gallons, gal | L |
| °F, Fahrenheit | °C |
| acres | hectares |

Handles thousands separators (1,200 feet), decimals (26.2 miles), and mixed fractions (5 1/2 inches). It skips code blocks, form fields, and editable regions, and it converts content that loads dynamically (infinite scroll, SPAs) via a MutationObserver.

## Why no bundled LLM?

The original idea was to use a small open model like Gemma for conversion. In practice that is not viable inside a mobile browser extension: even the smallest Gemma variant is hundreds of megabytes, would need to download and initialize on every device, and would burn battery to do arithmetic that a 5 KB rule engine does instantly, offline, and deterministically. Unit conversion is exact math, so a deterministic engine is also more accurate (an LLM can hallucinate a wrong number). If you later want LLM-assisted conversion for genuinely ambiguous phrases, the right architecture is an optional call to a hosted API for those edge cases only, not an on-device model.

## Install: Firefox desktop (temporary, for testing)

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `manifest.json` inside this folder (or the zip)
4. Visit any page with imperial units

## Install: Firefox for Android

Firefox for Android (120+) supports open extension installation, but extensions must be signed. Two routes:

**Route A (recommended): sign via addons.mozilla.org (AMO)**
1. Create a free account at https://addons.mozilla.org/developers/
2. Submit `metric-glance.zip` as an unlisted add-on (self-distribution). Signing is automatic and usually takes minutes.
3. Download the signed `.xpi`, open it from Firefox on your phone (or host it and tap the link), and confirm the install.

**Route B: Firefox Nightly + custom collection**
1. In AMO, create a collection and add your (signed) extension to it
2. In Firefox Nightly on Android: Settings > About > tap the logo 5 times to enable the debug menu
3. Settings > Custom Add-on collection > enter your user ID and collection name
4. Install from the add-ons menu

**Developer route: web-ext over USB**
With Android debugging enabled, `web-ext run --target=firefox-android` sideloads the unsigned build directly for testing.

## Files

- `manifest.json` - MV2 manifest with `gecko_android` support
- `options.html` / `options.js` - settings page for price rounding
- `converter.js` - content script: scanning, conversion, tap/hover behavior
- `styles.css` - dotted underline and tooltip styles
- `icons/` - extension icons

## Price rounding (v1.1, redefined in v1.4)

Prices are rounded UP to the next whole amount when they are within a cents threshold of it. The threshold (1 to 99 cents, set in Preferences) is how far a price may be nudged up:

- At 1¢, only prices ending in .99 round (so $1.99 becomes $2, $1,299.99 becomes $1,300).
- At 99¢ (the maximum), any price with cents rounds up ($2.01 becomes $3), but whole-dollar prices like $500.00 are left untouched.
- In general a price rounds up when its cents are at least (100 minus the threshold).

The dollar size of the price does not matter, only the cents. Recognizes $, €, £, ¥, US$, CA$, A$, NZ$, and HK$. Settings changes apply to pages on reload.

## Corrections and training data (v1.2)

The detector isn't perfect, and it's designed to learn from you. Two ways to correct it, both working on desktop and Firefox for Android:

- **Something was missed?** Select the text (long-press on mobile), then tap "Convert as unit" or "Round as price" in the small toolbar that appears.
- **Something is wrong?** Tap, click, or right-click a converted value and choose "Not a conversion" in the popover.

Every correction does two things: it changes behavior immediately (via local rules stored on your device, so the page updates and the choice sticks), and it's saved as a labeled example. In the settings page you can see how many corrections you've made and export them as JSON.

### Why export?

This is the bootstrap for the detection model. Regex handles the clear-cut cases but can't read context (it can't tell "5 pounds of flour" from "5 pounds sterling", or skip "Five Mile Road"). The exported JSON is labeled training data for fine-tuning a small token-classification encoder, which then drops into the `proposeSpans()` hook in `converter.js`. The contract is documented there: the model returns character spans it believes are convertible, those are intersected with the deterministic candidates, and the math stays in code so the model can never produce a wrong number.

### On the "very small LLM" question

The detector is deliberately structured for a small encoder (a few tens of MB, INT8), not a generative model. An encoder doing token classification runs on plain CPU/WASM, so it works on mobile today, whereas a generative model would need WebGPU, which Firefox for Android does not yet ship. Conversion is always deterministic regardless.

### Important: native right-click menus

Firefox for Android does not support the extension `contextMenus` API, so this uses an in-page selection toolbar and tap-popover instead of a native menu. On desktop, right-clicking a converted value opens the same popover, so the right-click behavior is preserved where the platform allows it.

## Platform-specific correction UI (v1.3)

The correction interactions now follow each platform's conventions, decided by feature-detecting the `contextMenus` API rather than sniffing the user agent.

**Adding a conversion the detector missed:**
- Desktop: select the text and right-click. The menu has two items, "Mark as a unit to convert to metric" and "Mark as a price that should be rounded."
- Mobile (Firefox Android, where native menus don't exist): select the text (long-press) and use the small in-page toolbar. The in-page toolbar is suppressed on desktop so it doesn't compete with the native menu.

**Removing a wrong conversion:** this lives on the underlined value itself, not in any menu.
- Desktop: hover the value. A panel shows the original and a "Mark as incorrect" button. A short (150ms) close delay bridges the gap between the word and the panel, with a relatedTarget guard, so the button stays reachable and doesn't flicker.
- Mobile: tap the value to toggle the same panel.

Both correction types still take effect immediately via local rules and are logged as exportable training examples, exactly as in v1.2.

## Correct conversions + disambiguation (v1.5)

Two fixes and a feature here.

Conversion correctness: an earlier bug applied some conversion factors twice (pounds, feet, fluid ounces, pints, quarts all came out wrong, e.g. 14 pounds showing 2.88 kg instead of 6.35 kg). The unit table was rebuilt on a single convention so every conversion is now applied exactly once. 14 pounds is 6.35 kg, 196 pounds is 88.9 kg.

Hover/tap panel detail: the panel now shows the original text, the conversion (e.g. "14 pounds → 6.35 kg"), and the rate used ("1 lb = 0.4536 kg"; for temperature, the formula). For prices it explains the round-up and the cents gap.

Disambiguation: units that are genuinely ambiguous carry interpretation options shown right in the panel. "pounds" can be weight (lb → kg), British money (£, left unconverted), or stone. "ounces" can be weight or US fluid ounces. Volumes that differ between US and imperial systems (gallon, quart, pint, fluid ounce) offer both. Picking one stores the choice for that exact phrase, re-renders immediately, and is logged as a labeled training example (label "interpretation:<id>"). When you mark a missed value for conversion, it now converts on the spot and opens the panel so you can immediately pick the right interpretation if needed.

## v1.6 — split prices, tighter menus, richer training data

- Default round-up threshold is now 50¢.
- The "pounds" menu offers only weight (lb → kg) and money (£); the stone option was removed since "14 pounds" never means 14 stone.
- Prices split across multiple HTML elements now round. Many retailers (Amazon among them) render the visible price as separate symbol/whole/fraction elements with no literal decimal, keeping the only contiguous "$12.77" in a hidden screen-reader element. The extension now skips those hidden copies and rewrites the visible split price in place. This is heuristic: it acts on a compact wrapper that contains only a price (no words), so unusual markup may still be missed.

### What the training data records

Each correction is stored in `browser.storage.local` and exportable as JSON from the settings page. Every example now contains: the `label` ("unit", "price", "not_a_conversion", or "interpretation:<id>"), the exact `span` text, the surrounding sentence `context`, the `span_start`/`span_end` character offsets within that context, the source `url` host, and a timestamp. That is enough to fine-tune a token-classification encoder later: the context plus offsets convert directly into per-token BIO labels, the "not_a_conversion" rows are the negative examples, and the "interpretation" rows teach disambiguation. The main thing it does not capture is naturally-occurring true positives you never had to correct, so a real training run would mix this in with synthetic or auto-labeled data.

## v1.7 — conversions across element boundaries (linked units)

The scanner no longer works one text node at a time. It now reads each block's inline content as a single run, so a value and its unit convert even when they're separated by an element boundary. The common case is a unit word that is a hyperlink (Wikipedia links "inches", "miles", etc.): "39.37 <a>inches</a>" previously stayed unconverted because "39.37" and "inches" were in different nodes; it now becomes 100 cm. This also fixes most table cells that weren't converting for the same reason.

When a conversion replaces rich content (a link, bold, etc.):
- The converted value is shown with a dashed blue underline instead of the plain dotted one, signalling there was hidden formatting in the original.
- The hover/tap panel shows the original under "Original text:" in a code-style box that preserves the formatting and links exactly as they were.
- The converted value itself is plain text (the link is not carried over), but "Mark as incorrect" restores the original rich content, link included.

Known limitation: the comparison table that defines these units uses space-grouped digits ("0.960 7599") and prefixed unit names ("imp fl oz", "US fl oz") that are deliberately not parsed, both because that notation isn't standard running text and because auto-converting a table whose purpose is to define the units would be counterproductive.

## v1.8 — surface-aware ambiguity + manual price on odd markup

The interpretation menu now appears only when the written form is genuinely ambiguous:
- "14 lb" / "14 lbs" convert to kg with no menu (the abbreviation is unambiguously weight).
- Spelled-out "14 pounds" shows the weight-vs-money choice.
- "8 oz" converts to grams with no menu (the fluid form is written "fl oz", which still offers US vs imperial).
- US-vs-imperial volume units (fl oz, gallon, pint, quart) still offer both, since that ambiguity exists for every spelling.

This is driven by matching the exact unit token: a variant can declare which surface forms it applies to (e.g. the £ reading applies only to "pound"/"pounds"), and the menu lists only the applicable ones.

Manual price on strange markup: selecting a price and choosing "Round as price" (mobile toolbar) or the right-click menu item (desktop) now replaces the entire selection with a single rounded integer, reading the value from the most reliable price in the selection (a contiguous copy if present). Note that the inline-run scanner already auto-converts most split prices that contain a literal decimal; the manual path is the fallback for markup the detector leaves alone. A price with no decimal and no hidden full copy (cents shown only as styling) remains genuinely unparseable.

## v1.9 — original styling, cubic units, category menu

- The "Original text:" code box now renders in the page's own font, size, weight, colour and decorations, captured from the live element before extraction, so it looks like it did on the site. The box background flips between light and dark based on the text colour so the original stays readable. Links and inline formatting are still preserved.
- Cubic units convert: cubic inches (cu in / in³), cubic feet (cu ft / ft³), cubic yards (cu yd / yd³). These are placed ahead of the linear units so "ft³" reads as cubic feet, not feet. So "≈277.42 cu in" becomes ≈4.55 L.
- New "Convert selection to metric" menu, organised by category then specific unit, for telling the extension what an unrecognised value is. Right-click (desktop) gives Metric Glance > Convert selection to metric > Length / Weight / Volume / Area / Temperature / Speed > the specific unit. On mobile the in-page toolbar cascades the same way (Convert to metric… > category > unit, with Back). Picking a unit converts the selection on the spot and logs a "convert-as:<id>" training example. "Round selection as a price" remains alongside.

Note on getComputedStyle: the original-styling capture relies on the element being live when the conversion happens (it is), so styling is captured correctly even though the converted span is plain text.

