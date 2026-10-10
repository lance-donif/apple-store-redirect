const SWITCH_CHANNEL = "appleStoreRedirectGuard";
// Key names are the wire contract with forgetStorefront() in guard.js: content
// scripts can't share constants, so rename both sides together.
const STORE_PREFIX = "appleStoreRedirectGuard";

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "clearCountryIntent") return;

  try {
    sessionStorage.removeItem(`${STORE_PREFIX}.country`);
    sessionStorage.removeItem(`${STORE_PREFIX}.appPath`);
    sessionStorage.setItem(`${STORE_PREFIX}.switching`, "1");
  } catch {}
});

globalThis.addEventListener?.("message", (event) => {
  const message = event.data;
  if (event.source !== globalThis ||
      message?.channel !== SWITCH_CHANNEL ||
      message.type !== "prepareCountrySwitch" ||
      !/^[a-z]{2}$/i.test(message.country || "")) return;

  Promise.resolve(chrome.runtime.sendMessage({
    type: "prepareCountrySwitch",
    country: message.country
  })).catch(() => {}).finally(() => {
    globalThis.postMessage?.({
      channel: SWITCH_CHANNEL,
      type: "countrySwitchReady",
      requestId: message.requestId
    }, location.origin);
  });
});
