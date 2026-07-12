import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const background = await readFile("background.js", "utf8");
const guard = await readFile("guard.js", "utf8");
const fanqieCopy = await readFile("fanqie-copy.js", "utf8");
const state = await readFile("state.js", "utf8");

assert.equal(manifest.content_scripts[0].js[0], "state.js");
assert.equal(manifest.content_scripts[0].run_at, "document_start");
assert.equal(manifest.content_scripts[0].world, "ISOLATED");
assert.equal(manifest.content_scripts[1].js[0], "guard.js");
assert.equal(manifest.content_scripts[1].run_at, "document_start");
assert.equal(manifest.content_scripts[1].world, "MAIN");
assert.deepEqual(manifest.content_scripts[2].matches, ["https://fanqienovel.com/reader/*"]);
assert.equal(manifest.content_scripts[2].js[0], "fanqie-copy.js");
assert.equal(manifest.content_scripts[2].run_at, "document_start");
assert.equal(manifest.content_scripts[2].world, "MAIN");
assert.match(state, /clearCountryIntent/);
assert.ok(!guard.includes("fetch response:"));
assert.ok(!guard.includes("class DebugXHR"));
assert.equal(manifest.declarative_net_request.rule_resources[0].path, "rules.json");
assert.equal(manifest.background.service_worker, "background.js");
assert.ok(manifest.permissions.includes("browsingData"));

// TC-STATE-001: Background can clear only the target tab's country intent.
{
  const values = new Map([
    ["appleStoreRedirectGuard.country", "us"],
    ["appleStoreRedirectGuard.appPath", encodeURIComponent("/us/app/example/id1")]
  ]);
  let messageListener;
  vm.runInNewContext(state, {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          }
        }
      }
    },
    sessionStorage: {
      getItem(key) {
        return values.get(key) ?? null;
      },
      removeItem(key) {
        values.delete(key);
      },
      setItem(key, value) {
        values.set(key, String(value));
      }
    }
  });

  messageListener({ type: "clearCountryIntent" });
  assert.equal(values.has("appleStoreRedirectGuard.country"), false);
  assert.equal(values.has("appleStoreRedirectGuard.appPath"), false);
  assert.equal(values.get("appleStoreRedirectGuard.switching"), "1");
}
assert.ok(!background.match(/X-Apple-Store-Front/i));
assert.ok(!background.includes("operation: \"set\""));
assert.ok(background.includes("removeRuleIds: [LEGACY_STORE_FRONT_RULE_ID, LEGACY_COUNTRY_REWRITE_RULE_ID]"));

const rules = JSON.parse(await readFile("rules.json", "utf8"));
assert.equal(rules[0].action.requestHeaders[0].header, "x-apple-store-front");
assert.equal(rules[0].action.requestHeaders[0].operation, "remove");
assert.ok(rules[0].condition.resourceTypes.includes("main_frame"));
assert.ok(rules[0].condition.resourceTypes.includes("xmlhttprequest"));
assert.ok(!rules[0].action.requestHeaders.some((h) => h.header === "cookie"));
assert.deepEqual(rules[1].condition.requestDomains, ["apps.apple.com"]);

async function runBackgroundNavigations(urls, cookies = {}) {
  const cookieSets = [];
  const cookieRemovals = [];
  const tabUpdates = [];
  const tabMessages = [];
  const cookieJar = new Map(Object.entries(cookies));
  let listener;
  const context = {
    URL,
    chrome: {
      cookies: {
        set(details) {
          cookieSets.push(details);
          cookieJar.set(details.name, details.value);
          return Promise.resolve(details);
        },
        get(details) {
          const value = cookieJar.get(details.name);
          return Promise.resolve(value == null ? null : { value });
        },
        remove(details) {
          cookieRemovals.push(details);
          cookieJar.delete(details.name);
          return Promise.resolve();
        }
      },
      tabs: {
        sendMessage(tabId, message) {
          tabMessages.push({ tabId, message });
          return Promise.resolve();
        },
        update(tabId, details) {
          tabUpdates.push({ tabId, ...details });
          return Promise.resolve(details);
        }
      },
      declarativeNetRequest: {
        updateSessionRules() {
          return Promise.resolve();
        }
      },
      browsingData: {
        remove() {
          return Promise.resolve();
        }
      },
      runtime: {
        onInstalled: {
          addListener() {}
        }
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    }
  };

  vm.runInNewContext(background, context);
  for (const navigation of urls) {
    const details = typeof navigation === "string"
      ? { frameId: 0, tabId: 1, url: navigation }
      : { frameId: 0, ...navigation };
    await listener(details);
  }
  return { cookieSets, cookieRemovals, tabUpdates, tabMessages };
}

async function runBackgroundInstall(reason) {
  const removals = [];
  const cookieRemovals = [];
  let installListener;
  const context = {
    URL,
    chrome: {
      cookies: {
        set() {
          return Promise.resolve();
        },
        remove(details) {
          cookieRemovals.push(details);
          return Promise.resolve();
        }
      },
      declarativeNetRequest: {
        updateSessionRules() {
          return Promise.resolve();
        }
      },
      browsingData: {
        remove(options, dataToRemove) {
          removals.push({ options, dataToRemove });
          return Promise.resolve();
        }
      },
      runtime: {
        onInstalled: {
          addListener(callback) {
            installListener = callback;
          }
        }
      },
      tabs: {
        update() {
          return Promise.resolve();
        }
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener() {}
        }
      }
    }
  };

  vm.runInNewContext(background, context);
  await installListener({ reason });
  return { removals, cookieRemovals };
}

