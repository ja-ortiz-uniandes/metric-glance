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
  const action = ext && (ext.browserAction || ext.action);

  // ---- Per-site disable list (hostnames where the content script stays idle) ----
  function normHost(h) { return String(h || "").trim().toLowerCase().replace(/\.$/, ""); }
  function hostOf(url) {
    try { return normHost(new URL(url).hostname); } catch (e) { return ""; }
  }
  function getDisabled() {
    return ext.storage.local.get({ disabledHosts: [] }).then(
      (r) => (r && r.disabledHosts) || [],
      () => []
    );
  }
  function isDisabled(list, host) {
    const h = normHost(host);
    return !!h && list.some((x) => normHost(x) === h);
  }
  // Add or remove a hostname from the disabled list. Returns the new state.
  function toggleHost(host) {
    const h = normHost(host);
    if (!h) return Promise.resolve(false);
    return getDisabled().then((list) => {
      const i = list.findIndex((x) => normHost(x) === h);
      let nowDisabled;
      if (i >= 0) { list.splice(i, 1); nowDisabled = false; }
      else { list.push(h); nowDisabled = true; }
      return ext.storage.local.set({ disabledHosts: list }).then(() => nowDisabled);
    });
  }
  // Reflect the active tab's state on the toolbar button (badge + title).
  function updateBadge(tab) {
    if (!action || !tab) return;
    const host = hostOf(tab.url);
    getDisabled().then((list) => {
      const off = isDisabled(list, host);
      try {
        if (action.setBadgeText) action.setBadgeText({ text: off ? "OFF" : "", tabId: tab.id });
        if (action.setBadgeBackgroundColor) action.setBadgeBackgroundColor({ color: "#b42318", tabId: tab.id });
        if (action.setTitle) action.setTitle({ tabId: tab.id, title: off ? "Metric Glance (off on this site) — click to re-enable" : "Metric Glance (on) — click to disable on this site" });
      } catch (e) { /* tab gone */ }
    });
  }
  function refreshActiveBadge() {
    if (!action || !ext.tabs) return;
    ext.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs && tabs[0]) updateBadge(tabs[0]);
    }, () => {});
  }

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
    // Shown when nothing is selected: toggle the current site on/off the list.
    // Title is refreshed per page in onShown to reflect the current state.
    menus.create({ id: "mg-toggle-site", title: "Don't run Metric Glance on this site", contexts: ["page"] });
  }
  function toggleTitle(off) {
    return off ? "Run Metric Glance on this site" : "Don't run Metric Glance on this site";
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
      menus.onShown.addListener((info, tab) => {
        currentShortcut().then((sc) => {
          try { menus.update("mg-more", { title: moreTitle(sc) }); menus.refresh(); } catch (e) { /* menu closed */ }
        });
        const host = hostOf(info.pageUrl || (tab && tab.url));
        getDisabled().then((list) => {
          try { menus.update("mg-toggle-site", { title: toggleTitle(isDisabled(list, host)) }); menus.refresh(); } catch (e) { /* menu closed */ }
        });
      });
    }

    menus.onClicked.addListener((info, tab) => {
      if (!tab) return;
      const id = info.menuItemId;
      if (id === "mg-toggle-site") {
        const host = hostOf(info.pageUrl || tab.url);
        toggleHost(host).then(() => updateBadge(tab));
      } else if (id === "mg-price") {
        ext.tabs.sendMessage(tab.id, { type: "mg-force", kind: "price", text: info.selectionText });
      } else if (id === "mg-more") {
        ext.tabs.sendMessage(tab.id, { type: "mg-open-picker", text: info.selectionText });
      } else if (typeof id === "string" && id.indexOf("mg-as:") === 0) {
        ext.tabs.sendMessage(tab.id, { type: "mg-convert-as", unitId: id.slice(6), text: info.selectionText });
      }
    });
  }

  // Toolbar button opens popup.html (a small menu: open settings, or toggle
  // this site). The popup does the work, so there is no onClicked handler.

  // Keep the toolbar badge in sync as the user navigates or toggles elsewhere.
  if (action && ext.tabs) {
    if (ext.tabs.onActivated) ext.tabs.onActivated.addListener(() => refreshActiveBadge());
    if (ext.tabs.onUpdated) {
      ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo && changeInfo.url) updateBadge(tab);
      });
    }
    if (ext.storage && ext.storage.onChanged) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.disabledHosts) refreshActiveBadge();
      });
    }
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
