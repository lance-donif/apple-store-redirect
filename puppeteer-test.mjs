import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = process.cwd();
const EXTENSION_FILES = [
  "manifest.json",
  "background.js",
  "guard.js",
  "state.js",
  "fanqie-copy.js",
  "rules.json",
  "country-switch.png"
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "appleUs-ext-"));
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "appleUs-profile-"));
for (const file of EXTENSION_FILES) {
  await fs.copyFile(path.join(ROOT, file), path.join(extensionDir, file));
}

const browser = await puppeteer.launch({
  headless: false,
  executablePath: await puppeteer.executablePath(),
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ],
  ignoreDefaultArgs: ["--disable-extensions"],
  userDataDir: profileDir,
  defaultViewport: { width: 1280, height: 900 }
});

async function navigate(page, url, country) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    if (!String(error).includes("ERR_ABORTED")) throw error;
  }
  await page.waitForFunction(
    (expected) => location.pathname.startsWith(`/${expected}/`) &&
      document.querySelector("#apple-store-country-switcher button"),
    { timeout: 45000 },
    country
  );
  await wait(1500);
}

async function switchCountry(page, code) {
  const clicked = await page.evaluate((wanted) => {
    const root = document.getElementById("apple-store-country-switcher");
    const button = root?.querySelector("button");
    const menu = button?.nextElementSibling;
    button?.click();
    const item = [...(menu?.children || [])].find(
      (element) => element.lastElementChild?.textContent?.trim() === wanted
    );
    item?.click();
    return Boolean(item);
  }, code);
  assert.equal(clicked, true, `${code} country menu item should exist`);
  await page.waitForFunction(
    (expected) => location.pathname.startsWith(`/${expected.toLowerCase()}/`) &&
      document.querySelector("#apple-store-country-switcher button")?.textContent?.includes(`(${expected})`),
    { timeout: 45000 },
    code
  );
  await wait(1500);
}

