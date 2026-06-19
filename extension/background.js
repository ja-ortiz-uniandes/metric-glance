/**
 * Metric Glance background script.
 *
 * - Desktop right-click menu: a short fast-path of common units, a "More…"
 *   item that opens the in-page picker, and "Round selection as a price".
 * - The Ctrl+Alt+M shortcut is a real, user-customizable command (see the
 *   "commands" key in the manifest; remappable in Firefox's "Manage Extension
 *   Shortcuts"). On trigger it asks the active tab to open the picker.
 * - The menu's "More…" label shows the CURRENT shortcut, read live from the
 *   commands API on every menu open, so it always reflects user remapping
 *   (and shows no shortcut if the user has cleared it).
 * - Tells content scripts whether native menus exist (Firefox for Android has
 *   no contextMenus API) and what the current shortcut is.
 */
(function () {
  "use strict";

  const ext =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome);

  const menus = ext && (ext.contextMenus || ext.menus);
  const hasMenus = !!(menus && menus.create);

  const COMMON = [
    ["in", "Inches → cm"],
    ["ft", "Feet → m"],
    ["mi", "Miles → km"],
    ["lb", "Pounds → kg"],
    ["oz", "Ounces → g"],
    ["usfloz", "US fl oz → ml"],
    ["usgal", "US gallon → L"],
    ["f", "Fahrenheit → °C"],
  ];

  // Current shortcut for the open-picker command, or "" if unavailable/unset.
  function currentShortcut() {
    if (!ext.commands || !ext.commands.getAll) return Promise.resolve("");
    return ext.commands.getAll().then(
      (cmds) => {
        const c = (cmds || []).find((x) => x.name === "open-picker");
        return c && c.shortcut ? c.shortcut : "";
      },
      () => ""
    );
  }
  function moreTitle(sc) { return sc ? "More units… search (" + sc + ")" : "More units… search"; }

  function createItems() {
    menus.create({ id: "mg-as", title: "Convert selection to metric", contexts: ["selection"] });
    for (const pair of COMMON) {
      menus.create({ id: "mg-as:" + pair[0], parentId: "mg-as", title: pair[1], contexts: ["selection"] });
    }
    menus.create({ id: "mg-sep", parentId: "mg-as", type: "separator", contexts: ["selection"] });
    menus.create({ id: "mg-more", parentId: "mg-as", title: moreTitle(""), contexts: ["selection"] });
    menus.create({ id: "mg-price", title: "Round selection as a price", contexts: ["selection"] });
  }

  if (hasMenus) {
    try {
      const p = menus.removeAll(createItems);
      if (p && typeof p.then === "function") p.then(createItems);
    } catch (e) {
      createItems();
    }

    // Refresh the "More…" label with the live shortcut each time the menu opens,
    // so it always matches what the user has set (Firefox: menus.onShown).
    if (menus.onShown && menus.refresh) {
      menus.onShown.addListener(() => {
        currentShortcut().then((sc) => {
          try { menus.update("mg-more", { title: moreTitle(sc) }); menus.refresh(); } catch (e) { /* menu closed */ }
        });
      });
    }

    menus.onClicked.addListener((info, tab) => {
      if (!tab) return;
      const id = info.menuItemId;
      if (id === "mg-price") {
        ext.tabs.sendMessage(tab.id, { type: "mg-force", kind: "price", text: info.selectionText });
      } else if (id === "mg-more") {
        ext.tabs.sendMessage(tab.id, { type: "mg-open-picker", text: info.selectionText });
      } else if (typeof id === "string" && id.indexOf("mg-as:") === 0) {
        ext.tabs.sendMessage(tab.id, { type: "mg-convert-as", unitId: id.slice(6), text: info.selectionText });
      }
    });
  }

  // The customizable keyboard command opens the picker in the active tab.
  if (ext.commands && ext.commands.onCommand) {
    ext.commands.onCommand.addListener((command) => {
      if (command !== "open-picker") return;
      ext.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs && tabs[0]) ext.tabs.sendMessage(tabs[0].id, { type: "mg-open-picker" });
      });
    });
  }

  if (ext.runtime.onInstalled) {
    ext.runtime.onInstalled.addListener((details) => {
      if (details.reason !== "install") return;
      ext.tabs.create({ url: ext.runtime.getURL("welcome.html") });
    });
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "mg-native-menus?") {
      sendResponse({ native: hasMenus });
      return true;
    }
    if (msg && msg.type === "mg-shortcut?") {
      currentShortcut().then((sc) => sendResponse({ shortcut: sc }));
      return true; // async response
    }
  });
})();
