# Agent Guide

遵循 DRY 和 SOLID 原则

## Project Overview

Chrome/Edge MV3 extension that keeps `apps.apple.com` on the storefront named in the URL instead of the IP-derived China store. The manifest carries two unrelated features with no shared code: the store guard, and a `fanqienovel.com` reader copy unlock (`fanqie-copy.js`, MAIN world).

Country list lives in `COUNTRIES` in `guard.js`; README's "37 countries/regions" is a copy of that count.

## Guard, in request order

Each layer exists because the one before it can't cover the case, so keep every layer when editing.

1. **`rules.json` (static DNR)** — strips the `x-apple-store-front` request header and blocks Apple's `processRedirectUrl` XHR/sub_frame.
2. **`background.js` (service worker)** — on `webNavigation.onBeforeNavigate`, sets the storefront cookies for the URL's country, and installs a **per-tab session rule** (ids `10000`–`19999`) that rewrites that tab's `/cn/...` XHR and sub_frame requests back to the target country. Ids are allocated from that range and must be released on tab close and on switch to CN; capacity is one rule per tab.
3. **`guard.js` (MAIN world, `document_start`)** — patches `history.pushState/replaceState`, `navigation.navigate`, and `Location.prototype.assign/replace` so client-side redirects to `/cn/` are rewritten before Apple's Svelte SPA commits them; repairs the address bar afterwards, and re-plays route changes so the SPA still renders.

`background.js` cannot see same-document SPA navigations, and `guard.js` cannot run before the first response arrives: the layers are not redundant.

## Context split: `state.js` is the only bridge

`guard.js` needs MAIN world to patch page globals, which costs it all `chrome.*` APIs. `state.js` (ISOLATED world, `document_start`) relays the `prepareCountrySwitch` handshake: page `postMessage` → `chrome.runtime.sendMessage` → reply → `countrySwitchReady` back to the page, with a 1s timeout so navigation never stalls on the worker. Any new page↔worker call goes through this channel; don't call `chrome.*` from `guard.js`.

## State model

Apple's server-side 302 can overwrite `geo` and drop `sessionStorage` across a redirect, so intent is mirrored into keys Apple doesn't own. All are written by both `background.js` and `guard.js` — change both sides.

| Key | Meaning |
|---|---|
| `geo` | Apple's own storefront cookie, set to the target country |
| `__asgc` | intended country; Apple won't overwrite it, so it's the fallback source of truth |
| `__asgp` | URL-encoded app-page path, so a bounce to `/cn/` restores the exact page |
| `itspod` | Apple pod cookie, cleared on every storefront change |
| `appleStoreRedirectGuard.country` | sessionStorage mirror of `__asgc` |
| `appleStoreRedirectGuard.appPath` | sessionStorage mirror of `__asgp` |
| `appleStoreRedirectGuard.switching` | one-shot flag: guard is being turned off, hooks must not bounce back |

## Behaviour rules to keep

- **The tab reload is deliberate.** Cookies land after the request that carried the navigation, so `background.js` reloads the tab once after setting them; `net::ERR_ABORTED` on the first navigation is expected. Same URL reloading 3 times within 5s means the guard is looping, and it clears all state and gives up — that silent give-up is the first thing to check when protection "stops working".
- **Same-storefront link clicks become document navigations.** After a storefront change Apple's SPA sends App API requests with an empty Bearer token and gets 429; a full navigation reloads Apple's bootstrap. Keep it even though it looks like a regression against SPA smoothness.
- **Switching to CN is an opt-out**, not a redirect: clear `__asgc`/`__asgp`/`geo` and the sessionStorage mirrors, set `switching`, drop the tab's session rule, then assign `window.location.href` — `location.assign()`/`replace()` are patched and would rewrite the CN URL away.
- **A URL with no country prefix means the user left the storefront**, so `background.js` wipes guard state and tells `state.js` to clear the intent.
- `guard.js` also unlocks text selection and copy on App Store pages (`enableSelection` plus `stopImmediatePropagation` on copy/cut/contextmenu/selectstart). Unrelated to redirects, and intentional.
- The `cookie` header must survive: removing it in `rules.json` breaks storefront targeting.

## Testing

Run both layers after changing extension behaviour — `npm test`, then `npm run test:browser` (see `package.json`).

- **Unit (`test.mjs`)** runs `guard.js`, `background.js`, `state.js` and `fanqie-copy.js` in `vm` sandboxes with fake `chrome` and DOM; `runAt(href, storage, cookie, …)` is the guard entry point. It also pins manifest shape: content-script order, `document_start`, and MAIN vs ISOLATED worlds — so a manifest edit fails here first.
- **Browser (`puppeteer-test.mjs`)** loads the unpacked extension in Chrome for Testing and asserts real outcomes: GB protection, CN/JP switching, category navigation, App-page 429 prevention, SPA route repair, per-tab DNR isolation and cleanup on tab close. It copies sources into a temp extension dir from an explicit `EXTENSION_FILES` list — **a new source file must be added there, or the run silently uses the old bundle.** It also requires a `chrome-extension://.../background.js` service-worker target before trusting results, and uses temp extension/profile dirs so it never touches the user's profile.
- Stable Chrome may ignore `--load-extension` and automate without the extension; that's why the suite uses `puppeteer.executablePath()`. Install the browser with `npx --no-install puppeteer browsers install chrome` — `--no-install` matters because the revision comes from the pinned `puppeteer` version, and a newer one resolves to a build the launcher then rejects with "Browser was not found at the configured executablePath". `npm install` alone won't fetch it: puppeteer's postinstall is blocked here. The canonical launch flags live in `puppeteer-test.mjs`, not in this file.
