const APPLE_APPS_HOST = "apps.apple.com";
const APPLE_ORIGIN = `https://${APPLE_APPS_HOST}`;
const APPLE_URL = `${APPLE_ORIGIN}/`;
const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
const APP_PATH = /^\/[a-z]{2}\/app\//i;
const GEO_COOKIE = "geo";
const GEO_DOMAIN = ".apple.com";
const GUARD_COUNTRY_COOKIE = "__asgc";
const GUARD_PATH_COOKIE = "__asgp";
const POD_COOKIE = "itspod";
const ITUNES_URL = "https://itunes.apple.com/";
const COOKIE_URLS = ["https://apple.com/", APPLE_URL, ITUNES_URL];
// Apple serves a host-only and an iTunes-scoped `geo` that shadow the parent-domain value.
const GEO_SHADOW_URLS = [APPLE_URL, ITUNES_URL];
const LEGACY_STORE_FRONT_RULE_ID = 2;
const LEGACY_COUNTRY_REWRITE_RULE_ID = 1000;
const COUNTRY_REWRITE_RULE_ID_MIN = 10000;
const COUNTRY_REWRITE_RULE_ID_MAX = 19999;
const MAX_RELOADS_PER_URL = 3;
const RELOAD_LOOP_WINDOW_MS = 5000;
const APPLE_STORE_ORIGINS = [APPLE_ORIGIN];
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
  removeRuleIds: [LEGACY_STORE_FRONT_RULE_ID, LEGACY_COUNTRY_REWRITE_RULE_ID]
});

const cookieExpiry = () => Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

const setCookie = (name, value, domain) =>
  chrome.cookies.set({
    url: APPLE_URL,
    name,
    value,
    domain,
    path: "/",
    secure: true,
    sameSite: "no_restriction",
    expirationDate: cookieExpiry()
  });

const removeCookie = (name, url = APPLE_URL) => chrome.cookies.remove({ url, name });

const removeCookieEverywhere = (name) =>
  Promise.allSettled(COOKIE_URLS.map((url) => removeCookie(name, url)));

const setGeoCookie = async (country) => {
  await Promise.allSettled(GEO_SHADOW_URLS.map((url) => removeCookie(GEO_COOKIE, url)));
  return setCookie(GEO_COOKIE, country.toUpperCase(), GEO_DOMAIN);
};

const clearGeoCookie = () => removeCookieEverywhere(GEO_COOKIE);
const clearItspodCookie = () => removeCookieEverywhere(POD_COOKIE);

// Custom cookies Apple won't overwrite: the intended country, and the intended path
// so guard.js can redirect back to the exact page.
const setGuardCookie = (country) =>
  setCookie(GUARD_COUNTRY_COOKIE, country.toUpperCase(), APPLE_APPS_HOST);
const setGuardPathCookie = (fullPath) => setCookie(GUARD_PATH_COOKIE, fullPath, APPLE_APPS_HOST);
const clearGuardCountryCookie = () => removeCookie(GUARD_COUNTRY_COOKIE);
const clearGuardPathCookie = () => removeCookie(GUARD_PATH_COOKIE);

let countryRuleUpdateQueue = Promise.resolve();

const isCountryRewriteRule = (rule) =>
  rule.id >= COUNTRY_REWRITE_RULE_ID_MIN &&
  rule.id <= COUNTRY_REWRITE_RULE_ID_MAX &&
  Array.isArray(rule.condition?.tabIds);

const buildCountryRewriteRule = (id, code, tabId) => ({
  id,
  priority: 200,
  action: {
    type: "redirect",
    redirect: { regexSubstitution: `https://apps.apple.com/${code}\\1` }
  },
  condition: {
    regexFilter: "^https://apps\\.apple\\.com/cn(/.*)$",
    resourceTypes: ["xmlhttprequest", "sub_frame"],
    tabIds: [tabId]
  }
});

const freeRuleId = (usedRuleIds) => {
  for (let candidate = COUNTRY_REWRITE_RULE_ID_MIN; candidate <= COUNTRY_REWRITE_RULE_ID_MAX; candidate++) {
    if (!usedRuleIds.has(candidate)) return candidate;
  }
  throw new Error("No country rewrite rule IDs available");
};

async function applyCountryRewriteRule(country, tabId) {
  const rules = (await chrome.declarativeNetRequest.getSessionRules?.()) || [];
  const rewriteRules = rules.filter(isCountryRewriteRule);
  const existing = rewriteRules.find((rule) => rule.condition.tabIds.includes(tabId));
  const removeRuleIds = existing ? [existing.id] : [];
  const code = country?.toLowerCase();

  if (!code || code === "cn") {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
    return;
  }

  const ruleId = existing?.id ?? freeRuleId(new Set(rewriteRules.map((rule) => rule.id)));
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [buildCountryRewriteRule(ruleId, code, tabId)]
  });
}

