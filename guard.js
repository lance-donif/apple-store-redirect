(() => {
  const APPLE_HOST = "apps.apple.com";
  const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
  const CHINA_TODAY_PATH = /^\/cn\/iphone\/today\/?$/i;
  const GUARD_MARKER = "__appleStoreRedirectGuard";
  const COUNTRY_STORAGE_KEY = "appleStoreRedirectGuard.country";

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

  const storedCountry = (() => {
    try {
      const country = sessionStorage.getItem(COUNTRY_STORAGE_KEY);
      return /^[a-z]{2}$/.test(country) && country !== "cn" ? country : null;
    } catch {
      return null;
    }
  })();

  const targetCountry = startCountry && startCountry !== "cn" ? startCountry : CHINA_TODAY_PATH.test(startUrl.pathname) ? storedCountry : null;
  if (!targetCountry) return;

  globalThis[GUARD_MARKER] = { country: targetCountry, version: 3 };

  const guarded = (rawUrl) => {
    if (rawUrl == null) return rawUrl;

    try {
      const url = new URL(String(rawUrl), location.href);
      if (url.hostname !== APPLE_HOST || !CHINA_TODAY_PATH.test(url.pathname)) return rawUrl;

      url.pathname = `/${targetCountry}/iphone/today`;
      return typeof rawUrl === "string" ? url.href : url;
    } catch {
      return rawUrl;
    }
  };

  const repairCurrentUrl = () => {
    if (!CHINA_TODAY_PATH.test(location.pathname)) return;

    const url = new URL(location.href);
    url.pathname = `/${targetCountry}/iphone/today`;
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

  const injectCountrySwitcher = () => {
    const NAV_SELECTOR = "/html/body/div/div/div[1]/div/nav";
    const TARGET_SELECTOR = "/html/body/div/div/div[1]/div/nav/div[2]/div[1]/div[2]";

    const target = document.evaluate(
      TARGET_SELECTOR,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
    if (!target || document.getElementById("apple-store-country-switcher")) return;

    const wrapper = document.createElement("div");
    wrapper.id = "apple-store-country-switcher";
    wrapper.style.cssText = "position:relative;display:inline-flex;align-items:center;height:44px;margin-left:12px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;";

    const button = document.createElement("button");
    const current = COUNTRIES.find((c) => c.code.toLowerCase() === targetCountry) || COUNTRIES[0];
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

    const applyStorefrontCookie = (code) => {
      const date = new Date();
      date.setFullYear(date.getFullYear() + 1);
      document.cookie = `geo=${code.toUpperCase()};domain=.apple.com;path=/;expires=${date.toUTCString()};secure;samesite=none`;
    };

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
        button.textContent = `${country.name} (${country.code})`;
        menu.style.display = "none";
        const url = new URL(location.href);
        url.pathname = `/${country.code.toLowerCase()}${url.pathname.replace(COUNTRY_PATH, "/")}`;
        location.assign(url.href);
      };
      menu.append(item);
    }

    button.onclick = () => {
      const isOpen = menu.style.display === "block";
      menu.style.display = isOpen ? "none" : "block";
    };

    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) menu.style.display = "none";
    });

    wrapper.append(button, menu);
    target.append(wrapper);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectCountrySwitcher);
  } else {
    injectCountrySwitcher();
  }
})();
