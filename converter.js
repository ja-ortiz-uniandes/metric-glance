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
    priceRoundCents: 50,
    // When on, log a small random sample of the conversions the detector got
    // right (not just corrections), so the eventual training set is balanced.
    logSamples: false,
    // Number formatting
    maxOrderOfMagnitude: 6, // max integer digits before switching to a bigger unit
    decimalPlaces: 2,       // max decimals shown
    thousandsSeparator: ",",
    // Which metric tiers to display (global), and optional per-type overrides.
    displayTiers: ["milli", "centi", "base", "kilo", "mega", "giga"],
    displayScales: {}, // { Length: ["cm","m"], ... } overrides tiers for that type
    hoverScales: {},   // { Length: ["mm","m"], ... } extra units shown in the hover panel
    useEncoder: false, // becomes meaningful once a model is provided
    encoderModelUrl: "",
  };
  const SAMPLE_RATE = 0.12; // fraction of correct detections logged when logSamples is on
  const DEFAULT_RULES = {
    blockUnits: [],
    blockPrices: [],
    interpretations: {}, // norm(surface) -> variant id, e.g. "14 pounds" -> "gbp"
  };

  let settings = { ...DEFAULT_SETTINGS };
  let rules = { ...DEFAULT_RULES };
  const ruleSets = {
    blockUnits: new Set(),
    blockPrices: new Set(),
  };

  function rebuildRuleSets() {
    for (const k of Object.keys(ruleSets)) {
      ruleSets[k] = new Set((rules[k] || []).map(norm));
    }
  }

  function norm(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function persistRules() {
    if (storage) storage.set({ mgRules: rules });
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

  function flushLog() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!storage || !pendingLog.length) return;
    const batch = pendingLog;
    pendingLog = [];
    writeChain = writeChain
      .then(() => storage.get({ mgTraining: [] }))
      .then((res) => {
        const list = res.mgTraining || [];
        for (const r of batch) list.push(r);
        if (list.length > 5000) list.splice(0, list.length - 5000);
        return storage.set({ mgTraining: list });
      })
      .catch(() => {});
  }

  function logTrainingExample(label, span, context) {
    if (!storage) return;
    const ctx = (context || "").replace(/\s+/g, " ").trim();
    let windowText = ctx.slice(0, 200);
    let start = -1;
    let end = -1;
    const idx = ctx.indexOf(span);
    if (idx >= 0) {
      const from = Math.max(0, idx - 80);
      const to = Math.min(ctx.length, idx + span.length + 80);
      windowText = ctx.slice(from, to);
      start = idx - from;
      end = start + span.length;
    }
    pendingLog.push({
      label,
      span,
      context: windowText,
      span_start: start,
      span_end: end,
      url: typeof location !== "undefined" ? location.hostname : "",
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
    { name: "feet", pattern: "(?:feet|foot|ft\\.?|′)", variants: [
      { id: "ft", label: "Length (feet → m)", toMetric: (v) => v * 0.3048, fmt: (v) => formatLengthM(v), rate: "1 foot = 0.3048 m" },
    ] },
    { name: "inches", pattern: "(?:inches|inch|in\\.|″)", variants: [
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
      { id: "usgal", label: "US gallon (→ L)", toMetric: (v) => v * 3.785412, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 US gal = 3.785 L", surfaces: /^(?!.*imp)/i },
      { id: "impgal", label: "Imperial gallon (→ L)", toMetric: (v) => v * 4.54609, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 imp gal = 4.546 L", surfaces: /^(?!.*u\.?s)/i },
    ] },
    { name: "quarts", pattern: "(?:(?:imp(?:erial)?|u\\.?\\s?s\\.?|us)\\s+)?(?:quarts?|qts?\\.?)", variants: [
      { id: "usqt", label: "US quart (→ L)", toMetric: (v) => v * 0.946353, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 US qt = 0.946 L", surfaces: /^(?!.*imp)/i },
      { id: "impqt", label: "Imperial quart (→ L)", toMetric: (v) => v * 1.136523, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 imp qt = 1.137 L", surfaces: /^(?!.*u\.?s)/i },
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
  const UNIT_RE = new RegExp(NUM + "\\s*(" + UNIT_ALT + ")(?![\\w°])", "gi");
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
    { re: /^(?:in|inch|inches|in\.|″)$/i, name: "inches" },
    { re: /^(?:ft|feet|foot|ft\.|′)$/i, name: "feet" },
    { re: /^(?:yd|yds?|yards?|yd\.)$/i, name: "yards" },
  ];
  function findDimUnit(unitText) {
    const x = (unitText || "").trim();
    for (const d of DIM_UNITS) if (d.re.test(x)) return UNITS.find((u) => u.name === d.name);
    return findUnit(unitText);
  }

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
    { id: "usqt", cat: "Volume", name: "US quart", rank: 2, aliases: ["quart", "quarts", "us quart", "qt"], toMetric: (v) => v * 0.946353, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 US qt = 0.946 L" },
    { id: "usgal", cat: "Volume", name: "US gallon", rank: 1, aliases: ["gallon", "gallons", "us gallon", "gal"], toMetric: (v) => v * 3.785412, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 US gal = 3.785 L" },
    { id: "imppt", cat: "Volume", name: "Imperial pint", rank: 3, aliases: ["imperial pint", "uk pint"], toMetric: (v) => v * 568.261, fmt: (v) => formatVolumeMl(v), rate: "1 imp pint = 568 ml" },
    { id: "impqt", cat: "Volume", name: "Imperial quart", rank: 4, aliases: ["imperial quart", "uk quart"], toMetric: (v) => v * 1.136523, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 imp qt = 1.137 L" },
    { id: "impgal", cat: "Volume", name: "Imperial gallon", rank: 2, aliases: ["imperial gallon", "uk gallon"], toMetric: (v) => v * 4.54609, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 imp gal = 4.546 L" },
    { id: "usdrypt", cat: "Volume", name: "US dry pint", rank: 6, aliases: ["dry pint", "us dry pint"], toMetric: (v) => v * 550.610, fmt: (v) => formatVolumeMl(v), rate: "1 US dry pint = 551 ml" },
    { id: "usdryqt", cat: "Volume", name: "US dry quart", rank: 6, aliases: ["dry quart", "us dry quart"], toMetric: (v) => v * 1.101221, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 US dry qt = 1.101 L" },
    { id: "cuin", cat: "Volume", name: "Cubic inch", rank: 2, aliases: ["cubic inch", "cu in", "in³"], toMetric: (v) => v * 16.387064, fmt: (v) => formatVolumeCm3(v), rate: "1 cu in = 16.39 cm³" },
    { id: "cuft", cat: "Volume", name: "Cubic foot", rank: 2, aliases: ["cubic foot", "cubic feet", "cu ft", "ft³"], toMetric: (v) => v * 0.0283168466, fmt: (v) => formatVolumeM3(v), rate: "1 cu ft = 0.0283 m³" },
    { id: "cuyd", cat: "Volume", name: "Cubic yard", rank: 4, aliases: ["cubic yard", "cu yd", "yd³"], toMetric: (v) => v * 0.764554858, fmt: (v) => formatVolumeM3(v), rate: "1 cu yd = 0.765 m³" },
    { id: "bushel", cat: "Volume", name: "US bushel", rank: 6, aliases: ["bushel", "bushels", "us bushel"], toMetric: (v) => v * 35.2391, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 US bushel = 35.24 L" },
    { id: "bushel_imp", cat: "Volume", name: "Imperial bushel", rank: 7, aliases: ["imperial bushel", "uk bushel"], toMetric: (v) => v * 36.36872, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 imp bushel = 36.37 L" },
    { id: "peck", cat: "Volume", name: "US peck", rank: 7, aliases: ["peck", "pecks"], toMetric: (v) => v * 8.80977, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 peck = 8.810 L" },
    { id: "gill", cat: "Volume", name: "US gill", rank: 7, aliases: ["gill", "gills"], toMetric: (v) => v * 118.294, fmt: (v) => formatVolumeMl(v), rate: "1 gill = 118.3 ml" },
    { id: "bbl_oil", cat: "Volume", name: "Oil barrel", rank: 5, aliases: ["barrel", "barrels", "bbl"], toMetric: (v) => v * 158.987, fmt: (v) => fmtScale("Volume", v*1000), rate: "1 barrel = 159.0 L" },

    // Area
    { id: "sqft", cat: "Area", name: "Square foot", rank: 1, aliases: ["square foot", "square feet", "sq ft", "ft²"], toMetric: (v) => v * 0.09290304, fmt: (v) => formatAreaM2(v), rate: "1 sq ft = 0.0929 m²" },
    { id: "sqin", cat: "Area", name: "Square inch", rank: 2, aliases: ["square inch", "sq in", "in²"], toMetric: (v) => v * 0.00064516, fmt: (v) => formatAreaM2(v), rate: "1 sq in = 6.452 cm²" },
    { id: "sqyd", cat: "Area", name: "Square yard", rank: 2, aliases: ["square yard", "sq yd", "yd²"], toMetric: (v) => v * 0.83612736, fmt: (v) => formatAreaM2(v), rate: "1 sq yd = 0.8361 m²" },
    { id: "sqmi", cat: "Area", name: "Square mile", rank: 2, aliases: ["square mile", "sq mi", "mi²"], toMetric: (v) => v * 2.589988, fmt: (v) => fmtScale("Area", v*1e6), rate: "1 sq mi = 2.59 km²" },
    { id: "ac", cat: "Area", name: "Acre", rank: 1, aliases: ["acre", "acres"], toMetric: (v) => v * 0.40468564, fmt: (v) => fmtScale("Area", v*1e4), rate: "1 acre = 0.4047 ha" },

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
  const REG_CATEGORIES = ["Length", "Mass", "Volume", "Area", "Temperature", "Speed", "Energy", "Power", "Pressure"];
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

  // --- Metric scale engine -------------------------------------------------
  // Each category has a canonical base unit and a ladder of metric scales
  // (size of each unit in base units). The renderer picks the enabled scale
  // that reads most simply: no leading "0.x", fewest decimals, then fewest
  // integer digits, capped at maxOrderOfMagnitude integer digits. So 0.62 m
  // shows as "62 cm", 551 ml stays "551 ml" (not "0.55 L").
  const SCALES = {
    Length:   [["mm", 1e-3], ["cm", 1e-2], ["m", 1], ["km", 1e3]],         // base m
    Mass:     [["mg", 1e-3], ["g", 1], ["kg", 1e3], ["t", 1e6]],           // base g
    Volume:   [["ml", 1], ["L", 1e3], ["m³", 1e6]],                        // base ml
    Area:     [["cm²", 1e-4], ["m²", 1], ["km²", 1e6]],                    // base m²
    Speed:    [["m/s", 1], ["km/h", 1 / 3.6]],                             // base m/s
    Energy:   [["J", 1], ["kJ", 1e3], ["MJ", 1e6], ["GJ", 1e9]],           // base J
    Power:    [["W", 1], ["kW", 1e3], ["MW", 1e6], ["GW", 1e9]],           // base W
    Pressure: [["Pa", 1], ["kPa", 1e3], ["MPa", 1e6], ["GPa", 1e9]],       // base Pa
  };
  // Generic SI tier each scale belongs to, so one global prefix choice can
  // apply across every measurement type (advanced UI can override per type).
  const TIER_OF = {
    Length:   { mm: "milli", cm: "centi", m: "base", km: "kilo" },
    Mass:     { mg: "milli", g: "base", kg: "kilo", t: "mega" },
    Volume:   { ml: "milli", L: "base", "m³": "kilo" },
    Area:     { "cm²": "centi", "m²": "base", "km²": "kilo" },
    Speed:    { "m/s": "base", "km/h": "kilo" },
    Energy:   { J: "base", kJ: "kilo", MJ: "mega", GJ: "giga" },
    Power:    { W: "base", kW: "kilo", MW: "mega", GW: "giga" },
    Pressure: { Pa: "base", kPa: "kilo", MPa: "mega", GPa: "giga" },
  };
  function clampInt(x, lo, hi, dflt) {
    x = parseInt(x, 10);
    if (!isFinite(x)) return dflt;
    return Math.max(lo, Math.min(hi, x));
  }
  function enabledScales(cat) {
    const all = SCALES[cat];
    const ov = settings.displayScales && settings.displayScales[cat];
    if (ov && ov.length) {
      const f = all.filter((u) => ov.indexOf(u[0]) >= 0);
      if (f.length) return f;
    }
    const tiers = settings.displayTiers;
    if (tiers && tiers.length) {
      const f = all.filter((u) => tiers.indexOf(TIER_OF[cat][u[0]]) >= 0);
      if (f.length) return f;
    }
    return all;
  }
  // Render a base value in one specific scale (for the hover "also in" list).
  function renderInScale(cat, base, sym) {
    const def = SCALES[cat];
    if (!def) return null;
    const u = def.find((x) => x[0] === sym);
    if (!u) return null;
    const maxDec = clampInt(settings.decimalPlaces, 0, 6, 2);
    const sep = settings.thousandsSeparator != null ? settings.thousandsSeparator : ",";
    return fmtNum(base / u[1], maxDec, sep) + "\u00A0" + sym;
  }
  // Derive (category, base-units-per-1-input-unit) for any unit entry purely
  // from its own fmt output, so we can show the value in other metric scales
  // without tagging every unit. Returns null for non-scale units (°C, money).
  function unitBaseInfo(entry) {
    if (!entry || typeof entry.toMetric !== "function" || typeof entry.fmt !== "function") return null;
    const saved = settings.decimalPlaces;
    settings.decimalPlaces = 6; // parse at high precision
    let s;
    try { s = entry.fmt(entry.toMetric(1)); } finally { settings.decimalPlaces = saved; }
    const m = /^(-?[\d.,]+)\u00A0?(.+)$/.exec(s || "");
    if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, ""));
    const sym = m[2].trim();
    for (const cat of Object.keys(SCALES)) {
      const u = SCALES[cat].find((x) => x[0] === sym);
      if (u) return { cat, base1: num * u[1] };
    }
    return null;
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
    const def = SCALES[cat];
    if (!def) return String(base);
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
  function formatVolumeMl(ml) { return fmtScale("Volume", ml); }
  function formatVolumeCm3(cm3) { return fmtScale("Volume", cm3); }
  function formatVolumeM3(m3) { return fmtScale("Volume", m3 * 1e6); }
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
    if (!m) return null;
    const value = parseFloat(m[2].replace(/,/g, "")) + (m[3] ? parseFloat("0." + m[3]) : 0);
    if (!isFinite(value)) return null;
    return { priceStr: m[0], value, symbol: m[1] };
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

    PRICE_RE.lastIndex = 0;
    let m;
    while ((m = PRICE_RE.exec(text)) !== null) {
      const [full, symbol, intPart, cents] = m;
      const value = parseFloat(intPart.replace(/,/g, "")) + (cents ? parseFloat("0." + cents) : 0);
      if (!isFinite(value)) continue;
      out.push({ start: m.index, end: m.index + full.length, full, kind: "price", value, symbol });
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

  // Pick the interpretation variant for a candidate: a stored interpretation
  // rule for this exact surface form (if still applicable), else the first
  // applicable variant.
  function variantFor(c) {
    const vs = applicableVariants(c);
    const id = rules.interpretations && rules.interpretations[norm(c.full)];
    if (id) {
      const v = vs.find((x) => x.id === id);
      if (v) return v;
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

  // Apply settings + user rules to the raw candidate list.
  function filterCandidates(text, candidates) {
    let list = candidates.filter((c) => {
      const key = norm(c.full);
      if (c.kind === "price") {
        if (ruleSets.blockPrices.has(key)) return false;
        c.forced = false;
        if (!settings.priceRounding && !c.forced) return false;
      } else {
        if (ruleSets.blockUnits.has(key)) return false;
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
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `${c.display}, originally ${c.full.trim()}, activate to review`);
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
      const v = tn.nodeValue || "";
      for (let i = 0; i < v.length; i++) { text += v[i]; map.push([tn, i]); }
    }
    if (text.length < 2 || !/\d/.test(text)) return;

    const chosen = filterCandidates(text, proposeSpans(text));
    if (!chosen.length) return;

    // Apply right-to-left so earlier matches' node offsets stay valid after
    // we extract later ones (Range.extractContents splits text nodes).
    chosen.sort((a, b) => b.start - a.start);
    for (const c of chosen) { replaceRange(map, c); maybeLogPositive(c, text); }
  }

  // Optionally record a correct detection as a (positive) training example,
  // labelled with the unit it resolved to, so the dataset isn't all corrections.
  function maybeLogPositive(c, contextText) {
    if (!settings.logSamples || Math.random() >= SAMPLE_RATE) return;
    let label;
    if (c.kind === "price") label = "auto:price";
    else if (c.dim) return; // skip dimension lists for now
    else {
      const v = variantFor(c);
      if (!v || v.money) return;
      label = "auto:" + v.id;
    }
    logTrainingExample(label, c.full, contextText);
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
    if (frag.querySelector && frag.querySelector("*")) span.classList.add("mg-rich");
    if (ctxStyle) originalStyle.set(span, ctxStyle);
    originalContent.set(span, frag);
    range.insertNode(span);

    // Extraction can leave empty inline shells (e.g. a now-textless <a>);
    // remove those adjacent to the new span so no stray link/styling lingers.
    cleanupEmptyInline(span.previousSibling, "prev");
    cleanupEmptyInline(span.nextSibling, "next");
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
    if (!text || text.length < 2 || !/\d/.test(text)) return;
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
        } else if (isInlineEl(child)) {
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

    const key = norm(priceStr);
    if (ruleSets.blockPrices.has(key)) return false;
    const forced = false;
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
    return true;
  }

  function rescan() {
    // Revert nothing; just process text that became convertible under new
    // rules. Newly-blocked spans are handled by revertSpan() at click time.
    scan(document.body);
  }

  // ---------------------------------------------------------------
  // Corrections
  // ---------------------------------------------------------------
  function addRule(listName, value) {
    const key = norm(value);
    if (!key) return;
    if (!rules[listName].map(norm).includes(key)) rules[listName].push(value.trim());
    rebuildRuleSets();
    persistRules();
  }

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
    logTrainingExample("interpretation:" + unitId, original, original);
    return true;
  }

  // User explicitly told us the unit of a selection (category > unit menu).
  function applyConvertAs(range, unitId) {
    if (!range || range.collapsed) return { ok: false, reason: "empty" };
    const v = REG_BY_ID[unitId] || VARIANT_BY_ID[unitId];
    if (!v || typeof v.toMetric !== "function") return { ok: false, reason: "bad_unit" };
    const selText = range.toString().replace(/\s+/g, " ").trim();
    const m = selText.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!m) return { ok: false, reason: "no_value" };
    const value = parseFloat(m[0].replace(/,/g, ""));
    if (!isFinite(value)) return { ok: false, reason: "no_value" };

    const disp = v.fmt(v.toMetric(value));
    const ca = range.commonAncestorContainer;
    const ctxStyle = snapshotStyle(ca && ca.nodeType === Node.ELEMENT_NODE ? ca : ca && ca.parentElement);
    if (ca && ca.nodeType === Node.ELEMENT_NODE) inlineDescendantStyles(ca);

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
    if (frag.querySelector && frag.querySelector("*")) span.classList.add("mg-rich");
    originalContent.set(span, frag);
    if (ctxStyle) originalStyle.set(span, ctxStyle);
    range.insertNode(span);

    logTrainingExample("convert-as:" + unitId, selText, selText);
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
    if (value === null || !isFinite(value)) return { ok: false, reason: "no_value" };

    const rounded = roundedPriceValue(value, force); // forced: always round up
    const intVal = rounded === null ? Math.round(value) : rounded;
    const disp = symbol.replace(/\s+$/, "") + intVal.toLocaleString("en-US");

    const frag = range.extractContents();
    const span = document.createElement("span");
    span.className = MARK_CLASS;
    span.textContent = disp;
    span.setAttribute("data-original", priceStr || selText);
    span.setAttribute("data-kind", "price");
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `${disp}, originally ${priceStr || selText}, activate to review`);
    if (frag.querySelector && frag.querySelector("*")) span.classList.add("mg-rich");
    originalContent.set(span, frag);
    range.insertNode(span);

    logTrainingExample("price", priceStr || selText, selText);
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
    logTrainingExample("price", original, original);
    return { ok: true };
  }

  // User marked an existing conversion as wrong.
  function markFalsePositive(span) {
    const original = span.getAttribute("data-original");
    const kind = span.getAttribute("data-kind");
    addRule(kind === "price" ? "blockPrices" : "blockUnits", original);
    rebuildRuleSets();
    persistRules();

    const parentText = span.parentElement ? span.parentElement.textContent : "";
    const ctx = parentText.replace(span.textContent, original);
    logTrainingExample("not_a_conversion", original, ctx);
    revertAllMatching(original);
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
  function revertAllMatching(original) {
    const key = norm(original);
    document.querySelectorAll("." + MARK_CLASS).forEach((s) => {
      if (norm(s.getAttribute("data-original")) === key) revertSpan(s);
    });
  }

  // User chose a different interpretation for an ambiguous quantity
  // (e.g. "14 pounds" is money, or stone, not lb). Stored per surface form.
  function setInterpretation(original, variantId, context) {
    if (!rules.interpretations) rules.interpretations = {};
    rules.interpretations[norm(original)] = variantId;
    // an interpretation overrides any block on the same surface
    rules.blockUnits = rules.blockUnits.filter((r) => norm(r) !== norm(original));
    rebuildRuleSets();
    persistRules();
    logTrainingExample("interpretation:" + variantId, original, context || "");
    // revert existing spans for this surface, then rescan so they re-render
    revertAllMatching(original);
    rescan();
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

    if (kind === "price" && c && c.kind === "price") {
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
      if (bi && settings.hoverScales && settings.hoverScales[bi.cat] && spanValue != null) {
        const dispSym = (/\u00A0?([^\u00A0\d.,-]+)$/.exec(span.textContent) || [])[1];
        const extras = settings.hoverScales[bi.cat]
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
                onClick: () => { setInterpretation(original, variant.id, ctx); hidePanel(); },
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
                onClick: () => { setInterpretation(original, variant.id, ctx); hidePanel(); },
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

    // Keep open while pointer is over the panel (desktop bridge).
    el.addEventListener("mouseenter", cancelHide);
    el.addEventListener("mouseleave", scheduleHide);

    document.body.appendChild(el);
    const r = span.getBoundingClientRect();
    el.style.top = window.scrollY + r.bottom + 6 + "px";
    el.style.left = window.scrollX + Math.max(6, r.left) + "px";

    panel = el;
    panelSpan = span;
  }

  function togglePanelFor(span) {
    if (panelSpan === span && panel) hidePanel();
    else showPanelFor(span);
  }

  // Desktop: hover, with hide-intent delay and a relatedTarget guard so
  // moving within the word (or onto the panel) does not flicker it closed.
  if (FINE) {
    document.addEventListener("mouseover", (e) => {
      const span = e.target.closest && e.target.closest("." + MARK_CLASS);
      if (span) { cancelHide(); showPanelFor(span); }
    });
    document.addEventListener("mouseout", (e) => {
      const span = e.target.closest && e.target.closest("." + MARK_CLASS);
      if (!span) return;
      const to = e.relatedTarget;
      if (to && (span.contains(to) || (panel && panel.contains(to)))) return;
      scheduleHide();
    });
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
  function showToolbar(selText, rect, range) {
    hideToolbar();
    pendingRange = range ? range.cloneRange() : null;
    const el = document.createElement("div");
    el.className = "mg-toolbar";
    el.setAttribute(UI_ATTR, "1");
    document.body.appendChild(el);
    toolbar = el;

    const place = () => {
      el.style.top = window.scrollY + Math.max(6, rect.top - el.offsetHeight - 8) + "px";
      el.style.left = window.scrollX + rect.left + "px";
    };

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
    place();
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

  function openPickerForSpan(span) {
    hidePanel();
    openPicker({
      seedText: span.getAttribute("data-original") || "",
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
    head.appendChild(title);
    head.appendChild(kbd);
    // Refresh from the background so it reflects any remapping, even live.
    refreshShortcut((sc) => { if (picker === overlay) applyKbd(sc); });
    const sub = document.createElement("div");
    sub.className = "mg-pk-sub";
    sub.textContent = selText ? `Selection: ${selText}` : "Select some text first";
    box.appendChild(head);
    box.appendChild(sub);

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
      // Treat-as-price option (when the selection looks like a price).
      if (priceInfo && !q.trim()) {
        list.appendChild(sectionHead("Price"));
        list.appendChild(makePriceRow());
      }
      // Suggestions: only in the default All view with no active search.
      let suggested = [];
      if (activeCat === "All" && !q.trim()) suggested = suggestionsFor(hint);
      if (suggested.length) {
        list.appendChild(sectionHead("Suggestions"));
        suggested.forEach((e) => list.appendChild(makeRow(e)));
        list.appendChild(sectionHead("All units"));
      } else if (priceInfo && !q.trim()) {
        list.appendChild(sectionHead("All units"));
      }
      const suggestedIds = new Set(suggested.map((e) => e.id));
      const items = searchRegistry(q, activeCat).filter((e) => !suggestedIds.has(e.id));
      if (!items.length && !suggested.length) {
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
      ["All", ...REG_CATEGORIES].forEach((cat) => {
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
    if (!range.getBoundingClientRect) { hideToolbar(); return; }
    const rect = range.getBoundingClientRect();
    showToolbar(txt, rect, range);
  }

  document.addEventListener("mouseup", () => setTimeout(handleSelection, 0));
  document.addEventListener("touchend", () => setTimeout(handleSelection, 0));

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
  function startObserver() {
    let pending = null;
    const queue = new Set();
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) for (const node of m.addedNodes) queue.add(node);
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        const nodes = Array.from(queue);
        queue.clear();
        for (const node of nodes) {
          if (!node.isConnected) continue;
          if (node.nodeType === Node.ELEMENT_NODE && !isSkippable(node)) scan(node);
          else if (node.nodeType === Node.TEXT_NODE && !isSkippable(node)) processTextNode(node);
        }
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    rebuildRuleSets();
    scan(document.body);
    startObserver();
    loadEncoder();
  }

  if (storage) {
    Promise.all([
      storage.get(DEFAULT_SETTINGS),
      storage.get({ mgRules: DEFAULT_RULES }),
    ]).then(
      ([s, r]) => {
        settings = { ...DEFAULT_SETTINGS, ...s };
        rules = { ...DEFAULT_RULES, ...(r.mgRules || {}) };
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
      if (changes.mgRules) { rules = { ...DEFAULT_RULES, ...changes.mgRules.newValue }; rebuildRuleSets(); touched = true; }
      if (touched) rescan();
    });
  } else {
    start();
  }
})();