{
  const { removals, cookieRemovals } = await runBackgroundInstall("install");
  assert.deepEqual(JSON.parse(JSON.stringify(removals)), [{
    options: { origins: ["https://apps.apple.com"] },
    dataToRemove: {
      cache: true,
      cacheStorage: true,
      fileSystems: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
      webSQL: true
    }
  }]);
  assert.ok(cookieRemovals.some((details) => details.name === "__asgp"));
}

// TC-INSTALL-002: Updates perform the same stale-state cleanup as fresh installs.
{
  const { removals, cookieRemovals } = await runBackgroundInstall("update");
  assert.equal(removals.length, 1);
  assert.ok(cookieRemovals.some((details) => details.name === "__asgp"));
}

// TC-INSTALL-003: Unrelated installation reasons do not clear site data.
{
  const { removals, cookieRemovals } = await runBackgroundInstall("chrome_update");
  assert.deepEqual(removals, []);
  assert.deepEqual(cookieRemovals, []);
}

{
  const { cookieSets, cookieRemovals, tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/us/app/12-twelves/id6447656121",
    "https://apps.apple.com/us/iphone/today",
    "https://apps.apple.com/cn/iphone/today"
  ]);
  const savedPaths = cookieSets.filter((details) => details.name === "__asgp").map((details) => details.value);

  assert.deepEqual(savedPaths, [encodeURIComponent("/us/app/12-twelves/id6447656121")]);
  assert.ok(cookieRemovals.some((details) => details.name === "__asgp"));
  assert.deepEqual(tabUpdates, [{
    tabId: 1,
    url: "https://apps.apple.com/us/app/12-twelves/id6447656121"
  }]);
}

// TC-SWITCH-CN-US-001: returning from CN reloads US after the geo cookie is ready.
{
  const { cookieSets, tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/us/iphone/today"
  ], { geo: "CN" });

  assert.ok(cookieSets.some((details) => details.name === "geo" && details.value === "US"));
  assert.deepEqual(tabUpdates, [{
    tabId: 1,
    url: "https://apps.apple.com/us/iphone/today"
  }]);
}

// TC-SWITCH-CN-US-002: the corrective reload does not loop once geo and guard are US.
{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/us/iphone/today"
  ], { geo: "US", __asgc: "US" });

  assert.deepEqual(tabUpdates, []);
}

// TC-SWITCH-CN-US-003: switching from CN does not trigger a duplicate reload
// when the country menu already prepared matching cookies.
{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/cn/iphone/today",
    "https://apps.apple.com/us/iphone/today"
  ], { geo: "US", __asgc: "US" });

  assert.deepEqual(tabUpdates, []);
}

{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/cn"
  ], {
    __asgc: "US",
    __asgp: encodeURIComponent("/us/app/12-twelves/id6447656121")
  });

  assert.deepEqual(tabUpdates, []);
}

{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/cn/iphone/today"
  ], {
    __asgc: "JP",
    __asgp: encodeURIComponent("/jp/app/standland/id1033409631")
  });

  assert.deepEqual(tabUpdates, []);
}

{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/cn",
    "https://apps.apple.com/cn"
  ], {
    __asgc: "US",
    __asgp: encodeURIComponent("/us/app/12-twelves/id6447656121")
  });

  assert.deepEqual(tabUpdates, []);
}

{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/cn"
  ], {
    __asgc: "US",
    __asgp: encodeURIComponent("/us/iphone/today")
  });

  assert.deepEqual(tabUpdates, []);
}

// TC-SEC-001: Saved paths with a non-standard origin must never be opened.
{
  const { tabUpdates } = await runBackgroundNavigations([
    "https://apps.apple.com/cn/iphone/today"
  ], {
    __asgc: "US",
    __asgp: encodeURIComponent("https://apps.apple.com:444/us/app/example/id1")
  });

  assert.deepEqual(tabUpdates, []);
}

