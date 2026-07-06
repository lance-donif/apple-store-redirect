const APPLE_APPS_HOST = "apps.apple.com";
const COUNTRY_PATH = /^\/([a-z]{2})\//i;
const COOKIE_URLS = [
  "https://apple.com/",
  "https://apps.apple.com/",
  "https://itunes.apple.com/"
];

async function setGeoCookie(country) {
  await chrome.cookies.set({
    url: "https://apps.apple.com/",
    name: "geo",
    value: country.toUpperCase(),
    domain: ".apple.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction"
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
    sameSite: "no_restriction"
  });
}

async function clearGuardCookie() {
  await chrome.cookies.remove({ url: "https://apps.apple.com/", name: "__asgc" });
}

// Track per-tab intended country
const tabCountry = new Map();

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;

    const url = new URL(details.url);
    if (url.hostname !== APPLE_APPS_HOST) return;

    const match = url.pathname.match(COUNTRY_PATH);
    if (!match) return;

    const country = match[1].toLowerCase();

    if (country !== "cn") {
      tabCountry.set(details.tabId, country);
      setGeoCookie(country);
      setGuardCookie(country);
      clearItspodCookie();
    } else {
      // Navigating to /cn/ — set guard cookie to intended country
      const intended = tabCountry.get(details.tabId);
      if (intended) {
        setGeoCookie(intended);
        setGuardCookie(intended);
        clearItspodCookie();
      }
    }
  },
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);

// Clean up when tab is closed
chrome.tabs.onRemoved?.addListener((tabId) => {
  tabCountry.delete(tabId);
});

chrome.runtime.onMessageExternal?.addListener((request, _sender, sendResponse) => {
  if (request?.action === "switchCountry") {
    const country = String(request.country).toLowerCase();
    const guardOp = country === "cn" ? clearGuardCookie() : setGuardCookie(country);
    Promise.allSettled([setGeoCookie(country), clearItspodCookie(), guardOp]).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.runtime.onMessage?.addListener((request, _sender, sendResponse) => {
  if (request?.action === "switchCountry") {
    const country = String(request.country).toLowerCase();
    const guardOp = country === "cn" ? clearGuardCookie() : setGuardCookie(country);
    Promise.allSettled([setGeoCookie(country), clearItspodCookie(), guardOp]).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
