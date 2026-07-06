(() => {
  const APPLE_HOST = "apps.apple.com";
  const COUNTRY_PATH = /^\/([a-z]{2})(?:\/|$)/i;
  const CHINA_TODAY_PATH = /^\/cn\/iphone\/today\/?$/i;
  const GUARD_MARKER = "__appleStoreRedirectGuard";
  const COUNTRY_STORAGE_KEY = "appleStoreRedirectGuard.country";

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
})();