try {
  await wait(1200);
  // The MV3 worker starts lazily, so poll instead of assuming a fixed delay.
  const findServiceWorker = () => browser.targets().find(
    (target) => target.type() === "service_worker" && target.url().endsWith("/background.js")
  );
  let serviceWorkerTarget;
  for (let attempt = 0; attempt < 40 && !serviceWorkerTarget; attempt++) {
    serviceWorkerTarget = findServiceWorker();
    if (!serviceWorkerTarget) await wait(250);
  }
  assert.ok(serviceWorkerTarget, "extension service worker should be running");
  const worker = await serviceWorkerTarget.worker();

  const pageErrors = [];
  const mainNavigations = [];
  const catalogStatuses = [];
  const page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainNavigations.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (/\/api\/apps\/v1\/catalog\/jp\/apps\//.test(response.url())) {
      catalogStatuses.push(response.status());
    }
  });

  await navigate(page, "https://apps.apple.com/gb/iphone/today", "gb");
  const gbState = await page.evaluate(() => ({
    url: location.href,
    guard: globalThis.__appleStoreRedirectGuard,
    switcher: document.querySelector("#apple-store-country-switcher button")?.textContent,
    cookie: document.cookie
  }));
  assert.equal(gbState.guard?.country, "gb");
  assert.match(gbState.switcher, /英国 \(GB\)/);
  assert.match(gbState.cookie, /(?:^|; )geo=GB(?:;|$)/);
  assert.match(gbState.cookie, /(?:^|; )__asgc=GB(?:;|$)/);

  // Environment precondition. Apple serves the storefront its network egress
  // implies and 302s every other country path, so from an egress it reads as
  // China the whole page collapses to /cn/ and this suite cannot exercise
  // storefront switching at all. Detect that up front and say so, instead of
  // timing out on a selector three steps later.
  const contentProfile = () => page.evaluate(() => {
    const paths = [...document.querySelectorAll('a[href*="apps.apple.com"]')]
      .slice(0, 60)
      .map((a) => { try { return new URL(a.href).pathname; } catch { return ""; } });
    return {
      lang: document.documentElement.lang,
      gb: paths.filter((p) => p.startsWith("/gb/")).length,
      cn: paths.filter((p) => p.startsWith("/cn/")).length
    };
  });
  const firstProfile = await contentProfile();
  assert.ok(
    !/^zh/i.test(firstProfile.lang) && firstProfile.cn <= firstProfile.gb,
    `Apple is forcing the CN storefront from this network egress (lang=${firstProfile.lang}, gb links=${firstProfile.gb}, cn links=${firstProfile.cn}). ` +
    "The extension cannot override a server-side storefront decision — check the proxy routing for *.apple.com before trusting this suite."
  );

  // One helper for both match assertions: testMatchOutcome reports static and
  // session rules together, so filter to the per-tab session rule under test.
  const matchSessionRule = async (url, type) => {
    const outcome = await worker.evaluate(async (request) => {
      const [rule] = await chrome.declarativeNetRequest.getSessionRules();
      return chrome.declarativeNetRequest.testMatchOutcome({
        url: request.url,
        type: request.type,
        tabId: rule.condition.tabIds[0]
      });
    }, { url, type });
    return outcome.matchedRules.filter((r) => r.rulesetId === "_session").length;
  };

  let rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.redirect.regexSubstitution, "https://apps.apple.com/gb\\1");
  assert.deepEqual(rules[0].condition.resourceTypes.sort(), ["sub_frame", "xmlhttprequest"]);
  assert.equal(rules[0].condition.tabIds.length, 1);
  assert.equal(await matchSessionRule("https://apps.apple.com/cn/iphone/today", "xmlhttprequest"), 1);

  // main_frame is intentionally excluded from the *country rewrite* rule: Apple
  // 302s /gb/... -> /cn when it disagrees with the client storefront, and
  // rewriting that top-level request back loops until ERR_TOO_MANY_REDIRECTS.
  assert.equal(
    await matchSessionRule("https://apps.apple.com/cn/app/example/id1", "main_frame"),
    0,
    "main_frame must not be rewritten (redirect loop risk)"
  );

  // The rendered body must match the storefront in the URL, not the IP.
  const gbContent = await contentProfile();
  assert.ok(!/^zh/i.test(gbContent.lang), `GB storefront rendered lang=${gbContent.lang}`);
  assert.ok(gbContent.cn < 20, `GB storefront body carries ${gbContent.cn} CN links`);

  await page.evaluate(() => history.pushState({}, "", "/cn/iphone/today"));
  assert.equal(new URL(page.url()).pathname, "/gb/iphone/today");

  await switchCountry(page, "CN");
  const cnState = await page.evaluate(() => ({
    guard: globalThis.__appleStoreRedirectGuard,
    switcher: document.querySelector("#apple-store-country-switcher button")?.textContent,
    cookie: document.cookie
  }));
  assert.equal(cnState.guard, undefined);
  assert.match(cnState.switcher, /中国大陆 \(CN\)/);
  assert.doesNotMatch(cnState.cookie, /(?:^|; )__asgc=/);
  rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 0);

  const jpNavigationStart = mainNavigations.length;
  await switchCountry(page, "JP");
  // Apple answers a country path it disagrees with by 302-ing to the storefront
  // it believes in (`/jp/...` -> `/cn` -> `/cn/iphone/today`) when the network
  // egress reads as China. That is server behaviour, not a duplicate reload, so
  // assert on the navigations the extension itself caused.
  const storefrontBounce = (url) => /^https:\/\/apps\.apple\.com\/cn(\/|$)/.test(url);
  const selfCausedNavigations = mainNavigations.slice(jpNavigationStart).filter((url) => !storefrontBounce(url));
  assert.deepEqual(selfCausedNavigations, ["https://apps.apple.com/jp/iphone/today"]);
  const jpState = await page.evaluate(() => ({
    guard: globalThis.__appleStoreRedirectGuard,
    switcher: document.querySelector("#apple-store-country-switcher button")?.textContent,
    cookie: document.cookie
  }));
  assert.equal(jpState.guard?.country, "jp");
  assert.match(jpState.switcher, /日本 \(JP\)/);
  assert.match(jpState.cookie, /(?:^|; )geo=JP(?:;|$)/);
  assert.match(jpState.cookie, /(?:^|; )__asgc=JP(?:;|$)/);

  await page.waitForSelector('a[href="https://apps.apple.com/jp/iphone/apps"]', { timeout: 30000 });
  const appsNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.click('a[href="https://apps.apple.com/jp/iphone/apps"]');
  await appsNavigation;
  assert.equal(new URL(page.url()).pathname, "/jp/iphone/apps");

  await navigate(page, "https://apps.apple.com/jp/iphone/grouping/25241", "jp");
  await page.waitForSelector('a[href*="/jp/app/"]', { timeout: 30000 });
  const appHref = await page.$eval('a[href*="/jp/app/"]', (link) => link.href);
  const catalogRequestStart = catalogStatuses.length;
  const appNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((href) => {
    [...document.querySelectorAll('a[href*="/jp/app/"]')].find((link) => link.href === href)?.click();
  }, appHref);
  await appNavigation;
  assert.match(new URL(page.url()).pathname, /^\/jp\/app\//);
  assert.deepEqual(catalogStatuses.slice(catalogRequestStart), []);

  // On an App page, a /cn/ route that is not an App must keep its own path
  // instead of being rewritten back to the App the guard remembers.
  await page.evaluate(() => history.pushState({}, "", "/cn/iphone/apps"));
  assert.equal(new URL(page.url()).pathname, "/jp/iphone/apps");
  await page.evaluate(() => history.pushState({}, "", "/cn/app/other/id999"));
  assert.equal(new URL(page.url()).pathname, "/jp/app/other/id999");
  // A bounce back to the same App is still restored.
  await page.evaluate((href) => history.pushState({}, "", `/cn${new URL(href).pathname.slice(3)}`), appHref);
  assert.equal(new URL(page.url()).pathname, new URL(appHref).pathname);

  const secondPage = await browser.newPage();
  await navigate(secondPage, "https://apps.apple.com/us/iphone/today", "us");
  rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 2);
  assert.equal(new Set(rules.map((rule) => rule.condition.tabIds[0])).size, 2);
  assert.deepEqual(
    rules.map((rule) => rule.action.redirect.regexSubstitution).sort(),
    ["https://apps.apple.com/jp\\1", "https://apps.apple.com/us\\1"]
  );

  await secondPage.close();
  for (let attempt = 0; attempt < 20; attempt++) {
    rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    if (rules.length === 1) break;
    await wait(100);
  }
  assert.equal(rules.length, 1, "closing a tab should remove only that tab's rewrite rule");
  assert.equal(rules[0].action.redirect.regexSubstitution, "https://apps.apple.com/jp\\1");
  assert.deepEqual(pageErrors, []);

  console.log("browser ok: storefront switching, category navigation, App 429 bypass, route repair, and per-tab DNR cleanup");
} finally {
  await browser.close();
  await Promise.allSettled([
    fs.rm(extensionDir, { recursive: true, force: true }),
    fs.rm(profileDir, { recursive: true, force: true })
  ]);
}
