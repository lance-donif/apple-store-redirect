import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const background = await readFile("background.js", "utf8");
const guard = await readFile("guard.js", "utf8");
const fanqieCopy = await readFile("fanqie-copy.js", "utf8");

assert.equal(manifest.content_scripts[0].js[0], "guard.js");
assert.equal(manifest.content_scripts[0].run_at, "document_start");
assert.equal(manifest.content_scripts[0].world, "MAIN");
assert.deepEqual(manifest.content_scripts[1].matches, ["https://fanqienovel.com/reader/*"]);
assert.equal(manifest.content_scripts[1].js[0], "fanqie-copy.js");
assert.equal(manifest.content_scripts[1].run_at, "document_start");
assert.equal(manifest.content_scripts[1].world, "MAIN");
assert.equal(manifest.declarative_net_request.rule_resources[0].path, "rules.json");
assert.equal(manifest.background.service_worker, "background.js");
assert.ok(!background.match(/X-Apple-Store-Front/i));
assert.ok(!background.includes("operation: \"set\""));
assert.ok(background.includes("removeRuleIds: [LEGACY_STORE_FRONT_RULE_ID]"));

const rules = JSON.parse(await readFile("rules.json", "utf8"));
assert.equal(rules[0].action.requestHeaders[0].header, "x-apple-store-front");
assert.equal(rules[0].action.requestHeaders[0].operation, "remove");
assert.equal(rules[0].condition.resourceTypes[0], "main_frame");
assert.ok(!rules[0].action.requestHeaders.some((h) => h.header === "cookie"));

function runAt(href, storage = {}, cookie = "") {
  const calls = [];
  const styles = [];
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
        const element = { tagName, id: "", textContent: "", style: {}, children: [], append(...nodes) { this.children.push(...nodes); } };
        styles.push(element);
        return element;
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
      querySelector() {
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
    },
    queueMicrotask(callback) {
      callback();
    },
    setTimeout(callback) {
      callback();
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
  return { calls, context, local, session, styles };
}

const us = runAt("https://apps.apple.com/us/app/12-twelves/id6447656121");
us.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");
us.context.history.pushState({}, "", "/cn/iphone/today");
us.context.navigation.navigate("https://apps.apple.com/cn/iphone/today");
us.context.history.replaceState({}, "", "https://apps.apple.com/us/iphone/today");

assert.deepEqual(us.calls, [
  ["addEventListener", "copy"],
  ["addEventListener", "cut"],
  ["addEventListener", "contextmenu"],
  ["addEventListener", "selectstart"],
  ["addEventListener", "popstate"],
  ["addEventListener", "hashchange"],
  ["replaceState", {}, "", "https://apps.apple.com/us/iphone/today"],
  ["pushState", {}, "", "https://apps.apple.com/us/iphone/today"],
  ["navigate", "https://apps.apple.com/us/iphone/today", undefined],
  ["replaceState", {}, "", "https://apps.apple.com/us/iphone/today"]
]);
assert.match(us.styles[0].textContent, /user-select:\s*text/);
assert.equal(us.context.__appleStoreRedirectGuard.country, "us");
assert.equal(us.context.__appleStoreRedirectGuard.version, 3);
assert.equal(us.session.get("appleStoreRedirectGuard.country"), "us");
assert.equal(us.local.size, 1); // localStorage is no longer cleared (it breaks Apple's PWA bootstrap)

const jp = runAt("https://apps.apple.com/jp/app/%E5%9B%B3%E5%BD%A2%E9%9B%BB%E5%8D%93-shapeinfo-plus/id983851989");
jp.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");

assert.deepEqual(jp.calls, [
  ["addEventListener", "copy"],
  ["addEventListener", "cut"],
  ["addEventListener", "contextmenu"],
  ["addEventListener", "selectstart"],
  ["addEventListener", "popstate"],
  ["addEventListener", "hashchange"],
  ["replaceState", {}, "", "https://apps.apple.com/jp/iphone/today"]
]);

const redirectedCnToday = runAt("https://apps.apple.com/cn/iphone/today", {
  "appleStoreRedirectGuard.country": "us"
});

// Since force-redirect triggers immediately, no event listeners or states are replaced
// However, the test mock location updates the URL synchronously via setTimeout mock
assert.equal(redirectedCnToday.context.location.href, "https://apps.apple.com/us/iphone/today");

const restoredAppPath = runAt(
  "https://apps.apple.com/cn/iphone/today",
  { "appleStoreRedirectGuard.country": "us" },
  `__asgp=${encodeURIComponent("/us/app/12-twelves/id6447656121")}; __asgc=US`
);

assert.equal(restoredAppPath.context.location.href, "https://apps.apple.com/us/app/12-twelves/id6447656121");
assert.equal(restoredAppPath.calls[0][0], "replaceState");
assert.equal(restoredAppPath.session.has("appleStoreRedirectGuard.forceRedirect"), false);

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

const cn = runAt("https://apps.apple.com/cn/app/example/id1");
cn.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");

assert.equal(cn.calls.length, 7);

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

console.log("ok");
