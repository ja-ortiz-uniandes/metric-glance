// Shared setup: put a fixture page on screen with the content script running.
//
// converter.js needs no extension API to convert (see the `else { start(); }`
// at the bottom of the file), so the base case injects it bare. A stub is only
// installed when a test needs one of the two things that do go through the
// API: non-default settings (storage) and entering Smart Picker mode (a
// runtime message).

const path = require("path");
const { pathToFileURL } = require("url");

const EXT_DIR = path.join(__dirname, "..", "extension");
const CONVERTER = path.join(EXT_DIR, "converter.js");
const STYLES = path.join(EXT_DIR, "styles.css");
const FIXTURES = path.join(__dirname, "fixtures");

const MARK = ".mg-converted";

function fixtureUrl(name) {
  return pathToFileURL(path.join(FIXTURES, name)).href;
}

// A minimal `window.browser`, installed before converter.js runs.
//
// storage.get is handed an object of defaults and must resolve to the stored
// values, so echoing the defaults back with the test's overrides on top is
// exactly the contract. sendMessage answers the two questions the content
// script asks the background page at startup; onMessage keeps its listeners
// where a test can reach them, which is how pick mode gets switched on.
async function installApiStub(page, overrides) {
  await page.evaluate((stored) => {
    const listeners = [];
    window.__mgListeners = listeners;
    const answer = (msg) => {
      if (!msg) return undefined;
      if (msg.type === "mg-shortcut?") return { shortcut: "Ctrl+Alt+M" };
      if (msg.type === "mg-native-menus?") return { nativeMenus: true };
      return undefined;
    };
    window.browser = {
      storage: {
        local: {
          get(defaults) {
            const out = { ...(defaults || {}) };
            for (const k of Object.keys(stored)) out[k] = stored[k];
            return Promise.resolve(out);
          },
          set(obj) {
            Object.assign(stored, obj);
            return Promise.resolve();
          },
          remove() { return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        sendMessage(msg) { return Promise.resolve(answer(msg)); },
        onMessage: { addListener(fn) { listeners.push(fn); } },
      },
    };
  }, overrides || {});
}

// Load a fixture and run the content script over it.
async function loadFixture(page, name, opts) {
  const options = opts || {};
  await page.goto(fixtureUrl(name));
  if (options.stub || options.settings) await installApiStub(page, options.settings);
  if (options.styles) await page.addStyleTag({ path: STYLES });
  await page.addScriptTag({ path: CONVERTER });
  return page;
}

// Deliver a background-page message to the content script, the same way the
// toolbar menu and the right-click menu do.
async function sendToContentScript(page, msg) {
  await page.evaluate((m) => {
    const listeners = window.__mgListeners || [];
    if (!listeners.length) throw new Error("no runtime.onMessage listener registered");
    for (const fn of listeners) fn(m);
  }, msg);
}

// The text a reader actually sees, with the screen-reader-only copies retailers
// keep (a full "$12.77" beside a split price) dropped. Those stay in the DOM by
// design, so plain textContent would report them and every price assertion
// would be about markup the user never sees.
//
// rawVisibleText keeps the whitespace exactly as it stands, which is the whole
// question for a rewrite that must not eat the page's spacing. visibleText
// collapses it, for assertions about wording rather than spacing.
const OFFSCREEN_SEL = ".a-offscreen, .offscreen, .sr-only, .visually-hidden, .screen-reader, [hidden]";

async function rawVisibleText(page, selector) {
  return page.locator(selector).evaluate((el, sel) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(sel).forEach((n) => n.remove());
    return clone.textContent;
  }, OFFSCREEN_SEL);
}

async function visibleText(page, selector) {
  return (await rawVisibleText(page, selector)).replace(/\s+/g, " ").trim();
}

module.exports = {
  EXT_DIR, MARK, fixtureUrl, installApiStub, loadFixture, sendToContentScript,
  rawVisibleText, visibleText,
};
