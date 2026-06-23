/**
 * Metric Glance background uploader (item #6, Option A: race-safe hard delete).
 *
 * Sends locally-logged training records to the collection Worker, then DELETES
 * the records that the server confirmed receiving. Runs in the background
 * context (sibling of background.js), so the signing secret stays out of page
 * scope and a batch is signed exactly once.
 *
 * Consent gate:
 *   Transmits ONLY when the Firefox "websiteContent" data-collection permission
 *   is granted (the toggle under about:addons -> Permissions and data). That
 *   permission is the single source of truth; the shareData setting just mirrors
 *   it for the UI. It is optional and ungranted by default, so until the user
 *   opts in this script is completely inert and nothing leaves the device.
 *
 * Race safety (no transactions in browser.storage.local):
 *   - converter.js only ever APPENDS to mgTraining (inside its own serialized
 *     writeChain).
 *   - This uploader only ever REMOVES specific, already-confirmed records,
 *     identified by their stable key tuple. After {ok:true} it RE-READS
 *     mgTraining fresh and removes the uploaded keys as a set difference, never
 *     writing back a stale snapshot. Records the content script appended during
 *     the upload survive.
 *   - The only residual window is a content-script flush landing between our
 *     fresh re-read and our set(); it's tiny, and the server's UNIQUE dedup_key
 *     makes the rare re-send idempotent. Proportionate to a training set.
 *
 * Contract with worker.js:
 *   POST JSON { install_id, records: [...] }
 *   Headers: X-MG-Ts (epoch seconds), X-MG-Sig (HMAC-SHA256 hex of ts "." body)
 *   install_id matches /^[0-9a-f-]{8,64}$/i  (crypto.randomUUID() qualifies)
 *   Each record carries the exact field names the worker validates.
 *   Success: { ok:true, inserted, skipped }. On ok:true we delete the whole
 *   sent batch locally (inserted rows are stored; server-skipped rows are
 *   malformed and would never insert, so retaining them would just clog the
 *   queue forever).
 */