{
  const { tabUpdates } = await runBackgroundNavigations([
    { tabId: 1, url: "https://apps.apple.com/us/app/12-twelves/id6447656121" },
    { tabId: 2, url: "https://apps.apple.com/jp/app/standland/id1033409631" },
    { tabId: 1, url: "https://apps.apple.com/cn/iphone/today" }
  ]);

  assert.deepEqual(tabUpdates, [
    { tabId: 1, url: "https://apps.apple.com/us/app/12-twelves/id6447656121" },
    { tabId: 2, url: "https://apps.apple.com/jp/app/standland/id1033409631" }
  ]);
}

// TC-NC-002: Countryless top-level navigation clears only that tab's stored intent.
{
  const { tabUpdates, tabMessages } = await runBackgroundNavigations([
    "https://apps.apple.com/us/app/12-twelves/id6447656121",
    "https://apps.apple.com/app/standland/id1033409631",
    "https://apps.apple.com/cn/iphone/today"
  ]);

  assert.deepEqual(tabUpdates, [{
    tabId: 1,
    url: "https://apps.apple.com/us/app/12-twelves/id6447656121"
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(tabMessages)), [{ tabId: 1, message: { type: "clearCountryIntent" } }]);
}

function runAt(href, storage = {}, cookie = "", deferTimeouts = false, injectNavigation = false) {
  const calls = [];
  const listeners = {};
  const timers = [];
  const styles = [];
  const navChildren = [];
  const nav = {
    querySelector() {
      return null;
    },
    append(...nodes) {
      navChildren.push(...nodes);
    }
  };
  let cookieJar = cookie;
  let currentUrl = new URL(href);
  const location = {
    get href() {
      return currentUrl.href;
    },
    set href(value) {
      currentUrl = new URL(String(value), currentUrl.href);
    },
    get hostname() {
      return currentUrl.hostname;
    },
    get pathname() {
      return currentUrl.pathname;
    }
  };
  const session = new Map(Object.entries(storage));
  const local = new Map([["storefront", "cn"]]);
  const updateLocation = (url) => {
    if (url != null) location.href = url;
  };
  const context = {
    URL,
    decodeURIComponent,
    location,
    sessionStorage: {
      clear() {
        session.clear();
      },
      getItem(key) {
        return session.get(key) ?? null;
      },
      removeItem(key) {
        session.delete(key);
      },
      setItem(key, value) {
        session.set(key, String(value));
      }
    },
    localStorage: {
      clear() {
        local.clear();
      }
    },
    document: {
      readyState: "complete",
      getElementById(id) {
        return styles.find((style) => style.id === id) ?? null;
      },
      createElement(tagName) {
        const element = {
          tagName,
          id: "",
          textContent: "",
          style: {},
          dataset: {},
          children: [],
          append(...nodes) { this.children.push(...nodes); },
          contains() { return false; },
          remove() {}
        };
        styles.push(element);
        return element;
      },
      addEventListener() {},
      contains() {
        return true;
      },
      get cookie() {
        return cookieJar;
      },
      set cookie(value) {
        cookieJar = cookieJar ? `${cookieJar}; ${value}` : String(value);
      },
      documentElement: {
        style: {},
        append() {}
      },
      evaluate() {
        return { singleNodeValue: null };
      },
      querySelector(selector) {
        if (injectNavigation && (selector === 'nav[data-testid="navigation"]' || selector === "nav")) return nav;
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    XPathResult: { FIRST_ORDERED_NODE_TYPE: 9 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener(eventName) {
      calls.push(["addEventListener", eventName]);
      listeners[eventName] ??= [];
      listeners[eventName].push(arguments[1]);
    },
    dispatchEvent(event) {
      calls.push(["dispatchEvent", event.type]);
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    PopStateEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    queueMicrotask(callback) {
      callback();
    },
    setTimeout(callback) {
      if (deferTimeouts) timers.push(callback);
      else callback();
    },
    history: {
      state: null,
      pushState(...args) {
        calls.push(["pushState", ...args]);
        updateLocation(args[2]);
      },
      replaceState(...args) {
        calls.push(["replaceState", ...args]);
        updateLocation(args[2]);
      }
    },
    navigation: {
      addEventListener(eventName, callback) {
        listeners[`navigation:${eventName}`] ??= [];
        listeners[`navigation:${eventName}`].push(callback);
      },
      navigate(...args) {
        calls.push(["navigate", ...args]);
      }
    },
    Location: class {
      assign(url) {
        calls.push(["assign", url]);
        updateLocation(url);
      }
      replace(url) {
        calls.push(["replace", url]);
        updateLocation(url);
      }
    }
  };
  context.window = context;

  vm.runInNewContext(guard, context);
  return { calls, context, listeners, local, navChildren, session, styles, timers, get cookie() { return cookieJar; } };
}

const us = runAt("https://apps.apple.com/us/app/12-twelves/id6447656121");
us.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
us.context.history.pushState({}, "", "/cn/iphone/today");
us.context.navigation.navigate("https://apps.apple.com/cn/iphone/today");
us.context.history.replaceState({}, "", "https://apps.apple.com/us/iphone/today");

assert.deepEqual(us.calls, [
  ["addEventListener", "click"],
  ["addEventListener", "copy"],
  ["addEventListener", "cut"],
  ["addEventListener", "contextmenu"],
  ["addEventListener", "selectstart"],
  ["addEventListener", "popstate"],
  ["addEventListener", "hashchange"],
  ["replaceState", {}, "", "https://apps.apple.com/us/app/12-twelves/id6447656121"],
  ["pushState", {}, "", "https://apps.apple.com/us/app/12-twelves/id6447656121"],
  ["navigate", "https://apps.apple.com/us/app/12-twelves/id6447656121", undefined],
  ["replaceState", {}, "", "https://apps.apple.com/us/iphone/today"]
]);
assert.match(us.styles[0].textContent, /user-select:\s*text/);
assert.equal(us.context.__appleStoreRedirectGuard.country, "us");
assert.equal(us.context.__appleStoreRedirectGuard.version, 3);
assert.equal(Object.getOwnPropertyDescriptor(us.context.history, "pushState").writable, true);
assert.equal(Object.getOwnPropertyDescriptor(us.context.navigation, "navigate").writable, true);
assert.equal(Object.getOwnPropertyDescriptor(us.context.Location.prototype, "assign").writable, true);
assert.equal(us.session.get("appleStoreRedirectGuard.country"), "us");
assert.equal(us.local.size, 1); // localStorage is no longer cleared (it breaks Apple's PWA bootstrap)

const clickedAppNavigation = runAt(
  "https://apps.apple.com/us/iphone/today",
  {},
  `__asgp=${encodeURIComponent("/us/iphone/today")}; __asgc=US`
);
clickedAppNavigation.listeners.click[0]({
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/us/app/standland/id1033409631" } : null;
    }
  }
});

assert.equal(clickedAppNavigation.context.location.href, "https://apps.apple.com/us/app/standland/id1033409631");
assert.match(clickedAppNavigation.cookie, new RegExp(`__asgp=${encodeURIComponent("/us/app/standland/id1033409631")}`));
assert.match(clickedAppNavigation.cookie, /geo=US/);
assert.match(clickedAppNavigation.cookie, /itspod=;/);
assert.match(clickedAppNavigation.cookie, /__asgp=;/);
clickedAppNavigation.context.history.replaceState({}, "");
clickedAppNavigation.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.deepEqual(clickedAppNavigation.calls.at(-1), [
  "replaceState",
  {},
  "",
  "https://apps.apple.com/us/app/standland/id1033409631"
]);
clickedAppNavigation.listeners.click[0]({
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/us/iphone/today" } : null;
    }
  }
});
clickedAppNavigation.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.deepEqual(clickedAppNavigation.calls.at(-1), [
  "replaceState",
  {},
  "",
  "https://apps.apple.com/us/iphone/today"
]);

let categoryDefaultPrevented = false;
let categoryPropagationStopped = false;
const sameStorefrontCategoryNavigation = runAt("https://apps.apple.com/jp/iphone/today");
sameStorefrontCategoryNavigation.listeners.click[0]({
  button: 0,
  preventDefault() { categoryDefaultPrevented = true; },
  stopImmediatePropagation() { categoryPropagationStopped = true; },
  target: {
    closest(selector) {
      return selector === "a[href]"
        ? { href: "https://apps.apple.com/jp/iphone/grouping/25241", target: "", hasAttribute() { return false; } }
        : null;
    }
  }
});
assert.equal(categoryDefaultPrevented, true);
assert.equal(categoryPropagationStopped, true);
assert.equal(sameStorefrontCategoryNavigation.context.location.href, "https://apps.apple.com/jp/iphone/grouping/25241");

const countrylessNavigation = runAt(
  "https://apps.apple.com/us/iphone/today",
  {},
  `__asgc=US; __asgp=${encodeURIComponent("/us/app/12-twelves/id6447656121")}`
);
countrylessNavigation.listeners.click[0]({
  button: 0,
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/app/standland/id1033409631" } : null;
    }
  }
});
countrylessNavigation.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.equal(countrylessNavigation.context.location.href, "https://apps.apple.com/cn/iphone/today");
assert.equal(countrylessNavigation.session.get("appleStoreRedirectGuard.switching"), "1");

