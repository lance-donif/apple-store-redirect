(() => {
  const APPLE_HOST = "apps.apple.com";
  const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
  const CHINA_PATH = /^\/cn(?:\/|$)/i;
  const GUARD_MARKER = "__appleStoreRedirectGuard";
  const COUNTRY_STORAGE_KEY = "appleStoreRedirectGuard.country";
  const SWITCHING_KEY = "appleStoreRedirectGuard.switching";

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

  const countryOf = (url) => url.pathname.match(COUNTRY_PATH)?.[1]?.toLowerCase() ?? null;

  const startUrl = new URL(location.href);
  if (startUrl.hostname !== APPLE_HOST) return;
  const startCountry = countryOf(startUrl);

  if (startCountry && startCountry !== "cn" && /^\/[a-z]{2}\/app\//i.test(startUrl.pathname)) {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
  }

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

  if (startCountry && startCountry !== "cn") {
    try {
      sessionStorage.setItem(COUNTRY_STORAGE_KEY, startCountry);
    } catch {}
  }

  let storedCountry = null;
  try {
    const country = sessionStorage.getItem(COUNTRY_STORAGE_KEY);
    if (/^[a-z]{2}$/.test(country) && country !== "cn") {
      storedCountry = country;
    }
  } catch {}
  if (!storedCountry) {
    try {
      const m = document.cookie.match(/(?:^|;\s*)__asgc=([A-Za-z]{2})/);
      if (m) {
        const c = m[1].toLowerCase();
        if (c !== "cn") storedCountry = c;
      }
    } catch {}
  }

  let isSwitching = false;
  try {
    const v = sessionStorage.getItem(SWITCHING_KEY);
    if (v) {
      sessionStorage.removeItem(SWITCHING_KEY);
      isSwitching = true;
    }
  } catch {}

  const targetCountry = startCountry && startCountry !== "cn" ? startCountry : CHINA_PATH.test(startUrl.pathname) && !isSwitching ? storedCountry : null;

  // If we landed on /cn/ due to server redirect, force a full page redirect (once)
  if (startCountry === "cn" && targetCountry) {
    const REDIRECT_KEY = "appleStoreRedirectGuard.forceRedirect";
    try {
      const attempts = parseInt(sessionStorage.getItem(REDIRECT_KEY) || "0");
      if (attempts < 1) {
        sessionStorage.setItem(REDIRECT_KEY, String(attempts + 1));
        const url = new URL(location.href);
        url.pathname = url.pathname.replace(/^\/cn(?=\/|$)/i, `/${targetCountry}`);
        window.location.href = url.href;
        return; // exit IIFE, page will reload at correct URL
      }
      sessionStorage.removeItem(REDIRECT_KEY);
    } catch {}
  }

  // Clear redirect counter when successfully on non-CN page
  if (startCountry && startCountry !== "cn") {
    try { sessionStorage.removeItem("appleStoreRedirectGuard.forceRedirect"); } catch {}
  }

  if (targetCountry) {
    globalThis[GUARD_MARKER] = { country: targetCountry, version: 3 };
  }

  const guarded = (rawUrl) => {
    if (rawUrl == null) return rawUrl;

    try {
      const url = new URL(String(rawUrl), location.href);
      if (url.hostname !== APPLE_HOST || !CHINA_PATH.test(url.pathname)) return rawUrl;
      if (!targetCountry) return rawUrl;
      if (sessionStorage.getItem(SWITCHING_KEY)) return rawUrl;

      // Replace /cn/ prefix with target country, preserve the rest of the path
      url.pathname = url.pathname.replace(/^\/cn(?=\/|$)/i, `/${targetCountry}`);
      return typeof rawUrl === "string" ? url.href : url;
    } catch {
      return rawUrl;
    }
  };

  const repairCurrentUrl = () => {
    if (!targetCountry || !CHINA_PATH.test(location.pathname)) return;

    const url = new URL(location.href);
    url.pathname = url.pathname.replace(/^\/cn(?=\/|$)/i, `/${targetCountry}`);
    history.replaceState(history.state, "", url.href);
  };

  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    if (typeof original !== "function") continue;

    Object.defineProperty(history, name, {
      configurable: true,
      value(...args) {
        args[2] = guarded(args[2]);
        const result = original.apply(this, args);
        repairCurrentUrl();
        return result;
      }
    });
  }

  if (globalThis.navigation?.navigate) {
    const original = globalThis.navigation.navigate;
    Object.defineProperty(globalThis.navigation, "navigate", {
      configurable: true,
      value(url, options) {
        const result = original.call(this, guarded(url), options);
        queueMicrotask(repairCurrentUrl);
        return result;
      }
    });
  }

  for (const name of ["assign", "replace"]) {
    const original = Location.prototype[name];
    if (typeof original !== "function") continue;

    try {
      Object.defineProperty(Location.prototype, name, {
        configurable: true,
        value(url) {
          return original.call(this, guarded(url));
        }
      });
    } catch {}
  }

  addEventListener("popstate", repairCurrentUrl, true);
  addEventListener("hashchange", repairCurrentUrl, true);
  queueMicrotask(repairCurrentUrl);

  const resolveNavTarget = () => {
    const nav = document.querySelector('nav[data-testid="navigation"]') || document.querySelector('nav');
    if (!nav) return null;
    const header = nav.querySelector('.navigation__header');
    if (header) return header;
    const target = nav.querySelector('[data-testid*="navigation"], [role="navigation"]');
    if (target) return target;
    return nav;
  };

  const applyStorefrontCookie = (code) => {
    const date = new Date();
    date.setFullYear(date.getFullYear() + 1);
    document.cookie = `geo=${code.toUpperCase()};domain=.apple.com;path=/;expires=${date.toUTCString()};secure;samesite=none`;
  };

  const clearItspodCookie = () => {
    document.cookie = "itspod=;domain=.apple.com;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT;secure;samesite=none";
  };

  const createCountrySwitcher = (activeCountry) => {
    const wrapper = document.createElement("div");
    wrapper.id = "apple-store-country-switcher";
    wrapper.style.cssText = "position:relative;display:inline-flex;align-items:center;height:44px;margin-left:12px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;";

    const button = document.createElement("button");
    const current = COUNTRIES.find((c) => c.code.toLowerCase() === activeCountry) || COUNTRIES[0];
    button.textContent = `${current.name} (${current.code})`;
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
        applyStorefrontCookie(country.code);
        clearItspodCookie();
        button.textContent = `${country.name} (${country.code})`;
        menu.style.display = "none";
        try {
          if (country.code.toLowerCase() === "cn") {
            // Switching to CN: disable guard, clear our cookie
            sessionStorage.removeItem(COUNTRY_STORAGE_KEY);
            sessionStorage.setItem(SWITCHING_KEY, "1");
            document.cookie = "__asgc=;domain=apps.apple.com;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT;secure;samesite=none";
          } else {
            // Switching to non-CN: update guard cookie so redirect protection works
            sessionStorage.setItem(COUNTRY_STORAGE_KEY, country.code.toLowerCase());
            sessionStorage.removeItem(SWITCHING_KEY);
            const date = new Date();
            date.setFullYear(date.getFullYear() + 1);
            document.cookie = `__asgc=${country.code.toUpperCase()};domain=apps.apple.com;path=/;expires=${date.toUTCString()};secure;samesite=none`;
          }
        } catch {}

        const url = new URL(location.href);
        url.pathname = `/${country.code.toLowerCase()}${url.pathname.replace(COUNTRY_PATH, "/")}`;
        window.location.href = url.href;
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
    const activeCountry = countryOf(new URL(location.href)) || targetCountry || "us";
    const existing = document.getElementById("apple-store-country-switcher");
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

  let observer;
  const scheduleInject = () => {
    if (document.getElementById("apple-store-country-switcher")) return;
    injectCountrySwitcher();
  };
  observer = new MutationObserver(scheduleInject);
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
