const APPLE_APPS_HOST = "apps.apple.com";
const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
const APP_PATH = /^\/[a-z]{2}\/app\//i;
const COOKIE_URLS = [
  "https://apple.com/",
  "https://apps.apple.com/",
  "https://itunes.apple.com/"
];
const LEGACY_STORE_FRONT_RULE_ID = 2;
const lastAppPathByTab = new Map();
const lastRestoreByTab = new Map();

chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [LEGACY_STORE_FRONT_RULE_ID]
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

function normalCountry(value) {
  return /^[a-z]{2}$/i.test(value || "") ? value.toLowerCase() : null;
}

function savedAppUrl(value, country) {
  try {
    const url = new URL(decodeURIComponent(value || ""), "https://apps.apple.com/");
    const pathCountry = url.pathname.match(COUNTRY_PATH)?.[1]?.toLowerCase();
    if (url.hostname !== APPLE_APPS_HOST || pathCountry !== country || !APP_PATH.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function restoreSavedAppPath(details) {
  if (details.tabId < 0) return;

  const countryCookie = await chrome.cookies.get({ url: "https://apps.apple.com/", name: "__asgc" });
  const country = normalCountry(countryCookie?.value);
  if (!country || country === "cn") return;

  const pathCookie = await chrome.cookies.get({ url: "https://apps.apple.com/", name: "__asgp" });
  const redirectUrl = savedAppUrl(lastAppPathByTab.get(details.tabId) || pathCookie?.value, country);
  if (!redirectUrl) return;

  const recent = lastRestoreByTab.get(details.tabId);
  if (recent?.url === redirectUrl && Date.now() - recent.time < 5000) return;
  lastRestoreByTab.set(details.tabId, { url: redirectUrl, time: Date.now() });

  await setGeoCookie(country);
  await clearItspodCookie();
  await chrome.tabs.update(details.tabId, { url: redirectUrl });
}

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;

    const url = new URL(details.url);
    if (url.hostname !== APPLE_APPS_HOST) return;

    const match = url.pathname.match(COUNTRY_PATH);
    if (!match) return;

    const country = match[1].toLowerCase();

    if (country === "cn") {
      await restoreSavedAppPath(details);
      return;
    }

    if (country !== "cn") {
      setGeoCookie(country);
      setGuardCookie(country);
      if (APP_PATH.test(url.pathname)) {
        const appPath = url.pathname + url.search + url.hash;
        lastAppPathByTab.set(details.tabId, appPath);
        setGuardPathCookie(encodeURIComponent(appPath));
      }
      clearItspodCookie();
    }
  },
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);