// TC-NAV-404-001
// Precondition: The user switches from a US App page to JP via the extension menu,
// and the App is unavailable in JP, leaving the tab on the JP 404 App URL.
// Step: Click Apple's Today link; Apple then attempts a CN storefront fallback.
// Expected: The stale JP App path is cleared and the tab stays on the JP Today page.
const unavailableJpAppHomeNavigation = runAt(
  "https://apps.apple.com/jp/app/paramount/id530168168",
  {
    "appleStoreRedirectGuard.country": "jp",
    "appleStoreRedirectGuard.appPath": encodeURIComponent("/jp/app/paramount/id530168168")
  },
  `__asgc=JP; __asgp=${encodeURIComponent("/jp/app/paramount/id530168168")}`
);
unavailableJpAppHomeNavigation.listeners.click[0]({
  button: 0,
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/jp/iphone/today" } : null;
    }
  }
});
assert.equal(unavailableJpAppHomeNavigation.session.has("appleStoreRedirectGuard.appPath"), false);
unavailableJpAppHomeNavigation.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.equal(unavailableJpAppHomeNavigation.context.location.href, "https://apps.apple.com/jp/iphone/today");

const crossCountryNavigation = runAt("https://apps.apple.com/us/iphone/today");
crossCountryNavigation.listeners.click[0]({
  button: 0,
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/jp/iphone/today" } : null;
    }
  }
});
crossCountryNavigation.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.equal(crossCountryNavigation.context.location.href, "https://apps.apple.com/jp/iphone/today");
assert.equal(crossCountryNavigation.session.get("appleStoreRedirectGuard.country"), "jp");

