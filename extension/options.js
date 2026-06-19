/* Metric Glance options */
(function () {
  "use strict";

  const DEFAULTS = {
    priceRounding: true,
    priceRoundCents: 60,
    logSamples: false,
    maxOrderOfMagnitude: 6,
    decimalPlaces: 2,
    thousandsSeparator: ",",
    displayTiers: [-3, -2, 0, 3, 6, 9],
    hoverTiers: [-3, -2, 0, 3, 6, 9],
    displayTiersByCat: { Volume: [-3, 0, 3], Mass: [-3, 0, 3, 6], Energy: [0, 3, 6, 9], Power: [0, 3, 6, 9], Pressure: [0, 3, 6, 9], Speed: [0], Density: [3] },
    hoverTiersByCat: { Volume: [-3, 0, 3], Mass: [-3, 0, 3, 6], Energy: [0, 3, 6, 9], Power: [0, 3, 6, 9], Pressure: [0, 3, 6, 9], Speed: [0], Density: [3] },
    displayScales: {},
    hoverScales: {},
    catBase: { Speed: "km/h" },
  };

  const CATS = {
    Length: ["mm", "cm", "m", "km"], Mass: ["mg", "g", "kg", "Mg"],
    Volume: ["mL", "L", "kL"], Area: ["cm\u00B2", "m\u00B2", "km\u00B2"],
    Speed: ["m/s", "km/h"], Energy: ["J", "kJ", "MJ", "GJ"],
    Power: ["W", "kW", "MW", "GW"], Pressure: ["Pa", "kPa", "MPa", "GPa"],
    Density: ["kg/m\u00B3", "g/cm\u00B3"],
  };
  const PREFIXES = [
    ["quetta", "Q", 30], ["ronna", "R", 27], ["yotta", "Y", 24], ["zetta", "Z", 21],
    ["exa", "E", 18], ["peta", "P", 15], ["tera", "T", 12], ["giga", "G", 9],
    ["mega", "M", 6], ["kilo", "k", 3], ["hecto", "h", 2], ["deca", "da", 1],
    ["(base)", "\u2014", 0], ["deci", "d", -1], ["centi", "c", -2], ["milli", "m", -3],
    ["micro", "\u03BC", -6], ["nano", "n", -9], ["pico", "p", -12], ["femto", "f", -15],
    ["atto", "a", -18], ["zepto", "z", -21], ["yocto", "y", -24], ["ronto", "r", -27],
    ["quecto", "q", -30],
  ];
  let tierState = [], hoverTierState = [], dispState = {}, hoverState = {}, baseState = {};
  let dispTierByCat = {}, hoverTierByCat = {};
  const CAT_BASES = {
    Length: ["m"], Mass: ["g"], Volume: ["L", "m\u00B3"], Area: ["m\u00B2"],
    Energy: ["J", "Wh", "cal", "kg\u00B7m\u00B2/s\u00B2"], Power: ["W", "J/s"],
    Pressure: ["Pa", "bar", "N/m\u00B2"], Speed: ["m/s", "km/h"], Density: ["g/m\u00B3", "g/cm\u00B3"],
  };
  const SPECIAL_UNITS = {};
  const BASE_LABEL = {
    m: "metre (m)", g: "gram (g)", L: "litre (L)", "m\u00B3": "cubic metre (m\u00B3)",
    "m\u00B2": "square metre (m\u00B2)", J: "joule (J)", "Wh": "watt-hour (Wh)",
    "cal": "calorie (cal)", "kg\u00B7m\u00B2/s\u00B2": "SI base (kg\u00B7m\u00B2/s\u00B2)",
    W: "watt (W)", "J/s": "joule/second (J/s)", Pa: "pascal (Pa)", "bar": "bar",
    "N/m\u00B2": "newton/m\u00B2 (N/m\u00B2)", "m/s": "metre/second (m/s)", "km/h": "km/hour (km/h)",
    "g/m\u00B3": "per cubic metre (g/m\u00B3)", "g/cm\u00B3": "per cubic cm (g/cm\u00B3)",
  };

  const api =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome);

  const $enabled = document.getElementById("enabled");
  const $cents = document.getElementById("cents");
  const $status = document.getElementById("status");
  const $example = document.getElementById("example");
  const $logsamples = document.getElementById("logsamples");
  const $oom = document.getElementById("oom");
  const $dec = document.getElementById("dec");
  const $sep = document.getElementById("sep");
  const $tiers = document.getElementById("tiers");
  const $advbody = document.getElementById("advbody");

  function clampNum(x, lo, hi, dflt) {
    x = parseInt(x, 10);
    if (!isFinite(x)) return dflt;
    return Math.max(lo, Math.min(hi, x));
  }
  function clampCents(v) {
    let n = parseInt(v, 10);
    if (!isFinite(n)) n = DEFAULTS.priceRoundCents;
    return Math.min(99, Math.max(1, n));
  }

  function roundUp(value, threshold) {
    const whole = Math.floor(value);
    const fracCents = Math.round((value - whole) * 100);
    if (fracCents === 0) return null;
    const gapCents = 100 - fracCents;
    if (gapCents > threshold) return null;
    return whole + 1;
  }

  function renderExample() {
    if (!$enabled.checked) {
      $example.textContent = "Price rounding is off.";
      return;
    }
    const t = clampCents($cents.value);
    const samples = [1.99, 2.5, 2.01];
    const parts = samples.map((v) => {
      const r = roundUp(v, t);
      const shown = r === null ? "stays $" + v.toFixed(2) : "$" + r;
      return "$" + v.toFixed(2) + " \u2192 " + shown;
    });
    $example.textContent =
      "At " + t + "\u00A2: " + parts.join(" \u00A0\u00B7\u00A0 ");
  }

  function toggle(arr, v) {
    const a = arr ? arr.slice() : [];
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1); else a.push(v);
    return a;
  }
  function mkCheck(checked, disabled, onChange) {
    const td = document.createElement("td");
    td.style.textAlign = "center";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.disabled = !!disabled;
    if (!disabled) cb.addEventListener("change", onChange);
    td.appendChild(cb);
    return td;
  }
  function headerRow(cols) {
    const tr = document.createElement("tr");
    cols.forEach((c, i) => {
      const th = document.createElement("th");
      th.textContent = c;
      th.style.cssText = "text-align:" + (i < 2 ? "left" : "center") + ";font-size:11px;color:var(--mg-muted,#667);padding:2px 6px;font-weight:600";
      tr.appendChild(th);
    });
    return tr;
  }
  function supExp(e) {
    const map = { "-": "\u207B", "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3", "4": "\u2074", "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079" };
    return String(e).split("").map((c) => map[c] || c).join("");
  }
  function togCatExp(map, cat, exp) {
    const a = toggle(map[cat], exp);
    if (a.length) map[cat] = a; else delete map[cat];
  }
  // The one prefix table, reused for the global settings and each measurement.
  function prefixTable(dHas, dTog, hHas, hTog) {
    const tbl = document.createElement("table");
    tbl.style.cssText = "border-collapse:collapse;width:100%;font-size:12.5px;margin-top:4px";
    tbl.appendChild(headerRow(["Prefix", "Symbol", "10\u207F", "Display", "Hover"]));
    PREFIXES.forEach(([name, psym, exp]) => {
      const tr = document.createElement("tr");
      [name, psym, "10" + supExp(exp)].forEach((t) => {
        const td = document.createElement("td");
        td.textContent = t;
        td.style.cssText = "padding:2px 6px;white-space:nowrap";
        tr.appendChild(td);
      });
      tr.appendChild(mkCheck(dHas(exp), false, () => { dTog(exp); save(); }));
      tr.appendChild(mkCheck(hHas(exp), false, () => { hTog(exp); save(); }));
      tbl.appendChild(tr);
    });
    return tbl;
  }
  function buildTiers() {
    $tiers.textContent = "";
    $tiers.appendChild(prefixTable(
      (e) => tierState.indexOf(e) >= 0, (e) => { tierState = toggle(tierState, e); },
      (e) => hoverTierState.indexOf(e) >= 0, (e) => { hoverTierState = toggle(hoverTierState, e); }
    ));
  }
  // Per-measurement override: base-unit selector + the same prefix table.
  function buildAdv() {
    $advbody.textContent = "";
    Object.keys(CAT_BASES).forEach((cat) => {
      const base = baseState[cat] || CAT_BASES[cat][0];
      const det = document.createElement("details");
      det.style.cssText = "margin:4px 0;border-top:1px solid var(--mg-divider,#e3e5ea);padding-top:4px";
      const sum = document.createElement("summary");
      sum.textContent = cat;
      sum.style.cssText = "cursor:pointer;font-weight:600;font-size:12px";
      det.appendChild(sum);
      if (CAT_BASES[cat].length > 1) {
        const lbl = document.createElement("label");
        lbl.className = "hint";
        lbl.textContent = "Unit: ";
        const sel = document.createElement("select");
        CAT_BASES[cat].forEach((b) => {
          const o = document.createElement("option");
          o.value = b; o.textContent = BASE_LABEL[b] || b;
          if (b === base) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener("change", () => { baseState[cat] = sel.value; save(); });
        lbl.appendChild(sel);
        det.appendChild(lbl);
      } else {
        const ind = document.createElement("div");
        ind.className = "hint";
        ind.textContent = "Unit: " + (BASE_LABEL[base] || base);
        det.appendChild(ind);
      }
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.style.margin = "4px 0 0";
      hint.textContent = "Leave all unticked to follow the global table above.";
      det.appendChild(hint);
      det.appendChild(prefixTable(
        (e) => (dispTierByCat[cat] || []).indexOf(e) >= 0, (e) => togCatExp(dispTierByCat, cat, e),
        (e) => (hoverTierByCat[cat] || []).indexOf(e) >= 0, (e) => togCatExp(hoverTierByCat, cat, e)
      ));
      $advbody.appendChild(det);
    });
    // Speed / Density: not prefixable, so just a unit dropdown (the other unit
    // is offered on hover).
    Object.keys(SPECIAL_UNITS).forEach((cat) => {
      const det = document.createElement("details");
      det.style.cssText = "margin:4px 0;border-top:1px solid var(--mg-divider,#e3e5ea);padding-top:4px";
      const sum = document.createElement("summary");
      sum.textContent = cat;
      sum.style.cssText = "cursor:pointer;font-weight:600;font-size:12px";
      det.appendChild(sum);
      const lbl = document.createElement("label");
      lbl.className = "hint";
      lbl.textContent = "Unit: ";
      const sel = document.createElement("select");
      const cur = (dispState[cat] && dispState[cat][0]) || SPECIAL_UNITS[cat][0];
      SPECIAL_UNITS[cat].forEach((u) => {
        const o = document.createElement("option");
        o.value = u; o.textContent = u;
        if (u === cur) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => { dispState[cat] = [sel.value]; save(); });
      lbl.appendChild(sel);
      det.appendChild(lbl);
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.style.margin = "4px 0 0";
      hint.textContent = "Not prefixable, so just pick the unit to display.";
      det.appendChild(hint);
      $advbody.appendChild(det);
    });
  }

  function save() {
    const data = {
      priceRounding: $enabled.checked,
      priceRoundCents: clampCents($cents.value),
      logSamples: $logsamples.checked,
      maxOrderOfMagnitude: clampNum($oom.value, 1, 12, 6),
      decimalPlaces: clampNum($dec.value, 0, 6, 2),
      thousandsSeparator: $sep.value,
      displayTiers: tierState.slice(),
      hoverTiers: hoverTierState.slice(),
      displayTiersByCat: dispTierByCat,
      hoverTiersByCat: hoverTierByCat,
      displayScales: dispState,
      hoverScales: hoverState,
      catBase: baseState,
    };
    api.storage.local.set(data).then(() => {
      $status.textContent = "Saved";
      setTimeout(() => ($status.textContent = ""), 1200);
    });
    renderExample();
  }

  api.storage.local.get(DEFAULTS).then((stored) => {
    const s = { ...DEFAULTS, ...stored };
    $enabled.checked = !!s.priceRounding;
    $cents.value = clampCents(s.priceRoundCents);
    $logsamples.checked = !!s.logSamples;
    $oom.value = clampNum(s.maxOrderOfMagnitude, 1, 12, 6);
    $dec.value = clampNum(s.decimalPlaces, 0, 6, 2);
    $sep.value = s.thousandsSeparator != null ? s.thousandsSeparator : ",";
    tierState = (s.displayTiers || DEFAULTS.displayTiers).slice();
    hoverTierState = (s.hoverTiers || []).slice();
    dispTierByCat = Object.assign({}, s.displayTiersByCat || {});
    hoverTierByCat = Object.assign({}, s.hoverTiersByCat || {});
    dispState = Object.assign({}, s.displayScales || {});
    hoverState = Object.assign({}, s.hoverScales || {});
    baseState = Object.assign({}, s.catBase || {});
    buildTiers();
    buildAdv();
    renderExample();
  });

  $enabled.addEventListener("change", save);
  $logsamples.addEventListener("change", save);
  $oom.addEventListener("change", save);
  $dec.addEventListener("change", save);
  $sep.addEventListener("change", save);
  $cents.addEventListener("change", save);
  $cents.addEventListener("input", renderExample);

  // ---- Training data: counts, export, clear ----
  const $counts = document.getElementById("counts");
  const $export = document.getElementById("export");
  const $clear = document.getElementById("clear");

  function flatten(store) {
    if (Array.isArray(store)) return store;
    if (!store || typeof store !== "object") return [];
    return [].concat(store.corrected || [], store.seen || [], store.auto || []);
  }

  function renderCounts() {
    api.storage.local.get({ mgTraining: {} }).then((res) => {
      const s = res.mgTraining || {};
      const corrected = (s.corrected || []).length;
      const seen = (s.seen || []).length;
      const auto = (s.auto || []).length;
      const total = corrected + seen + auto || flatten(s).length;
      if (!total) {
        $counts.textContent = "No training examples recorded yet.";
        return;
      }
      $counts.textContent =
        `${total} examples — ${corrected} corrected (most valuable), ` +
        `${seen} seen, ${auto} auto-sampled.`;
    });
  }

  $export.addEventListener("click", () => {
    api.storage.local.get({ mgTraining: {} }).then((res) => {
      const blob = new Blob([JSON.stringify(res.mgTraining || {}, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "metric-glance-training.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });

  $clear.addEventListener("click", () => {
    api.storage.local.set({ mgTraining: { corrected: [], seen: [], auto: [] } }).then(renderCounts);
  });

  renderCounts();
})();
