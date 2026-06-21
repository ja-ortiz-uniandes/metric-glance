/* Metric Glance toolbar popup: open settings, or toggle this site on/off the
 * list of sites where the add-on does not run. */
(function () {
  "use strict";

  const api =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome);

  const $host = document.getElementById("host");
  const $state = document.getElementById("state");
  const $toggle = document.getElementById("toggle");
  const $toggleTxt = document.getElementById("toggle-txt");
  const $toggleIco = document.getElementById("toggle-ico");
  const $pick = document.getElementById("pick");
  const $settings = document.getElementById("settings");

  function normHost(h) { return String(h || "").trim().toLowerCase().replace(/\.$/, ""); }
  function hostOf(url) {
    try { return normHost(new URL(url).hostname); } catch (e) { return ""; }
  }
  function getDisabled() {
    return api.storage.local.get({ disabledHosts: [] }).then(
      (r) => (r && r.disabledHosts) || [], () => []
    );
  }

  let host = "";

  function render(disabled) {
    $host.textContent = host || "this page";
    if (!host) {
      $state.textContent = "Not available on this page";
      $state.className = "state off";
      $toggle.disabled = true;
      $pick.disabled = true;
      $toggleTxt.textContent = "Don't run on this site";
      $toggleIco.textContent = "🚫";
      return;
    }
    $toggle.disabled = false;
    $pick.disabled = false;
    if (disabled) {
      $state.textContent = "Off on this site";
      $state.className = "state off";
      $toggleTxt.textContent = "Run on this site again";
      $toggleIco.textContent = "✅";
    } else {
      $state.textContent = "Running on this site";
      $state.className = "state";
      $toggleTxt.textContent = "Don't run on this site";
      $toggleIco.textContent = "🚫";
    }
  }

  function toggle() {
    if (!host) return;
    getDisabled().then((list) => {
      const i = list.findIndex((h) => normHost(h) === host);
      let nowDisabled;
      if (i >= 0) { list.splice(i, 1); nowDisabled = false; }
      else { list.push(host); nowDisabled = true; }
      api.storage.local.set({ disabledHosts: list }).then(() => render(nowDisabled));
    });
  }

  $toggle.addEventListener("click", toggle);
  $pick.addEventListener("click", () => {
    api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) return;
      const p = api.tabs.sendMessage(tab.id, { type: "mg-pick-mode" });
      if (p && p.catch) p.catch(() => {});
      window.close();
    });
  });
  $settings.addEventListener("click", () => {
    if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
    window.close();
  });

  // Initialise from the active tab.
  api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    host = tab ? hostOf(tab.url) : "";
    getDisabled().then((list) => render(list.some((h) => normHost(h) === host)));
  }, () => render(false));
})();
