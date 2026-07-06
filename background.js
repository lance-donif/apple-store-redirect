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

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;

    const url = new URL(details.url);
    if (url.hostname !== APPLE_APPS_HOST) return;

    const match = url.pathname.match(COUNTRY_PATH);
    if (!match) return;

    const country = match[1].toLowerCase();
    setGeoCookie(country);
    if (country !== "cn") {
      clearItspodCookie();
    }
  },
  { url: [{ hostEquals: APPLE_APPS_HOST }] }
);