(function () {
  "use strict";

  const ext =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome);
  if (!ext || !ext.storage || !ext.storage.local) return;
  const storage = ext.storage.local;

  // --- config -------------------------------------------------------------
  // ENDPOINT is the live Worker. CLIENT_SECRET MUST equal the value set on the
  // Worker via `wrangler secret put MG_HMAC_SECRET` (a 32-byte hex string).
  // Leave it empty in source control; fill it in the build that ships.
  const ENDPOINT = "https://mg-collect.metric-glance.workers.dev";
  const CLIENT_SECRET = "8001235cecd03b7c1c1a81176a0dc03a8337f6d5421a9e18cd3877c987cc1b5c";

  const MAX_RECORDS = 100;           // worker's per-POST cap
  const MAX_BODY_BYTES = 250 * 1024; // stay under the worker's 256 KB limit
  const ALARM = "mg-upload";
  const PERIOD_MIN = 60;             // upload sweep cadence
  const STARTUP_DELAY_MS = 15 * 1000;

  // Sharing consent is the Firefox "websiteContent" data-collection permission
  // (the toggle under about:addons -> Permissions and data). It is the single
  // source of truth for whether records may leave the device; the shareData
  // setting is just a mirror of it for the UI. Only this permission is linked
  // to sharing; logSamples (local-only logging) is independent.
  const SHARE_PERMISSION = { data_collection: ["websiteContent"] };

  // Fail closed: if the permissions API is unavailable, never upload.
  function hasSharePermission() {
    if (!ext.permissions || !ext.permissions.contains) return Promise.resolve(false);
    return Promise.resolve(ext.permissions.contains(SHARE_PERMISSION)).catch(() => false);
  }

  // Keep the shareData setting in sync with the actual permission, so the
  // options/welcome UI and the share-nudge reflect reality even when the user
  // flips the Firefox toggle directly. Re-reads the live permission rather than
  // trusting the event payload, which is robust across background-page unloads.
  function reconcileShareData() {
    return hasSharePermission().then((granted) =>
      getLocal({ shareData: false }).then(({ shareData }) => {
        if (!!shareData !== granted) return setLocal({ shareData: granted });
      })
    );
  }

  // --- tiny helpers -------------------------------------------------------
  function getLocal(defaults) {
    return new Promise((resolve) => {
      try {
        const p = storage.get(defaults);
        if (p && p.then) p.then(resolve, () => resolve(defaults));
        else storage.get(defaults, resolve); // callback-style fallback
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

  async function hmacHex(secret, msg) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Stable per-record identity. Mirrors the worker's dedup tuple minus the
  // install_id (which is constant for this install), so the same record always
  // maps to the same key on both sides.
  function recKey(r) {
    return [r.ts, r.label, r.span, r.span_start, r.span_end].join("|");
  }

  // The exact shape the worker validates. Extra fields are ignored server-side,
  // but sending a clean object keeps the body small and predictable.
  function toWire(r) {
    return {
      label: r.label,
      tier: r.tier,
      span: r.span,
      num: r.num != null ? r.num : null,
      unit: r.unit || "",
      unit_id: r.unit_id != null ? r.unit_id : null,
      before: r.before || "",
      after: r.after || "",
      sentence: r.sentence || "",
      heading: r.heading || "",
      tag: r.tag || "",
      page_units: Array.isArray(r.page_units) ? r.page_units : [],
      span_start: r.span_start,
      span_end: r.span_end,
      interacted: !!r.interacted,
      seen: !!r.seen,
      url: r.url || "",
      lang: r.lang || "",
      title: r.title || "",
      locale: r.locale || "",
      ts: r.ts,
    };
  }

  function flatten(store) {
    if (Array.isArray(store)) return store.slice(); // legacy flat format
    if (!store || typeof store !== "object") return [];
    return [].concat(store.corrected || [], store.seen || [], store.auto || []);
  }

  // --- install id ---------------------------------------------------------
  async function getInstallId() {
    const { mgInstallId } = await getLocal({ mgInstallId: null });
    if (typeof mgInstallId === "string" && /^[0-9a-f-]{8,64}$/i.test(mgInstallId)) {
      return mgInstallId;
    }
    const id = (crypto.randomUUID && crypto.randomUUID()) ||
      ([...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, "0")).join(""));
    await setLocal({ mgInstallId: id });
    return id;
  }

  // --- batch selection ----------------------------------------------------
  // Take up to MAX_RECORDS oldest records, then trim by serialized body size so
  // the payload stays under the worker limit. Returns { records, keys, body }.
  function buildBatch(installId, all) {
    const ordered = all.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let pick = ordered.slice(0, MAX_RECORDS);

    let wire, body;
    while (pick.length) {
      wire = pick.map(toWire);
      body = JSON.stringify({ install_id: installId, records: wire });
      if (body.length <= MAX_BODY_BYTES) break;
      // Drop the largest tail until it fits (or down to a single record).
      pick = pick.slice(0, Math.max(1, Math.floor(pick.length * 0.8)));
      if (pick.length === 1) {
        body = JSON.stringify({ install_id: installId, records: pick.map(toWire) });
        break;
      }
    }
    if (!pick.length) return null;
    const keys = new Set(pick.map(recKey));
    return { keys, body };
  }

  // Remove confirmed keys from a FRESH read of mgTraining (set difference), so
  // anything appended during the upload is preserved.
  async function deleteConfirmed(keys) {
    const { mgTraining } = await getLocal({ mgTraining: {} });
    let store = mgTraining;
    if (Array.isArray(store)) {
      // Legacy flat array: rebuild filtered, keep flat.
      const next = store.filter((r) => !keys.has(recKey(r)));
      await setLocal({ mgTraining: next });
      return;
    }
    if (!store || typeof store !== "object") store = {};
    const prune = (arr) => (arr || []).filter((r) => !keys.has(recKey(r)));
    await setLocal({
      mgTraining: {
        corrected: prune(store.corrected),
        seen: prune(store.seen),
        auto: prune(store.auto),
      },
    });
  }

  // --- one upload cycle ---------------------------------------------------
  let running = false;
  async function runCycle() {
    if (running) return;
    running = true;
    try {
      if (!CLIENT_SECRET) return; // not configured for this build

      if (!(await hasSharePermission())) return; // consent gate (Firefox websiteContent)

      const installId = await getInstallId();
      const { mgTraining } = await getLocal({ mgTraining: {} });
      const all = flatten(mgTraining);
      if (!all.length) return;

      const batch = buildBatch(installId, all);
      if (!batch) return;

      const ts = Math.floor(Date.now() / 1000);
      const sig = await hmacHex(CLIENT_SECRET, ts + "." + batch.body);

      let resp;
      try {
        resp = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-MG-Ts": String(ts),
            "X-MG-Sig": sig,
          },
          body: batch.body,
        });
      } catch (e) {
        return; // network error: keep records, try next cycle
      }

      if (resp.status === 429) return; // rate limited: back off, keep records

      let out = null;
      try { out = await resp.json(); } catch (e) { /* ignore */ }
      if (!resp.ok || !out || out.ok !== true) {
        // 4xx config errors (bad_sig, bad_install, ...) and 5xx: do NOT delete.
        return;
      }

      // Confirmed receipt -> hard delete the sent batch, race-safely.
      await deleteConfirmed(batch.keys);
      // Remaining records (if the queue was larger than one batch) go next tick.
    } finally {
      running = false;
    }
  }

  // --- scheduling ---------------------------------------------------------
  if (ext.alarms && ext.alarms.create) {
    ext.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MIN });
    if (ext.alarms.onAlarm) {
      ext.alarms.onAlarm.addListener((a) => { if (a && a.name === ALARM) runCycle(); });
    }
  }
  // A nudge shortly after the background script wakes (non-persistent page).
  setTimeout(runCycle, STARTUP_DELAY_MS);

  // Mirror the websiteContent permission into shareData: on every background
  // wake (covers toggles made while the page was unloaded) and live whenever
  // the user grants/revokes it in the Firefox UI.
  reconcileShareData();
  if (ext.permissions && ext.permissions.onAdded) {
    ext.permissions.onAdded.addListener(reconcileShareData);
    ext.permissions.onRemoved.addListener(reconcileShareData);
  }

  // Manual trigger (useful for verifying #5's toggle later):
  //   browser.runtime.sendMessage({ type: "mg-upload-now" })
  if (ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "mg-upload-now") {
        runCycle().then(() => { try { sendResponse({ ok: true }); } catch (e) {} });
        return true; // async response
      }
    });
  }
})();
