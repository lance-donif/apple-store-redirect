const APPLE_APPS_HOST = "apps.apple.com";
const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
const APP_PATH = /^\/[a-z]{2}\/app\//i;
const COOKIE_URLS = [
  "https://apple.com/",
  "https://apps.apple.com/",
  "https://itunes.apple.com/"
];
const LEGACY_STORE_FRONT_RULE_ID = 2;
const LEGACY_COUNTRY_REWRITE_RULE_ID = 1000;
const COUNTRY_REWRITE_RULE_ID_MIN = 10000;
const COUNTRY_REWRITE_RULE_ID_MAX = 19999;
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
  removeRuleIds: [LEGACY_STORE_FRONT_RULE_ID, LEGACY_COUNTRY_REWRITE_RULE_ID]
});

let countryRuleUpdateQueue = Promise.resolve();

function isCountryRewriteRule(rule) {
  return rule.id >= COUNTRY_REWRITE_RULE_ID_MIN &&
    rule.id <= COUNTRY_REWRITE_RULE_ID_MAX &&
    Array.isArray(rule.condition?.tabIds);
}

function updateCountryRewriteRule(country, tabId) {
  countryRuleUpdateQueue = countryRuleUpdateQueue.catch(() => {}).then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules?.() || [];
    const rewriteRules = rules.filter(isCountryRewriteRule);
    const existing = rewriteRules.find((rule) => rule.condition.tabIds.includes(tabId));
    const removeRuleIds = existing ? [existing.id] : [];

    if (!country || country.toLowerCase() === "cn") {
      if (removeRuleIds.length) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
      }
      return;
    }

    const usedRuleIds = new Set(rewriteRules.map((rule) => rule.id));
    let ruleId = existing?.id;
    if (!ruleId) {
      for (let candidate = COUNTRY_REWRITE_RULE_ID_MIN; candidate <= COUNTRY_REWRITE_RULE_ID_MAX; candidate++) {
        if (!usedRuleIds.has(candidate)) {
          ruleId = candidate;
          break;
        }
      }
    }
    if (!ruleId) throw new Error("No country rewrite rule IDs available");

    const code = country.toLowerCase();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: [
        {
          id: ruleId,
          priority: 200,
          action: {
            type: "redirect",
            redirect: {
              regexSubstitution: `https://apps.apple.com/${code}\\1`
            }
          },
          condition: {
            regexFilter: "^https://apps\\.apple\\.com/cn(/.*)$",
            resourceTypes: ["xmlhttprequest", "sub_frame"],
            tabIds: [tabId]
          }
        }
      ]
    });
  });

  return countryRuleUpdateQueue;
}

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
  await Promise.all([
    chrome.cookies.remove({ url: "https://apps.apple.com/", name: "geo" }),
    chrome.cookies.remove({ url: "https://itunes.apple.com/", name: "geo" })
  ]).catch(() => {});

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

const tabReloads = new Map(); // tabId -> { url: string, count: number, lastTime: number }
const preparedCountryByTab = new Map();
chrome.tabs.onRemoved?.addListener((tabId) => {
  tabReloads.delete(tabId);
  preparedCountryByTab.delete(tabId);
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

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;

    const url = new URL(details.url);
    if (url.origin !== "https://apps.apple.com") return;

    const match = url.pathname.match(COUNTRY_PATH);
    if (!match) {
      try { await chrome.tabs.sendMessage?.(details.tabId, { type: "clearCountryIntent" }); } catch {}
      tabReloads.delete(details.tabId);
      preparedCountryByTab.delete(details.tabId);
      Promise.allSettled([
        clearGuardPathCookie(),
        clearGuardCountryCookie(),
        clearGeoCookie(),
        clearItspodCookie(),
        updateCountryRewriteRule(null, details.tabId)
      ]);
      return;
    }

    const country = match[1].toLowerCase();
    const wasPrepared = preparedCountryByTab.get(details.tabId) === country;
    preparedCountryByTab.delete(details.tabId);
    if (country === "cn") {
      await Promise.allSettled([
        clearItspodCookie(),
        updateCountryRewriteRule(null, details.tabId)
      ]);
      return;
    }

    const currentGeo = await chrome.cookies.get({
      url: "https://apps.apple.com/",
      name: "geo"
    });
    const guardCookie = await chrome.cookies.get({
      url: "https://apps.apple.com/",
      name: "__asgc"
    });
    const geoMatches = currentGeo?.value?.toLowerCase() === country;
    const guardMatches = guardCookie?.value?.toLowerCase() === country;
    const needsReload = !wasPrepared && (!geoMatches || !guardMatches);
    const operations = [
      setGeoCookie(country),
      setGuardCookie(country),
      clearItspodCookie(),
      updateCountryRewriteRule(country, details.tabId)
    ];
    if (APP_PATH.test(url.pathname)) {
      const appPath = url.pathname + url.search + url.hash;
      operations.push(setGuardPathCookie(encodeURIComponent(appPath)));
    } else {
      operations.push(clearGuardPathCookie());
    }
    await Promise.allSettled(operations);

    if (needsReload) {
      const tabId = details.tabId;
      const now = Date.now();
      const currentUrl = details.url;
      const state = tabReloads.get(tabId) || { url: "", count: 0, lastTime: 0 };

      if (state.url === currentUrl && (now - state.lastTime) < 5000) {
        state.count++;
      } else {
        state.url = currentUrl;
        state.count = 1;
      }
      state.lastTime = now;
      tabReloads.set(tabId, state);

      if (state.count > 3) {
        console.warn(`[Redirect Guard] Prevented reload loop on tab ${tabId} for URL ${currentUrl}`);
        tabReloads.delete(tabId);
        Promise.allSettled([
          clearGuardPathCookie(),
          clearGuardCountryCookie(),
          clearGeoCookie(),
          clearItspodCookie(),
          updateCountryRewriteRule(null, tabId)
        ]);
        return;
      }

      await chrome.tabs.update(details.tabId, { url: url.href });
    } else {
      tabReloads.delete(details.tabId);
    }
  },
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);
