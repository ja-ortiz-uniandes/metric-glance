/**
 * Metric Glance - converts imperial units to metric and rounds large prices.
 *
 * Detection pipeline:
 *   proposeSpans(text)  -> candidate spans needing conversion
 *     - Today: deterministic regex engine (runs everywhere, incl. mobile).
 *     - Future: a fine-tuned token-classification encoder (transformers.js)
 *       slots in here. See loadEncoder() and the README for the contract.
 *   User rules (force / block) override the detector both ways.
 *   Conversion math is always deterministic (the model never does arithmetic).
 *
 * User corrections:
 *   - Select text -> floating toolbar -> "Convert as unit" / "Round as price".
 *   - Tap / click / right-click a converted value -> popover -> "Not a conversion".
 *   Each correction (a) takes effect immediately via local rules and
 *   (b) is logged as a labeled training example, exportable from Options.
 *   All of this works on desktop and on Firefox for Android.
 */
(function () {
  "use strict";

  const MARK_CLASS = "mg-converted";
  const UI_ATTR = "data-mg-ui";
  let currentShortcut = ""; // live value of the open-picker command, from background

  const api =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome) ||
    null;
  const storage = api && api.storage ? api.storage.local : null;

  // ---------------------------------------------------------------
  // Settings + user rules + training log (all storage-backed)
  // ---------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    priceRounding: true,
    // Max cents a price may be nudged UP to reach the next whole unit.
    // 1..99. e.g. 5 rounds $1.99 and $1.95 up to the next dollar, but not $1.50.
    priceRoundCents: 60,
    // When on, log a small random sample of the conversions the detector got
    // right (not just corrections), so the eventual training set is balanced.
    logSamples: false,
    // Number formatting
    maxOrderOfMagnitude: 6, // max integer digits before switching to a bigger unit
    decimalPlaces: 2,       // max decimals shown
    thousandsSeparator: ",",
    // Which metric tiers to display (global), and optional per-type overrides.
    displayTiers: [-3, -2, 0, 3, 6, 9],
    hoverTiers: [-3, -2, 0, 3, 6, 9],
    displayTiersByCat: { Volume: [-3, 0, 3], Mass: [-3, 0, 3, 6], Energy: [0, 3, 6, 9], Power: [0, 3, 6, 9], Pressure: [0, 3, 6, 9], Speed: [0], Density: [3] },
    hoverTiersByCat: { Volume: [-3, 0, 3], Mass: [-3, 0, 3, 6], Energy: [0, 3, 6, 9], Power: [0, 3, 6, 9], Pressure: [0, 3, 6, 9], Speed: [0], Density: [3] },
    displayScales: {}, // (no fixed non-prefix measurements remain)
    hoverScales: {},
    catBase: { Speed: "km/h" }, // per-measurement base unit
    useEncoder: false, // becomes meaningful once a model is provided
    encoderModelUrl: "",
    shareData: false,  // consent to upload training examples to the backend
    disabledHosts: [], // hostnames where Metric Glance does not run at all
    wordSubs: { soccer: true, aluminum: true }, // playful word swaps, toggled per term in Options
  };
  const SAMPLE_RATE = 0.12; // fraction of correct detections logged when logSamples is on
  // Corrections are stored per-hostname under DEFAULT_RULES.hosts, never global.
  const DEFAULT_RULES = { hosts: {} };

  let settings = { ...DEFAULT_SETTINGS };
  let rules = { hosts: {} };

  function norm(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  // ---------------------------------------------------------------
  // Corrections (per-site, anchored to one occurrence)
  //
  // Every manual correction is permanent but LOCAL: stored under the current
  // hostname and anchored to the specific occurrence it was made on, by keeping
  // a normalized window of the page text on each side. On reload it re-applies
  // only where the same surface appears in the same surrounding text, so it
  // never leaks to other sites, nor to other occurrences of the same text on
  // the page. Types: block (not a conversion), forceUnit (convert as a unit),
  // forcePrice (round as a price).
  // ---------------------------------------------------------------
  const HOST = String(location.hostname || "").trim().toLowerCase().replace(/\.$/, "");
  const CTX_WIN = 24; // chars of surrounding context kept on each side
  const EMPTY_BUCKET = { block: [], forceUnit: [], forcePrice: [] };

  function bucket(create) {
    if (!rules.hosts) rules.hosts = {};
    let b = rules.hosts[HOST];
    if (!b && create) { b = { block: [], forceUnit: [], forcePrice: [] }; rules.hosts[HOST] = b; }
    if (b) { b.block = b.block || []; b.forceUnit = b.forceUnit || []; b.forcePrice = b.forcePrice || []; }
    return b || EMPTY_BUCKET;
  }
  function persistRules() {
    if (storage) storage.set({ mgRules: rules });
  }

  // --- occurrence anchoring -------------------------------------------------
  function winBefore(text, start) { return norm(text.slice(Math.max(0, start - CTX_WIN), start)); }
  function winAfter(text, end) { return norm(text.slice(end, end + CTX_WIN)); }
  // A side matches when either string is a suffix/prefix of the other (the
  // write-time and scan-time windows are gathered differently, so lengths and
  // outer edges can differ; only the text nearest the surface must coincide).
  function tailMatch(a, b) { if (!b) return true; if (!a) return false; return a.endsWith(b) || b.endsWith(a); }
  function headMatch(a, b) { if (!b) return true; if (!a) return false; return a.startsWith(b) || b.startsWith(a); }
  function occMatches(rec, surface, text, start, end) {
    return rec.surface === surface &&
      tailMatch(winBefore(text, start), rec.before) &&
      headMatch(winAfter(text, end), rec.after);
  }
  function blockMatch(surface, text, start, end) {
    return bucket(false).block.some((r) => occMatches(r, surface, text, start, end));
  }
  function forcePriceMatch(surface, text, start, end) {
    return bucket(false).forcePrice.some((r) => occMatches(r, surface, text, start, end));
  }
  function forceUnitMatch(surface, text, start, end) {
    const r = bucket(false).forceUnit.find((x) => occMatches(x, surface, text, start, end));
    return r ? r.unitId : null;
  }
  // Match an occurrence given a DOM node rather than linear text+offsets, for
  // the split-price path where the price is spread across elements.
  function occMatchesNode(rec, surface, node) {
    if (rec.surface !== norm(surface)) return false;
    const a = anchorFor(node, surface);
    return tailMatch(a.before, rec.before) && headMatch(a.after, rec.after);
  }

  // --- writing a correction (anchor computed from the live DOM) -------------
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function blockAncestor(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el.parentElement && isInlineEl(el)) el = el.parentElement;
    return el || node.parentElement || node;
  }
  // Build the {surface, before, after} anchor for a span (or wrapper) sitting in
  // the page, by reading the surrounding text of its nearest block ancestor.
  function anchorFor(node, surface) {
    let before = "", after = "", seen = false;
    const block = blockAncestor(node);
    try {
      const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      let t;
      while ((t = w.nextNode())) {
        if (node.contains ? node.contains(t) : node === t) { seen = true; continue; }
        if (!seen) before += (t.nodeValue || "");
        else after += (t.nodeValue || "");
      }
    } catch (e) { /* detached node; fall back to empty windows */ }
    return { surface: norm(surface), before: norm(before).slice(-CTX_WIN * 2), after: norm(after).slice(0, CTX_WIN * 2) };
  }
  function sameOcc(a, b) { return a.surface === b.surface && a.before === b.before && a.after === b.after; }
  function clearOcc(b, rec) {
    b.block = b.block.filter((r) => !sameOcc(r, rec));
    b.forceUnit = b.forceUnit.filter((r) => !sameOcc(r, rec));
    b.forcePrice = b.forcePrice.filter((r) => !sameOcc(r, rec));
  }
  function recordForceUnit(node, surface, unitId) {
    const rec = anchorFor(node, surface);
    if (!rec.surface) return;
    const b = bucket(true); clearOcc(b, rec); b.forceUnit.push({ ...rec, unitId }); persistRules();
  }
  function recordForcePrice(node, surface) {
    const rec = anchorFor(node, surface);
    if (!rec.surface) return;
    const b = bucket(true); clearOcc(b, rec); b.forcePrice.push(rec); persistRules();
  }
  function recordBlock(node, surface) {
    const rec = anchorFor(node, surface);
    if (!rec.surface) return;
    const b = bucket(true); clearOcc(b, rec); b.block.push(rec); persistRules();
  }

  // A training example captures everything a token-classification encoder
  // would need later: the label, the exact span text, the surrounding
  // sentence window, and the span's character offsets within that window
  // (so it can be turned into BIO tags). "not_a_conversion" examples are the
  // negative labels; "interpretation:<id>" records which reading was correct.
  // Buffer records in memory and flush them in a single batched, serialized
  // write. Logging many at once (e.g. sampled detections across a page) would
  // otherwise race: each async get/set would clobber the others.
  let pendingLog = [];
  let flushTimer = null;
  let writeChain = Promise.resolve();
  const FLUSH_DELAY = 400;

  const CTX_BEFORE = 400;   // context kept before the span
  const CTX_AFTER = 200;    // context kept after (before is ~2x after)
  const TRAIN_CAPS = { corrected: 6000, seen: 4000, auto: 2000 };

  function capArr(a, n) { if (a.length > n) a.splice(0, a.length - n); return a; }
  function migrateTraining(store) {
    if (Array.isArray(store)) { // old flat-array format -> route by label into tiers
      const out = { corrected: [], seen: [], auto: [] };
      for (const r of store) {
        const l = (r && r.label) || "";
        const t = l.indexOf("auto:") === 0 ? "auto" : (l.indexOf("seen:") === 0 ? "seen" : "corrected");
        out[t].push(r);
      }
      return out;
    }
    if (!store || typeof store !== "object") store = {};
    store.corrected = store.corrected || [];
    store.seen = store.seen || [];
    store.auto = store.auto || [];
    return store;
  }

  function flushLog() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!storage || !pendingLog.length) return;
    const batch = pendingLog;
    pendingLog = [];
    writeChain = writeChain
      .then(() => storage.get({ mgTraining: {} }))
      .then((res) => {
        const store = migrateTraining(res.mgTraining);
        for (const r of batch) (store[r.tier] || store.corrected).push(r);
        capArr(store.corrected, TRAIN_CAPS.corrected);
        capArr(store.seen, TRAIN_CAPS.seen);
        capArr(store.auto, TRAIN_CAPS.auto);
        return storage.set({ mgTraining: store });
      })
      .catch(() => {});
  }

  // Nearest containing tag + nearest preceding heading: strong "what kind of
  // page is this" signal for the classifier.
  function domSignals(node) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : (node && node.parentElement);
    let tag = "", heading = "";
    if (el) {
      tag = (el.tagName || "").toLowerCase();
      let h = el.closest ? el.closest("h1,h2,h3,h4,h5,h6") : null;
      let cur = el;
      for (let i = 0; i < 50 && cur && !h; i++) {
        let p = cur.previousElementSibling;
        while (p) {
          if (/^H[1-6]$/.test(p.tagName)) { h = p; break; }
          if (p.querySelector) { const inner = p.querySelector("h1,h2,h3,h4,h5,h6"); if (inner) { h = inner; break; } }
          p = p.previousElementSibling;
        }
        cur = cur.parentElement;
      }
      if (h) heading = (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    }
    return { tag, heading };
  }
  function sentenceAround(full, idx, spanLen) {
    if (idx < 0) return "";
    const before = full.slice(0, idx);
    const b = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
    const start = b >= 0 ? b + 1 : 0;
    const from = idx + spanLen;
    const cands = [full.indexOf(". ", from), full.indexOf("? ", from), full.indexOf("! ", from)].filter((x) => x >= 0);
    const end = cands.length ? Math.min.apply(null, cands) + 1 : full.length;
    return full.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
  }
  function splitNumUnit(text) {
    const m = /(-?[\d.,]+)\s*(.*)$/.exec((text || "").trim());
    if (!m) return { num: null, unit: (text || "").trim() };
    return { num: parseFloat(m[1].replace(/,/g, "")), unit: m[2].trim() };
  }
  function pageUnitIds() {
    const seen = {}, out = [];
    try {
      const nodes = document.querySelectorAll("." + MARK_CLASS + "[data-variant]");
      for (let i = 0; i < nodes.length && out.length < 40; i++) {
        const v = nodes[i].getAttribute("data-variant");
        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
      }
    } catch (e) {}
    return out;
  }

  function logTrainingExample(label, span, context, opts) {
    if (!storage) return;
    opts = opts || {};
    const ctx = (context || "").replace(/\s+/g, " ").trim();
    let before = "", after = "";
    const idx = ctx.indexOf(span);
    if (idx >= 0) {
      before = ctx.slice(Math.max(0, idx - CTX_BEFORE), idx);
      after = ctx.slice(idx + span.length, idx + span.length + CTX_AFTER);
    } else {
      before = ctx.slice(0, CTX_BEFORE);
    }
    const tier = opts.tier
      || (label.indexOf("auto:") === 0 ? "auto" : (label.indexOf("seen:") === 0 ? "seen" : "corrected"));
    const interacted = opts.interacted !== undefined ? !!opts.interacted : tier === "corrected";
    const nu = splitNumUnit(span);
    const dom = domSignals(opts.node);
    pendingLog.push({
      label,
      tier,                                   // corrected | seen | auto (value)
      span,
      num: opts.num != null ? opts.num : nu.num,
      unit: opts.unit || nu.unit,
      unit_id: opts.unitId || null,
      before,                                 // up to 400 chars before
      after,                                  // up to 200 chars after
      sentence: sentenceAround(ctx, idx, span.length),
      heading: dom.heading,
      tag: dom.tag,
      page_units: pageUnitIds(),              // co-occurring converted units
      span_start: before.length,
      span_end: before.length + span.length,
      interacted,
      seen: opts.seen !== undefined ? !!opts.seen : (tier !== "auto"),
      url: typeof location !== "undefined" ? location.hostname : "",
      lang: (document.documentElement && document.documentElement.lang) || "",
      title: (document.title || "").slice(0, 120),
      locale: (typeof navigator !== "undefined" && navigator.language) || "",
      ts: Date.now(),
    });
    if (!flushTimer) flushTimer = setTimeout(flushLog, FLUSH_DELAY);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushLog);
    window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushLog(); });
  }

  // ---------------------------------------------------------------
  // Unit engine
  // ---------------------------------------------------------------
  // Each unit has one or more interpretation "variants". variants[0] is the
  // default. A variant's toMetric(value) returns the metric value, and fmt()
  // formats THAT value (no re-conversion). rate is shown in the hover panel.
  // Ambiguous units (pounds, ounces, US-vs-imperial volumes) carry several
  // variants so the user can say which one is meant.
  const UNITS = [
    { name: "fahrenheit", pattern: "(?:°\\s*F|℉|degrees?\\s+Fahrenheit|Fahrenheit)", allowNegative: true, variants: [
      { id: "f", label: "Temperature (°F → °C)", toMetric: (v) => ((v - 32) * 5) / 9, fmt: (v) => `${round(v, 1)}\u00A0°C`, rate: "°C = (°F − 32) × 5/9" },
    ] },
    { name: "mph", pattern: "(?:mph|miles?\\s+per\\s+hour|miles?\\s*/\\s*h(?:ou)?r?)", variants: [
      { id: "mph", label: "Speed (mph → km/h)", toMetric: (v) => v * 1.609344, fmt: (v) => fmtScale("Speed", v/3.6), rate: "1 mph = 1.609 km/h" },
    ] },
    { name: "sqft", pattern: "(?:sq\\.?\\s*ft\\.?|square\\s+feet|square\\s+foot|ft²)", variants: [
      { id: "sqft", label: "Area (sq ft → m²)", toMetric: (v) => v * 0.09290304, fmt: (v) => fmtScale("Area", v), rate: "1 sq ft = 0.0929 m²" },
    ] },
    { name: "sqmi", pattern: "(?:sq\\.?\\s*mi\\.?|square\\s+miles?|mi²)", variants: [
      { id: "sqmi", label: "Area (sq mi → km²)", toMetric: (v) => v * 2.589988, fmt: (v) => fmtScale("Area", v*1e6), rate: "1 sq mi = 2.59 km²" },
    ] },
    { name: "cuin", pattern: "(?:cubic\\s+inch(?:es)?|cu\\.?\\s*in\\.?|in³|in\\^?3)", variants: [
      { id: "cuin", label: "Volume — cubic inches (→ cm³)", toMetric: (v) => v * 16.387064, fmt: (v) => formatVolumeCm3(v), rate: "1 cu in = 16.39 cm³" },
    ] },
    { name: "cuft", pattern: "(?:cubic\\s+f(?:oot|eet)|cu\\.?\\s*ft\\.?|ft³|ft\\^?3)", variants: [
      { id: "cuft", label: "Volume — cubic feet (→ m³)", toMetric: (v) => v * 0.0283168466, fmt: (v) => formatVolumeM3(v), rate: "1 cu ft = 0.0283 m³" },
    ] },
    { name: "cuyd", pattern: "(?:cubic\\s+yards?|cu\\.?\\s*yd\\.?|yd³|yd\\^?3)", variants: [
      { id: "cuyd", label: "Volume — cubic yards (→ m³)", toMetric: (v) => v * 0.764554858, fmt: (v) => formatVolumeM3(v), rate: "1 cu yd = 0.765 m³" },
    ] },
    { name: "floz", pattern: "(?:(?:imp(?:erial)?|u\\.?\\s?s\\.?|us)\\s+)?(?:fl\\.?\\s*oz\\.?|fluid\\s+ounces?)", variants: [
      { id: "usfloz", label: "US fluid ounce (→ ml)", toMetric: (v) => v * 29.5735, fmt: (v) => formatVolumeMl(v), rate: "1 US fl oz = 29.57 ml", surfaces: /^(?!.*imp)/i },
      { id: "impfloz", label: "Imperial fluid ounce (→ ml)", toMetric: (v) => v * 28.4131, fmt: (v) => formatVolumeMl(v), rate: "1 imp fl oz = 28.41 ml", surfaces: /^(?!.*u\.?s)/i },
    ] },
    { name: "miles", pattern: "(?:miles?|mi\\.)", variants: [
      { id: "mi", label: "Distance (miles → km)", toMetric: (v) => v * 1.609344, fmt: (v) => fmtScale("Length", v*1000), rate: "1 mile = 1.609 km" },
    ] },
    { name: "yards", pattern: "(?:yards?|yds?\\.?)", variants: [
      { id: "yd", label: "Length (yards → m)", toMetric: (v) => v * 0.9144, fmt: (v) => fmtScale("Length", v), rate: "1 yard = 0.9144 m" },
    ] },
    { name: "feet", pattern: "(?:feet|foot|ft\\.?|[′'])", variants: [
      { id: "ft", label: "Length (feet → m)", toMetric: (v) => v * 0.3048, fmt: (v) => formatLengthM(v), rate: "1 foot = 0.3048 m" },
    ] },
    { name: "inches", pattern: "(?:inches|inch|in\\.|[″\"])", variants: [
      { id: "in", label: "Length (inches → cm)", toMetric: (v) => v * 2.54, fmt: (v) => fmtScale("Length", v/100), rate: "1 inch = 2.54 cm" },
    ] },
    { name: "pounds", pattern: "(?:pounds?|lbs?\\.?)", variants: [
      { id: "lb", label: "Weight — pounds (lb → kg)", toMetric: (v) => v * 0.45359237, fmt: (v) => formatMassKg(v), rate: "1 lb = 0.4536 kg" },
      { id: "gbp", label: "Money — British pounds (£)", money: true, rate: "currency, left unconverted", surfaces: /^pounds?$/i },
    ] },
    { name: "ounces", pattern: "(?:ounces?|oz\\.?)", variants: [
      { id: "oz", label: "Weight — ounces (oz → g)", toMetric: (v) => v * 28.349523, fmt: (v) => fmtScale("Mass", v), rate: "1 oz = 28.35 g" },
    ] },
    { name: "stone", pattern: "(?:stones?)", variants: [
      { id: "st", label: "Weight (stone → kg)", toMetric: (v) => v * 6.35029318, fmt: (v) => fmtScale("Mass", v*1000), rate: "1 stone = 6.35 kg" },
    ] },
    { name: "gallons", pattern: "(?:(?:imp(?:erial)?|u\\.?\\s?s\\.?|us)\\s+)?(?:gallons?|gal\\.?)", variants: [
      { id: "usgal", label: "US gallon (→ L)", toMetric: (v) => v * 3.785412, fmt: (v) => fmtScale("Volume", v), rate: "1 US gal = 3.785 L", surfaces: /^(?!.*imp)/i },
      { id: "impgal", label: "Imperial gallon (→ L)", toMetric: (v) => v * 4.54609, fmt: (v) => fmtScale("Volume", v), rate: "1 imp gal = 4.546 L", surfaces: /^(?!.*u\.?s)/i },
    ] },
    { name: "quarts", pattern: "(?:(?:imp(?:erial)?|u\\.?\\s?s\\.?|us)\\s+)?(?:quarts?|qts?\\.?)", variants: [
      { id: "usqt", label: "US quart (→ L)", toMetric: (v) => v * 0.946353, fmt: (v) => fmtScale("Volume", v), rate: "1 US qt = 0.946 L", surfaces: /^(?!.*imp)/i },
      { id: "impqt", label: "Imperial quart (→ L)", toMetric: (v) => v * 1.136523, fmt: (v) => fmtScale("Volume", v), rate: "1 imp qt = 1.137 L", surfaces: /^(?!.*u\.?s)/i },
    ] },
    { name: "pints", pattern: "(?:(?:imp(?:erial)?|u\\.?\\s?s\\.?|us)\\s+)?(?:pints?|pts?\\.)", variants: [
      { id: "uspt", label: "US pint (→ ml)", toMetric: (v) => v * 473.176, fmt: (v) => formatVolumeMl(v), rate: "1 US pint = 473 ml", surfaces: /^(?!.*imp)/i },
      { id: "imppt", label: "Imperial pint (→ ml)", toMetric: (v) => v * 568.261, fmt: (v) => formatVolumeMl(v), rate: "1 imp pint = 568 ml", surfaces: /^(?!.*u\.?s)/i },
    ] },
    { name: "acres", pattern: "(?:acres?)", variants: [
      { id: "ac", label: "Area (acres → ha)", toMetric: (v) => v * 0.40468564, fmt: (v) => fmtScale("Area", v*1e4), rate: "1 acre = 0.4047 ha" },
    ] },
  ];

  const NUM = "(-?\\d{1,3}(?:,\\d{3})+|-?\\d+)(?:\\.(\\d+(?:\\s\\d{2,})*))?(?:\\s+(\\d+)\\s*/\\s*(\\d+))?";
  const UNIT_ALT = UNITS.map((u) => u.pattern).join("|");
  const UNIT_RE = new RegExp("(?<![\\w])" + NUM + "\\s*(" + UNIT_ALT + ")(?![\\w°])", "gi");
  const UNIT_RES = UNITS.map((u) => ({ unit: u, re: new RegExp("^(?:" + u.pattern + ")$", "i") }));

  // Dimension lists sharing one trailing unit. With ×/x separators we allow
  // bare in/ft/yd (the × strongly signals dimensions); with "by" we require
  // full unit words, since "5 by 3 in the box" is ordinary English.
  const DIM_UNIT_ALT = "in|inch|inches|in\\.|″|ft|feet|foot|ft\\.|′|yd|yds?|yards?|yd\\.";
  const DIM_RE_X = new RegExp(
    "(\\d+(?:\\.\\d+)?)((?:\\s*[x×]\\s*\\d+(?:\\.\\d+)?){1,})\\s*(" + DIM_UNIT_ALT + ")(?![\\w°])",
    "gi"
  );
  const DIM_RE_BY = new RegExp(
    "(\\d+(?:\\.\\d+)?)((?:\\s*by\\s*\\d+(?:\\.\\d+)?){1,})\\s*(" + UNIT_ALT + ")(?![\\w°])",
    "gi"
  );
  const DIM_UNITS = [
    { re: /^(?:in|inch|inches|in\.|[″"])$/i, name: "inches" },
    { re: /^(?:ft|feet|foot|ft\.|[′'])$/i, name: "feet" },
    { re: /^(?:yd|yds?|yards?|yd\.)$/i, name: "yards" },
  ];
  function findDimUnit(unitText) {
    const x = (unitText || "").trim();
    for (const d of DIM_UNITS) if (d.re.test(x)) return UNITS.find((u) => u.name === d.name);
    return findUnit(unitText);
  }

  // Compound feet+inches written as 5'10" or 5′10″ (or mixed). Matched as a
  // single span so it wins over the partial 10" match from UNIT_RE.
  const HEIGHT_RE = new RegExp(
    "(\\d+(?:\\.\\d+)?)\\s*[′']\\s*(\\d+(?:\\.\\d+)?)\\s*[″\"](?![\\w°])",
    "gi"
  );

  function findUnit(unitText) {
    for (const { unit, re } of UNIT_RES) if (re.test(unitText.trim())) return unit;
    return null;
  }

  // Lookup of every convertible variant by id (money excluded), and a
  // category catalog used by the "convert selection to metric" menu.
  const VARIANT_BY_ID = {};
  for (const u of UNITS) for (const v of u.variants) if (!v.money) VARIANT_BY_ID[v.id] = v;

  // ---------------------------------------------------------------
  // Conversion registry: the full set of units a person can pick from
  // the search panel. Superset of the detection units; survives the
  // eventual swap of the regex detector for a classifier (detection and
  // this manual catalog sit on opposite sides of the proposeSpans seam).
  // rank: 1 = most common, higher = more esoteric. aliases feed search.
  // ---------------------------------------------------------------
  const REGISTRY = [
    // Length (base: cm or m via formatLengthM)
    { id: "in", cat: "Length", name: "Inch", rank: 1, aliases: ["inch", "inches", "in", '"', "″"], toMetric: (v) => v * 2.54, fmt: (v) => fmtScale("Length", v/100), rate: "1 in = 2.54 cm" },
    { id: "ft", cat: "Length", name: "Foot", rank: 1, aliases: ["foot", "feet", "ft", "'", "′"], toMetric: (v) => v * 0.3048, fmt: (v) => formatLengthM(v), rate: "1 ft = 0.3048 m" },
    { id: "yd", cat: "Length", name: "Yard", rank: 2, aliases: ["yard", "yards", "yd"], toMetric: (v) => v * 0.9144, fmt: (v) => fmtScale("Length", v), rate: "1 yd = 0.9144 m" },
    { id: "mi", cat: "Length", name: "Mile", rank: 1, aliases: ["mile", "miles", "mi"], toMetric: (v) => v * 1.609344, fmt: (v) => fmtScale("Length", v*1000), rate: "1 mi = 1.609 km" },
    { id: "nmi", cat: "Length", name: "Nautical mile", rank: 4, aliases: ["nautical mile", "nmi", "nm"], toMetric: (v) => v * 1.852, fmt: (v) => fmtScale("Length", v*1000), rate: "1 nmi = 1.852 km" },
    { id: "fathom", cat: "Length", name: "Fathom", rank: 5, aliases: ["fathom", "fathoms"], toMetric: (v) => v * 1.8288, fmt: (v) => fmtScale("Length", v), rate: "1 fathom = 1.829 m" },
    { id: "furlong", cat: "Length", name: "Furlong", rank: 6, aliases: ["furlong", "furlongs"], toMetric: (v) => v * 201.168, fmt: (v) => fmtScale("Length", v), rate: "1 furlong = 201.2 m" },
    { id: "chain", cat: "Length", name: "Chain", rank: 7, aliases: ["chain", "chains"], toMetric: (v) => v * 20.1168, fmt: (v) => fmtScale("Length", v), rate: "1 chain = 20.12 m" },
    { id: "rod", cat: "Length", name: "Rod (pole, perch)", rank: 7, aliases: ["rod", "pole", "perch"], toMetric: (v) => v * 5.0292, fmt: (v) => fmtScale("Length", v), rate: "1 rod = 5.029 m" },
    { id: "hand", cat: "Length", name: "Hand", rank: 6, aliases: ["hand", "hands"], toMetric: (v) => v * 10.16, fmt: (v) => fmtScale("Length", v/100), rate: "1 hand = 10.16 cm" },
    { id: "mil", cat: "Length", name: "Mil (thou, 1/1000 inch)", rank: 8, aliases: ["mil", "thou"], toMetric: (v) => v * 0.0254, fmt: (v) => fmtScale("Length", v/1000), rate: "1 mil = 0.0254 mm" },
    { id: "mil_se", cat: "Length", name: "Swedish mil (10 km)", rank: 8, aliases: ["swedish mil", "scandinavian mil"], toMetric: (v) => v * 10, fmt: (v) => fmtScale("Length", v*1000), rate: "1 Swedish mil = 10 km" },
    { id: "league", cat: "Length", name: "League", rank: 7, aliases: ["league", "leagues", "lea"], toMetric: (v) => v * 4828.032, fmt: (v) => fmtScale("Length", v), rate: "1 league = 4.828 km" },
    { id: "link", cat: "Length", name: "Link (Gunter's)", rank: 8, aliases: ["link", "links"], toMetric: (v) => v * 0.201168, fmt: (v) => fmtScale("Length", v), rate: "1 link = 20.12 cm" },
    { id: "cable", cat: "Length", name: "Cable length", rank: 8, aliases: ["cable", "cables", "cable length"], toMetric: (v) => v * 185.2, fmt: (v) => fmtScale("Length", v), rate: "1 cable = 185.2 m" },
    { id: "barleycorn", cat: "Length", name: "Barleycorn", rank: 8, aliases: ["barleycorn", "barleycorns"], toMetric: (v) => v * 0.0084667, fmt: (v) => fmtScale("Length", v), rate: "1 barleycorn = 8.47 mm" },
    { id: "twip", cat: "Length", name: "Twip", rank: 8, aliases: ["twip", "twips"], toMetric: (v) => v * 0.0000176389, fmt: (v) => fmtScale("Length", v), rate: "1 twip = 17.64 µm" },
    { id: "tenthft", cat: "Length", name: "Tenth of a foot (rig tape)", rank: 8, aliases: ["tenth of a foot", "tenths of a foot"], toMetric: (v) => v * 0.03048, fmt: (v) => fmtScale("Length", v), rate: "1 tenth-ft = 3.048 cm" },
    { id: "smoot", cat: "Length", name: "Smoot", rank: 8, aliases: ["smoot", "smoots"], toMetric: (v) => v * 1.7018, fmt: (v) => fmtScale("Length", v), rate: "1 smoot = 1.702 m" },
    { id: "passus", cat: "Length", name: "Roman pace (passus)", rank: 8, aliases: ["passus", "roman pace"], toMetric: (v) => v * 1.48, fmt: (v) => fmtScale("Length", v), rate: "1 passus \u2248 1.48 m" },
    { id: "stadium", cat: "Length", name: "Stadium (stadion)", rank: 8, aliases: ["stadium", "stadion", "stadia"], toMetric: (v) => v * 185, fmt: (v) => fmtScale("Length", v), rate: "1 stadium \u2248 185 m" },

    // Mass
    { id: "oz", cat: "Mass", name: "Ounce", rank: 1, aliases: ["ounce", "ounces", "oz"], toMetric: (v) => v * 28.349523, fmt: (v) => fmtScale("Mass", v), rate: "1 oz = 28.35 g" },
    { id: "lb", cat: "Mass", name: "Pound (avoirdupois)", rank: 1, aliases: ["pound", "pounds", "lb", "lbs"], toMetric: (v) => v * 0.45359237, fmt: (v) => formatMassKg(v), rate: "1 lb = 0.4536 kg" },
    { id: "lb_troy", cat: "Mass", name: "Troy pound", rank: 6, aliases: ["troy pound", "troy lb", "lb t"], toMetric: (v) => v * 0.3732417216, fmt: (v) => formatMassKg(v), rate: "1 troy lb = 373.2 g" },
    { id: "st", cat: "Mass", name: "Stone", rank: 3, aliases: ["stone", "stones"], toMetric: (v) => v * 6.35029318, fmt: (v) => fmtScale("Mass", v*1000), rate: "1 stone = 6.35 kg" },
    { id: "ton_us", cat: "Mass", name: "US ton (short)", rank: 4, aliases: ["short ton", "us ton", "ton"], toMetric: (v) => v * 907.18474, fmt: (v) => formatMassT(v), rate: "1 short ton = 907.2 kg" },
    { id: "ton_long", cat: "Mass", name: "Long ton (UK)", rank: 5, aliases: ["long ton", "imperial ton"], toMetric: (v) => v * 1016.0469, fmt: (v) => formatMassT(v), rate: "1 long ton = 1016 kg" },
    { id: "tonne", cat: "Mass", name: "Metric ton (tonne)", rank: 3, aliases: ["tonne", "metric ton", "mt"], toMetric: (v) => v * 1000, fmt: (v) => formatMassT(v), rate: "1 tonne = 1000 kg" },
    { id: "ozt", cat: "Mass", name: "Troy ounce", rank: 5, aliases: ["troy ounce", "ozt", "oz t"], toMetric: (v) => v * 31.1034768, fmt: (v) => fmtScale("Mass", v), rate: "1 ozt = 31.10 g" },
    { id: "grain", cat: "Mass", name: "Grain", rank: 6, aliases: ["grain", "grains", "gr"], toMetric: (v) => v * 0.06479891, fmt: (v) => fmtScale("Mass", v), rate: "1 grain = 64.8 mg" },
    { id: "dram", cat: "Mass", name: "Dram (avoirdupois)", rank: 6, aliases: ["dram", "drams"], toMetric: (v) => v * 1.7718452, fmt: (v) => fmtScale("Mass", v), rate: "1 dram = 1.772 g" },
    { id: "dram_apoth", cat: "Mass", name: "Apothecary dram", rank: 7, aliases: ["apothecary dram", "drachm"], toMetric: (v) => v * 3.8879346, fmt: (v) => fmtScale("Mass", v), rate: "1 apoth dram = 3.888 g" },
    { id: "cwt_us", cat: "Mass", name: "Hundredweight (US short)", rank: 7, aliases: ["hundredweight", "cwt", "short hundredweight"], toMetric: (v) => v * 45.359237, fmt: (v) => fmtScale("Mass", v*1000), rate: "1 US cwt = 45.36 kg" },
    { id: "cwt_uk", cat: "Mass", name: "Hundredweight (UK long)", rank: 7, aliases: ["long hundredweight", "uk cwt", "imperial cwt"], toMetric: (v) => v * 50.80234544, fmt: (v) => fmtScale("Mass", v*1000), rate: "1 UK cwt = 50.80 kg" },

    // Volume
    { id: "usfloz", cat: "Volume", name: "US fluid ounce (customary)", rank: 1, aliases: ["fl oz", "fluid ounce", "us fl oz", "floz"], toMetric: (v) => v * 29.5735, fmt: (v) => formatVolumeMl(v), rate: "1 US fl oz = 29.57 ml" },
    { id: "usfloz_food", cat: "Volume", name: "US fl oz (nutrition label, 30 ml)", rank: 3, aliases: ["fl oz food", "us fl oz food", "nutrition fl oz", "label fl oz"], toMetric: (v) => v * 30, fmt: (v) => formatVolumeMl(v), rate: "1 US fl oz (food) = 30 ml" },
    { id: "impfloz", cat: "Volume", name: "Imperial fluid ounce", rank: 3, aliases: ["imp fl oz", "imperial fl oz", "uk fl oz"], toMetric: (v) => v * 28.4131, fmt: (v) => formatVolumeMl(v), rate: "1 imp fl oz = 28.41 ml" },
    { id: "tsp", cat: "Volume", name: "Teaspoon (US)", rank: 2, aliases: ["teaspoon", "tsp"], toMetric: (v) => v * 4.92892, fmt: (v) => formatVolumeMl(v), rate: "1 tsp = 4.93 ml" },
    { id: "tbsp", cat: "Volume", name: "Tablespoon (US)", rank: 2, aliases: ["tablespoon", "tbsp"], toMetric: (v) => v * 14.7868, fmt: (v) => formatVolumeMl(v), rate: "1 tbsp = 14.79 ml" },
    { id: "cup", cat: "Volume", name: "US cup (customary)", rank: 1, aliases: ["cup", "cups"], toMetric: (v) => v * 236.588, fmt: (v) => formatVolumeMl(v), rate: "1 cup = 236.6 ml" },
    { id: "cup_legal", cat: "Volume", name: "US legal cup (240 ml)", rank: 4, aliases: ["legal cup", "us legal cup"], toMetric: (v) => v * 240, fmt: (v) => formatVolumeMl(v), rate: "1 legal cup = 240 ml" },
    { id: "cup_metric", cat: "Volume", name: "Metric cup (250 ml)", rank: 4, aliases: ["metric cup"], toMetric: (v) => v * 250, fmt: (v) => formatVolumeMl(v), rate: "1 metric cup = 250 ml" },
    { id: "uspt", cat: "Volume", name: "US pint", rank: 2, aliases: ["pint", "pints", "us pint", "pt"], toMetric: (v) => v * 473.176, fmt: (v) => formatVolumeMl(v), rate: "1 US pint = 473 ml" },
    { id: "usqt", cat: "Volume", name: "US quart", rank: 2, aliases: ["quart", "quarts", "us quart", "qt"], toMetric: (v) => v * 0.946353, fmt: (v) => fmtScale("Volume", v), rate: "1 US qt = 0.946 L" },
    { id: "usgal", cat: "Volume", name: "US gallon", rank: 1, aliases: ["gallon", "gallons", "us gallon", "gal"], toMetric: (v) => v * 3.785412, fmt: (v) => fmtScale("Volume", v), rate: "1 US gal = 3.785 L" },
    { id: "imppt", cat: "Volume", name: "Imperial pint", rank: 3, aliases: ["imperial pint", "uk pint"], toMetric: (v) => v * 568.261, fmt: (v) => formatVolumeMl(v), rate: "1 imp pint = 568 ml" },
    { id: "impqt", cat: "Volume", name: "Imperial quart", rank: 4, aliases: ["imperial quart", "uk quart"], toMetric: (v) => v * 1.136523, fmt: (v) => fmtScale("Volume", v), rate: "1 imp qt = 1.137 L" },
    { id: "impgal", cat: "Volume", name: "Imperial gallon", rank: 2, aliases: ["imperial gallon", "uk gallon"], toMetric: (v) => v * 4.54609, fmt: (v) => fmtScale("Volume", v), rate: "1 imp gal = 4.546 L" },
    { id: "usdrypt", cat: "Volume", name: "US dry pint", rank: 6, aliases: ["dry pint", "us dry pint"], toMetric: (v) => v * 550.610, fmt: (v) => formatVolumeMl(v), rate: "1 US dry pint = 551 ml" },
    { id: "usdryqt", cat: "Volume", name: "US dry quart", rank: 6, aliases: ["dry quart", "us dry quart"], toMetric: (v) => v * 1.101221, fmt: (v) => fmtScale("Volume", v), rate: "1 US dry qt = 1.101 L" },
    { id: "cuin", cat: "Volume", name: "Cubic inch", rank: 2, aliases: ["cubic inch", "cu in", "in³"], toMetric: (v) => v * 16.387064, fmt: (v) => formatVolumeCm3(v), rate: "1 cu in = 16.39 cm³" },
    { id: "cuft", cat: "Volume", name: "Cubic foot", rank: 2, aliases: ["cubic foot", "cubic feet", "cu ft", "ft³"], toMetric: (v) => v * 0.0283168466, fmt: (v) => formatVolumeM3(v), rate: "1 cu ft = 0.0283 m³" },
    { id: "cuyd", cat: "Volume", name: "Cubic yard", rank: 4, aliases: ["cubic yard", "cu yd", "yd³"], toMetric: (v) => v * 0.764554858, fmt: (v) => formatVolumeM3(v), rate: "1 cu yd = 0.765 m³" },
    { id: "bushel", cat: "Volume", name: "US bushel", rank: 6, aliases: ["bushel", "bushels", "us bushel"], toMetric: (v) => v * 35.2391, fmt: (v) => fmtScale("Volume", v), rate: "1 US bushel = 35.24 L" },
    { id: "bushel_imp", cat: "Volume", name: "Imperial bushel", rank: 7, aliases: ["imperial bushel", "uk bushel"], toMetric: (v) => v * 36.36872, fmt: (v) => fmtScale("Volume", v), rate: "1 imp bushel = 36.37 L" },
    { id: "peck", cat: "Volume", name: "US peck", rank: 7, aliases: ["peck", "pecks"], toMetric: (v) => v * 8.80977, fmt: (v) => fmtScale("Volume", v), rate: "1 peck = 8.810 L" },
    { id: "gill", cat: "Volume", name: "US gill", rank: 7, aliases: ["gill", "gills"], toMetric: (v) => v * 118.294, fmt: (v) => formatVolumeMl(v), rate: "1 gill = 118.3 ml" },
    { id: "bbl_oil", cat: "Volume", name: "Oil barrel", rank: 5, aliases: ["barrel", "barrels", "bbl"], toMetric: (v) => v * 158.987, fmt: (v) => fmtScale("Volume", v), rate: "1 barrel = 159.0 L" },
    { id: "scf", cat: "Volume", name: "Standard cubic foot (gas)", rank: 6, aliases: ["scf", "standard cubic foot", "standard cubic feet"], toMetric: (v) => v * 0.0283168466, fmt: (v) => formatVolumeM3(v), rate: "1 SCF \u2248 28.32 L" },

    // Area
    { id: "sqft", cat: "Area", name: "Square foot", rank: 1, aliases: ["square foot", "square feet", "sq ft", "ft²"], toMetric: (v) => v * 0.09290304, fmt: (v) => formatAreaM2(v), rate: "1 sq ft = 0.0929 m²" },
    { id: "sqin", cat: "Area", name: "Square inch", rank: 2, aliases: ["square inch", "sq in", "in²"], toMetric: (v) => v * 0.00064516, fmt: (v) => formatAreaM2(v), rate: "1 sq in = 6.452 cm²" },
    { id: "sqyd", cat: "Area", name: "Square yard", rank: 2, aliases: ["square yard", "sq yd", "yd²"], toMetric: (v) => v * 0.83612736, fmt: (v) => formatAreaM2(v), rate: "1 sq yd = 0.8361 m²" },
    { id: "sqmi", cat: "Area", name: "Square mile", rank: 2, aliases: ["square mile", "sq mi", "mi²"], toMetric: (v) => v * 2.589988, fmt: (v) => fmtScale("Area", v*1e6), rate: "1 sq mi = 2.59 km²" },
    { id: "ac", cat: "Area", name: "Acre", rank: 1, aliases: ["acre", "acres"], toMetric: (v) => v * 0.40468564, fmt: (v) => fmtScale("Area", v*1e4), rate: "1 acre = 0.4047 ha" },
    { id: "rood", cat: "Area", name: "Rood (quarter-acre)", rank: 7, aliases: ["rood", "roods"], toMetric: (v) => v * 1011.7141056, fmt: (v) => fmtScale("Area", v), rate: "1 rood = 1012 m²" },
    { id: "sqperch", cat: "Area", name: "Square perch (square rod/pole)", rank: 7, aliases: ["square perch", "square pole", "square rod", "sq perch", "sq pole", "sq rod"], toMetric: (v) => v * 25.29285264, fmt: (v) => fmtScale("Area", v), rate: "1 sq perch = 25.29 m²" },

    // Temperature (affine; rate is a formula)
    { id: "f", cat: "Temperature", name: "Fahrenheit", rank: 1, aliases: ["fahrenheit", "°f", "f"], toMetric: (v) => ((v - 32) * 5) / 9, fmt: (v) => `${round(v, 1)}\u00A0°C`, rate: "°C = (°F − 32) × 5/9" },
    { id: "rankine", cat: "Temperature", name: "Rankine", rank: 6, aliases: ["rankine", "°r"], toMetric: (v) => ((v - 491.67) * 5) / 9, fmt: (v) => `${round(v, 1)}\u00A0°C`, rate: "°C = (°R − 491.67) × 5/9" },

    // Speed
    { id: "mph", cat: "Speed", name: "Miles per hour", rank: 1, aliases: ["mph", "miles per hour", "mi/h"], toMetric: (v) => v * 1.609344, fmt: (v) => fmtScale("Speed", v/3.6), rate: "1 mph = 1.609 km/h" },
    { id: "knot", cat: "Speed", name: "Knot", rank: 3, aliases: ["knot", "knots", "kn", "kt"], toMetric: (v) => v * 1.852, fmt: (v) => fmtScale("Speed", v/3.6), rate: "1 knot = 1.852 km/h" },
    { id: "fps", cat: "Speed", name: "Feet per second", rank: 4, aliases: ["fps", "feet per second", "ft/s"], toMetric: (v) => v * 1.09728, fmt: (v) => fmtScale("Speed", v/3.6), rate: "1 ft/s = 1.097 km/h" },

    // Energy (base: J)
    { id: "btu", cat: "Energy", name: "BTU", rank: 1, aliases: ["btu", "british thermal unit"], toMetric: (v) => v * 1055.06, fmt: (v) => formatEnergy(v), rate: "1 BTU = 1055 J" },
    { id: "kcal", cat: "Energy", name: "Food Calorie (kcal)", rank: 2, aliases: ["calorie", "calories", "kcal", "cal"], toMetric: (v) => v * 4184, fmt: (v) => formatEnergy(v), rate: "1 kcal = 4184 J" },
    { id: "cal", cat: "Energy", name: "Calorie (cal)", rank: 4, aliases: ["small calorie", "gram calorie", "cal"], toMetric: (v) => v * 4.184, fmt: (v) => formatEnergy(v), rate: "1 cal = 4.184 J" },
    { id: "ftlb", cat: "Energy", name: "Foot-pound", rank: 4, aliases: ["foot-pound", "foot pound", "ft·lb", "ft lb"], toMetric: (v) => v * 1.3558179, fmt: (v) => formatEnergy(v), rate: "1 ft·lb = 1.356 J" },
    { id: "boe", cat: "Energy", name: "Barrel of oil equivalent", rank: 6, aliases: ["boe", "barrel of oil equivalent"], toMetric: (v) => v * 6.1178632e9, fmt: (v) => formatEnergy(v), rate: "1 BOE \u2248 6.12 GJ" },

    // Density
    { id: "ppg", cat: "Density", name: "Pounds per gallon (mud weight)", rank: 5, aliases: ["ppg", "lb/gal", "lbs/gal", "pounds per gallon"], toMetric: (v) => v * 119.8264273, fmt: (v) => fmtScale("Density", v), rate: "1 lb/gal \u2248 119.8 kg/m³" },
    { id: "api", cat: "Density", name: "API gravity (\u2192 density)", rank: 6, aliases: ["api", "api gravity", "°api", "deg api"], toMetric: (v) => (141.5 / (v + 131.5)) * 999.016, fmt: (v) => fmtScale("Density", v), rate: "°API \u2192 141.5/(°API+131.5) × water" },
    { id: "therm", cat: "Energy", name: "Therm", rank: 5, aliases: ["therm", "therms"], toMetric: (v) => v * 105505585, fmt: (v) => formatEnergy(v), rate: "1 therm = 105.5 MJ" },

    // Pressure (base: kPa)
    { id: "psi", cat: "Pressure", name: "Pound per sq inch (psi)", rank: 1, aliases: ["psi", "pound per square inch", "lbf/in²"], toMetric: (v) => v * 6.894757, fmt: (v) => formatPressure(v), rate: "1 psi = 6.895 kPa" },
    { id: "atm", cat: "Pressure", name: "Standard atmosphere (atm)", rank: 2, aliases: ["atm", "atmosphere", "standard atmosphere"], toMetric: (v) => v * 101.325, fmt: (v) => formatPressure(v), rate: "1 atm = 101.3 kPa" },
    { id: "at_tech", cat: "Pressure", name: "Technical atmosphere (at)", rank: 5, aliases: ["technical atmosphere", "at", "kgf/cm²"], toMetric: (v) => v * 98.0665, fmt: (v) => formatPressure(v), rate: "1 at = 98.07 kPa" },
    { id: "inhg", cat: "Pressure", name: "Inch of mercury", rank: 3, aliases: ["inhg", "inch of mercury", "in hg"], toMetric: (v) => v * 3.386389, fmt: (v) => formatPressure(v), rate: "1 inHg = 3.386 kPa" },
    { id: "inh2o", cat: "Pressure", name: "Inch of water", rank: 5, aliases: ["inh2o", "inch of water", "in wc"], toMetric: (v) => v * 0.249089, fmt: (v) => formatPressure(v), rate: "1 inH2O = 0.249 kPa" },

    // Power (base: W)
    { id: "hp_mech", cat: "Power", name: "Horsepower (mechanical)", rank: 1, aliases: ["horsepower", "hp", "mechanical horsepower", "bhp"], toMetric: (v) => v * 745.699872, fmt: (v) => formatPower(v), rate: "1 hp = 745.7 W" },
    { id: "hp_metric", cat: "Power", name: "Metric horsepower (PS)", rank: 2, aliases: ["metric horsepower", "ps", "cv", "pferdestarke"], toMetric: (v) => v * 735.49875, fmt: (v) => formatPower(v), rate: "1 PS = 735.5 W" },
    { id: "hp_elec", cat: "Power", name: "Electrical horsepower", rank: 4, aliases: ["electrical horsepower", "electric horsepower"], toMetric: (v) => v * 746, fmt: (v) => formatPower(v), rate: "1 elec hp = 746 W" },
  ];

  const REG_BY_ID = {};
  for (const e of REGISTRY) REG_BY_ID[e.id] = e;
  const REG_CATEGORIES = ["Length", "Mass", "Volume", "Area", "Temperature", "Speed", "Energy", "Power", "Pressure", "Density"];
  // The handful surfaced directly in the desktop right-click menu (fast path).
  const COMMON_IDS = ["in", "ft", "mi", "lb", "oz", "usfloz", "usgal", "f"];

  // Units that share a NAME but differ in value (e.g. the three fluid ounces,
  // the three quarts). Grouped only by name collision, never by mere relation:
  // cubic inch/foot/yard are different names, so they are NOT grouped. When one
  // is detected, the hover panel offers the rest as one-tap reinterpretations.
  const ALT_CLUSTERS = [
    ["usfloz", "usfloz_food", "impfloz"],     // fluid ounce
    ["usqt", "usdryqt", "impqt"],             // quart (US liquid / US dry / imperial)
    ["uspt", "usdrypt", "imppt"],             // pint
    ["usgal", "impgal"],                      // gallon
    ["cup", "cup_legal", "cup_metric"],       // cup
    ["bushel", "bushel_imp"],                 // bushel
    ["mi", "nmi"],                            // mile (statute / nautical)
    ["mil", "mil_se"],                        // mil (thou / Swedish mil)
    ["oz", "ozt"],                            // ounce (avoirdupois / troy)
    ["lb", "lb_troy"],                        // pound (avoirdupois / troy)
    ["ton_us", "ton_long", "tonne"],          // ton (short / long / metric)
    ["cwt_us", "cwt_uk"],                     // hundredweight
    ["dram", "dram_apoth"],                   // dram
    ["cal", "kcal"],                          // calorie (small / large)
    ["hp_mech", "hp_metric", "hp_elec"],      // horsepower
    ["atm", "at_tech"],                       // atmosphere (standard / technical)
  ];
  const ALT_BY_ID = {};
  for (const cl of ALT_CLUSTERS) for (const id of cl) ALT_BY_ID[id] = cl;

  function searchRegistry(query, category) {
    const q = (query || "").trim().toLowerCase();
    let items = REGISTRY.filter((e) => !category || category === "All" || e.cat === category);
    if (q) {
      items = items.filter((e) =>
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        (e.aliases || []).some((a) => a.toLowerCase().includes(q))
      );
    }
    return items.slice().sort((a, b) => (a.rank - b.rank) || a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
  }

  // Context help shown on the per-row ⓘ. Curated for the ambiguous/contextual
  // units; everything else falls back to its name + rate.
  const INFO_BY_ID = {
    usfloz: "US customary fluid ounce (29.57 ml). The default for US recipes, drinks and product volumes.",
    usfloz_food: "US fluid ounce as used on Nutrition Facts labels, rounded to exactly 30 ml by FDA rule. Use only for nutrition labelling.",
    impfloz: "UK / imperial fluid ounce (28.41 ml). Use for British or Commonwealth recipes and older UK sources.",
    usgal: "US gallon (3.785 L). The default in the US, e.g. fuel and milk.",
    impgal: "Imperial gallon (4.546 L), about 20% larger than the US gallon. Use for UK / Canadian and older sources.",
    uspt: "US pint (473 ml). US liquid measure; the imperial pint is larger.",
    imppt: "Imperial pint (568 ml). UK pint, e.g. a pint of beer in Britain.",
    usqt: "US quart (0.946 L). Two US pints.",
    impqt: "Imperial quart (1.137 L). UK quart, larger than the US quart.",
    usqt: "US liquid quart (0.946 L). The everyday US quart.",
    usdryqt: "US dry quart (1.101 L). For dry goods like berries; larger than the liquid quart.",
    impqt: "Imperial quart (1.137 L). UK quart, larger still.",
    uspt: "US liquid pint (473 ml). US liquid measure.",
    usdrypt: "US dry pint (551 ml). For dry produce; larger than the US liquid pint.",
    cup: "US customary cup (236.6 ml). US recipes (derived from the half-pint).",
    cup_legal: "US 'legal' cup (240 ml). Used on US nutrition labels.",
    cup_metric: "Metric cup (250 ml). Australian/NZ and metric recipes.",
    bushel_imp: "Imperial bushel (36.37 L), a bit larger than the US bushel.",
    lb: "Pound, avoirdupois (453.6 g). The everyday US/UK pound.",
    lb_troy: "Troy pound (373.2 g). Precious metals. Lighter than the avoirdupois pound (only 12 troy oz).",
    tonne: "Metric ton / tonne (1000 kg). The metric 'ton'.",
    dram: "Avoirdupois dram (1.772 g). Everyday small weight.",
    dram_apoth: "Apothecary dram (3.888 g). Old pharmacy weight, over twice the avoirdupois dram.",
    cwt_us: "US (short) hundredweight (100 lb = 45.36 kg).",
    cwt_uk: "UK (long) hundredweight (112 lb = 50.80 kg).",
    mil_se: "Swedish 'mil' (10 km). A Nordic distance unit; unrelated to the thou.",
    hp_mech: "Mechanical horsepower (745.7 W). The common US/UK horsepower.",
    hp_metric: "Metric horsepower / PS / CV (735.5 W). Common in European car specs.",
    hp_elec: "Electrical horsepower (746 W). Used for electric motors.",
    atm: "Standard atmosphere (101.3 kPa). The fixed reference atmosphere.",
    at_tech: "Technical atmosphere (98.07 kPa = 1 kgf/cm²). ~3% smaller than standard atm.",
    cal: "Gram calorie (4.184 J). Physics/chemistry; one-thousandth of a food Calorie.",
    kcal: "Food Calorie / kilocalorie (4184 J). The 'Calorie' on nutrition labels.",
    tbsp: "US tablespoon (14.79 ml). Cooking measure.",
    tsp: "US teaspoon (4.93 ml). Cooking measure.",
    oz: "Ounce of weight (28.35 g). Mass, not the same as a fluid ounce (volume).",
    ozt: "Troy ounce (31.10 g). Used for precious metals such as gold and silver, not everyday weight.",
    lb: "Pound, mass (0.4536 kg). The everyday US/UK pound.",
    st: "Stone (6.35 kg = 14 lb). UK body-weight measure.",
    ton_us: "US short ton (907 kg = 2000 lb). The default 'ton' in the US.",
    ton_long: "UK long ton (1016 kg = 2240 lb). Older British sources.",
    grain: "Grain (64.8 mg). Bullets, gunpowder and pharmaceutical doses.",
    dram: "Dram (1.772 g). Small avoirdupois weight.",
    cuin: "Cubic inch (16.39 cm³). Engine displacement and small volumes.",
    cuft: "Cubic foot (0.0283 m³). Shipping, appliances, gas volumes.",
    f: "Degrees Fahrenheit. US temperatures; °C = (°F − 32) × 5/9.",
    rankine: "Rankine: absolute scale using Fahrenheit-sized degrees. Thermodynamics; rarely seen day to day.",
    mph: "Miles per hour (1.609 km/h). US / UK road speeds.",
    knot: "Nautical miles per hour (1.852 km/h). Marine and aviation speeds.",
    fps: "Feet per second (1.097 km/h). Ballistics and physics.",
    btu: "British Thermal Unit (1055 J). HVAC, heating and appliance energy ratings.",
    kcal: "Food Calorie / kilocalorie (4184 J). The 'Calorie' on nutrition labels.",
    cal: "Gram calorie (4.184 J). Physics and chemistry; one-thousandth of a food Calorie.",
    ftlb: "Foot-pound of energy (1.356 J). Torque/work in US engineering (distinct from lbf·ft torque).",
    therm: "Therm (105.5 MJ). Natural-gas billing.",
    psi: "Pounds per square inch (6.895 kPa). Tyre and fluid pressure in the US.",
    inhg: "Inch of mercury (3.386 kPa). Barometric pressure and vacuum.",
    inh2o: "Inch of water column (0.249 kPa). Low pressures, e.g. duct/gas.",
    nmi: "Nautical mile (1.852 km). Marine and aviation distance.",
    mil: "Mil, or thou: one thousandth of an inch (0.0254 mm). Engineering thickness.",
    ac: "Acre (0.4047 ha). Land area.",
    sqft: "Square foot (0.0929 m²). Floor area in the US/UK.",
    bbl_oil: "Oil barrel (159 L). Petroleum industry; other barrels differ.",
  };
  function infoFor(e) { return INFO_BY_ID[e.id] || `${e.name || e.label}. ${e.rate}.`; }

  // Most-likely units for the selected text, e.g. "30 fl oz" -> the three fl oz.
  // Matches on whole tokens (so "fl oz" won't match Fahrenheit's "f", and "lb"
  // won't match "lbf/in²"). Score: exact phrase 3, contiguous token-run 2.
  function tokenize(s) { return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
  function teq(a, b) { return a === b || a + "s" === b || b + "s" === a; }
  function tokenRun(hay, needle) {
    if (!needle.length || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) if (!teq(hay[i + j], needle[j])) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  function suggestionsFor(hint) {
    const h = (hint || "").trim().toLowerCase();
    const ht = tokenize(h);
    if (!ht.length || h.length < 2) return [];
    const scored = [];
    for (const e of REGISTRY) {
      let best = 0;
      const cands = [e.name, ...(e.aliases || [])];
      for (const a of cands) {
        const at = tokenize(a);
        if (!at.length) continue;
        if (at.length === ht.length && at.every((t, k) => teq(t, ht[k]))) best = Math.max(best, 3);
        else if (tokenRun(at, ht) || tokenRun(ht, at)) best = Math.max(best, 2);
      }
      if (best > 0) scored.push({ e, s: best });
    }
    scored.sort((a, b) => (b.s - a.s) || (a.e.rank - b.e.rank) || a.e.name.localeCompare(b.e.name));
    // Keep similar units together: when a match belongs to a cluster (the same
    // groups the underline menu shows), pull in its siblings, adjacent and in
    // cluster order. Mirrors the hover panel so the picker is consistent.
    const out = [];
    const seen = new Set();
    for (const x of scored) {
      const cl = ALT_BY_ID[x.e.id];
      const ids = cl || [x.e.id];
      for (const id of ids) {
        if (seen.has(id)) continue;
        const e = REG_BY_ID[id];
        if (!e) continue;
        seen.add(id);
        out.push(e);
      }
      if (out.length >= 8) break;
    }
    return out.slice(0, 8);
  }

  // When the selection gives no textual hint to go on (a bare number, e.g. the
  // user selected just "72"), default the picker's Suggestions to the most
  // common imperial units plus "Treat as price", so there is always a sensible
  // one-tap starting set instead of an empty section.
  const DEFAULT_SUGGESTION_IDS = ["in", "ft", "mi", "f"];

  // A number written with a prime/apostrophe is a length: a single mark
  // (5', 5′, 5’) means feet, a double mark (5", 5″, 5'') means inches. Used to
  // pin the right unit in the picker's suggestions. Returns "ft", "in", or null.
  // Single marks:  ' (U+0027)  ’ (U+2019)  ′ (U+2032)  ʹ (U+02B9)  ´ (U+00B4)  ʻ (U+02BB)  ` (U+0060)
  // Double marks:  " (U+0022)  ” (U+201D)  “ (U+201C)  ″ (U+2033)
  function primeLengthId(text) {
    if (!text) return null;
    // First number, optional spaces, then one or two prime/quote marks.
    const m = String(text).match(
      /\d[\d.,]*\s*(['’′ʹ´ʻ`"”“″]{1,2})/
    );
    if (!m) return null;
    const marks = m[1];
    if (marks.length >= 2) return "in"; // two marks (e.g. 5'') → inches
    // A single double-quote-style mark is inches; a single prime is feet.
    return /["”“″]/.test(marks) ? "in" : "ft";
  }

  // --- Metric scale engine -------------------------------------------------
  // Each category has a canonical base unit and a ladder of metric scales
  // (size of each unit in base units). The renderer picks the enabled scale
  // that reads most simply: no leading "0.x", fewest decimals, then fewest
  // integer digits, capped at maxOrderOfMagnitude integer digits. So 0.62 m
  // shows as "62 cm", 551 ml stays "551 ml" (not "0.55 L").
  // Prefix-based scale model: a category has a base unit and a dimensional
  // power. ANY SI prefix can be applied generically — displayed symbol is
  // prefix+base, factor is 10^(exp*dim) — so the prefix table needs no
  // greyed-out rows. Compound units (speed, density) stay as fixed lists.
  const PREFIXES = [
    [30, "Q"], [27, "R"], [24, "Y"], [21, "Z"], [18, "E"], [15, "P"], [12, "T"],
    [9, "G"], [6, "M"], [3, "k"], [2, "h"], [1, "da"], [0, ""], [-1, "d"],
    [-2, "c"], [-3, "m"], [-6, "\u00B5"], [-9, "n"], [-12, "p"], [-15, "f"],
    [-18, "a"], [-21, "z"], [-24, "y"], [-27, "r"], [-30, "q"],
  ];
  const PREFIX_BY_SYM = {};
  PREFIXES.forEach((p) => { PREFIX_BY_SYM[p[1]] = p[0]; });
  // Each measurement has one or more interchangeable base-unit representations.
  // f = canonical units per 1 of this base (no prefix); dim = how a prefix
  // exponent scales it (length 1, area 2, volume-as-m³ 3). Canonical unit per
  // category is the first option (metre, gram, litre, m², joule, watt, pascal).
  const CAT_UNIT_OPTIONS = {
    Length:   [{ sym: "m", f: 1, dim: 1 }],
    Mass:     [{ sym: "g", f: 1, dim: 1 }],
    Volume:   [{ sym: "L", f: 1, dim: 1 }, { sym: "m\u00B3", f: 1000, dim: 3 }],
    Area:     [{ sym: "m\u00B2", f: 1, dim: 2 }],
    Energy:   [{ sym: "J", f: 1, dim: 1 }, { sym: "Wh", f: 3600, dim: 1 }, { sym: "cal", f: 4.184, dim: 1 }, { sym: "kg\u00B7m\u00B2/s\u00B2", f: 1, dim: 1 }],
    Power:    [{ sym: "W", f: 1, dim: 1 }, { sym: "J/s", f: 1, dim: 1 }],
    Pressure: [{ sym: "Pa", f: 1, dim: 1 }, { sym: "bar", f: 1e5, dim: 1 }, { sym: "N/m\u00B2", f: 1, dim: 1 }],
    Speed:    [{ sym: "m/s", f: 1, dim: 1 }, { sym: "km/h", f: 1 / 3.6, dim: 0 }],
    Density:  [{ sym: "g/m\u00B3", f: 0.001, dim: 1 }, { sym: "g/cm\u00B3", f: 1000, dim: 1 }],
  };
  const CATBASE = {}; // default (canonical) base symbol + dim per category
  for (const cat in CAT_UNIT_OPTIONS) CATBASE[cat] = { sym: CAT_UNIT_OPTIONS[cat][0].sym, dim: CAT_UNIT_OPTIONS[cat][0].dim };
  const SPECIAL = {}; // (no fixed non-prefix measurements remain)
  const DEFAULT_EXPS = [-3, -2, 0, 3, 6, 9]; // milli, centi, base, kilo, mega, giga

  function clampInt(x, lo, hi, dflt) {
    x = parseInt(x, 10);
    if (!isFinite(x)) return dflt;
    return Math.max(lo, Math.min(hi, x));
  }
  // Resolve a unit symbol to {cat, factor} (base units per 1 unit), or null.
  function symInfo(sym) {
    for (const cat in SPECIAL) {
      const u = SPECIAL[cat].find((x) => x[0] === sym);
      if (u) return { cat, factor: u[1] };
    }
    for (const cat in CAT_UNIT_OPTIONS) {
      for (const opt of CAT_UNIT_OPTIONS[cat]) {
        if (sym === opt.sym) return { cat, factor: opt.f };
        if (sym.length > opt.sym.length && sym.slice(-opt.sym.length) === opt.sym) {
          const e = PREFIX_BY_SYM[sym.slice(0, sym.length - opt.sym.length)];
          if (e !== undefined) return { cat, factor: opt.f * Math.pow(10, e * opt.dim) };
        }
      }
    }
    return null;
  }
  function symFactor(sym) { const i = symInfo(sym); return i ? i.factor : null; }
  function scalesFromExps(cat, exps) {
    const baseSym = (settings.catBase && settings.catBase[cat]) || CATBASE[cat].sym;
    return exps.map((e) => {
      const psym = (PREFIXES.find((p) => p[0] === e) || [0, ""])[1];
      const sym = psym + baseSym;
      const f = symFactor(sym);
      return f != null ? [sym, f] : null;
    }).filter(Boolean);
  }
  function scalesFromSyms(cat, syms) {
    return syms.map((s) => { const f = symFactor(s); return f != null ? [s, f] : null; }).filter(Boolean);
  }
  function enabledScales(cat) {
    if (SPECIAL[cat]) {
      const ov = settings.displayScales && settings.displayScales[cat];
      if (ov && ov.length) { const f = SPECIAL[cat].filter((u) => ov.indexOf(u[0]) >= 0); if (f.length) return f; }
      return SPECIAL[cat];
    }
    const per = settings.displayTiersByCat && settings.displayTiersByCat[cat];
    const exps = (per && per.length) ? per
      : ((settings.displayTiers && settings.displayTiers.length) ? settings.displayTiers : DEFAULT_EXPS);
    return scalesFromExps(cat, exps);
  }
  function enabledHoverScales(cat) {
    if (SPECIAL[cat]) {
      const ov = settings.hoverScales && settings.hoverScales[cat];
      if (ov && ov.length) return SPECIAL[cat].filter((u) => ov.indexOf(u[0]) >= 0);
      return [];
    }
    const per = settings.hoverTiersByCat && settings.hoverTiersByCat[cat];
    const exps = (per && per.length) ? per : settings.hoverTiers;
    if (exps && exps.length) return scalesFromExps(cat, exps);
    return [];
  }
  // Render a base value in one specific scale. Returns null if it rounds to 0
  // at the current precision (so the hover panel can skip it).
  function renderInScale(cat, base, sym) {
    const f = symFactor(sym);
    if (f == null) return null;
    const maxDec = clampInt(settings.decimalPlaces, 0, 6, 2);
    const v = base / f;
    if (Number(Math.abs(v).toFixed(maxDec)) === 0) return null;
    const sep = settings.thousandsSeparator != null ? settings.thousandsSeparator : ",";
    return fmtNum(v, maxDec, sep) + "\u00A0" + sym;
  }
  // Derive (category, base-units-per-1-input-unit) for any unit entry purely
  // from its own fmt output. Returns null for non-scale units (°C, money).
  function unitBaseInfo(entry) {
    if (!entry || typeof entry.toMetric !== "function" || typeof entry.fmt !== "function") return null;
    const saved = settings.decimalPlaces;
    settings.decimalPlaces = 6; // parse at high precision
    let s;
    try { s = entry.fmt(entry.toMetric(1)); } finally { settings.decimalPlaces = saved; }
    const m = /^(-?[\d.,]+)\u00A0?(.+)$/.exec(s || "");
    if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, ""));
    const info = symInfo(m[2].trim());
    return info ? { cat: info.cat, base1: num * info.factor } : null;
  }
  function groupInt(s, sep) { return sep ? s.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : s; }
  function fmtNum(v, maxDec, sep) {
    const neg = v < 0;
    let s = Math.abs(v).toFixed(maxDec);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    const parts = s.split(".");
    parts[0] = groupInt(parts[0], sep);
    return (neg ? "-" : "") + (parts[1] ? parts[0] + "." + parts[1] : parts[0]);
  }
  function betterScore(a, b) {
    if (!b) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }
  function fmtScale(cat, base) {
    if (!CATBASE[cat] && !SPECIAL[cat]) return String(base);
    const maxDec = clampInt(settings.decimalPlaces, 0, 6, 2);
    const maxOOM = clampInt(settings.maxOrderOfMagnitude, 1, 12, 6);
    const sep = settings.thousandsSeparator != null ? settings.thousandsSeparator : ",";
    const units = enabledScales(cat);
    let bestSym = null, bestScore = null, bestV = 0;
    let fbSym = null, fbScore = null, fbV = 0;
    for (const [sym, f] of units) {
      const v = base / f;
      const rounded = Number(Math.abs(v).toFixed(maxDec));
      const intDigits = rounded >= 1 ? String(Math.floor(rounded)).length : 0;
      const leadingZero = rounded < 1 ? 1 : 0;
      let ds = rounded.toFixed(maxDec).split(".")[1] || "";
      ds = ds.replace(/0+$/, "");
      const score = [intDigits > maxOOM ? 1 : 0, leadingZero, intDigits, ds.length, -f];
      if (betterScore(score, fbScore)) { fbScore = score; fbSym = sym; fbV = v; }
      if (rounded === 0) continue;
      if (betterScore(score, bestScore)) { bestScore = score; bestSym = sym; bestV = v; }
    }
    const sym = bestSym || fbSym || units[units.length - 1][0];
    const v = bestSym ? bestV : fbV;
    return fmtNum(v, maxDec, sep) + "\u00A0" + sym;
  }
  // --- end scale engine ----------------------------------------------------

  function round(v, d) {
    const f = Math.pow(10, d);
    return (Math.round(v * f) / f).toLocaleString("en-US");
  }
  function smartRound(v) {
    const a = Math.abs(v);
    if (a >= 100) return round(v, 0);
    if (a >= 10) return round(v, 1);
    return round(v, 2);
  }
  function formatLengthM(m) { return fmtScale("Length", m); }
  function formatMassKg(kg) { return fmtScale("Mass", kg * 1000); }
  function formatVolumeMl(ml) { return fmtScale("Volume", ml / 1000); }
  function formatVolumeCm3(cm3) { return fmtScale("Volume", cm3 / 1000); }
  function formatVolumeM3(m3) { return fmtScale("Volume", m3 * 1000); }
  function formatMassT(kg) { return fmtScale("Mass", kg * 1000); }
  function formatAreaM2(m2) { return fmtScale("Area", m2); }
  function formatEnergy(j) { return fmtScale("Energy", j); }
  function formatPressure(kpa) { return fmtScale("Pressure", kpa * 1000); }
  function formatPower(w) { return fmtScale("Power", w); }

  function parseValue(intPart, decPart, fracNum, fracDen) {
    let v = parseFloat(intPart.replace(/,/g, ""));
    const sign = v < 0 ? -1 : 1;
    if (decPart) v += sign * parseFloat("0." + decPart.replace(/\s/g, ""));
    if (fracNum && fracDen && parseFloat(fracDen) !== 0) v += sign * (parseFloat(fracNum) / parseFloat(fracDen));
    return v;
  }

  // ---------------------------------------------------------------
  // Price engine
  // ---------------------------------------------------------------
  const PRICE_RE = new RegExp(
    "(US\\$|CA\\$|A\\$|NZ\\$|HK\\$|[$€£¥])\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?(?!\\d)",
    "g"
  );

  // Parse a price out of plain text (currency symbol + amount). Returns
  // {priceStr, value, symbol} or null. Used for the picker preview/indicator.
  function parsePriceText(text) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    PRICE_RE.lastIndex = 0;
    let m = PRICE_RE.exec(t);
    if (!m) { PRICE_RE.lastIndex = 0; m = PRICE_RE.exec(t.replace(/\s+/g, "")); }
    if (m) {
      const value = parseFloat(m[2].replace(/,/g, "")) + (m[3] ? parseFloat("0." + m[3]) : 0);
      if (isFinite(value)) return { priceStr: m[0], value, symbol: m[1] };
    }
    // No currency symbol: allow declaring any bare number as a price.
    const bm = t.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!bm) return null;
    const v = parseFloat(bm[0].replace(/,/g, ""));
    if (!isFinite(v)) return null;
    return { priceStr: bm[0], value: v, symbol: "" };
  }

  // Round a price UP to the next whole unit, but only when it is within the
  // configured cents threshold of that whole unit (or the user forced it).
  // Returns the rounded integer value, or null if it should be left alone.
  // Examples (threshold 5): 1.99 -> 2, 1.95 -> 2, 1.50 -> null, 2.01 -> null.
  // At threshold 99: 2.01 -> 3. Whole-unit prices (no cents) -> null.
  function roundedPriceValue(value, forced) {
    const whole = Math.floor(value);
    const fracCents = Math.round((value - whole) * 100); // 0..99
    if (fracCents === 0) return null; // already whole, nothing to round
    const gapCents = 100 - fracCents; // cents needed to reach the next whole
    if (!forced && gapCents > settings.priceRoundCents) return null;
    return whole + 1;
  }

  // ---------------------------------------------------------------
  // Candidate detection
  // ---------------------------------------------------------------
  // A candidate: {start, end, full, kind:"unit"|"price", display, forced}
  function regexCandidates(text) {
    const out = [];
    let m;

    // Price rounding is the only consumer of price candidates. Skip the whole
    // pass when rounding is off, unless this host has forced-price corrections
    // that still need to re-apply on reload.
    if (settings.priceRounding || bucket(false).forcePrice.length) {
      PRICE_RE.lastIndex = 0;
      while ((m = PRICE_RE.exec(text)) !== null) {
        const [full, symbol, intPart, cents] = m;
        const value = parseFloat(intPart.replace(/,/g, "")) + (cents ? parseFloat("0." + cents) : 0);
        if (!isFinite(value)) continue;
        out.push({ start: m.index, end: m.index + full.length, full, kind: "price", value, symbol });
      }
    }

    UNIT_RE.lastIndex = 0;
    while ((m = UNIT_RE.exec(text)) !== null) {
      const [full, intPart, decPart, fracNum, fracDen, unitText] = m;
      const unit = findUnit(unitText);
      if (!unit) continue;
      const value = parseValue(intPart, decPart, fracNum, fracDen);
      if (!isFinite(value)) continue;
      if (value < 0 && !unit.allowNegative) continue;
      out.push({ start: m.index, end: m.index + full.length, full, kind: "unit", value, unit, unitText: (unitText || "").trim() });
    }

    // Compound feet+inches: 5'10" → expressed as total feet so the feet
    // unit's toMetric/fmt pipeline handles the rest. Starts earlier and spans
    // wider than the partial 10" that UNIT_RE would also find, so overlap
    // resolution keeps this one and drops the shorter match.
    const feetUnit = UNITS.find((u) => u.name === "feet");
    HEIGHT_RE.lastIndex = 0;
    while ((m = HEIGHT_RE.exec(text)) !== null) {
      const full = m[0];
      const ft = parseFloat(m[1]);
      const ins = parseFloat(m[2]);
      if (!isFinite(ft) || !isFinite(ins)) continue;
      out.push({
        start: m.index, end: m.index + full.length, full, kind: "unit",
        value: ft + ins / 12, unit: feetUnit, unitText: "′",
      });
    }

    // Dimension lists: "4 x 3 x 1 in" share one trailing unit across all
    // numbers, so convert each (overlap resolution prefers this over the lone
    // "1 in" match because it starts earlier and is longer).
    for (const DIM_RE of [DIM_RE_X, DIM_RE_BY]) {
      DIM_RE.lastIndex = 0;
      while ((m = DIM_RE.exec(text)) !== null) {
        const full = m[0];
        const unitText = m[3];
        const unit = findDimUnit(unitText);
        if (!unit) continue;
        const nums = (m[1] + m[2]).match(/-?\d+(?:\.\d+)?/g);
        if (!nums || nums.length < 2) continue;
        const values = nums.map((n) => parseFloat(n));
        if (values.some((v) => !isFinite(v))) continue;
        out.push({
          start: m.index, end: m.index + full.length, full, kind: "unit",
          value: values[0], dim: true, dimValues: values, unit, unitText: (unitText || "").trim(),
        });
      }
    }
    return out;
  }

  // Playful word substitutions: not unit conversions and not part of the
  // numeric pipeline, just a small bit of fun marked with the same underline so
  // the hover panel and Options can turn them off. Each term toggles
  // independently via settings.wordSubs[id].
  const WORD_SUBS = [
    { id: "soccer", re: /\bsoccer\b/gi, to: "football" },
    { id: "aluminum", re: /\baluminum\b/gi, to: "aluminium" },
  ];
  // Non-global, for cheap presence checks in ownsRun / processRun.
  const WORD_TEST_RE = /\b(?:soccer|aluminum)\b/i;

  // A term is on unless its flag is explicitly false (so terms added later
  // default on for existing users).
  function wordSubOn(id) {
    const w = settings.wordSubs;
    return !w || w[id] !== false;
  }
  function anyWordSubOn() {
    return WORD_SUBS.some((w) => wordSubOn(w.id));
  }

  // Copy the source word's casing onto the replacement (soccer->football,
  // Soccer->Football, SOCCER->FOOTBALL).
  function matchCase(src, repl) {
    if (src && src === src.toUpperCase() && src !== src.toLowerCase()) return repl.toUpperCase();
    if (src && src[0] === src[0].toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
    return repl;
  }

  function wordCandidates(text) {
    const out = [];
    for (const w of WORD_SUBS) {
      if (!wordSubOn(w.id)) continue;
      w.re.lastIndex = 0;
      let m;
      while ((m = w.re.exec(text)) !== null) {
        const full = m[0];
        if (!full) { w.re.lastIndex++; continue; }
        out.push({
          start: m.index, end: m.index + full.length,
          full, kind: "word", display: matchCase(full, w.to), wordId: w.id,
        });
      }
    }
    return out;
  }

  // Encoder hook. Returns an array of {start,end} the model believes are
  // convertible, or null when no model is active. Today it returns null and
  // we fall back to regex. Once a model is loaded, intersect its spans with
  // regex candidates so math stays deterministic.
  let encoder = null;
  function proposeSpans(text) {
    const candidates = regexCandidates(text);
    if (!encoder) return candidates; // regex-only mode
    try {
      const accepted = encoder.classify(text); // array of {start,end}
      return candidates.filter((c) =>
        accepted.some((a) => a.start < c.end && a.end > c.start)
      );
    } catch (e) {
      return candidates; // model failure -> safe fallback
    }
  }

  // Variants applicable to a candidate given the exact unit text written.
  // e.g. "14 lb" -> [weight] only; "14 pounds" -> [weight, money].
  function applicableVariants(c) {
    const ut = c.unitText || "";
    return c.unit.variants.filter((v) => !v.surfaces || v.surfaces.test(ut));
  }

  // Pick the variant for a candidate: a per-occurrence "convert as" correction
  // (c.forceUnitId, set during scanning) wins outright, even across dimensions;
  // otherwise the first applicable variant.
  function variantFor(c) {
    const vs = applicableVariants(c);
    if (c.forceUnitId) {
      const fv = REG_BY_ID[c.forceUnitId] || VARIANT_BY_ID[c.forceUnitId];
      if (fv && typeof fv.toMetric === "function") return fv;
    }
    return vs[0] || c.unit.variants[0];
  }

  // Build a rate string ("1 cu in = 0.01639 L") in the SAME metric unit the
  // result is shown in, since formatters switch units by magnitude (cm³ vs L,
  // g vs kg, cm vs m). Non-linear conversions (temperature) keep their formula.
  function rateFor(value, v) {
    if (!v || typeof v.toMetric !== "function") return (v && v.rate) || "";
    if (Math.abs(v.toMetric(0)) > 1e-9) return v.rate; // affine (e.g. °F)
    const base = v.toMetric(value);
    const disp = v.fmt(base);
    const idx = disp.indexOf("\u00A0");
    if (idx < 0 || base === 0) return v.rate;
    const unitLabel = disp.slice(idx + 1);
    const dispNum = parseFloat(disp.slice(0, idx).replace(/,/g, ""));
    if (!isFinite(dispNum)) return v.rate;
    let factor = dispNum / base; // displayed unit per base unit
    if (!(factor > 0)) return v.rate;
    factor = Math.pow(10, Math.round(Math.log10(factor))); // snap to power of ten
    const per1 = parseFloat((v.toMetric(1) * factor).toPrecision(4));
    let left = "unit";
    const mm = (v.rate || "").match(/^1\s+([^=]+?)\s*=/);
    if (mm) left = mm[1].trim();
    return `1 ${left} = ${per1}\u00A0${unitLabel}`;
  }

  function renderDisplay(c) {
    if (c.kind === "price") {
      const rounded = roundedPriceValue(c.value, c.forced);
      if (rounded === null) return null;
      return c.symbol.replace(/\s+$/, "") + rounded.toLocaleString("en-US");
    }
    const v = variantFor(c);
    if (v.money || typeof v.toMetric !== "function") return null; // e.g. £ money
    if (c.dim && c.dimValues) {
      const parts = c.dimValues.map((n) => v.fmt(v.toMetric(n)));
      const labels = parts.map((p) => p.split("\u00A0")[1] || "");
      if (labels.every((l) => l === labels[0])) {
        const nums = parts.map((p) => p.split("\u00A0")[0]);
        return nums.join(" × ") + "\u00A0" + labels[0];
      }
      return parts.join(" × ");
    }
    return v.fmt(v.toMetric(c.value));
  }

  // Re-detect persisted "convert as" surfaces the regex engine does not find on
  // its own, so those corrections survive a reload. Only the anchored occurrence
  // is matched; surfaces already covered by a regex candidate are left alone
  // (filterCandidates applies the forced unit to those via forceUnitMatch).
  function appendForcedUnitCandidates(text, candidates) {
    const recs = bucket(false).forceUnit;
    if (!recs.length) return;
    for (const rec of recs) {
      const pat = rec.surface.split(/\s+/).map(escapeRe).join("\\s+");
      let re;
      try { re = new RegExp("(?<![\\w$£€¥₹¢])" + pat + "(?![\\w])", "gi"); } catch (e) { continue; }
      let m;
      while ((m = re.exec(text)) !== null) {
        const full = m[0];
        if (!full) { re.lastIndex++; continue; }
        const start = m.index, end = m.index + full.length;
        if (!occMatches(rec, rec.surface, text, start, end)) continue; // different occurrence
        if (candidates.some((c) => c.start < end && c.end > start)) continue; // already detected
        const unit = UNITS.find((u) => u.variants.some((v) => v.id === rec.unitId));
        if (!unit) continue;
        const nm = full.match(/-?\d[\d,]*(?:\.\d+)?/);
        if (!nm) continue;
        const value = parseFloat(nm[0].replace(/,/g, ""));
        if (!isFinite(value)) continue;
        candidates.push({ start, end, full, kind: "unit", value, unit, unitText: full, forceUnitId: rec.unitId });
      }
    }
  }

  // Apply settings + user corrections to the raw candidate list.
  function filterCandidates(text, candidates) {
    let list = candidates.filter((c) => {
      const surface = norm(c.full);
      if (blockMatch(surface, text, c.start, c.end)) return false; // user marked this occurrence not-a-conversion
      if (c.kind === "price") {
        c.forced = c.forced || forcePriceMatch(surface, text, c.start, c.end);
        if (!settings.priceRounding && !c.forced) return false;
      } else if (!c.forceUnitId) {
        c.forceUnitId = forceUnitMatch(surface, text, c.start, c.end) || null;
      }
      return true;
    });

    // Compute display, drop no-op conversions (price already whole, gap too
    // large for the threshold, etc.)
    list = list.filter((c) => {
      c.display = renderDisplay(c);
      return c.display && c.display !== c.full.trim();
    });

    // Resolve overlaps: earliest start wins, then longest.
    list.sort((a, b) => a.start - b.start || b.end - a.end);
    const chosen = [];
    let cursor = -1;
    for (const c of list) {
      if (c.start >= cursor) {
        chosen.push(c);
        cursor = c.end;
      }
    }
    return chosen;
  }

  // ---------------------------------------------------------------
  // DOM scanning
  // ---------------------------------------------------------------
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "CANVAS",
  ]);

  // Class names commonly used for visually-hidden, screen-reader-only text.
  // Retailers (Amazon etc.) hide a full "$12.77" here while the visible price
  // is split across elements; we must NOT convert the hidden copy.
  const OFFSCREEN_RE = /(?:^|[\s_-])(?:a-offscreen|offscreen|sr-only|visually-hidden|visuallyhidden|screen-reader|screenreader)(?:$|[\s_-])/i;

  function classString(el) {
    const c = el.className;
    if (!c) return "";
    return typeof c === "string" ? c : c.baseVal || "";
  }

  function isSkippable(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.isContentEditable) return true;
      if (el.classList && el.classList.contains(MARK_CLASS)) return true;
      if (el.hasAttribute && el.hasAttribute(UI_ATTR)) return true;
      if (OFFSCREEN_RE.test(classString(el))) return true;
      el = el.parentElement;
    }
    return false;
  }

  // Original rich DOM (e.g. a linked unit word) kept per converted span, so
  // the panel can show it and "mark incorrect" can restore it.
  const originalContent = new WeakMap();

  function makeMark(c) {
    const span = document.createElement("span");
    span.className = MARK_CLASS;
    span.textContent = c.display;
    span.setAttribute("data-original", c.full.trim());
    span.setAttribute("data-kind", c.kind);
    // Record a re-applied "convert as" unit so the hover panel highlights it.
    if (c.forceUnitId) span.setAttribute("data-variant", c.forceUnitId);
    // Tag word swaps with their term id so the panel can turn just that one off.
    if (c.wordId) span.setAttribute("data-word", c.wordId);
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `${c.display}, originally ${c.full.trim()}, activate to review`);
    wireHover();
    return span;
  }

  // Inline elements whose text flows together with surrounding text (so a
  // number and a linked unit form one logical run). Anything else is a block.
  const INLINE_TAGS = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "CITE", "DATA", "DFN", "EM", "I", "MARK",
    "Q", "RP", "RT", "RUBY", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP",
    "TIME", "U", "VAR", "WBR", "FONT", "LABEL", "OUTPUT", "INS", "DEL", "NOBR",
  ]);
  function isInlineEl(el) {
    return INLINE_TAGS.has(el.tagName);
  }

  function gatherTextNodes(node, out) {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || isSkippable(node)) return;
    if (node.tagName === "BR") { out.push(node); return; } // emits a space in processRun
    for (const child of node.childNodes) gatherTextNodes(child, out);
  }

  // Process one inline run (a list of text nodes / inline elements in order).
  function processRun(runNodes) {
    const tnodes = [];
    for (const node of runNodes) gatherTextNodes(node, tnodes);
    if (tnodes.length === 0) return;

    let text = "";
    const map = []; // map[i] = [textNode, offsetInNode]
    for (const tn of tnodes) {
      if (tn.tagName === "BR") { text += " "; map.push([tn, 0]); continue; }
      const v = tn.nodeValue || "";
      for (let i = 0; i < v.length; i++) { text += v[i]; map.push([tn, i]); }
    }
    if (text.length < 2) return;

    const hasDigit = /\d/.test(text);
    // Word substitutions need no number, so they run independently of the
    // numeric pipeline (and even on runs that contain no digit at all).
    const words = (anyWordSubOn() && WORD_TEST_RE.test(text)) ? wordCandidates(text) : [];
    if (!hasDigit && !words.length) return;

    let chosen = [];
    if (hasDigit) {
      const candidates = proposeSpans(text);
      appendForcedUnitCandidates(text, candidates);
      chosen = filterCandidates(text, candidates);
    }
    if (!chosen.length && !words.length) return;
    chosen = chosen.concat(words);

    // Apply right-to-left so earlier matches' node offsets stay valid after
    // we extract later ones (Range.extractContents splits text nodes).
    chosen.sort((a, b) => b.start - a.start);
    for (const c of chosen) { replaceRange(map, c); if (c.kind !== "word") maybeLogPositive(c, text); }
  }

  // Optionally record a correct detection as a (positive) training example,
  // labelled with the unit it resolved to, so the dataset isn't all corrections.
  function maybeLogPositive(c, contextText) {
    if (!settings.logSamples || Math.random() >= SAMPLE_RATE) return;
    let label, unitId;
    if (c.kind === "price") { label = "auto:price"; unitId = "price"; }
    else if (c.dim) return; // skip dimension lists for now
    else {
      const v = variantFor(c);
      if (!v || v.money) return;
      label = "auto:" + v.id; unitId = v.id;
    }
    logTrainingExample(label, c.full, contextText, { tier: "auto", unitId: unitId });
  }

  // Snapshot the text styling of the match's context (and inline child styles)
  // so the panel can show the original looking exactly as it did on the page.
  const STYLE_PROPS = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
    "color", "letterSpacing", "textTransform", "lineHeight",
  ];
  const originalStyle = new WeakMap();

  function isLightColor(color) {
    if (!color) return false;
    const m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(",").map((x) => parseFloat(x));
    const [r, g, b] = parts;
    if (![r, g, b].every((x) => isFinite(x))) return false;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.6; // light text -> use a dark box background
  }

  function snapshotStyle(el) {
    if (!el || !window.getComputedStyle) return null;
    let cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return null; }
    if (!cs) return null;
    const snap = {};
    for (const p of STYLE_PROPS) if (cs[p]) snap[p] = cs[p];
    return snap;
  }

  function inlineDescendantStyles(container) {
    if (!container || !container.querySelectorAll || !window.getComputedStyle) return;
    container.querySelectorAll("*").forEach((el) => {
      let cs;
      try { cs = window.getComputedStyle(el); } catch (e) { return; }
      if (!cs) return;
      for (const p of STYLE_PROPS) if (cs[p] && !el.style[p]) el.style[p] = cs[p];
      if (cs.verticalAlign && !el.style.verticalAlign) el.style.verticalAlign = cs.verticalAlign;
      if (cs.textDecorationLine && cs.textDecorationLine !== "none" && !el.style.textDecoration) {
        el.style.textDecoration = cs.textDecorationLine;
      }
    });
  }

  function replaceRange(map, c) {
    const s = c.start;
    const e = c.end;
    if (!map[s] || !map[e - 1]) return;
    const range = document.createRange();
    try {
      range.setStart(map[s][0], map[s][1]);
      range.setEnd(map[e - 1][0], map[e - 1][1] + 1);
    } catch (err) {
      return;
    }
    // Capture styling while the nodes are still live and in the document.
    const ctxStyle = snapshotStyle(map[s][0].parentElement);
    // Inline computed styles onto the live elements about to be extracted, so
    // the extracted clones (sup, links, sized text) keep their appearance.
    const ca = range.commonAncestorContainer;
    if (ca && ca.nodeType === Node.ELEMENT_NODE) inlineDescendantStyles(ca);

    const frag = range.extractContents(); // the original rich content
    const span = makeMark(c);
    // If the original held any element (a link, bold, etc.), mark it so the
    // underline differs and the panel knows there is hidden formatting.
    // Keep the original DOM only when it holds real markup (links, bold, etc.).
    // Plain-text originals are rebuilt from data-original on revert and in the
    // panel, so retaining a fragment for them only wastes memory.
    if (frag.querySelector && frag.querySelector("*")) {
      span.classList.add("mg-rich");
      originalContent.set(span, frag);
    }
    if (ctxStyle) originalStyle.set(span, ctxStyle);
    range.insertNode(span);

    // Extraction can leave empty inline shells (e.g. a now-textless <a>);
    // remove those adjacent to the new span so no stray link/styling lingers.
    cleanupEmptyInline(span.previousSibling, "prev");
    cleanupEmptyInline(span.nextSibling, "next");

    // Keep the converted value set off by spaces from the surrounding text.
    ensureSpacing(span);
  }

  // After inserting a conversion span, set it off with a space from the
  // surrounding text on BOTH sides, so a value never butts up against another
  // character (e.g. "3 mCord" or "1.37 cm× H"). Punctuation that normally hugs
  // is allowed to touch the value directly, handled directionally so it reads
  // right: closing punctuation (, . : ; ) ] }) may follow the value with no
  // space ("1.5 m).", "1.5 m:"), and opening brackets (( [ {) may precede it
  // ("(1.5 m"). Everything else (letters, digits, ×, /, opening bracket *after*
  // the value, …) gets a space. Spaces are inserted outside the span (no
  // underline); existing whitespace is left alone. Called from every insertion path.
  const NO_SPACE_AFTER = /[\s,.:;)\]}]/;
  const NO_SPACE_BEFORE = /[\s,.(\[{]/;
  function ensureSpacing(span) {
    if (!span || !span.parentNode) return;
    const edgeChar = (node, which) => {
      if (!node) return null;
      const s = node.nodeType === Node.TEXT_NODE ? (node.nodeValue || "")
        : node.nodeType === Node.ELEMENT_NODE ? (node.textContent || "") : "";
      if (!s) return null;
      return which === "first" ? s[0] : s[s.length - 1];
    };
    const after = span.nextSibling;
    const ac = edgeChar(after, "first");
    if (ac && !NO_SPACE_AFTER.test(ac)) {
      span.parentNode.insertBefore(document.createTextNode(" "), after);
    }
    const before = span.previousSibling;
    const bc = edgeChar(before, "last");
    if (bc && !NO_SPACE_BEFORE.test(bc)) {
      span.parentNode.insertBefore(document.createTextNode(" "), span);
    }
  }

  function cleanupEmptyInline(node, dir) {
    let count = 0;
    while (node && count < 4) {
      const next = dir === "prev" ? node.previousSibling : node.nextSibling;
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        isInlineEl(node) &&
        node.children.length === 0 &&
        !(node.textContent || "").trim()
      ) {
        const sib = next;
        node.parentNode.removeChild(node);
        node = sib;
        count++;
      } else {
        break;
      }
    }
  }

  // Single text node (used by the observer for added text nodes).
  function processTextNode(textNode) {
    const text = textNode.nodeValue;
    if (!text || text.length < 2) return;
    if (!/\d/.test(text) && !(anyWordSubOn() && WORD_TEST_RE.test(text))) return;
    if (isSkippable(textNode)) return;
    processRun([textNode]);
  }

  // Walk a block's children, grouping consecutive inline content into runs and
  // recursing into nested block elements.
  function collectRuns(block) {
    let run = [];
    const flush = () => { if (run.length) { processRun(run); run = []; } };
    // Snapshot children since processRun mutates the tree.
    const children = Array.prototype.slice.call(block.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (isSkippable(child)) {
          flush();
        } else if (child.tagName === "BR" || isInlineEl(child)) {
          run.push(child);
        } else {
          flush();
          collectRuns(child);
        }
      }
    }
    flush();
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { processTextNode(root); return; }
    if (root.nodeType === Node.ELEMENT_NODE && isSkippable(root)) return;
    collectRuns(root);
    scanSplitPrices(root);
  }

  // Prices split across multiple elements (e.g. Amazon: a "$", a "12", a "77"
  // in separate spans, with the only contiguous "$12.77" hidden offscreen).
  // The per-text-node pass can't see those as one string, so handle them here:
  // find a compact wrapper around a currency symbol, read the true price from a
  // contiguous full-price text node inside it (the hidden copy is reliable),
  // and replace the wrapper's visible content with a single rounded value.
  const PRICE_SYM_RE = /(US\$|CA\$|A\$|NZ\$|HK\$|[$€£¥])/;
  function scanSplitPrices(root) {
    if (!settings.priceRounding) return;
    const el0 = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (!el0) return;

    const walker = document.createTreeWalker(el0, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !PRICE_SYM_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        return isSkippable(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const symNodes = [];
    let n;
    while ((n = walker.nextNode())) symNodes.push(n);

    const seen = new Set();
    for (const sn of symNodes) {
      // Climb from the symbol outward, trying each ancestor. Stop at the first
      // element that tightly bounds the price (rewrite succeeds), and never
      // climb into an ancestor that contains real words.
      let el = sn.parentElement;
      let depth = 0;
      while (el && el !== el0.parentElement && depth < 6) {
        if (!seen.has(el)) {
          seen.add(el);
          if (!(el.classList && el.classList.contains(MARK_CLASS)) &&
              !(el.querySelector && el.querySelector("." + MARK_CLASS))) {
            if (tryRewriteSplitPrice(el)) break;
          }
        }
        // Don't climb into ancestors that hold words (e.g. "...Price history").
        if (/[A-Za-z]{2,}/.test(el.textContent || "")) break;
        el = el.parentElement;
        depth++;
      }
    }
  }

  function tryRewriteSplitPrice(wrapper) {
    // Collect this wrapper's text nodes. `full` = a contiguous full price with
    // cents found anywhere inside (e.g. an offscreen copy) = reliable value.
    const visibleNodes = [];
    let full = null;
    const w = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = w.nextNode())) {
      const val = n.nodeValue || "";
      if (!val.trim()) continue;
      PRICE_RE.lastIndex = 0;
      const m = PRICE_RE.exec(val);
      if (m && m[3] && m[0].replace(/\s+/g, "").length >= val.trim().length) full = m;
      if (!isSkippable(n)) visibleNodes.push(n);
    }
    if (visibleNodes.length < 2) return false; // not split; the text pass handles it

    const visibleStr = visibleNodes.map((t) => t.nodeValue).join("");
    if (/[A-Za-z]/.test(visibleStr)) return false; // wrapper holds words, too big

    let priceStr, value, symbol;
    if (full) {
      priceStr = full[0];
      symbol = full[1];
      value = parseFloat(full[2].replace(/,/g, "")) + (full[3] ? parseFloat("0." + full[3]) : 0);
    } else {
      // No contiguous copy: reconstruct from visible parts (needs a decimal).
      PRICE_RE.lastIndex = 0;
      const m = PRICE_RE.exec(visibleStr.replace(/\s+/g, ""));
      if (!m || !m[3]) return false;
      priceStr = m[0];
      symbol = m[1];
      value = parseFloat(m[2].replace(/,/g, "")) + parseFloat("0." + m[3]);
    }

    if (bucket(false).block.some((r) => occMatchesNode(r, priceStr, wrapper))) return false;
    const forced = bucket(false).forcePrice.some((r) => occMatchesNode(r, priceStr, wrapper));
    if (!settings.priceRounding && !forced) return false;
    const disp = renderDisplay({ kind: "price", value, symbol, full: priceStr, forced });
    if (!disp || disp === priceStr) return false;

    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    const span = document.createElement("span");
    span.className = MARK_CLASS;
    span.textContent = disp;
    span.setAttribute("data-original", priceStr);
    span.setAttribute("data-kind", "price");
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `${disp}, originally ${priceStr}, activate to review`);
    wrapper.appendChild(span);
    wireHover();
    return true;
  }

  function rescan() {
    // Revert nothing; just process text that became convertible under new
    // rules. Newly-blocked spans are handled by revertSpan() at click time.
    if (hostDisabled()) return;
    collectAndObserve(document.body);
  }

  // ---------------------------------------------------------------
  // Corrections (recorded per-occurrence; see the corrections block above)
  // ---------------------------------------------------------------

  // Re-express an already-converted span as a different unit in place
  // (used by the hover panel's alternative options). Keeps the original
  // fragment so revert still works; logs the choice as training data.
  function reconvertSpan(span, unitId) {
    const v = REG_BY_ID[unitId] || VARIANT_BY_ID[unitId];
    if (!v || typeof v.toMetric !== "function") return false;
    const original = span.getAttribute("data-original") || "";
    const m = original.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!m) return false;
    const value = parseFloat(m[0].replace(/,/g, ""));
    if (!isFinite(value)) return false;
    span.textContent = v.fmt(v.toMetric(value));
    span.setAttribute("data-kind", "unit");
    span.setAttribute("data-variant", unitId);
    span.setAttribute("aria-label", `${span.textContent}, originally ${original}, activate to review`);
    logTrainingExample("interpretation:" + unitId, original, span.parentElement ? span.parentElement.textContent : original, { node: span, unitId: unitId, interacted: true });
    recordForceUnit(span, original, unitId);
    return true;
  }

  // User explicitly told us the unit of a selection (category > unit menu).
  function applyConvertAs(range, unitId) {
    if (!range || range.collapsed) return { ok: false, reason: "empty" };
    const variant = REG_BY_ID[unitId] || VARIANT_BY_ID[unitId];
    if (!variant || typeof variant.toMetric !== "function") return { ok: false, reason: "bad_unit" };

    const ca = range.commonAncestorContainer;
    const ctxEl = ca.nodeType === Node.ELEMENT_NODE ? ca : ca.parentElement;
    const ctxText = ctxEl ? ctxEl.textContent : range.toString();

    // ── Multi-value path ──────────────────────────────────────────────────────
    // Build a character-to-DOM map for the selected text nodes, then find every
    // value that matches the chosen unit and insert a separate span for each.
    // Falls back to the single-value path if the map is empty or no spans land.

    const insertedSpans = (() => {
      const walkRoot = ca.nodeType === Node.TEXT_NODE ? ca.parentNode : ca;
      if (!walkRoot) return [];
      const selTnodes = [];
      const tw = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT, null);
      let tn;
      while ((tn = tw.nextNode())) {
        if (isSkippable(tn)) continue;
        try {
          const nr = document.createRange();
          nr.selectNodeContents(tn);
          // Keep only text nodes that overlap the selection. END_TO_START >= 0
          // means the node ends at/before the selection starts (entirely before);
          // START_TO_END <= 0 means it starts at/after the selection ends (after).
          if (range.compareBoundaryPoints(Range.END_TO_START, nr) >= 0) continue;
          if (range.compareBoundaryPoints(Range.START_TO_END, nr) <= 0) continue;
        } catch (e) { continue; }
        selTnodes.push(tn);
      }
      if (selTnodes.length === 0) return [];

      let text = "";
      const map = [];
      for (const node of selTnodes) {
        const startOff = node === range.startContainer ? range.startOffset : 0;
        const endOff   = node === range.endContainer   ? range.endOffset   : (node.nodeValue || "").length;
        const slice = (node.nodeValue || "").slice(startOff, endOff);
        for (let i = 0; i < slice.length; i++) { text += slice[i]; map.push([node, startOff + i]); }
      }
      if (!text || !/\d/.test(text)) return [];

      // Candidates matching the chosen unit; fall back to bare numbers.
      let candidates = proposeSpans(text).filter(c =>
        c.kind === "unit" && c.unit && c.unit.variants.some(va => va.id === unitId)
      );
      if (candidates.length === 0) {
        // Each bare number optionally carries a trailing prime/quote marker
        // (5', 0.54”, 0.39″) so the span consumes the marker instead of leaving
        // it orphaned next to the converted value ("1.4 cm”"). parseFloat reads
        // the leading number and ignores the marker, so the value is unaffected.
        // The leading guard rejects digits glued to a word (the "15" in
        // "iPhone15"), but allows a number after a dimension separator (the "10"
        // in "8x10", "8 x 10", "8.5×11") so dimension lists yield every value.
        const bareRe = /(?:(?<!\w)|(?<=\d\s{0,3}[x×]\s{0,3}))-?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*['’′ʹ´ʻ`"”“″]{1,2})?/g;
        let bm;
        const unit = UNITS.find(u => u.variants.some(va => va.id === unitId));
        while ((bm = bareRe.exec(text)) !== null) {
          const value = parseFloat(bm[0].replace(/,/g, ""));
          if (!isFinite(value)) continue;
          candidates.push({ start: bm.index, end: bm.index + bm[0].length, full: bm[0], kind: "unit", value, unit });
        }
      }
      if (candidates.length < 2) return []; // single value: let the simple path handle it

      for (const c of candidates) c.display = variant.fmt(variant.toMetric(c.value));
      candidates.sort((a, b) => a.start - b.start || b.end - a.end);
      const chosen = [];
      let cur = -1;
      for (const c of candidates) { if (c.start >= cur) { chosen.push(c); cur = c.end; } }
      if (chosen.length < 2) return [];

      chosen.sort((a, b) => b.start - a.start); // right-to-left for DOM stability
      const spans = [];
      for (const c of chosen) {
        if (!map[c.start] || !map[c.end - 1]) continue;
        const r = document.createRange();
        try {
          r.setStart(map[c.start][0], map[c.start][1]);
          r.setEnd(map[c.end - 1][0], map[c.end - 1][1] + 1);
        } catch (err) { continue; }
        const rStyle = snapshotStyle(map[c.start][0].parentElement);
        const rCa = r.commonAncestorContainer;
        if (rCa && rCa.nodeType === Node.ELEMENT_NODE) inlineDescendantStyles(rCa);
        const frag = r.extractContents();
        const span = makeMark(c);
        span.setAttribute("data-variant", unitId);
        if (frag.querySelector && frag.querySelector("*")) {
          span.classList.add("mg-rich");
          originalContent.set(span, frag);
        }
        if (rStyle) originalStyle.set(span, rStyle);
        r.insertNode(span);
        cleanupEmptyInline(span.previousSibling, "prev");
        cleanupEmptyInline(span.nextSibling, "next");
        ensureSpacing(span);
        logTrainingExample("convert-as:" + unitId, c.full, ctxText, { interacted: true, node: ctxEl, unitId });
        recordForceUnit(span, c.full, unitId);
        spans.push(span);
      }
      return spans;
    })();

    if (insertedSpans.length > 0) {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      setTimeout(() => showPanelFor(insertedSpans[insertedSpans.length - 1]), 0);
      return { ok: true };
    }

    // ── Single-value path (original behaviour) ────────────────────────────────
    const selText = range.toString().replace(/\s+/g, " ").trim();
    const m = selText.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!m) return { ok: false, reason: "no_value" };
    const value = parseFloat(m[0].replace(/,/g, ""));
    if (!isFinite(value)) return { ok: false, reason: "no_value" };

    const disp = variant.fmt(variant.toMetric(value));
    const ctxStyle = snapshotStyle(ca.nodeType === Node.ELEMENT_NODE ? ca : ca.parentElement);
    if (ca.nodeType === Node.ELEMENT_NODE) inlineDescendantStyles(ca);
    const frag = range.extractContents();
    const span = document.createElement("span");
    span.className = MARK_CLASS;
    span.textContent = disp;
    span.setAttribute("data-original", selText);
    span.setAttribute("data-kind", "unit");
    span.setAttribute("data-variant", unitId);
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `${disp}, originally ${selText}, activate to review`);
    if (frag.querySelector && frag.querySelector("*")) {
      span.classList.add("mg-rich");
      originalContent.set(span, frag);
    }
    if (ctxStyle) originalStyle.set(span, ctxStyle);
    range.insertNode(span);
    ensureSpacing(span);

    logTrainingExample("convert-as:" + unitId, selText, ctxText, { interacted: true, node: ctxEl, unitId });
    recordForceUnit(span, selText, unitId);
    wireHover();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    setTimeout(() => showPanelFor(span), 0);
    return { ok: true };
  }

  // User selected a price (possibly in odd/split markup) and asked to round it.
  // Replaces the entire selected range with a single rounded value, using the
  // most reliable price found in the selection (a contiguous copy if present).
  function forcePriceFromSelection(range, force) {
    if (force === undefined) force = true;
    if (!range || range.collapsed) return { ok: false, reason: "empty" };
    const _ca = range.commonAncestorContainer;
    const _ctxEl = _ca && _ca.nodeType === Node.ELEMENT_NODE ? _ca : _ca && _ca.parentElement;
    const priceCtx = _ctxEl ? _ctxEl.textContent : range.toString();

    let priceStr = null;
    let value = null;
    let symbol = null;

    const selText = range.toString().replace(/\s+/g, " ").trim();
    PRICE_RE.lastIndex = 0;
    let m = PRICE_RE.exec(selText);
    if (m && m[3]) {
      priceStr = m[0]; symbol = m[1];
      value = parseFloat(m[2].replace(/,/g, "")) + parseFloat("0." + m[3]);
    }
    // Look for a contiguous full price (with cents) anywhere in the selection,
    // e.g. an offscreen "$12.77" when the visible price is split.
    if (value === null) {
      const clone = range.cloneContents();
      const w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = w.nextNode())) {
        PRICE_RE.lastIndex = 0;
        const mm = PRICE_RE.exec(n.nodeValue || "");
        if (mm && mm[3]) {
          priceStr = mm[0]; symbol = mm[1];
          value = parseFloat(mm[2].replace(/,/g, "")) + parseFloat("0." + mm[3]);
          break;
        }
      }
    }
    // Last resort: any price-like sequence in the collapsed selection text.
    if (value === null) {
      PRICE_RE.lastIndex = 0;
      const m2 = PRICE_RE.exec(selText.replace(/\s+/g, ""));
      if (m2) {
        priceStr = m2[0]; symbol = m2[1];
        value = parseFloat(m2[2].replace(/,/g, "")) + (m2[3] ? parseFloat("0." + m2[3]) : 0);
      }
    }
    // No currency anywhere: let a bare number be declared a price.
    if (value === null) {
      const bm = selText.match(/-?\d[\d,]*(?:\.\d+)?/);
      if (bm) { priceStr = bm[0]; symbol = ""; value = parseFloat(bm[0].replace(/,/g, "")); }
    }
    if (value === null || !isFinite(value)) return { ok: false, reason: "no_value" };

    const rounded = roundedPriceValue(value, force);
    const intVal = rounded === null ? Math.round(value) : rounded;
    const disp = (symbol || "").replace(/\s+$/, "") + intVal.toLocaleString("en-US");

    const frag = range.extractContents();
    const span = document.createElement("span");
    span.className = MARK_CLASS;
    span.textContent = disp;
    span.setAttribute("data-original", priceStr || selText);
    span.setAttribute("data-kind", "price");
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `${disp}, originally ${priceStr || selText}, activate to review`);
    if (frag.querySelector && frag.querySelector("*")) {
      span.classList.add("mg-rich");
      originalContent.set(span, frag);
    }
    range.insertNode(span);
    ensureSpacing(span);

    logTrainingExample("price", priceStr || selText, priceCtx, { interacted: true, node: _ctxEl, unitId: "price" });
    if (force) recordForcePrice(span, priceStr || selText);
    wireHover();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    setTimeout(() => showPanelFor(span), 0);
    return { ok: true };
  }

  // Re-mark an existing conversion span as a price (from the picker).
  function reconvertSpanAsPrice(span, force) {
    if (force === undefined) force = false;
    const original = span.getAttribute("data-original") || "";
    const p = parsePriceText(original);
    if (!p) return { ok: false, reason: "no_price" };
    const rounded = roundedPriceValue(p.value, force);
    const cents = Math.round((p.value - Math.floor(p.value)) * 100);
    const sym = p.symbol.replace(/\s+$/, "");
    const disp = (rounded === null && cents !== 0)
      ? sym + p.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : sym + (rounded === null ? Math.round(p.value) : rounded).toLocaleString("en-US");
    span.textContent = disp;
    span.setAttribute("data-kind", "price");
    span.removeAttribute("data-variant");
    span.setAttribute("aria-label", `${disp}, originally ${original}, activate to review`);
    logTrainingExample("price", original, span.parentElement ? span.parentElement.textContent : original, { node: span, unitId: "price", interacted: true });
    if (force) recordForcePrice(span, original);
    return { ok: true };
  }

  // User marked an existing conversion as wrong. Record a per-occurrence block
  // (anchored before we revert, while the span is still in the page) and revert
  // just this span; other identical text elsewhere is untouched.
  function markFalsePositive(span) {
    const original = span.getAttribute("data-original");
    recordBlock(span, original);
    const parentText = span.parentElement ? span.parentElement.textContent : "";
    const ctx = parentText.replace(span.textContent, original);
    logTrainingExample("not_a_conversion", original, ctx, { node: span, unitId: span.getAttribute("data-variant") || null });
    revertSpan(span);
  }

  function revertSpan(span) {
    if (!span.parentNode) return;
    const frag = originalContent.get(span);
    if (frag) {
      span.parentNode.replaceChild(frag.cloneNode(true), span);
    } else {
      span.parentNode.replaceChild(document.createTextNode(span.getAttribute("data-original")), span);
    }
  }

  // User chose a different interpretation for an ambiguous quantity from the
  // hover panel (e.g. "14 pounds" is money, not mass). Anchored to this one
  // span: re-render it as the chosen unit, or, when the reading has no metric
  // form (money "kept as written"), record a block and revert just this span.
  function setInterpretation(span, original, variantId, context) {
    const v = REG_BY_ID[variantId] || VARIANT_BY_ID[variantId];
    logTrainingExample("interpretation:" + variantId, original, context || "", { unitId: variantId, interacted: true });
    if (!v || v.money || typeof v.toMetric !== "function") {
      recordBlock(span, original);
      revertSpan(span);
    } else {
      reconvertSpan(span, variantId); // re-renders in place and records the forced unit
    }
  }

  // Recover {kind, unit, value, symbol, full} from a span's original text,
  // so the panel can show the conversion details and offered variants.
  function deriveFromOriginal(originalText) {
    const cands = regexCandidates(originalText.replace(/\s+/g, " ").trim());
    return cands[0] || null;
  }

  // ---------------------------------------------------------------
  // Removal panel: hover (desktop) or tap (mobile) a conversion to see
  // the original and a "mark as incorrect" button. A short close delay
  // bridges the gap between the word and the panel so the button is
  // reachable on desktop.
  // ---------------------------------------------------------------
  const FINE = !!(
    window.matchMedia && window.matchMedia("(any-pointer: fine)").matches
  );
  const HIDE_DELAY = 150;

  let panel = null;
  let panelSpan = null;
  let hideTimer = null;

  function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hidePanel, HIDE_DELAY);
  }
  function hidePanel() {
    cancelHide();
    if (panel) panel.remove();
    panel = null;
    panelSpan = null;
  }

  function showPanelFor(span) {
    cancelHide();
    if (panelSpan === span && panel) return; // already open for this span
    hidePanel();

    const original = span.getAttribute("data-original");
    const kind = span.getAttribute("data-kind");

    // The user opened the panel, so they saw this conversion. If they don't
    // correct it, that's a mid-value "seen but accepted" example. Log once per
    // span, only when sample logging is enabled.
    if (settings.logSamples && kind !== "word" && !span.__mgSeenLogged) {
      span.__mgSeenLogged = true;
      const vid = span.getAttribute("data-variant") || (kind === "price" ? "price" : null);
      logTrainingExample("seen:" + (vid || "unit"), original || span.textContent,
        span.parentElement ? span.parentElement.textContent : (original || ""),
        { tier: "seen", seen: true, interacted: false, node: span, unitId: vid });
    }

    const el = document.createElement("div");
    el.className = "mg-popover";
    el.setAttribute(UI_ATTR, "1");

    const addLine = (cls, text) => {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      el.appendChild(d);
    };

    addLine("mg-pop-head", "Original text:");
    const box = document.createElement("div");
    box.className = "mg-pop-codebox";
    box.setAttribute(UI_ATTR, "1");
    const frag = originalContent.get(span);
    const snap = originalStyle.get(span);
    if (snap) {
      // Render the original in its own font/size/colour so it looks like the
      // page; pick a box background that keeps the original colour readable.
      for (const p of STYLE_PROPS) if (snap[p]) box.style[p] = snap[p];
      box.style.background = isLightColor(snap.color) ? "#1f2430" : "#ffffff";
      box.style.borderColor = isLightColor(snap.color) ? "#3a4250" : "#d0d4dd";
    }
    if (frag) {
      box.appendChild(frag.cloneNode(true)); // preserves links / formatting
    } else {
      box.textContent = original;
    }
    el.appendChild(box);

    // Tooltip for the ⓘ badges in this panel.
    const tip = document.createElement("div");
    tip.className = "mg-pop-tip";
    tip.setAttribute(UI_ATTR, "1");
    tip.style.display = "none";
    el.appendChild(tip);
    const showTip = (text, badge) => {
      tip.textContent = text;
      tip.style.display = "block";
      const r = badge.getBoundingClientRect();
      const tw = Math.min(240, window.innerWidth - 24);
      tip.style.width = tw + "px";
      let left = r.left;
      if (left + tw > window.innerWidth - 12) left = window.innerWidth - 12 - tw;
      tip.style.left = Math.max(12, left) + "px";
      tip.style.top = r.bottom + 6 + "px";
    };
    const hideTip = () => { tip.style.display = "none"; };

    const makeBadge = (info) => {
      const badge = document.createElement("span");
      badge.className = "mg-pop-info";
      badge.setAttribute(UI_ATTR, "1");
      badge.textContent = "\u24D8";
      badge.tabIndex = 0;
      badge.setAttribute("aria-label", "About this unit");
      badge.addEventListener("mouseenter", () => showTip(info, badge));
      badge.addEventListener("mouseleave", hideTip);
      badge.addEventListener("focus", () => showTip(info, badge));
      badge.addEventListener("blur", hideTip);
      badge.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); showTip(info, badge); });
      return badge;
    };

    const optionRow = (o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mg-pop-btn mg-pop-opt" + (o.current ? " mg-pop-opt-on" : "");
      b.setAttribute(UI_ATTR, "1");
      const left = document.createElement("span");
      left.className = "mg-pop-opt-l";
      left.textContent = (o.current ? "\u2713 " : "") + o.name;
      left.appendChild(makeBadge(o.info));
      const right = document.createElement("span");
      right.className = "mg-pop-opt-r";
      right.textContent = o.preview;
      b.appendChild(left);
      b.appendChild(right);
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); o.onClick(); });
      return b;
    };

    const c = deriveFromOriginal(original);
    const explicitVariant = span.getAttribute("data-variant");
    const numMatch = original.match(/-?\d[\d,]*(?:\.\d+)?/);
    const spanValue = numMatch ? parseFloat(numMatch[0].replace(/,/g, "")) : null;

    if (kind === "word") {
      const wid = span.getAttribute("data-word");
      addLine("mg-pop-line", original + "  →  " + span.textContent);
      addLine("mg-pop-rate", "A little flourish, not a measurement.");
      const off = document.createElement("button");
      off.type = "button";
      off.className = "mg-pop-btn";
      off.setAttribute(UI_ATTR, "1");
      off.textContent = "Turn off this substitution";
      off.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = { ...(settings.wordSubs || {}) };
        if (wid) next[wid] = false;
        settings.wordSubs = next;
        if (storage) storage.set({ wordSubs: next });
        hidePanel();
        revertWords(wid);
      });
      el.appendChild(off);
    } else if (kind === "price" && c && c.kind === "price") {
      addLine("mg-pop-line", original + "  →  " + span.textContent);
      const whole = Math.floor(c.value);
      const gap = 100 - Math.round((c.value - whole) * 100);
      addLine("mg-pop-rate", "Rounded up to the next whole amount (gap " + gap + "¢).");
    } else {
      // Unit display (auto-detected or explicitly chosen).
      const currentId = explicitVariant || (c && c.unit && !c.dim ? variantFor(c).id : null);
      const curV = (currentId && (REG_BY_ID[currentId] || VARIANT_BY_ID[currentId])) || (c && c.unit ? variantFor(c) : null);
      addLine("mg-pop-line", original + "  →  " + span.textContent);
      if (curV && typeof curV.toMetric === "function") {
        addLine("mg-pop-rate", "Rate: " + rateFor(spanValue != null ? spanValue : (c ? c.value : 1), curV));
      }

      // "Also in" — value rendered in the user's chosen extra hover units.
      const bi = unitBaseInfo(curV);
      const hov = bi ? enabledHoverScales(bi.cat) : [];
      if (bi && hov.length && spanValue != null) {
        const dispSym = (/\u00A0?([^\u00A0\d.,-]+)$/.exec(span.textContent) || [])[1];
        const extras = hov
          .map((u) => u[0])
          .filter((sym) => sym !== (dispSym ? dispSym.trim() : ""))
          .map((sym) => renderInScale(bi.cat, bi.base1 * spanValue, sym))
          .filter(Boolean);
        if (extras.length) addLine("mg-pop-rate", "Also: " + extras.join("  ·  "));
      }

      if (!(c && c.dim)) {
        const cluster = currentId ? ALT_BY_ID[currentId] : null;
        const options = [];
        if (cluster) {
          cluster.forEach((id) => {
            const e2 = REG_BY_ID[id];
            if (!e2) return;
            options.push({
              id, name: e2.name, info: infoFor(e2), current: id === currentId,
              preview: spanValue != null ? e2.fmt(e2.toMetric(spanValue)) : e2.rate,
              onClick: () => { reconvertSpan(span, id); hidePanel(); showPanelFor(span); },
            });
          });
          // If the detected word also has a money reading (e.g. "pounds"), keep
          // the "it's currency" option available alongside the unit choices.
          if (c && c.unit) {
            applicableVariants(c).filter((v) => v.money).forEach((variant) => {
              const parentText = span.parentElement ? span.parentElement.textContent : "";
              const ctx = parentText.replace(span.textContent, original);
              options.push({
                id: variant.id, name: variant.label, info: infoFor(variant), current: variant.id === currentId,
                preview: "kept as written",
                onClick: () => { setInterpretation(span, original, variant.id, ctx); hidePanel(); },
              });
            });
          }
        } else if (c && c.unit) {
          const appl = applicableVariants(c);
          if (appl.length > 1) {
            appl.forEach((variant) => {
              const parentText = span.parentElement ? span.parentElement.textContent : "";
              const ctx = parentText.replace(span.textContent, original);
              options.push({
                id: variant.id, name: variant.label, info: infoFor(variant), current: variant.id === currentId,
                preview: variant.money ? "kept as written" : (spanValue != null && variant.toMetric ? variant.fmt(variant.toMetric(spanValue)) : variant.rate),
                onClick: () => { setInterpretation(span, original, variant.id, ctx); hidePanel(); },
              });
            });
          }
        }

        if (options.length > 1) {
          addLine("mg-pop-head", "Interpret as:");
          options.forEach((o) => el.appendChild(optionRow(o)));
        }

        // Always offer the full searchable picker for a unit span.
        const link = document.createElement("button");
        link.type = "button";
        link.className = "mg-pop-link";
        link.setAttribute(UI_ATTR, "1");
        link.textContent = "Browse all units… (search)";
        link.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          hidePanel();
          openPickerForSpan(span);
        });
        el.appendChild(link);
      }
    }

    if (kind !== "word") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mg-pop-btn mg-danger";
      btn.setAttribute(UI_ATTR, "1");
      btn.textContent = "Mark as incorrect (don't convert)";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        markFalsePositive(span);
        hidePanel();
      });
      el.appendChild(btn);
    }

    // Keep open while pointer is over the panel (desktop bridge).
    el.addEventListener("mouseenter", cancelHide);
    el.addEventListener("mouseleave", scheduleHide);

    document.body.appendChild(el);
    // Clamp into the viewport so a span near an edge does not push the panel
    // off-screen. offsetWidth/Height are valid now that el is in the document.
    const r = span.getBoundingClientRect();
    const margin = 6;
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;

    let left = r.left;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - margin - pw;
    if (left < margin) left = margin;

    // Below the span by default; flip above if it would overflow the bottom and
    // there is room above.
    let top = r.bottom + margin;
    if (top + ph > window.innerHeight - margin && r.top - margin - ph >= margin) {
      top = r.top - margin - ph;
    }

    el.style.left = window.scrollX + left + "px";
    el.style.top = window.scrollY + top + "px";

    panel = el;
    panelSpan = span;
  }

  function togglePanelFor(span) {
    if (panelSpan === span && panel) hidePanel();
    else showPanelFor(span);
  }

  // Desktop: hover opens the panel, with a hide-intent delay and relatedTarget
  // guard so moving within the word (or onto the panel) does not flicker it
  // closed. These delegated listeners run closest() on every mouse move, so we
  // attach them lazily on the first conversion (wireHover, called from the span
  // factories) and drop them when the page is cleared (unwireHover, from
  // revertAll). Pages with no imperial units never attach them at all.
  let hoverWired = false;
  function onHoverOver(e) {
    const span = e.target.closest && e.target.closest("." + MARK_CLASS);
    if (span) { cancelHide(); showPanelFor(span); }
  }
  function onHoverOut(e) {
    const span = e.target.closest && e.target.closest("." + MARK_CLASS);
    if (!span) return;
    const to = e.relatedTarget;
    if (to && (span.contains(to) || (panel && panel.contains(to)))) return;
    scheduleHide();
  }
  function wireHover() {
    if (hoverWired || !FINE) return;
    hoverWired = true;
    document.addEventListener("mouseover", onHoverOver);
    document.addEventListener("mouseout", onHoverOut);
  }
  function unwireHover() {
    if (!hoverWired) return;
    hoverWired = false;
    document.removeEventListener("mouseover", onHoverOver);
    document.removeEventListener("mouseout", onHoverOut);
  }

  // Tap (mobile) / click (either) toggles the panel; click elsewhere closes.
  document.addEventListener(
    "click",
    (e) => {
      const span = e.target.closest && e.target.closest("." + MARK_CLASS);
      if (span) {
        e.preventDefault();
        e.stopPropagation();
        if (FINE) showPanelFor(span);
        else togglePanelFor(span);
        return;
      }
      if (e.target.closest && e.target.closest("[" + UI_ATTR + "]")) return;
      hidePanel();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (
      (e.key === "Enter" || e.key === " ") &&
      e.target.classList &&
      e.target.classList.contains(MARK_CLASS)
    ) {
      e.preventDefault();
      togglePanelFor(e.target);
    }
    if (e.key === "Escape") { hidePanel(); hideToolbar(); closePicker(); }
  });

  document.addEventListener("scroll", () => { hidePanel(); hideToolbar(); }, true);

  // ---------------------------------------------------------------
  // Adding a conversion.
  //   Desktop: native right-click menu (handled in background.js, which
  //            messages us here). The in-page toolbar is suppressed.
  //   Mobile:  in-page selection toolbar (no native menus on Android).
  // ---------------------------------------------------------------
  let nativeMenus = FINE; // optimistic default; corrected by background reply
  function refreshShortcut(cb) {
    if (!(api && api.runtime && api.runtime.sendMessage)) { if (cb) cb(currentShortcut); return; }
    try {
      const p = api.runtime.sendMessage({ type: "mg-shortcut?" });
      if (p && p.then) p.then(
        (r) => { currentShortcut = (r && r.shortcut) || ""; if (cb) cb(currentShortcut); },
        () => { if (cb) cb(currentShortcut); }
      );
    } catch (e) { if (cb) cb(currentShortcut); }
  }
  refreshShortcut();
  if (api && api.runtime && api.runtime.sendMessage) {
    try {
      const p = api.runtime.sendMessage({ type: "mg-native-menus?" });
      if (p && p.then) p.then((r) => { if (r) nativeMenus = !!r.native; }, () => {});
    } catch (e) { /* ignore */ }

    api.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      const sel = window.getSelection();
      const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      if (msg.type === "mg-open-picker") {
        // If the hover menu of a converted item is open, act on that item
        // (its original value); otherwise use the current text selection.
        if (panel && panelSpan) openPickerForSpan(panelSpan);
        else if (range) openPicker(range);
        return;
      }
      if (msg.type === "mg-pick-mode") { enterPickMode(); return; }
      if (!range) return;
      if (msg.type === "mg-convert-as" && msg.unitId) {
        applyConvertAs(range, msg.unitId);
      } else if (msg.type === "mg-force" && msg.kind === "price") {
        forcePriceFromSelection(range);
      }
    });
  }

  let toolbar = null;
  let pendingRange = null;
  function hideToolbar() {
    if (toolbar) toolbar.remove();
    toolbar = null;
    pendingRange = null;
  }
  function showToolbar(selText, range) {
    hideToolbar();
    pendingRange = range ? range.cloneRange() : null;
    const el = document.createElement("div");
    el.className = "mg-toolbar";
    el.setAttribute(UI_ATTR, "1");
    document.body.appendChild(el);
    toolbar = el;

    const button = (label, onClick, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mg-tb-btn" + (cls ? " " + cls : "");
      b.setAttribute(UI_ATTR, "1");
      b.textContent = label;
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
      return b;
    };

    const clear = () => { while (el.firstChild) el.removeChild(el.firstChild); };

    const fail = (b, reason) => {
      b.textContent = reason === "no_value" ? "No value found" : "Nothing selected";
      setTimeout(hideToolbar, 1100);
    };
    const done = (res, b) => {
      if (!res.ok) fail(b, res.reason);
      else hideToolbar();
    };

    el.appendChild(button("Convert to metric…", () => { const r = pendingRange; hideToolbar(); openPicker(r); }));
    el.appendChild(button("Round as price", (b) => done(forcePriceFromSelection(pendingRange), b)));
  }

  // ---------------------------------------------------------------
  // Unit picker: searchable overlay listing the whole registry, ordered
  // common -> esoteric, filterable by category, with a live preview of the
  // selected number converted into each unit. Same panel on desktop and
  // mobile; opened from the right-click "More…" item, the mobile toolbar,
  // or Ctrl+Alt+M.
  // ---------------------------------------------------------------
  let picker = null;
  let pickerRange = null;

  function closePicker() {
    if (picker) picker.remove();
    picker = null;
    pickerRange = null;
  }

  // Build the selection-line fade mask in JS so it is content-aware: only the
  // context clipped by the box edges is dimmed. The bold selection together
  // with the 3 characters on either side (lnear/rnear) is always left fully
  // opaque, even when the selection sits at the very start or end of the line.
  // The static CSS mask on .mg-pk-selline is just a first-frame fallback.
  function applySellineMask(line, lnear, strong, rnear) {
    const FADE = 24; // px of fade applied at a clipped edge
    const vw = line.clientWidth;
    if (!vw) return;
    const sl = line.scrollLeft;
    // Protected zone, in viewport px: 3 chars before + bold + 3 chars after.
    // Fall back to the bold's own edges when there is no adjacent context.
    const leftEl = lnear && lnear.textContent ? lnear : strong;
    const rightEl = rnear && rnear.textContent ? rnear : strong;
    const protLeft = leftEl.offsetLeft - sl;
    const protRight = rightEl.offsetLeft + rightEl.offsetWidth - sl;
    const hasLeftOverflow = sl > 1;
    const hasRightOverflow = line.scrollWidth - sl - vw > 1;
    // Fade only where content is actually clipped, and never let a fade reach
    // into the protected zone.
    let leftEnd = 0; // opaque from the very left unless we fade
    if (hasLeftOverflow) leftEnd = Math.max(0, Math.min(FADE, protLeft));
    let rightStart = vw; // opaque to the very right unless we fade
    if (hasRightOverflow) rightStart = Math.min(vw, Math.max(vw - FADE, protRight));
    const head = leftEnd > 0 ? "transparent 0, #000 " + leftEnd + "px" : "#000 0";
    const tail = rightStart < vw
      ? "#000 " + rightStart + "px, transparent " + vw + "px"
      : "#000 " + vw + "px";
    const g = "linear-gradient(to right, " + head + ", " + tail + ")";
    line.style.webkitMaskImage = g;
    line.style.maskImage = g;
  }

  function openPickerForSpan(span) {
    hidePanel();
    openPicker({
      seedText: span.getAttribute("data-original") || "",
      context: span.parentElement ? span.parentElement.textContent : "",
      span: span,
      currentId: span.getAttribute("data-variant") || null,
      apply: (id) => { reconvertSpan(span, id); hidePanel(); showPanelFor(span); },
    });
  }

  function openPicker(arg) {
    closePicker();
    hideToolbar();
    const opts = arg && typeof arg.cloneRange === "function" ? { range: arg } : (arg || {});
    const range = opts.range || null;
    if (range) { if (range.collapsed) return; pickerRange = range.cloneRange(); }
    else pickerRange = null;
    const applyChoice = opts.apply || ((id) => applyConvertAs(pickerRange, id));
    const currentId = opts.currentId || null;
    const selText = (opts.seedText != null ? opts.seedText : (range ? range.toString() : "")).replace(/\s+/g, " ").trim();
    const numMatch = selText.match(/-?\d[\d,]*(?:\.\d+)?/);
    const value = numMatch ? parseFloat(numMatch[0].replace(/,/g, "")) : null;
    const priceInfo = parsePriceText(selText);
    const isPlausiblePrice = !!priceInfo && (priceInfo.symbol !== "" || /\d\.\d{2}(?!\d)/.test(selText));
    let ctxText = (opts.context || "").replace(/\s+/g, " ").trim();
    if (!ctxText && range) {
      const ca = range.commonAncestorContainer;
      const el = ca && ca.nodeType === Node.ELEMENT_NODE ? ca : (ca && ca.parentElement);
      ctxText = el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    }

    const overlay = document.createElement("div");
    overlay.className = "mg-picker-overlay";
    overlay.setAttribute(UI_ATTR, "1");
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePicker(); });

    const box = document.createElement("div");
    box.className = "mg-picker";
    box.setAttribute(UI_ATTR, "1");
    overlay.appendChild(box);

    const head = document.createElement("div");
    head.className = "mg-pk-head";
    const title = document.createElement("span");
    title.textContent = "Convert to metric";
    const kbd = document.createElement("span");
    kbd.className = "mg-pk-kbd";
    const applyKbd = (sc) => {
      if (sc) {
        kbd.textContent = sc;
        kbd.title = "Shortcut to open this panel — change it in Firefox's Manage Extension Shortcuts";
        kbd.style.display = "";
      } else {
        kbd.style.display = "none";
      }
    };
    applyKbd(currentShortcut);
    const headLeft = document.createElement("span");
    headLeft.style.cssText = "display:inline-flex;align-items:center;gap:8px;min-width:0";
    headLeft.appendChild(title);
    headLeft.appendChild(kbd);
    head.appendChild(headLeft);
    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "mg-pk-min";
    minBtn.setAttribute(UI_ATTR, "1");
    minBtn.textContent = "\u2013"; // –
    minBtn.title = "Minimize (keep open, browse the page)";
    minBtn.setAttribute("aria-label", "Minimize");
    head.appendChild(minBtn);
    // Floating chip to bring the picker back after minimizing.
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "mg-pk-restore";
    restore.setAttribute(UI_ATTR, "1");
    restore.textContent = "Metric Glance \u2197"; // ↗
    restore.title = "Reopen the unit picker";
    restore.style.display = "none";
    overlay.appendChild(restore);
    minBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      box.style.display = "none";
      overlay.classList.add("mg-pk-minimized");
      restore.style.display = "";
    });
    restore.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      box.style.display = "";
      overlay.classList.remove("mg-pk-minimized");
      restore.style.display = "none";
    });
    // Refresh from the background so it reflects any remapping, even live.
    refreshShortcut((sc) => { if (picker === overlay) applyKbd(sc); });
    const selbox = document.createElement("div");
    selbox.className = "mg-pk-selbox";
    const sellabel = document.createElement("div");
    sellabel.className = "mg-pk-sellabel";
    sellabel.textContent = "Selection";
    selbox.appendChild(sellabel);
    if (selText) {
      const line = document.createElement("div");
      line.className = "mg-pk-selline";
      const idx = ctxText.indexOf(selText);
      const beforeAll = idx > 0 ? ctxText.slice(0, idx) : "";
      const afterAll = idx >= 0 ? ctxText.slice(idx + selText.length) : "";
      const beforeWin = beforeAll.slice(-80);
      const afterWin = afterAll.slice(0, 80);
      // Keep the 3 characters adjacent to the selection in their own spans so
      // they can be measured: the bold selection and these neighbours must
      // never be touched by the edge fade (see applySellineMask).
      const mkctx = (text) => {
        const s = document.createElement("span");
        s.className = "mg-pk-ctx";
        s.textContent = text;
        return s;
      };
      const lfar = mkctx(beforeWin.slice(0, -3));
      const lnear = mkctx(beforeWin.slice(-3));
      const strong = document.createElement("strong");
      strong.className = "mg-pk-seltext";
      strong.textContent = selText;
      const rnear = mkctx(afterWin.slice(0, 3));
      const rfar = mkctx(afterWin.slice(3));
      line.appendChild(lfar);
      line.appendChild(lnear);
      line.appendChild(strong);
      line.appendChild(rnear);
      line.appendChild(rfar);
      selbox.appendChild(line);
      // Scroll so the selection sits a fixed bit in from the left edge (always
      // some context before it, but never pushed past mid-box), then build a
      // content-aware fade that never dims the bold selection or its neighbours.
      requestAnimationFrame(() => {
        const inset = Math.min(64, line.clientWidth * 0.4);
        line.scrollLeft = Math.max(0, strong.offsetLeft - inset);
        applySellineMask(line, lnear, strong, rnear);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "mg-pk-ctx";
      empty.textContent = "Select some text on the page first.";
      selbox.appendChild(empty);
    }
    box.appendChild(head);
    box.appendChild(selbox);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "mg-pk-search";
    search.setAttribute(UI_ATTR, "1");
    search.placeholder = "Search units (e.g. gallon, psi, troy)…";
    box.appendChild(search);

    const chips = document.createElement("div");
    chips.className = "mg-pk-chips";
    box.appendChild(chips);

    const list = document.createElement("div");
    list.className = "mg-pk-list";
    box.appendChild(list);

    // Single reusable tooltip for the ⓘ badges.
    const tip = document.createElement("div");
    tip.className = "mg-pk-tip";
    tip.setAttribute(UI_ATTR, "1");
    tip.style.display = "none";
    overlay.appendChild(tip);
    const showTip = (text, badge) => {
      tip.textContent = text;
      tip.style.display = "block";
      const r = badge.getBoundingClientRect();
      const tw = Math.min(280, window.innerWidth - 24);
      tip.style.width = tw + "px";
      let left = r.left;
      if (left + tw > window.innerWidth - 12) left = window.innerWidth - 12 - tw;
      tip.style.left = Math.max(12, left) + "px";
      tip.style.top = r.bottom + 6 + "px";
    };
    const hideTip = () => { tip.style.display = "none"; };

    // The selection's non-numeric remainder, used to suggest likely units.
    const hint = selText.replace(/-?\d[\d,]*(?:\.\d+)?/g, " ").replace(/[x×]/g, " ").trim();
    // A number followed by a prime/apostrophe pins the length unit:
    // ' → feet, '' or " → inches (see primeLengthId).
    const primeId = primeLengthId(selText);

    let activeCat = "All";

    const makeRow = (e) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mg-pk-row";
      row.setAttribute(UI_ATTR, "1");

      const left = document.createElement("span");
      left.className = "mg-pk-name";
      const nm = document.createElement("span");
      nm.className = "mg-pk-nm";
      nm.textContent = e.name;
      const badge = document.createElement("span");
      badge.className = "mg-pk-info";
      badge.setAttribute(UI_ATTR, "1");
      badge.textContent = "\u24D8";
      badge.setAttribute("aria-label", "About this unit");
      badge.tabIndex = 0;
      const info = infoFor(e);
      badge.addEventListener("mouseenter", () => showTip(info, badge));
      badge.addEventListener("mouseleave", hideTip);
      badge.addEventListener("focus", () => showTip(info, badge));
      badge.addEventListener("blur", hideTip);
      badge.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); showTip(info, badge); });
      nm.appendChild(badge);
      const tag = document.createElement("span");
      tag.className = "mg-pk-cat";
      tag.textContent = e.cat;
      left.appendChild(nm);
      left.appendChild(tag);

      const right = document.createElement("span");
      right.className = "mg-pk-prev";
      right.textContent = value != null && isFinite(value) ? e.fmt(e.toMetric(value)) : e.rate;

      row.appendChild(left);
      row.appendChild(right);
      if (currentId && e.id === currentId) {
        row.classList.add("mg-pk-row-on");
        row.setAttribute("aria-current", "true");
        const chk = document.createElement("span");
        chk.className = "mg-pk-check";
        chk.textContent = "\u2713";
        nm.insertBefore(chk, nm.firstChild);
        const pill = document.createElement("span");
        pill.className = "mg-pk-current";
        pill.textContent = "current";
        nm.appendChild(pill);
      }
      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        applyChoice(e.id);
        closePicker();
      });
      return row;
    };

    const sectionHead = (label) => {
      const h = document.createElement("div");
      h.className = "mg-pk-section";
      h.textContent = label;
      return h;
    };

    // "Treat as price": respects the rounding threshold so the indicator can
    // honestly say whether the value will change.
    const doPrice = () => {
      if (pickerRange) forcePriceFromSelection(pickerRange, false);
      else if (opts.span) { reconvertSpanAsPrice(opts.span, false); hidePanel(); showPanelFor(opts.span); }
      closePicker();
    };
    const makePriceRow = () => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mg-pk-row mg-pk-pricerow";
      row.setAttribute(UI_ATTR, "1");
      const left = document.createElement("span");
      left.className = "mg-pk-name";
      const nm = document.createElement("span");
      nm.className = "mg-pk-nm";
      nm.textContent = "Treat as price";
      const tag = document.createElement("span");
      tag.className = "mg-pk-cat";
      const cents = Math.round((priceInfo.value - Math.floor(priceInfo.value)) * 100);
      const willRound = roundedPriceValue(priceInfo.value, false) !== null;
      tag.textContent = willRound
        ? "rounds up"
        : (cents === 0 ? "already whole" : "not rounded (gap over " + settings.priceRoundCents + "\u00A2)");
      left.appendChild(nm);
      left.appendChild(tag);
      const right = document.createElement("span");
      right.className = "mg-pk-prev";
      const sym = priceInfo.symbol.replace(/\s+$/, "");
      const from = sym + priceInfo.value.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
      right.textContent = willRound
        ? from + " \u2192 " + sym + (Math.floor(priceInfo.value) + 1).toLocaleString("en-US")
        : from;
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); doPrice(); });
      return row;
    };

    const renderList = () => {
      list.textContent = "";
      hideTip();
      const q = search.value;
      let suggested = [];
      let usingDefaults = false;
      if (activeCat === "All" && !q.trim()) {
        suggested = suggestionsFor(hint);
        // A number written with a prime/apostrophe is feet (') or inches (''/"):
        // pin that unit at the top of the suggestions regardless of other hints.
        if (primeId) {
          const forced = REG_BY_ID[primeId];
          if (forced) suggested = [forced, ...suggested.filter((e) => e.id !== primeId)];
        }
        // No hint at all (bare number): fall back to a common default set so the
        // Suggestions section is never empty. Price is added via showPriceSug.
        if (!suggested.length) {
          suggested = DEFAULT_SUGGESTION_IDS.map((id) => REG_BY_ID[id]).filter(Boolean);
          usingDefaults = true;
        }
      }

      // Price is its own category. Show it as a suggestion only when the
      // selection really looks like a price; otherwise it's still reachable
      // via the Price chip.
      if (activeCat === "Price") {
        if (priceInfo) {
          list.appendChild(makePriceRow());
        } else {
          const empty = document.createElement("div");
          empty.className = "mg-pk-empty";
          empty.textContent = "Select a number to treat as a price.";
          list.appendChild(empty);
        }
        return;
      }
      const showPriceSug = activeCat === "All" && !q.trim() && !!priceInfo && (isPlausiblePrice || usingDefaults);
      if (suggested.length || showPriceSug) {
        list.appendChild(sectionHead("Suggestions"));
        if (showPriceSug) list.appendChild(makePriceRow());
        suggested.forEach((e) => list.appendChild(makeRow(e)));
        list.appendChild(sectionHead("All units"));
      }
      const suggestedIds = new Set(suggested.map((e) => e.id));
      const items = searchRegistry(q, activeCat).filter((e) => !suggestedIds.has(e.id));
      if (!items.length && !suggested.length && !showPriceSug) {
        const empty = document.createElement("div");
        empty.className = "mg-pk-empty";
        empty.textContent = "No matching units.";
        list.appendChild(empty);
        return;
      }
      items.forEach((e) => list.appendChild(makeRow(e)));
    };

    const renderChips = () => {
      chips.textContent = "";
      ["All", ...REG_CATEGORIES, "Price"].forEach((cat) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "mg-pk-chip" + (cat === activeCat ? " mg-pk-chip-on" : "");
        chip.setAttribute(UI_ATTR, "1");
        chip.textContent = cat;
        chip.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          activeCat = cat;
          renderChips();
          renderList();
        });
        chips.appendChild(chip);
      });
    };

    search.addEventListener("input", renderList);
    search.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const first = list.querySelector(".mg-pk-row");
        if (first) first.click();
      }
    });

    renderChips();
    renderList();
    document.body.appendChild(overlay);
    picker = overlay;
    setTimeout(() => search.focus(), 0);
  }

  function handleSelection() {
    if (nativeMenus) return; // desktop uses the native right-click menu
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideToolbar(); return; }
    const txt = sel.toString().trim();
    if (txt.length < 1 || txt.length > 120 || !/\d/.test(txt)) { hideToolbar(); return; }
    const anchor = sel.anchorNode;
    if (anchor && isSkippable(anchor)) { hideToolbar(); return; }
    const range = sel.getRangeAt(0);
    showToolbar(txt, range);
  }

  document.addEventListener("mouseup", () => setTimeout(handleSelection, 0));
  document.addEventListener("touchend", () => setTimeout(handleSelection, 0));

  // ---------------------------------------------------------------
  // Pick mode: mark an imperial unit the detector missed, including in
  // text that cannot be selected (user-select:none, odd layouts, mobile).
  //
  // Click/tap an element; we run the detector over it and offer the unit
  // phrases we find as chips. Tap a chip to convert it. If we find nothing
  // (a genuine miss), fall back to tapping the words yourself. Either way
  // we build a Range and hand it to the SAME conversion paths the selection
  // flow uses (applyConvertAs / forcePriceFromSelection / openPicker), so
  // there is no new conversion or logging logic here.
  //
  // Entirely dormant until invoked from the toolbar menu or the right-click
  // menu: enter attaches listeners, exit removes them, leaving no cost.
  // ---------------------------------------------------------------
  let pickOn = false;
  let pickStage = 0;     // 1 = choosing an element, 2 = choosing the phrase
  let pickBox = null;    // hover / selection highlight outline (position:fixed)
  let pickBar = null;    // instruction + chips bar
  let pickCursor = null; // injected crosshair-cursor style, stage 1 only
  let pickText = "";     // last picked element's collected text
  let pickSegs = [];     // text-node segments for that text (offset -> DOM)

  function pickEl(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.setAttribute(UI_ATTR, "1");
    return el;
  }
  function setCrosshair(on) {
    if (on) {
      if (pickCursor) return;
      pickCursor = pickEl("style");
      pickCursor.textContent = "*{cursor:crosshair !important;}";
      (document.head || document.documentElement).appendChild(pickCursor);
    } else if (pickCursor) { pickCursor.remove(); pickCursor = null; }
  }

  function enterPickMode() {
    if (pickOn) return;
    closePicker(); hideToolbar(); hidePanel();
    pickOn = true;
    pickStage = 1;
    pickBox = pickEl("div", "mg-pick-box");
    pickBox.style.display = "none";
    document.body.appendChild(pickBox);
    setCrosshair(true);
    renderPickStage1();
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("click", onPickClick, true);
    document.addEventListener("keydown", onPickKey, true);
    document.addEventListener("scroll", hideBox, true);
  }
  function exitPickMode() {
    if (!pickOn) return;
    pickOn = false;
    pickStage = 0;
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onPickKey, true);
    document.removeEventListener("scroll", hideBox, true);
    setCrosshair(false);
    if (pickBox) { pickBox.remove(); pickBox = null; }
    if (pickBar) { pickBar.remove(); pickBar = null; }
    pickText = ""; pickSegs = [];
  }

  function onPickKey(e) { if (e.key === "Escape") { e.preventDefault(); exitPickMode(); } }
  function onPickMove(e) {
    if (!pickOn || pickStage !== 1) return;
    const t = pickTargetAt(e.clientX, e.clientY);
    if (t) positionBox(t.getBoundingClientRect()); else hideBox();
  }
  function onPickClick(e) {
    if (!pickOn) return;
    // Let clicks on our own bar/buttons behave normally.
    if (e.target && e.target.closest && e.target.closest("[" + UI_ATTR + "]")) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    if (pickStage !== 1) return; // stage 2 is driven by the bar
    const t = pickTargetAt(e.clientX, e.clientY);
    if (t) pickElement(t);
  }

  // The element a point resolves to, climbed to its nearest block ancestor so
  // pointing at a tiny inline (e.g. a bare "12") still captures the whole
  // phrase ("12 lb") around it. Ignores our own UI.
  function pickTargetAt(x, y) {
    const raw = document.elementFromPoint(x, y);
    if (!raw) return null;
    if (raw.closest && raw.closest("[" + UI_ATTR + "]")) return null;
    return blockAncestor(raw);
  }
  function positionBox(rect) {
    if (!pickBox || !rect) return;
    pickBox.style.display = "block";
    pickBox.style.top = rect.top + "px";
    pickBox.style.left = rect.left + "px";
    pickBox.style.width = rect.width + "px";
    pickBox.style.height = rect.height + "px";
  }
  function hideBox() { if (pickBox) pickBox.style.display = "none"; }

  // ---- bar rendering -------------------------------------------------------
  function pickBarEl() {
    if (!pickBar) { pickBar = pickEl("div", "mg-pick-bar"); document.body.appendChild(pickBar); }
    while (pickBar.firstChild) pickBar.removeChild(pickBar.firstChild);
    return pickBar;
  }
  function pickMsg(text) { const d = pickEl("div", "mg-pick-msg"); d.textContent = text; return d; }
  function pickNote(text) { const d = pickEl("div", "mg-pick-note"); d.textContent = text; return d; }
  function pickBtn(label, onClick, extra) {
    const b = pickEl("button", "mg-pick-btn" + (extra ? " " + extra : ""));
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", (e) => { e.preventDefault(); onClick(b); });
    return b;
  }
  function pickCancelBtn() { return pickBtn("Cancel", exitPickMode, "mg-pick-cancel"); }
  function pickRestartBtn() {
    return pickBtn("Pick another spot", () => {
      pickStage = 1; hideBox(); setCrosshair(true); renderPickStage1();
    });
  }

  function renderPickStage1() {
    const bar = pickBarEl();
    bar.appendChild(pickMsg("Click text that has an imperial unit Metric Glance missed."));
    bar.appendChild(pickNote("Works on text you cannot select. Esc to cancel."));
    const row = pickEl("div", "mg-pick-actions");
    row.appendChild(pickCancelBtn());
    bar.appendChild(row);
  }
  function flashPickMsg(text) {
    if (!pickBar) return;
    const m = pickBar.querySelector(".mg-pick-msg");
    if (!m) return;
    const prev = m.textContent;
    m.textContent = text;
    setTimeout(() => {
      if (pickStage === 1 && pickBar) {
        const m2 = pickBar.querySelector(".mg-pick-msg");
        if (m2) m2.textContent = prev;
      }
    }, 1500);
  }

  // ---- text collection + offset -> Range mapping ---------------------------
  function collectPickText(root) {
    const segs = [];
    let text = "";
    let w;
    try {
      w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
          if (isSkippable(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
    } catch (e) { return { text: "", segs }; }
    let n;
    while ((n = w.nextNode())) {
      segs.push({ node: n, start: text.length, len: n.nodeValue.length });
      text += n.nodeValue;
    }
    return { text, segs };
  }
  function locateOffset(segs, pos) {
    let idx = 0;
    for (let i = 0; i < segs.length; i++) { if (segs[i].start <= pos) idx = i; else break; }
    const seg = segs[idx];
    let off = pos - seg.start;
    if (off < 0) off = 0;
    if (off > seg.len) off = seg.len;
    return { node: seg.node, offset: off };
  }
  function rangeFromOffsets(segs, start, end) {
    if (!segs.length || end <= start) return null;
    const a = locateOffset(segs, start);
    const b = locateOffset(segs, end);
    try {
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r.collapsed ? null : r;
    } catch (e) { return null; }
  }
  // Drop candidates fully contained inside a longer one (e.g. the inner 10"
  // of a 5'10" height), keeping the widest reading of each span.
  function dedupeOverlap(list) {
    const sorted = list.slice().sort((a, b) => a.c.start - b.c.start || (b.c.end - b.c.start) - (a.c.end - a.c.start));
    const kept = [];
    for (const x of sorted) {
      if (kept.some((k) => x.c.start >= k.c.start && x.c.end <= k.c.end)) continue;
      kept.push(x);
    }
    return kept;
  }

  // ---- stage 2 -------------------------------------------------------------
  function pickElement(target) {
    const collected = collectPickText(target);
    pickText = collected.text;
    pickSegs = collected.segs;
    if (!pickText || !/\S/.test(pickText)) {
      flashPickMsg("No text there. Try clicking the words themselves.");
      return;
    }
    const cands = dedupeOverlap(
      proposeSpans(pickText)
        .map((c) => ({ c, range: rangeFromOffsets(pickSegs, c.start, c.end) }))
        .filter((x) => x.range)
    );
    pickStage = 2;
    hideBox();
    setCrosshair(false);
    if (cands.length) renderCandidates(cands);
    else renderWordPick();
  }

  function renderCandidates(cands) {
    const bar = pickBarEl();
    bar.appendChild(pickMsg(cands.length === 1
      ? "Found a unit here. Tap it to convert:"
      : "Found these. Tap the one to convert:"));
    const chips = pickEl("div", "mg-pick-chips");
    const MAX = 12;
    cands.slice(0, MAX).forEach((x) => {
      const chip = pickEl("button", "mg-pick-chip");
      chip.type = "button";
      chip.textContent = (x.c.full || "").trim() || x.range.toString().trim();
      chip.addEventListener("mouseenter", () => { try { positionBox(x.range.getBoundingClientRect()); } catch (e) {} });
      chip.addEventListener("mouseleave", hideBox);
      chip.addEventListener("click", (e) => { e.preventDefault(); chooseCandidate(x); });
      chips.appendChild(chip);
    });
    bar.appendChild(chips);
    if (cands.length > MAX) bar.appendChild(pickNote("Showing the first " + MAX + ". Click a smaller area to narrow it down."));
    const row = pickEl("div", "mg-pick-actions");
    row.appendChild(pickBtn("None of these — pick words", renderWordPick));
    row.appendChild(pickRestartBtn());
    row.appendChild(pickCancelBtn());
    bar.appendChild(row);
  }

  function chooseCandidate(x) {
    const range = x.range;
    const kind = x.c.kind;
    exitPickMode();
    if (kind === "price") { forcePriceFromSelection(range); return; }
    const v = variantFor(x.c);
    if (v && !v.money && typeof v.toMetric === "function" && v.id) applyConvertAs(range, v.id);
    else openPicker(range);
  }

  // Fallback: tokenize the picked element into tappable words. Select the words
  // of the measurement, then Convert opens the unit picker over that phrase.
  // Fully general (any registry unit, any spelling).
  //
  // Selection model: on desktop a plain click selects one word, Ctrl/Cmd-click
  // toggles a word in/out (so non-adjacent words can be picked), and Shift-click
  // selects the range from the last click. On mobile (no modifier keys) every
  // tap is an independent toggle. On Convert we build one Range spanning the
  // first to the last selected word and seed the picker with the chosen words.
  function renderWordPick() {
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(pickText)) !== null) {
      tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
      if (tokens.length >= 80) break;
    }
    const bar = pickBarEl();
    const isMobile = !nativeMenus;
    bar.appendChild(pickMsg(isMobile
      ? "Tap each word of the measurement, then Convert."
      : "Click the words. Ctrl-click to add, Shift-click for a range. Then Convert."));
    if (!tokens.length) {
      bar.appendChild(pickNote("No words found here."));
      const r0 = pickEl("div", "mg-pick-actions");
      r0.appendChild(pickRestartBtn());
      r0.appendChild(pickCancelBtn());
      bar.appendChild(r0);
      return;
    }
    const wrap = pickEl("div", "mg-pick-words");
    const chipEls = [];
    const sel = new Set();
    let anchor = -1; // last single/toggle click, the pivot for Shift-click
    let convertBtn;
    const selRange = () => {
      const idx = [...sel].sort((a, b) => a - b);
      if (!idx.length) return null;
      return rangeFromOffsets(pickSegs, tokens[idx[0]].start, tokens[idx[idx.length - 1]].end);
    };
    const refresh = () => {
      for (let i = 0; i < chipEls.length; i++) chipEls[i].classList.toggle("mg-pick-word-on", sel.has(i));
      if (convertBtn) convertBtn.disabled = sel.size === 0;
      const r = sel.size ? selRange() : null;
      if (r) { try { positionBox(r.getBoundingClientRect()); } catch (e) { hideBox(); } } else hideBox();
    };
    tokens.forEach((tk, i) => {
      const c = pickEl("button", "mg-pick-word");
      c.type = "button";
      c.textContent = tk.word;
      c.addEventListener("click", (e) => {
        e.preventDefault();
        if (e.shiftKey && anchor >= 0 && !isMobile) {
          const a = Math.min(anchor, i), b = Math.max(anchor, i);
          sel.clear();
          for (let k = a; k <= b; k++) sel.add(k);
        } else if (e.ctrlKey || e.metaKey || isMobile) {
          if (sel.has(i)) sel.delete(i); else sel.add(i);
          anchor = i;
        } else {
          sel.clear(); sel.add(i); anchor = i;
        }
        refresh();
      });
      chipEls.push(c);
      wrap.appendChild(c);
    });
    bar.appendChild(wrap);
    const row = pickEl("div", "mg-pick-actions");
    convertBtn = pickBtn("Convert…", () => {
      if (!sel.size) return;
      const idx = [...sel].sort((a, b) => a - b);
      const r = selRange();
      const seedText = idx.map((k) => tokens[k].word).join(" ");
      exitPickMode();
      if (r) openPicker({ range: r, seedText: seedText, context: pickText });
    }, "mg-pick-primary");
    convertBtn.disabled = true;
    row.appendChild(convertBtn);
    row.appendChild(pickRestartBtn());
    row.appendChild(pickCancelBtn());
    bar.appendChild(row);
    refresh();
  }

  // ---------------------------------------------------------------
  // Optional encoder loader (documented contract; inert until provided)
  // ---------------------------------------------------------------
  async function loadEncoder() {
    if (!settings.useEncoder || !settings.encoderModelUrl) return;
    // Intentionally not bundled. To enable: ship a transformers.js token
    // classifier and implement encoder = { classify(text) -> [{start,end}] }.
    // Left as a no-op so the extension runs on regex everywhere today.
    encoder = null;
  }

  // ---------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------
  let observer = null;       // page MutationObserver, or null when disabled here
  let started = false;       // whether the feature is active on this page
  let observerPaused = false; // true while suspended (e.g. tab in background)

  // A host is disabled when its (normalized) hostname is on the user's list.
  function normHost(h) {
    return String(h || "").trim().toLowerCase().replace(/\.$/, "");
  }
  function hostDisabled() {
    const here = normHost(location.hostname);
    if (!here) return false;
    return (settings.disabledHosts || []).some((h) => normHost(h) === here);
  }
  // Live teardown: undo every conversion this page currently shows.
  function revertAll() {
    teardownIO();
    document.querySelectorAll("." + MARK_CLASS).forEach((s) => revertSpan(s));
    unwireHover();
  }

  // Undo word substitutions: a single term when id is given, otherwise all.
  function revertWords(id) {
    let sel = "." + MARK_CLASS + "[data-kind='word']";
    if (id) sel += "[data-word='" + id + "']";
    document.querySelectorAll(sel).forEach((s) => revertSpan(s));
  }

  function startObserver() {
    let pending = null;
    const queue = new Set();
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) for (const node of m.addedNodes) queue.add(node);
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        const nodes = Array.from(queue);
        queue.clear();
        for (const node of nodes) {
          if (!node.isConnected || isSkippable(node)) continue;
          collectAndObserve(node);
        }
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // ---------------------------------------------------------------
  // Viewport-gated conversion
  //
  // The expensive work (regex over text, range extraction, span creation,
  // retained originals) is deferred until content is actually near the
  // viewport. A lightweight structural pass finds "run-owning" blocks (the
  // innermost blocks that directly contain a number) and hands them to an
  // IntersectionObserver; each is converted on first approach, then unobserved.
  // On a long page, blocks never scrolled to are never converted at all.
  //
  // Falls back to an eager full scan where IntersectionObserver is missing.
  // ---------------------------------------------------------------
  const HAS_IO = typeof IntersectionObserver !== "undefined";
  let io = null;

  function ensureIO() {
    if (!io) io = new IntersectionObserver(onIntersect, { rootMargin: "200px 0px" });
    return io;
  }
  function teardownIO() {
    if (io) { io.disconnect(); io = null; }
  }
  function onIntersect(entries) {
    if (!started || hostDisabled()) return;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      if (io) io.unobserve(el);
      if (el.isConnected && !isSkippable(el)) scanShallow(el);
    }
  }

  // A block "owns a run" when it directly holds a number (or, when word
  // substitutions are on, a substitutable word), in a direct text node or an
  // inline child. Blocks with neither are never observed or scanned.
  function wantsScan(s) {
    return /\d/.test(s) || (anyWordSubOn() && WORD_TEST_RE.test(s));
  }
  function ownsRun(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue && wantsScan(node.nodeValue)) return true;
      } else if (node.nodeType === Node.ELEMENT_NODE &&
                 (node.tagName === "BR" || isInlineEl(node))) {
        if (!isSkippable(node) && wantsScan(node.textContent || "")) return true;
      }
    }
    return false;
  }
  function observeBlock(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || !ownsRun(el)) return;
    ensureIO().observe(el); // observing an already-observed target is a no-op
  }
  // Observe every run-owning block under el, recursing into child blocks so a
  // big container is never observed (and thus never scanned) as a single unit.
  function walkBlocks(el) {
    observeBlock(el);
    for (const child of el.children) {
      if (child.nodeType === Node.ELEMENT_NODE && !isInlineEl(child) && !isSkippable(child)) {
        walkBlocks(child);
      }
    }
  }
  // Like collectRuns, but does NOT recurse into child blocks (each is observed
  // and scanned on its own), so a block is converted only when it comes in view.
  function scanRunsShallow(block) {
    let run = [];
    const flush = () => { if (run.length) { processRun(run); run = []; } };
    const children = Array.prototype.slice.call(block.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) run.push(child);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (isSkippable(child)) flush();
        else if (child.tagName === "BR" || isInlineEl(child)) run.push(child);
        else flush(); // child block: handled by its own observation
      }
    }
    flush();
  }
  function scanShallow(block) {
    scanRunsShallow(block);
    scanSplitPrices(block);
  }
  // Entry point in place of scan(): observe run-owning blocks under root (or,
  // without IntersectionObserver, fall back to an eager full scan).
  function collectAndObserve(root) {
    if (!root) return;
    if (!HAS_IO) { scan(root); return; }
    if (root.nodeType === Node.TEXT_NODE) { observeBlock(blockAncestor(root)); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || isSkippable(root)) return;
    if (isInlineEl(root)) { observeBlock(blockAncestor(root)); return; }
    walkBlocks(root);
  }

  // Run work when the main thread is idle, so the initial scan never competes
  // with page load. Falls back to a timeout where requestIdleCallback is absent.
  function deferIdle(fn) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2000 });
    else setTimeout(fn, 0);
  }

  // Begin or resume scanning + observing. The body scan is deferred to idle and
  // is idempotent (already-converted spans are skipped), so calling this on
  // resume also catches content added while the tab was in the background.
  function activate() {
    if (!started || hostDisabled()) return;
    observerPaused = false;
    if (!observer) startObserver();
    deferIdle(() => { if (started && !hostDisabled() && !observerPaused) collectAndObserve(document.body); });
  }
  // Stop observing while the tab is hidden; existing conversions stay in place.
  function suspend() {
    stopObserver();
    teardownIO();
    observerPaused = true;
  }
  // A hidden tab does no mutation work; resume (and catch up) when it returns.
  document.addEventListener("visibilitychange", () => {
    if (!started || hostDisabled()) return;
    if (document.hidden) suspend();
    else if (observerPaused) activate();
  });

  function start() {
    if (hostDisabled() || started) return;
    started = true;
    loadEncoder();
    if (document.hidden) observerPaused = true; // wait until first foregrounded
    else activate();
  }

  // Accept only the per-host shape; older flat rule shapes (if any) are dropped.
  function adoptRules(obj) {
    rules = obj && obj.hosts && typeof obj.hosts === "object" ? { hosts: obj.hosts } : { hosts: {} };
  }

  if (storage) {
    Promise.all([
      storage.get(DEFAULT_SETTINGS),
      storage.get({ mgRules: DEFAULT_RULES }),
    ]).then(
      ([s, r]) => {
        settings = { ...DEFAULT_SETTINGS, ...s };
        adoptRules(r.mgRules);
        start();
      },
      () => start()
    );

    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let touched = false;
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) { settings[key] = changes[key].newValue; touched = true; }
      }
      // React live when this site is toggled on/off the disabled list.
      if (changes.disabledHosts) {
        if (hostDisabled()) { stopObserver(); started = false; revertAll(); }
        else { start(); }
      }
      if (changes.mgRules) { adoptRules(changes.mgRules.newValue); touched = true; }
      // A word term turned off has its existing swaps removed live; rescan
      // (below) re-adds any term turned back on.
      if (changes.wordSubs) {
        WORD_SUBS.forEach((w) => { if (!wordSubOn(w.id)) revertWords(w.id); });
      }
      if (touched) rescan();
    });
  } else {
    start();
  }
})();
