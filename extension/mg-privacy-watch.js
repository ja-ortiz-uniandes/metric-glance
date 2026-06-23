/**
 * Metric Glance privacy-policy watcher.
 *
 * Runs in the background context (sibling of background.js and mg-uploader.js).
 * Periodically fetches the published privacy policy, reads its version marker
 * (the <meta name="mg-privacy-version"> tag), and compares it against the
 * version this install last acknowledged. When the live policy is newer, it:
 *
 *   - records the new version as the baseline (so we notify once per change),
 *   - stores a pending notice (mgPrivacyNotice) that the options page surfaces
 *     as a dismissable banner, and
 *   - fires a system notification (if the notifications API is available)
 *     whose click opens the policy.
 *
 * Baseline handling:
 *   On first run the baseline is unset. We seed it from CURRENT_PRIVACY_VERSION
 *   (the version that ships with this build, i.e. the one the user agreed to at
 *   install) rather than from the live page, so the very first fetch can still
 *   flag a policy that changed after this build was packaged. After that, only
 *   changes relative to the last-seen version trigger a notice.
 *
 * Network/permissions:
 *   Fetching the policy needs a host permission for PRIVACY_URL (declared in
 *   manifest.json). The fetch sends no extension data; it is a plain GET of a
 *   public static page. If the fetch fails or the marker is missing, we do
 *   nothing and try again next cycle.
 */
(function () {
  "use strict";

  const ext =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome);
  if (!ext || !ext.storage || !ext.storage.local) return;
  const storage = ext.storage.local;

  // --- config -------------------------------------------------------------
  // The published policy and its in-extension view target. PRIVACY_URL must
  // match the host permission in manifest.json.
  const PRIVACY_URL =
    "https://ja-ortiz-uniandes.github.io/metric-glance/privacy.html";
  // The policy version packaged with THIS build. Must equal the
  // <meta name="mg-privacy-version"> content in docs/privacy.html at release
  // time; bump both together when the policy text changes.
  const CURRENT_PRIVACY_VERSION = "2026-06-23";

  const ALARM = "mg-privacy-check";
  const PERIOD_MIN = 1440; // once a day
  const STARTUP_DELAY_MS = 25 * 1000; // after the background page wakes
  const NOTIF_ID = "mg-privacy-update";

  // --- tiny storage helpers (promise-normalized) --------------------------
  function getLocal(defaults) {
    return new Promise((resolve) => {
      try {
        const p = storage.get(defaults);
        if (p && p.then) p.then(resolve, () => resolve(defaults));
        else storage.get(defaults, resolve);
      } catch (e) { resolve(defaults); }
    });
  }
  function setLocal(obj) {
    return new Promise((resolve) => {
      try {
        const p = storage.set(obj);
        if (p && p.then) p.then(() => resolve(true), () => resolve(false));
        else storage.set(obj, () => resolve(true));
      } catch (e) { resolve(false); }
    });
  }

  // Pull the version marker out of the fetched HTML. Order-independent and
  // quote-agnostic; returns "" if the marker is absent.
  function parseVersion(html) {
    if (typeof html !== "string") return "";
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
      if (!/name\s*=\s*["']mg-privacy-version["']/i.test(tag)) continue;
      const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      if (m) return m[1].trim();
    }
    return "";
  }

  function openPolicy() {
    if (ext.tabs && ext.tabs.create) ext.tabs.create({ url: PRIVACY_URL });
  }

  function notify(version) {
    if (!ext.notifications || !ext.notifications.create) return;
    let iconUrl;
    try { iconUrl = ext.runtime.getURL("icons/icon-96.png"); } catch (e) { iconUrl = undefined; }
    const opts = {
      type: "basic",
      title: "Metric Glance privacy policy updated",
      message:
        "Our privacy policy has changed. Click to review what data is " +
        "collected and how it is used.",
    };
    if (iconUrl) opts.iconUrl = iconUrl;
    try { ext.notifications.create(NOTIF_ID, opts); } catch (e) { /* unsupported */ }
  }

  // --- one check cycle ----------------------------------------------------
  let running = false;
  async function runCheck() {
    if (running) return;
    running = true;
    try {
      let resp;
      try {
        resp = await fetch(PRIVACY_URL, { cache: "no-cache", credentials: "omit" });
      } catch (e) {
        return; // offline or blocked: try again next cycle
      }
      if (!resp || !resp.ok) return;

      let html = "";
      try { html = await resp.text(); } catch (e) { return; }

      const remote = parseVersion(html);
      if (!remote) return; // no marker: nothing reliable to compare

      // Seed the baseline from the shipped version on first run, so a policy
      // that changed after packaging is still caught on the first fetch.
      const { mgPrivacyVersion } = await getLocal({ mgPrivacyVersion: null });
      let baseline = mgPrivacyVersion;
      if (!baseline) {
        baseline = CURRENT_PRIVACY_VERSION;
        await setLocal({ mgPrivacyVersion: baseline });
      }

      if (remote === baseline) return; // unchanged

      // Newer (or simply different) policy: record it, raise the notice once.
      await setLocal({
        mgPrivacyVersion: remote,
        mgPrivacyNotice: { version: remote, ts: Math.floor(Date.now() / 1000) },
      });
      notify(remote);
    } finally {
      running = false;
    }
  }

  // --- scheduling ---------------------------------------------------------
  if (ext.alarms && ext.alarms.create) {
    ext.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MIN });
    if (ext.alarms.onAlarm) {
      ext.alarms.onAlarm.addListener((a) => { if (a && a.name === ALARM) runCheck(); });
    }
  }
  // A nudge shortly after the (non-persistent) background page wakes.
  setTimeout(runCheck, STARTUP_DELAY_MS);

  // Clicking the system notification opens the policy and clears the notice.
  if (ext.notifications && ext.notifications.onClicked) {
    ext.notifications.onClicked.addListener((id) => {
      if (id !== NOTIF_ID) return;
      openPolicy();
      setLocal({ mgPrivacyNotice: null });
      try { ext.notifications.clear(NOTIF_ID); } catch (e) { /* ignore */ }
    });
  }

  // Manual trigger for verification:
  //   browser.runtime.sendMessage({ type: "mg-privacy-check-now" })
  if (ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "mg-privacy-check-now") {
        runCheck().then(() => { try { sendResponse({ ok: true }); } catch (e) {} });
        return true; // async response
      }
      if (msg && msg.type === "mg-open-privacy") {
        openPolicy();
        setLocal({ mgPrivacyNotice: null });
      }
    });
  }
})();
