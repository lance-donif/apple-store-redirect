# Agent Guide

This document helps AI agents understand and work with this repository.

## Project Overview

Apple Store Redirect Guard is a Chrome/Edge extension that prevents Apple from redirecting non-China App Store URLs to the China storefront based on the user's IP address.

## Key Behaviors

- When visiting a non-China App Store URL (e.g. `/us/...`), the extension sets the `geo` cookie to that country code before the request reaches Apple.
- `guard.js` also intercepts client-side redirects and history/navigation API calls to keep the user on the target storefront.
- A country/region switcher menu is injected into Apple Store pages so users can manually switch between 37 countries/regions, including China mainland (CN).

## File Reference

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (v3) |
| `background.js` | Service Worker; sets `geo` and `__asgc` cookies, and clears `itspod` cookie |
| `rules.json` | Declarative Net Request rules; removes `x-apple-store-front` and blocks Apple redirect-processing requests |
| `guard.js` | Content script; blocks client-side redirects, uses `__asgc` cookie as fallback, and injects the country switcher |
| `test.mjs` | Node.js unit tests for `guard.js`, `background.js`, and extension configuration |
| `puppeteer-test.mjs` | Real-browser regression using Chrome for Testing with the unpacked extension loaded |
| `README.md` / `README_EN.md` | User-facing Chinese / English documentation |
| `country-switch.png` | Screenshot of the country switcher menu |

## Testing

Run both test layers after changing extension behavior:

```bash
npm test
npm run test:browser
```

- `npm test` runs fast VM-based unit tests for redirect interception, cookies, storage, background navigation, and DNR rule generation.
- `npm run test:browser` launches a real Chrome for Testing instance with the unpacked extension and checks extension startup, GB storefront protection, CN/JP switching, category navigation, App-page 429 prevention, SPA route repair, per-tab DNR isolation, and rule cleanup when a tab closes.
- The browser test may briefly return `net::ERR_ABORTED` during the first navigation because `background.js` deliberately reloads the tab after setting cookies. The test runner handles this case.

### Chrome for Testing

Recent official Google Chrome builds may ignore `--load-extension`, causing automation to run without the extension. Do not use `/Applications/Google Chrome.app/...` for extension regression tests.

Use Puppeteer's Chrome for Testing build instead:

```bash
npm install
npx puppeteer browsers install chrome   # Only needed when Chrome for Testing is missing
npm run test:browser
```

In automation code, switch the executable to Chrome for Testing with:

```js
const browser = await puppeteer.launch({
  executablePath: await puppeteer.executablePath(),
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`
  ],
  ignoreDefaultArgs: ["--disable-extensions"]
});
```

Always verify that a `chrome-extension://.../background.js` service-worker target exists before trusting browser results. `puppeteer-test.mjs` performs this check automatically and uses temporary extension/profile directories so it does not affect the user's normal Chrome profile.

## Common Gotchas

- **Country State Persistence**: Because Apple's server-side 302 redirects might clear `sessionStorage` or overwrite the `geo` cookie, `background.js` and `guard.js` use a custom `__asgc` (Apple Store Guard Country) cookie as the reliable source of truth.
- The country switcher menu is injected by `guard.js` using `MutationObserver` because Apple Store pages are a Svelte SPA and re-render the DOM.
- Switching to CN bypasses the intercepted `location.assign()` by using `window.location.href` directly, and clears the stored fallback country from cookies and `sessionStorage`.
- The `geo` cookie must be preserved in requests; do not remove the `cookie` header in `rules.json`.
