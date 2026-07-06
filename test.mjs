import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const guard = await readFile("guard.js", "utf8");

assert.equal(manifest.content_scripts[0].js[0], "guard.js");
assert.equal(manifest.content_scripts[0].run_at, "document_start");
assert.equal(manifest.content_scripts[0].world, "MAIN");
assert.equal(manifest.declarative_net_request.rule_resources[0].path, "rules.json");
assert.equal(manifest.background.service_worker, "background.js");

const rules = JSON.parse(await readFile("rules.json", "utf8"));
assert.equal(rules[0].action.requestHeaders[0].header, "x-apple-store-front");
assert.equal(rules[0].action.requestHeaders[0].operation, "remove");
assert.equal(rules[0].condition.resourceTypes[0], "main_frame");
assert.ok(!rules[0].action.requestHeaders.some((h) => h.header === "cookie"));

function runAt(href, storage = {}) {
  const calls = [];
  const styles = [];
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
    location,
    sessionStorage: {
      clear() {
        session.clear();
      },
      getItem(key) {
        return session.get(key) ?? null;
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
      getElementById(id) {
        return styles.find((style) => style.id === id) ?? null;
      },
      createElement(tagName) {
        const element = { tagName, id: "", textContent: "" };
        styles.push(element);
        return element;
      },
      documentElement: {
        append() {}
      }
    },
    addEventListener(eventName) {
      calls.push(["addEventListener", eventName]);
    },
    queueMicrotask(callback) {
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
assert.equal(us.local.size, 0);

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

assert.equal(redirectedCnToday.context.__appleStoreRedirectGuard.country, "us");
assert.deepEqual(redirectedCnToday.calls, [
  ["addEventListener", "copy"],
  ["addEventListener", "cut"],
  ["addEventListener", "contextmenu"],
  ["addEventListener", "selectstart"],
  ["addEventListener", "popstate"],
  ["addEventListener", "hashchange"],
  ["replaceState", null, "", "https://apps.apple.com/us/iphone/today"]
]);

const cn = runAt("https://apps.apple.com/cn/app/example/id1");
cn.context.history.replaceState({}, "", "https://apps.apple.com/cn/iphone/today");

assert.equal(cn.calls.length, 5);

console.log("ok");