const modifiedClickNavigation = runAt("https://apps.apple.com/us/iphone/today");
modifiedClickNavigation.listeners.click[0]({
  button: 0,
  metaKey: true,
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/us/app/standland/id1033409631" } : null;
    }
  }
});
modifiedClickNavigation.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.equal(modifiedClickNavigation.context.location.href, "https://apps.apple.com/us/iphone/today");

const popstateAppNavigation = runAt(
  "https://apps.apple.com/us/iphone/today",
  {},
  "__asgc=US"
);
popstateAppNavigation.listeners.click[0]({
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/us/app/standland/id1033409631" } : null;
    }
  }
});
popstateAppNavigation.context.location.href = "https://apps.apple.com/cn/iphone/today";
popstateAppNavigation.listeners.popstate[0]();
assert.equal(popstateAppNavigation.context.location.href, "https://apps.apple.com/us/app/standland/id1033409631");

const locationAppNavigation = runAt(
  "https://apps.apple.com/us/iphone/today",
  {},
  "__asgc=US"
);
locationAppNavigation.listeners.click[0]({
  target: {
    closest(selector) {
      return selector === "a[href]" ? { href: "https://apps.apple.com/us/app/standland/id1033409631" } : null;
    }
  }
});
locationAppNavigation.context.Location.prototype.assign.call(
  locationAppNavigation.context.location,
  "https://apps.apple.com/cn/iphone/today"
);
assert.equal(locationAppNavigation.context.location.href, "https://apps.apple.com/us/app/standland/id1033409631");

const spaAppNavigation = runAt(
  "https://apps.apple.com/us/iphone/today",
  {},
  `__asgp=${encodeURIComponent("/us/iphone/today")}; __asgc=US`
);
spaAppNavigation.context.history.pushState({}, "", "https://apps.apple.com/us/app/standland/id1033409631");

assert.match(spaAppNavigation.cookie, new RegExp(`__asgp=${encodeURIComponent("/us/app/standland/id1033409631")}`));

const jp = runAt("https://apps.apple.com/jp/app/%E5%9B%B3%E5%BD%A2%E9%9B%BB%E5%8D%93-shapeinfo-plus/id983851989");
jp.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");

assert.deepEqual(jp.calls, [
  ["addEventListener", "click"],
  ["addEventListener", "copy"],
  ["addEventListener", "cut"],
  ["addEventListener", "contextmenu"],
  ["addEventListener", "selectstart"],
  ["addEventListener", "popstate"],
  ["addEventListener", "hashchange"],
  ["replaceState", {}, "", "https://apps.apple.com/jp/app/%E5%9B%B3%E5%BD%A2%E9%9B%BB%E5%8D%93-shapeinfo-plus/id983851989"]
]);

const redirectedCnToday = runAt("https://apps.apple.com/cn/iphone/today", {
  "appleStoreRedirectGuard.country": "us"
});

