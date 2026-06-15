/* Metric Glance options */
(function () {
  "use strict";

  const DEFAULTS = {
    priceRounding: true,
    priceRoundCents: 50,
    logSamples: false,
  };

  const api =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome);

  const $enabled = document.getElementById("enabled");
  const $cents = document.getElementById("cents");
  const $status = document.getElementById("status");
  const $example = document.getElementById("example");
  const $logsamples = document.getElementById("logsamples");

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
      return "$" + v.toFixed(2) + " &rarr; " + shown;
    });
    $example.innerHTML =
      "At " + t + "¢: " + parts.join(" &nbsp;·&nbsp; ");
  }

  function save() {
    const data = {
      priceRounding: $enabled.checked,
      priceRoundCents: clampCents($cents.value),
      logSamples: $logsamples.checked,
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
    renderExample();
  });

  $enabled.addEventListener("change", save);
  $logsamples.addEventListener("change", save);
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
