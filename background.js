const APPLE_APPS_HOST = "apps.apple.com";
const COUNTRY_PATH = /^\/([a-z]{2})\//i;
const COOKIE_URLS = [
  "https://apple.com/",
  "https://apps.apple.com/",
  "https://itunes.apple.com/"
];

async function setGeoCookie(country) {
  await chrome.cookies.set({
    url: "https://apps.apple.com/",
    name: "geo",
    value: country.toUpperCase(),
    domain: ".apple.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction"
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
    sameSite: "no_restriction"
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;

    const url = new URL(details.url);
    if (url.hostname !== APPLE_APPS_HOST) return;

    const match = url.pathname.match(COUNTRY_PATH);
    if (!match) return;

    const country = match[1].toLowerCase();

    if (country !== "cn") {
      setGeoCookie(country);
      setGuardCookie(country);
      clearItspodCookie();
    }
  },
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);
