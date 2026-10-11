(() => {
  const APPLE_HOST = "apps.apple.com";
  const APPLE_ORIGIN = `https://${APPLE_HOST}`;
  const APPLE_DOMAIN = ".apple.com";
  const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
  // Lookahead, not consumption: /cn stays intact when this is used to swap the prefix.
  const CHINA_PATH = /^\/cn(?=\/|$)/i;
  const APP_PATH = /^\/[a-z]{2}\/app\//i;
  const GUARD_MARKER = "__appleStoreRedirectGuard";
  const STORE_PREFIX = "appleStoreRedirectGuard";
  const COUNTRY_STORAGE_KEY = `${STORE_PREFIX}.country`;
  const APP_PATH_STORAGE_KEY = `${STORE_PREFIX}.appPath`;
  const SWITCHING_KEY = `${STORE_PREFIX}.switching`;
  const FORCE_REDIRECT_KEY = `${STORE_PREFIX}.forceRedirect`;
  const GEO_COOKIE = "geo";
  const POD_COOKIE = "itspod";
  const GUARD_COUNTRY_COOKIE = "__asgc";
  const GUARD_PATH_COOKIE = "__asgp";
  const SWITCH_CHANNEL = STORE_PREFIX;
  const SWITCHER_ID = "apple-store-country-switcher";
  const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

  const COUNTRIES = [
    { name: "美国", code: "US" },
    { name: "中国大陆", code: "CN" },
    { name: "日本", code: "JP" },
    { name: "英国", code: "GB" },
    { name: "德国", code: "DE" },
    { name: "法国", code: "FR" },
    { name: "加拿大", code: "CA" },
    { name: "澳大利亚", code: "AU" },
    { name: "韩国", code: "KR" },
    { name: "印度", code: "IN" },
    { name: "巴西", code: "BR" },
    { name: "墨西哥", code: "MX" },
    { name: "西班牙", code: "ES" },
    { name: "意大利", code: "IT" },
    { name: "荷兰", code: "NL" },
    { name: "瑞士", code: "CH" },
    { name: "瑞典", code: "SE" },
    { name: "挪威", code: "NO" },
    { name: "丹麦", code: "DK" },
    { name: "芬兰", code: "FI" },
    { name: "新加坡", code: "SG" },
    { name: "中国香港", code: "HK" },
    { name: "中国台湾", code: "TW" },
    { name: "泰国", code: "TH" },
    { name: "马来西亚", code: "MY" },
    { name: "印度尼西亚", code: "ID" },
    { name: "菲律宾", code: "PH" },
    { name: "越南", code: "VN" },
    { name: "阿联酋", code: "AE" },
    { name: "沙特阿拉伯", code: "SA" },
    { name: "土耳其", code: "TR" },
    { name: "波兰", code: "PL" },
    { name: "比利时", code: "BE" },
    { name: "奥地利", code: "AT" },
    { name: "爱尔兰", code: "IE" },
    { name: "新西兰", code: "NZ" },
    { name: "南非", code: "ZA" }
  ];

  const oneYearOut = () => {
    const date = new Date();
    date.setFullYear(date.getFullYear() + 1);
    return date.toUTCString();
  };
  // Every write is same-site+secure on `path=/`, matching what Apple issues, and the
  // cookie setter is wrapped so a frozen or sandboxed document can't break the guard.
  const setCookieRaw = (name, value, expires, domain) => {
    try {
      document.cookie = `${name}=${value};${domain ? `domain=${domain};` : ""}path=/;expires=${expires};secure;samesite=none`;
    } catch {}
  };
  const writeCookie = (name, value, domain) => setCookieRaw(name, value, oneYearOut(), domain);
  const eraseCookie = (name, domain) => setCookieRaw(name, "", EPOCH, domain);
  const readCookie = (name) => {
    try {
      return document.cookie.match(`(?:^|;\\s*)${name}=([^;]+)`)?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const readStore = (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const writeStore = (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {}
  };
  const removeStore = (key) => {
    try {
      sessionStorage.removeItem(key);
    } catch {}
  };

  const countryOf = (url) => url.pathname.match(COUNTRY_PATH)?.[1]?.toLowerCase() ?? null;
  const isAppsUrl = (url) => url?.origin === APPLE_ORIGIN;
  const asCountry = (value) => {
    const country = String(value ?? "").toLowerCase();
    return /^[a-z]{2}$/.test(country) && country !== "cn" ? country : null;
  };
  // Apple re-issues `geo` on three scopes; each one has to be replaced or removed.
  const forgetGeoCookie = () => {
    eraseCookie(GEO_COOKIE);
    eraseCookie(GEO_COOKIE, APPLE_HOST);
    eraseCookie(GEO_COOKIE, APPLE_DOMAIN);
  };
  // A storefront change always writes the same triple: every `geo` scope reset, then
  // the target value on the parent domain, and `itspod` dropped.
  const announceStorefront = (code) => {
    forgetGeoCookie();
    writeCookie(GEO_COOKIE, code.toUpperCase(), APPLE_DOMAIN);
    eraseCookie(POD_COOKIE, APPLE_DOMAIN);
  };

  let targetCountry = null;
  let pendingAppUrl = null;

  // Intent lives in two places because a server-side 302 can drop sessionStorage and
  // overwrite `geo`; Apple-owned keys are mirrored into our own so we can tell them apart.
  const rememberStorefront = (country) => {
    targetCountry = country;
    announceStorefront(country);
    writeStore(COUNTRY_STORAGE_KEY, country);
    removeStore(SWITCHING_KEY);
    writeCookie(GUARD_COUNTRY_COOKIE, country.toUpperCase(), APPLE_HOST);
  };
  const clearStoredAppPath = () => {
    pendingAppUrl = null;
    removeStore(APP_PATH_STORAGE_KEY);
    eraseCookie(GUARD_PATH_COOKIE, APPLE_HOST);
  };
  const forgetStorefront = () => {
    targetCountry = null;
    removeStore(COUNTRY_STORAGE_KEY);
    writeStore(SWITCHING_KEY, "1");
    eraseCookie(GUARD_COUNTRY_COOKIE, APPLE_HOST);
    clearStoredAppPath();
  };
  const clearStorefrontIntent = () => {
    forgetStorefront();
    forgetGeoCookie();
  };
  const rememberAppPath = (url) => {
    pendingAppUrl = url.href;
    const encodedPath = encodeURIComponent(url.pathname + url.search + url.hash);
    writeStore(APP_PATH_STORAGE_KEY, encodedPath);
    writeCookie(GUARD_PATH_COOKIE, encodedPath, APPLE_HOST);
  };
  const persistAppPath = (url) => {
    if (!isAppsUrl(url)) return;

    const country = countryOf(url);
    if (!country) {
      clearStorefrontIntent();
      return;
    }
    if (country === "cn") return;

    rememberStorefront(country);
    if (APP_PATH.test(url.pathname)) rememberAppPath(url);
    else clearStoredAppPath();
  };
  const savedAppUrl = (value, country) => {
    try {
      const url = new URL(decodeURIComponent(value || ""), location.href);
      if (!isAppsUrl(url) || url.username || url.password || countryOf(url) !== country || !APP_PATH.test(url.pathname)) return null;
      return url.href;
    } catch {
      return null;
    }
  };
  const storedAppUrl = (country) =>
    savedAppUrl(readStore(APP_PATH_STORAGE_KEY), country) ??
    savedAppUrl(readCookie(GUARD_PATH_COOKIE), country);

  const notifyRouteChange = () => {
    try {
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    } catch {
      try { dispatchEvent(new Event("popstate")); } catch {}
    }
  };
  const notifyRouteChangeSoon = () => {
    notifyRouteChange();
    try {
      addEventListener("DOMContentLoaded", notifyRouteChange, { once: true, capture: true });
    } catch {}
  };

  const startUrl = new URL(location.href);
  if (!isAppsUrl(startUrl)) return;
  const storedCountry = asCountry(readStore(COUNTRY_STORAGE_KEY)) ??
    asCountry(readCookie(GUARD_COUNTRY_COOKIE));
  const isSwitching = Boolean(readStore(SWITCHING_KEY));
  if (isSwitching) removeStore(SWITCHING_KEY);

  const targetableCountry = asCountry(countryOf(startUrl));
  targetCountry = targetableCountry ??
    (CHINA_PATH.test(startUrl.pathname) && !isSwitching ? storedCountry : null);
  persistAppPath(startUrl);
  let restoringInitialPath = !targetableCountry && Boolean(targetCountry);

  const setPageHidden = (hidden) => {
    if (document.documentElement) document.documentElement.style.display = hidden ? "none" : "";
  };

  // If we landed on /cn/ due to server redirect, restore the original path before Apple boots.
  if (restoringInitialPath) {
    removeStore(FORCE_REDIRECT_KEY);
    setPageHidden(true);

    const restoreOriginalPath = (retries) => {
      const redirectUrl = storedAppUrl(targetCountry);
      if (redirectUrl) {
        restoringInitialPath = false;
        pendingAppUrl = redirectUrl;
        announceStorefront(targetCountry);
        history.replaceState(history.state, "", redirectUrl);
        notifyRouteChangeSoon();
        setPageHidden(false);
        return;
      }
      if (retries < 10) {
        setTimeout(() => restoreOriginalPath(retries + 1), 50);
        return;
      }
      restoringInitialPath = false;
      const url = new URL(location.href);
      url.pathname = url.pathname.replace(CHINA_PATH, `/${targetCountry}`);
      history.replaceState(history.state, "", url.href);
      notifyRouteChangeSoon();
      setPageHidden(false);
    };
    restoreOriginalPath(0);
  }

  addEventListener("click", (event) => {
    try {
      if ((event.button != null && event.button !== 0) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const link = event.target?.closest?.("a[href]");
      if (!link?.href || (link.target && link.target.toLowerCase() !== "_self") || link.hasAttribute?.("download")) return;

      const url = new URL(link.href, location.href);
      if (!isAppsUrl(url)) return;

      persistAppPath(url);

      const currentUrl = new URL(location.href);
      const sameStorefront = countryOf(currentUrl) === countryOf(url);
      const sameDocument = currentUrl.pathname === url.pathname && currentUrl.search === url.search;
      const appLeavingChina = APP_PATH.test(url.pathname) && CHINA_PATH.test(currentUrl.pathname);

      // Apple's SPA sometimes sends App API requests with an empty Bearer token after
      // storefront changes, which returns 429. A document navigation reloads Apple's
      // storefront bootstrap and avoids stale category/App API state.
      if ((sameStorefront && !sameDocument) || appLeavingChina) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        window.location.href = url.href;
      }
    } catch {}
  }, true);

  const enableSelection = () => {
    if (document.getElementById("apple-store-copy-guard-style")) return;

    const style = document.createElement("style");
    style.id = "apple-store-copy-guard-style";
    style.textContent = `
      html, body, body * {
        -webkit-user-select: text !important;
        user-select: text !important;
      }
    `;
    (document.documentElement || document.head || document.body)?.append(style);
  };

  enableSelection();

  for (const eventName of ["copy", "cut", "contextmenu", "selectstart"]) {
    globalThis.addEventListener?.(eventName, (event) => event.stopImmediatePropagation(), true);
  }

  if (targetableCountry) {
    writeStore(COUNTRY_STORAGE_KEY, targetableCountry);
    removeStore(FORCE_REDIRECT_KEY);
  }

  if (targetCountry) {
    globalThis[GUARD_MARKER] = { country: targetCountry, version: 3 };
  }

  let guardLoopCount = 0;
  let lastGuardedInput = null;
  let lastGuardedOutput = null;
  const MAX_GUARDED_REWRITES = 6;

  const guarded = (rawUrl) => {
    if (rawUrl == null) return rawUrl;

    try {
      const url = new URL(String(rawUrl), location.href);
      const passThrough =
        !isAppsUrl(url) ||
        !CHINA_PATH.test(url.pathname) ||
        restoringInitialPath ||
        !targetCountry ||
        Boolean(readStore(SWITCHING_KEY));
      if (passThrough) {
        guardLoopCount = 0;
        return rawUrl;
      }

      // A saved App page only stands in for a bounce back to that same App. Any other
      // route — including a link to a different App — keeps its own path with the
      // storefront swapped, so SPA navigation is never hijacked onto a stale App.
      const withoutCountry = (pathname) => pathname.replace(COUNTRY_PATH, "/");
      const sameAppAsPending = () => {
        if (!pendingAppUrl || !APP_PATH.test(url.pathname)) return false;
        try {
          return withoutCountry(new URL(pendingAppUrl).pathname) === withoutCountry(url.pathname);
        } catch {
          return false;
        }
      };
      const targetUrl = () => {
        url.pathname = url.pathname.replace(CHINA_PATH, `/${targetCountry}`);
        return url.href;
      };
      const result = sameAppAsPending() ? pendingAppUrl : targetUrl();

      const inputStr = String(rawUrl);
      if (lastGuardedInput === inputStr && lastGuardedOutput === result) {
        guardLoopCount++;
      } else {
        guardLoopCount = 1;
        lastGuardedInput = inputStr;
        lastGuardedOutput = result;
      }

      if (guardLoopCount > MAX_GUARDED_REWRITES) {
        clearStorefrontIntent();
        guardLoopCount = 0;
        return rawUrl;
      }

      return typeof rawUrl === "string" ? result : new URL(result);
    } catch {
      return rawUrl;
    }
  };

  const repairCurrentUrl = () => {
    if (restoringInitialPath || !targetCountry || !CHINA_PATH.test(location.pathname)) return;

    const repairedUrl = guarded(location.href);
    if (repairedUrl !== location.href) history.replaceState(history.state, "", repairedUrl);
  };

  // Shared interception for every patched navigation API: guard the URL, mirror the
  // app-path intent, then hand off to the original.
  const guardedWithIntent = (rawUrl) => {
    const nextUrl = guarded(rawUrl);
    try { persistAppPath(new URL(nextUrl, location.href)); } catch {}
    return nextUrl;
  };

  const patchMethod = (target, name, intercept) => {
    const original = target[name];
    if (typeof original !== "function") return;
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value(...args) {
          return intercept(original, this, args);
        }
      });
    } catch {}
  };

  for (const name of ["pushState", "replaceState"]) {
    patchMethod(history, name, (original, self, args) => {
      if (args[2] != null) args[2] = guardedWithIntent(args[2]);
      const result = original.apply(self, args);
      repairCurrentUrl();
      return result;
    });
  }

  if (globalThis.navigation?.navigate) {
    patchMethod(globalThis.navigation, "navigate", (original, self, [url, options]) => {
      const result = original.call(self, guardedWithIntent(url), options);
      queueMicrotask(repairCurrentUrl);
      return result;
    });
  }

  for (const name of ["assign", "replace"]) {
    patchMethod(Location.prototype, name, (original, self, [url]) =>
      original.call(self, guardedWithIntent(url))
    );
  }

  const handleRouteChange = () => {
    if (!CHINA_PATH.test(location.pathname)) {
      try { persistAppPath(new URL(location.href)); } catch {}
    }
    repairCurrentUrl();
  };

  addEventListener("popstate", handleRouteChange, true);
  addEventListener("hashchange", handleRouteChange, true);
  queueMicrotask(handleRouteChange);

  const resolveNavTarget = () => {
    const nav = document.querySelector('nav[data-testid="navigation"]') || document.querySelector('nav');
    if (!nav) return null;
    const header = nav.querySelector('.navigation__header');
    if (header) return header;
    const target = nav.querySelector('[data-testid*="navigation"], [role="navigation"]');
    if (target) return target;
    return nav;
  };

  const prepareCountrySwitch = (country, navigate) => {
    if (typeof globalThis.postMessage !== "function") {
      navigate();
      return;
    }

    const requestId = `${Date.now()}-${Math.random()}`;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      removeEventListener("message", handleReady);
      navigate();
    };
    const handleReady = (event) => {
      if (event.source === globalThis &&
          event.data?.channel === SWITCH_CHANNEL &&
          event.data.type === "countrySwitchReady" &&
          event.data.requestId === requestId) finish();
    };

    addEventListener("message", handleReady);
    globalThis.postMessage({
      channel: SWITCH_CHANNEL,
      type: "prepareCountrySwitch",
      requestId,
      country
    }, location.origin);
    setTimeout(finish, 1000);
  };

  const selectCountry = (country) => {
    const code = country.code.toLowerCase();
    if (code === "cn") {
      // Opting out: hand /cn/ back to Apple, but keep geo=CN so Apple's own
      // storefront cookie agrees with the page the user asked for.
      announceStorefront(code);
      forgetStorefront();
      return;
    }
    rememberStorefront(code);
  };

  const createCountrySwitcher = (activeCountry) => {
    const wrapper = document.createElement("div");
    wrapper.id = SWITCHER_ID;
    wrapper.style.cssText = "position:relative;display:inline-flex;align-items:center;height:44px;margin-left:12px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;";

    const button = document.createElement("button");
    const current = COUNTRIES.find((c) => c.code.toLowerCase() === activeCountry) || COUNTRIES[0];
    const buttonLabel = (country) => `${country.name} (${country.code})`;
    button.textContent = buttonLabel(current);
    button.style.cssText = `
      display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;
      border:0;border-radius:6px;background:transparent;color:#1d1d1f;font-size:12px;
      font-weight:400;letter-spacing:-0.01em;cursor:pointer;transition:background .15s ease;
    `;
    button.onmouseenter = () => (button.style.background = "rgba(0,0,0,0.06)");
    button.onmouseleave = () => (button.style.background = "transparent");

    const menu = document.createElement("div");
    menu.style.cssText = `
      position:absolute;top:calc(100% + 6px);right:0;width:220px;max-height:320px;overflow-y:auto;
      background:rgba(255,255,255,0.92);backdrop-filter:saturate(180%) blur(20px);
      border:1px solid rgba(0,0,0,0.08);border-radius:12px;box-shadow:0 12px 28px rgba(0,0,0,0.15);
      padding:8px 0;display:none;z-index:9999;
    `;

    for (const country of COUNTRIES) {
      const item = document.createElement("div");
      item.style.cssText = `
        display:flex;align-items:center;justify-content:space-between;padding:8px 16px;
        font-size:13px;color:#1d1d1f;cursor:pointer;transition:background .12s ease;
      `;
      item.innerHTML = `<span>${country.name}</span><span style="color:#86868b;font-size:12px;">${country.code}</span>`;
      item.onmouseenter = () => (item.style.background = "rgba(0,0,0,0.06)");
      item.onmouseleave = () => (item.style.background = "transparent");
      item.onclick = () => {
        selectCountry(country);
        button.textContent = buttonLabel(country);
        menu.style.display = "none";

        const url = new URL(location.href);
        url.pathname = `/${country.code.toLowerCase()}${url.pathname.replace(COUNTRY_PATH, "/")}`;
        // location.assign() is patched and would rewrite the URL back; href assignment
        // is the one navigation this page owns.
        prepareCountrySwitch(country.code, () => {
          window.location.href = url.href;
        });
      };
      menu.append(item);
    }

    button.onclick = () => {
      menu.style.display = menu.style.display === "block" ? "none" : "block";
    };

    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) menu.style.display = "none";
    });

    wrapper.append(button, menu);
    return wrapper;
  };

  const injectCountrySwitcher = () => {
    const urlCountry = countryOf(new URL(location.href));
    // Show the user's intended country, not the URL's country.
    // After Apple redirects to /cn/, the URL says CN but the user selected something else.
    const activeCountry = targetCountry || storedCountry || urlCountry || "us";
    const existing = document.getElementById(SWITCHER_ID);
    if (existing) {
      if (existing.dataset?.country === activeCountry && document.contains(existing)) return;
      existing.remove();
    }

    const target = resolveNavTarget();
    if (!target) return;

    const switcher = createCountrySwitcher(activeCountry);
    switcher.dataset.country = activeCountry;
    target.append(switcher);
  };

  injectCountrySwitcher();

  const observer = new MutationObserver(() => {
    if (document.getElementById(SWITCHER_ID)) return;
    injectCountrySwitcher();
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
