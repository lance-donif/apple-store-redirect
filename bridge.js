// bridge.js — runs in ISOLATED world
// Receives postMessage from guard.js (MAIN world), forwards to background.js via chrome.runtime
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "apple-store-guard") return;
  if (event.data?.action !== "switchCountry") return;

  const country = event.data.country;
  chrome.runtime.sendMessage(
    { action: "switchCountry", country },
    (response) => {
      window.postMessage(
        { source: "apple-store-guard-bridge", action: "switchCountryDone", country, ok: !!response?.ok },
        "*"
      );
    }
  );
});
