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
  const serviceWorkerTarget = browser.targets().find(
    (target) => target.type() === "service_worker" && target.url().endsWith("/background.js")
  );
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

  let rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.redirect.regexSubstitution, "https://apps.apple.com/gb\\1");
  assert.deepEqual(rules[0].condition.resourceTypes.sort(), ["sub_frame", "xmlhttprequest"]);
  assert.equal(rules[0].condition.tabIds.length, 1);
  const matchOutcome = await worker.evaluate(async () => {
    const [rule] = await chrome.declarativeNetRequest.getSessionRules();
    return chrome.declarativeNetRequest.testMatchOutcome({
      url: "https://apps.apple.com/cn/iphone/today",
      type: "xmlhttprequest",
      tabId: rule.condition.tabIds[0]
    });
  });
  assert.equal(matchOutcome.matchedRules.length, 1);

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
  assert.deepEqual(mainNavigations.slice(jpNavigationStart), ["https://apps.apple.com/jp/iphone/today"]);
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
