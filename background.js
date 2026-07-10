const APPLE_APPS_HOST = "apps.apple.com";
const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
const APP_PATH = /^\/[a-z]{2}\/app\//i;
const COOKIE_URLS = [
  "https://apple.com/",
  "https://apps.apple.com/",
  "https://itunes.apple.com/"
];
const LEGACY_STORE_FRONT_RULE_ID = 2;
const APPLE_STORE_ORIGINS = ["https://apps.apple.com"];
const APPLE_STORE_CACHE_TYPES = {
  cache: true,
  cacheStorage: true,
  fileSystems: true,
  indexedDB: true,
  localStorage: true,
  serviceWorkers: true,
  webSQL: true
};

chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [LEGACY_STORE_FRONT_RULE_ID]
});

async function clearAppleStoreCache() {
  await chrome.browsingData.remove({ origins: APPLE_STORE_ORIGINS }, APPLE_STORE_CACHE_TYPES);
}

async function clearGuardPathCookie() {
  await chrome.cookies.remove({ url: "https://apps.apple.com/", name: "__asgp" });
}

async function clearGuardCountryCookie() {
  await chrome.cookies.remove({ url: "https://apps.apple.com/", name: "__asgc" });
}

async function clearGeoCookie() {
  await Promise.allSettled(
    COOKIE_URLS.map((url) => chrome.cookies.remove({ url, name: "geo" }))
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    Promise.allSettled([clearAppleStoreCache(), clearGuardPathCookie()]);
  }
});

async function setGeoCookie(country) {
  await chrome.cookies.set({
    url: "https://apps.apple.com/",
    name: "geo",
    value: country.toUpperCase(),
    domain: ".apple.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction",
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  });
}

async function clearItspodCookie() {
  await Promise.allSettled(
    COOKIE_URLS.map((url) => chrome.cookies.remove({ url, name: "itspod" }))
  );
}

// Custom cookie Apple won't overwrite — tells guard.js the intended country
async function setGuardCookie(country) {
  await chrome.cookies.set({
    url: "https://apps.apple.com/",
    name: "__asgc",
    value: country.toUpperCase(),
    domain: "apps.apple.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction",
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  });
}

// Save the original path so guard.js can redirect back to the exact page
async function setGuardPathCookie(fullPath) {
  await chrome.cookies.set({
    url: "https://apps.apple.com/",
    name: "__asgp",
    value: fullPath,
    domain: "apps.apple.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction",
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;

    const url = new URL(details.url);
    if (url.origin !== "https://apps.apple.com") return;

    const match = url.pathname.match(COUNTRY_PATH);
    if (!match) {
      try { await chrome.tabs.sendMessage?.(details.tabId, { type: "clearCountryIntent" }); } catch {}
      Promise.allSettled([
        clearGuardPathCookie(),
        clearGuardCountryCookie(),
        clearGeoCookie(),
        clearItspodCookie()
      ]);
      return;
    }

    const country = match[1].toLowerCase();

    if (country === "cn") return;

    const operations = [setGeoCookie(country), setGuardCookie(country), clearItspodCookie()];
    if (APP_PATH.test(url.pathname)) {
      const appPath = url.pathname + url.search + url.hash;
      operations.push(setGuardPathCookie(encodeURIComponent(appPath)));
    } else {
      operations.push(clearGuardPathCookie());
    }
    Promise.allSettled(operations);
  },
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);