// Serialized: concurrent getSessionRules() calls would allocate the same id twice.
function updateCountryRewriteRule(country, tabId) {
  countryRuleUpdateQueue = countryRuleUpdateQueue
    .catch(() => {})
    .then(() => applyCountryRewriteRule(country, tabId));
  return countryRuleUpdateQueue;
}

const clearStorefrontState = (tabId) =>
  Promise.allSettled([
    clearGuardPathCookie(),
    clearGuardCountryCookie(),
    clearGeoCookie(),
    clearItspodCookie(),
    updateCountryRewriteRule(null, tabId)
  ]);

async function clearAppleStoreCache() {
  await chrome.browsingData.remove({ origins: APPLE_STORE_ORIGINS }, APPLE_STORE_CACHE_TYPES);
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    Promise.allSettled([clearAppleStoreCache(), clearGuardPathCookie()]);
  }
});

const reloadAttempts = new Map(); // tabId -> { url, count, lastTime }
const preparedCountryByTab = new Map();

function forgetTab(tabId) {
  reloadAttempts.delete(tabId);
  preparedCountryByTab.delete(tabId);
}

chrome.tabs.onRemoved?.addListener((tabId) => {
  forgetTab(tabId);
  updateCountryRewriteRule(null, tabId).catch(() => {});
});

chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (message?.type !== "prepareCountrySwitch" || !/^[a-z]{2}$/i.test(message.country || "")) return;

  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const country = message.country.toLowerCase();

  (async () => {
    const operations = [setGeoCookie(country), clearItspodCookie()];
    if (country === "cn") {
      operations.push(clearGuardCountryCookie(), clearGuardPathCookie(), updateCountryRewriteRule(null, tabId));
    } else {
      operations.push(setGuardCookie(country), updateCountryRewriteRule(country, tabId));
    }
    await Promise.allSettled(operations);
    preparedCountryByTab.set(tabId, country);
    sendResponse({ ok: true });
  })().catch(() => sendResponse({ ok: false }));

  return true;
});

const storefrontOf = (url) => url.pathname.match(COUNTRY_PATH)?.[1]?.toLowerCase() ?? null;

// Cookies applied after a response can't influence the navigation that already
// happened, so the tab is reloaded once. Returns false when the same URL keeps
// coming back: give up rather than loop.
function shouldReloadTab(tabId, requestedUrl) {
  const now = Date.now();
  const previous = reloadAttempts.get(tabId);
  const inLoop = previous?.url === requestedUrl && now - previous.lastTime < RELOAD_LOOP_WINDOW_MS;
  const state = inLoop
    ? { url: requestedUrl, count: previous.count + 1, lastTime: now }
    : { url: requestedUrl, count: 1, lastTime: now };
  reloadAttempts.set(tabId, state);

  if (state.count <= MAX_RELOADS_PER_URL) return true;

  console.warn(`[Redirect Guard] Prevented reload loop on tab ${tabId} for URL ${requestedUrl}`);
  reloadAttempts.delete(tabId);
  return false;
}

async function handleStorefrontNavigation(details) {
  if (details.frameId !== 0) return;

  const url = new URL(details.url);
  if (url.origin !== APPLE_ORIGIN) return;

  const country = storefrontOf(url);
  if (!country) {
    try { await chrome.tabs.sendMessage?.(details.tabId, { type: "clearCountryIntent" }); } catch {}
    forgetTab(details.tabId);
    await clearStorefrontState(details.tabId);
    return;
  }

  const wasPrepared = preparedCountryByTab.get(details.tabId) === country;
  preparedCountryByTab.delete(details.tabId);
  if (country === "cn") {
    await Promise.allSettled([clearItspodCookie(), updateCountryRewriteRule(null, details.tabId)]);
    return;
  }

  const [currentGeo, guardCookie] = await Promise.all([
    chrome.cookies.get({ url: APPLE_URL, name: GEO_COOKIE }),
    chrome.cookies.get({ url: APPLE_URL, name: GUARD_COUNTRY_COOKIE })
  ]);
  const cookiesAgree =
    currentGeo?.value?.toLowerCase() === country &&
    guardCookie?.value?.toLowerCase() === country;
  const needsReload = !wasPrepared && !cookiesAgree;

  await Promise.allSettled([
    setGeoCookie(country),
    setGuardCookie(country),
    clearItspodCookie(),
    updateCountryRewriteRule(country, details.tabId),
    APP_PATH.test(url.pathname)
      ? setGuardPathCookie(encodeURIComponent(url.pathname + url.search + url.hash))
      : clearGuardPathCookie()
  ]);

  if (!needsReload) {
    reloadAttempts.delete(details.tabId);
    return;
  }
  if (shouldReloadTab(details.tabId, details.url)) {
    await chrome.tabs.update(details.tabId, { url: url.href });
  } else {
    await clearStorefrontState(details.tabId);
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(
  handleStorefrontNavigation,
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);