// Since force-redirect triggers immediately, no event listeners or states are replaced
// However, the test mock location updates the URL synchronously via setTimeout mock
assert.equal(redirectedCnToday.context.location.href, "https://apps.apple.com/us/iphone/today");

const delayedSavedPath = runAt(
  "https://apps.apple.com/cn/iphone/today",
  { "appleStoreRedirectGuard.country": "us" },
  "__asgc=US",
  true
);
assert.equal(delayedSavedPath.context.location.href, "https://apps.apple.com/cn/iphone/today");
delayedSavedPath.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.equal(delayedSavedPath.context.location.href, "https://apps.apple.com/cn/iphone/today");
delayedSavedPath.context.document.cookie = `__asgp=${encodeURIComponent("/us/app/12-twelves/id6447656121")}`;
delayedSavedPath.timers.shift()();
assert.equal(delayedSavedPath.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");

const perTabSavedPath = runAt(
  "https://apps.apple.com/cn/iphone/today",
  {
    "appleStoreRedirectGuard.country": "us",
    "appleStoreRedirectGuard.appPath": encodeURIComponent("/us/app/12-twelves/id6447656121")
  },
  `__asgc=US; __asgp=${encodeURIComponent("/jp/app/standland/id1033409631")}`
);
assert.equal(perTabSavedPath.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");

const restoredAppPath = runAt(
  "https://apps.apple.com/cn/iphone/today",
  { "appleStoreRedirectGuard.country": "us" },
  `__asgp=${encodeURIComponent("/us/app/12-twelves/id6447656121")}; __asgc=US`
);

assert.equal(restoredAppPath.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");
restoredAppPath.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
assert.equal(restoredAppPath.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");
assert.equal(restoredAppPath.calls[0][0], "replaceState");
assert.equal(restoredAppPath.session.has("appleStoreRedirectGuard.forceRedirect"), false);
assert.ok(restoredAppPath.calls.some((call) => call[0] === "dispatchEvent" && call[1] === "popstate"));

const mismatchedSavedCountry = runAt(
  "https://apps.apple.com/cn/iphone/today",
  { "appleStoreRedirectGuard.country": "us" },
  `__asgp=${encodeURIComponent("/jp/app/standland/id1033409631")}; __asgc=US`
);
assert.equal(mismatchedSavedCountry.context.location.href, "https://apps.apple.com/us/iphone/today");

const restoredWithStaleCounter = runAt(
  "https://apps.apple.com/cn/iphone/today",
  {
    "appleStoreRedirectGuard.country": "us",
    "appleStoreRedirectGuard.forceRedirect": "1"
  },
  `__asgp=${encodeURIComponent("/us/app/12-twelves/id6447656121")}; __asgc=US`
);

assert.equal(restoredWithStaleCounter.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");
assert.equal(restoredWithStaleCounter.session.has("appleStoreRedirectGuard.forceRedirect"), false);
assert.ok(restoredWithStaleCounter.calls.some((call) => call[0] === "dispatchEvent" && call[1] === "popstate"));

const backToHome = runAt("https://apps.apple.com/us/app/standland/id1033409631");
backToHome.context.location.href = "https://apps.apple.com/us/iphone/today";
backToHome.listeners.popstate[0]();
backToHome.context.location.href = "https://apps.apple.com/cn/iphone/today";
backToHome.listeners.popstate[0]();
assert.equal(backToHome.context.location.href, "https://apps.apple.com/us/iphone/today");

// TC-SWITCH-CN-001
// Precondition: A JP App path is stored after browsing the JP storefront.
// Step: Select China mainland from the extension's country menu.
// Expected: The JP App path is removed before navigating to the CN storefront.
const switchFromJpToCn = runAt(
  "https://apps.apple.com/jp/app/example/id1",
  {
    "appleStoreRedirectGuard.country": "jp",
    "appleStoreRedirectGuard.appPath": encodeURIComponent("/jp/app/example/id1")
  },
  `__asgc=JP; __asgp=${encodeURIComponent("/jp/app/example/id1")}`,
  false,
  true
);
const cnMenuItem = switchFromJpToCn.styles.find((element) => element.innerHTML?.includes("中国大陆"));
assert.ok(cnMenuItem);
cnMenuItem.onclick();
assert.equal(switchFromJpToCn.session.has("appleStoreRedirectGuard.appPath"), false);
assert.match(switchFromJpToCn.cookie, /__asgp=;/);
assert.equal(switchFromJpToCn.context.location.href, "https://apps.apple.com/cn/app/example/id1");

const cn = runAt("https://apps.apple.com/cn/app/example/id1");
cn.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");

assert.equal(cn.calls.length, 8);

{
  const listeners = {};
  const styles = [];
  let removed = false;
  let observed = false;
  const readerElement = {
    nodeType: 1,
    classList: {
      remove(value) {
        if (value === "noselect") removed = true;
      }
    },
    closest(selector) {
      return selector === ".muye-reader-content" ? this : null;
    }
  };
  const textNode = { parentElement: readerElement };
  const context = {
    location: { hostname: "fanqienovel.com" },
    document: {
      documentElement: {
        append(node) {
          styles.push(node);
        }
      },
      getElementById(id) {
        return styles.find((style) => style.id === id) ?? null;
      },
      createElement(tagName) {
        return { tagName, id: "", textContent: "" };
      },
      querySelectorAll(selector) {
        return selector === ".muye-reader-content.noselect" ? [readerElement] : [];
      }
    },
    addEventListener(eventName, callback) {
      listeners[eventName] = callback;
    },
    getSelection() {
      return { isCollapsed: false, anchorNode: textNode, focusNode: textNode };
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        observed = true;
      }
    }
  };
  context.globalThis = context;

  vm.runInNewContext(fanqieCopy, context);

  let stopped = false;
  listeners.copy({ type: "copy", stopImmediatePropagation() { stopped = true; } });

  assert.equal(removed, true);
  assert.equal(observed, true);
  assert.match(styles[0].textContent, /user-select:\s*text/);
  assert.equal(stopped, true);
}

// Test client-side routing loop protection
{
  const loopTest = runAt("https://apps.apple.com/us/app/12-twelves/id6447656121");
  // The initial page load set the country intent to 'us'.
  // Now we simulate the SPA repeatedly trying to transition to a 'cn' URL.
  // The first 6 times, it should be successfully rewritten to the pending US app URL.
  for (let i = 0; i < 6; i++) {
    loopTest.context.history.replaceState({}, "", "https://apps.apple.com/cn/app/example/id1");
    assert.equal(loopTest.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");
  }
  // The 7th time, the loop safeguard triggers.
  // The URL should not be rewritten, and targetCountry/intent is cleared.
  loopTest.context.history.replaceState({}, "", "https://apps.apple.com/cn/app/example/id1");
  assert.equal(loopTest.context.location.href, "https://apps.apple.com/cn/app/example/id1");
}

// Test background reload loop protection
{
  // We simulate 4 consecutive navigations to the same JP URL on tab 1.
  // We mock chrome.cookies.get to always return a geo value of 'cn',
  // which forces needsReload to be true every time.
  const cookieSets = [];
  const cookieRemovals = [];
  const tabUpdates = [];
  const cookieJar = new Map();
  let listener;
  const context = {
    URL,
    chrome: {
      cookies: {
        set(details) {
          cookieSets.push(details);
          cookieJar.set(details.name, details.value);
          return Promise.resolve(details);
        },
        get(details) {
          // Always return 'cn' for geo to simulate a reload loop scenario
          if (details.name === "geo") return Promise.resolve({ value: "cn" });
          const value = cookieJar.get(details.name);
          return Promise.resolve(value == null ? null : { value });
        },
        remove(details) {
          cookieRemovals.push(details);
          cookieJar.delete(details.name);
          return Promise.resolve();
        }
      },
      tabs: {
        sendMessage() { return Promise.resolve(); },
        update(tabId, details) {
          tabUpdates.push({ tabId, ...details });
          return Promise.resolve(details);
        }
      },
      declarativeNetRequest: { updateSessionRules() { return Promise.resolve(); } },
      browsingData: { remove() { return Promise.resolve(); } },
      runtime: { onInstalled: { addListener() {} } },
      webNavigation: { onBeforeNavigate: { addListener(cb) { listener = cb; } } }
    }
  };
  vm.runInNewContext(background, context);

  // Trigger 4 navigations to the same US URL
  const nav = { frameId: 0, tabId: 1, url: "https://apps.apple.com/us/app/12-twelves/id6447656121" };
  await listener(nav);
  await listener(nav);
  await listener(nav);
  // Total 3 updates triggered so far
  assert.equal(tabUpdates.length, 3);

  // The 4th navigation triggers the safeguard, clearing cookies and NOT updating the tab again
  await listener(nav);
  assert.equal(tabUpdates.length, 3); // Still 3, no 4th update

  // Verify that the safeguard removed the guard/intent cookies
  const removedNames = cookieRemovals.map(d => d.name);
  assert.ok(removedNames.includes("__asgp"));
  assert.ok(removedNames.includes("__asgc"));
  assert.ok(removedNames.includes("geo"));
}

// Test switching from CN to JP via menu
{
  const switchFromCnToJp = runAt(
    "https://apps.apple.com/cn/app/example/id1",
    {},
    "",
    false,
    true
  );
  const jpMenuItem = switchFromCnToJp.styles.find((element) => element.innerHTML?.includes("日本"));
  assert.ok(jpMenuItem);
  jpMenuItem.onclick();

  // Verify storage has target country
  assert.equal(switchFromCnToJp.session.get("appleStoreRedirectGuard.country"), "jp");
  // Verify cookie contains __asgc=JP
  assert.match(switchFromCnToJp.cookie, /__asgc=JP/);
  // Verify host-specific geo cookie is cleared first (so geo=; is present)
  assert.match(switchFromCnToJp.cookie, /geo=;/);
  // Verify domain-specific geo cookie is set to JP
  assert.match(switchFromCnToJp.cookie, /geo=JP/);
  // Verify navigation targeted JP URL
  assert.equal(switchFromCnToJp.context.location.href, "https://apps.apple.com/jp/app/example/id1");
}

// TC-REWRITE-001: navigating to a non-CN page installs a session rule that
// rewrites /cn/ API requests to the target country.
{
  const sessionRuleCalls = [];
  const cookieJar = new Map();
  let listener;
  const context = {
    URL,
    chrome: {
      cookies: {
        set(details) {
          cookieJar.set(details.name, details.value);
          return Promise.resolve(details);
        },
        get(details) {
          const value = cookieJar.get(details.name);
          return Promise.resolve(value == null ? null : { value });
        },
        remove(details) {
          cookieJar.delete(details.name);
          return Promise.resolve();
        }
      },
      tabs: {
        sendMessage() { return Promise.resolve(); },
        update(tabId, details) {
          return Promise.resolve(details);
        }
      },
      declarativeNetRequest: {
        updateSessionRules(details) {
          sessionRuleCalls.push(details);
          return Promise.resolve();
        }
      },
      browsingData: { remove() { return Promise.resolve(); } },
      runtime: { onInstalled: { addListener() {} } },
      webNavigation: {
        onBeforeNavigate: { addListener(cb) { listener = cb; } }
      }
    }
  };

  vm.runInNewContext(background, context);
  await listener({ frameId: 0, tabId: 1, url: "https://apps.apple.com/jp/iphone/today" });

  const lastCall = sessionRuleCalls[sessionRuleCalls.length - 1];
  assert.ok(lastCall.addRules, "expected addRules to be present, got: " + JSON.stringify(sessionRuleCalls));
  assert.equal(lastCall.addRules.length, 1);
  const rewriteRule = lastCall.addRules[0];
  assert.equal(rewriteRule.action.type, "redirect");
  assert.ok(rewriteRule.action.redirect, "redirect property missing from action");
  assert.equal(rewriteRule.action.redirect.regexSubstitution, "https://apps.apple.com/jp\\1");
  assert.equal(rewriteRule.condition.regexFilter, "^https://apps\\.apple\\.com/cn(/.*)$");
  assert.deepEqual(Array.from(rewriteRule.condition.tabIds), [1]);
  assert.equal(rewriteRule.id, 10000);
  assert.ok(rewriteRule.condition.resourceTypes.includes("xmlhttprequest"));
}

// TC-CN-GEO-001: navigating to CN does NOT change the geo cookie,
// so the geo stays matching the fake IP (non-CN).
{
  const cookieJar = new Map([["geo", "US"], ["__asgc", "US"]]);
  const cookieSets = [];
  let listener;
  const context = {
    URL,
    chrome: {
      cookies: {
        set(details) {
          cookieSets.push(details);
          cookieJar.set(details.name, details.value);
          return Promise.resolve(details);
        },
        get(details) {
          const value = cookieJar.get(details.name);
          return Promise.resolve(value == null ? null : { value });
        },
        remove(details) {
          cookieJar.delete(details.name);
          return Promise.resolve();
        }
      },
      tabs: {
        sendMessage() { return Promise.resolve(); },
        update() { return Promise.resolve(); }
      },
      declarativeNetRequest: {
        updateSessionRules() { return Promise.resolve(); }
      },
      browsingData: { remove() { return Promise.resolve(); } },
      runtime: { onInstalled: { addListener() {} } },
      webNavigation: {
        onBeforeNavigate: { addListener(cb) { listener = cb; } }
      }
    }
  };

  vm.runInNewContext(background, context);
  await listener({ frameId: 0, tabId: 1, url: "https://apps.apple.com/cn/iphone/today" });

  // geo cookie should NOT be set to CN
  assert.equal(cookieJar.get("geo"), "US", "geo should stay US (matching fake IP) when navigating to CN");
}

console.log("ok");
