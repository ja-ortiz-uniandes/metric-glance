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
    displayTiers: ["milli", "centi", "base", "kilo", "mega", "giga"],
    displayScales: {},
    hoverScales: {},
  };

  const CATS = {
    Length: ["mm", "cm", "m", "km"], Mass: ["mg", "g", "kg", "t"],
    Volume: ["ml", "L", "m\u00B3"], Area: ["cm\u00B2", "m\u00B2", "km\u00B2"],
    Speed: ["m/s", "km/h"], Energy: ["J", "kJ", "MJ", "GJ"],
    Power: ["W", "kW", "MW", "GW"], Pressure: ["Pa", "kPa", "MPa", "GPa"],
  };
  const TIERS = ["milli", "centi", "base", "kilo", "mega", "giga"];
  let tierState = [], dispState = {}, hoverState = {};

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

  function chip(label, on, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "margin:2px;padding:3px 9px;border-radius:12px;font-size:12px;cursor:pointer;border:1px solid #c6cad3;" +
      (on ? "background:#2d63d8;color:#fff;border-color:#2d63d8;" : "background:transparent;color:inherit;");
    b.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
    return b;
  }
  function toggle(arr, v) {
    const a = arr ? arr.slice() : [];
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1); else a.push(v);
    return a;
  }
  function buildTiers() {
    $tiers.textContent = "";
    TIERS.forEach((t) => {
      $tiers.appendChild(chip(t, tierState.indexOf(t) >= 0, () => {
        tierState = toggle(tierState, t);
        buildTiers(); save();
      }));
    });
  }
  function buildAdv() {
    $advbody.textContent = "";
    Object.keys(CATS).forEach((cat) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "padding:6px 0;border-top:1px solid #e3e5ea";
      const h = document.createElement("div");
      h.textContent = cat;
      h.style.cssText = "font-weight:600;font-size:12px;margin-bottom:2px";
      wrap.appendChild(h);
      const dl = document.createElement("div");
      dl.className = "hint"; dl.textContent = "Display:";
      wrap.appendChild(dl);
      const dr = document.createElement("div");
      CATS[cat].forEach((u) => {
        const on = (dispState[cat] || []).indexOf(u) >= 0;
        dr.appendChild(chip(u, on, () => {
          const arr = toggle(dispState[cat], u);
          if (arr.length) dispState[cat] = arr; else delete dispState[cat];
          buildAdv(); save();
        }));
      });
      wrap.appendChild(dr);
      const hl = document.createElement("div");
      hl.className = "hint"; hl.textContent = "Hover extra:";
      wrap.appendChild(hl);
      const hr = document.createElement("div");
      CATS[cat].forEach((u) => {
        const on = (hoverState[cat] || []).indexOf(u) >= 0;
        hr.appendChild(chip(u, on, () => {
          const arr = toggle(hoverState[cat], u);
          if (arr.length) hoverState[cat] = arr; else delete hoverState[cat];
          buildAdv(); save();
        }));
      });
      wrap.appendChild(hr);
      $advbody.appendChild(wrap);
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
      displayScales: dispState,
      hoverScales: hoverState,
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
    dispState = Object.assign({}, s.displayScales || {});
    hoverState = Object.assign({}, s.hoverScales || {});
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

  function renderCounts() {
    api.storage.local.get({ mgTraining: [] }).then((res) => {
      const list = res.mgTraining || [];
      if (!list.length) {
        $counts.textContent = "No corrections recorded yet.";
        return;
      }
      let auto = 0, corrections = 0, negatives = 0;
      list.forEach((e) => {
        const l = e.label || "";
        if (l.indexOf("auto:") === 0) auto++;
        else if (l === "not_a_conversion") negatives++;
        else corrections++;
      });
      $counts.textContent =
        `${list.length} examples: ${corrections} corrections, ` +
        `${auto} sampled, ${negatives} false positives.`;
    });
  }

  $export.addEventListener("click", () => {
    api.storage.local.get({ mgTraining: [] }).then((res) => {
      const blob = new Blob([JSON.stringify(res.mgTraining || [], null, 2)], {
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
    api.storage.local.set({ mgTraining: [] }).then(renderCounts);
  });

  renderCounts();
})();
