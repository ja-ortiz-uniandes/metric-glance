(function () {
  "use strict";

  const ext = (typeof browser !== "undefined" && browser) ||
              (typeof chrome !== "undefined" && chrome);

  const $togLog   = document.getElementById("tog-log");
  const $togShare = document.getElementById("tog-share");
  const $cardLog  = document.getElementById("card-log");
  const $cardShare = document.getElementById("card-share");
  const $done     = document.getElementById("done-btn");
  const $main     = document.getElementById("main-content");
  const $savedMsg = document.getElementById("saved-msg");

  function syncCard(card, checked) {
    card.classList.toggle("on", checked);
  }

  syncCard($cardLog,   true);
  syncCard($cardShare, true);

  $cardLog.addEventListener("click", () => {
    $togLog.checked = !$togLog.checked;
    syncCard($cardLog, $togLog.checked);
  });
  $cardShare.addEventListener("click", () => {
    $togShare.checked = !$togShare.checked;
    syncCard($cardShare, $togShare.checked);
  });

  $togLog.addEventListener("change",   () => syncCard($cardLog,   $togLog.checked));
  $togShare.addEventListener("change", () => syncCard($cardShare, $togShare.checked));

  $done.addEventListener("click", () => {
    ext.storage.local.set({
      logSamples: $togLog.checked,
      shareData:  $togShare.checked,
      showDataConsent: false,
    });
    $main.style.display     = "none";
    $savedMsg.style.display = "block";
  });
})();
