# Tests

Browser tests for `extension/converter.js`. Never packaged into the add-on:
`build-zip.ps1` and the release workflow only read `extension/`.

## Running them

```bash
cd test
npm ci
npx playwright install chromium   # once per machine
npm test                          # or: npm run test:headed
```

`npm run report` opens the HTML report after a failure.

## How they work

There is no extension loading here. `converter.js` ends with
`} else { start(); }`, so with no extension API present it runs on default
settings against whatever page it is injected into. A test therefore just does:

```js
await page.goto(fixtureUrl("swatches.html"));
await page.addScriptTag({ path: "extension/converter.js" });
```

Two things do go through the extension API, and `helpers.js` installs a small
`window.browser` stub for them:

- **settings**, read once at startup from `storage.local`
- **Smart Picker**, switched on by a `runtime.onMessage` message from the
  background page. The stub keeps its listeners where `sendToContentScript()`
  can reach them.

Chromium only. That is not a preference: Chromium no longer runs MV2 extensions
at all, and Playwright's Firefox cannot install one either. What a real engine
buys us is real layout, which is the only way to test `elementFromPoint` and
`getBoundingClientRect` (the Smart Picker is built on both).

## What is not covered

`manifest.json`, `background.js`, `mg-uploader.js`, `mg-privacy-watch.js`, the
options and welcome pages, and anything about the packaged `.xpi`. Those still
need a manual run: load `extension/manifest.json` via
`about:debugging#/runtime/this-firefox` and use `docs/index.html`.

## Adding a case

Put a minimal page in `fixtures/` with an `id` on each element you assert on,
and a comment saying what the shape is and why it is hard. Prefer copying the
real markup that broke (nesting, class names, inline styles) over a tidied
version: the nesting is usually the bug.

Assert on `visibleText()` / `rawVisibleText()` from `helpers.js` rather than
`textContent`. Retailers keep a screen-reader-only copy of a price next to the
split one, so raw `textContent` reports markup the user never sees. Use
`rawVisibleText()` when the whitespace itself is what is being tested.
