chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "clearCountryIntent") return;

  try {
    sessionStorage.removeItem("appleStoreRedirectGuard.country");
    sessionStorage.removeItem("appleStoreRedirectGuard.appPath");
    sessionStorage.setItem("appleStoreRedirectGuard.switching", "1");
  } catch {}
});
