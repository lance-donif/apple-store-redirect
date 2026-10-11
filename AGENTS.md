# Agent Guide

遵循 DRY 和 SOLID 原则

## Project Overview

Chrome/Edge MV3 extension that keeps `apps.apple.com` on the storefront named in the URL instead of the IP-derived China store. The manifest carries two unrelated features with no shared code: the store guard, and a `fanqienovel.com` reader copy unlock (`fanqie-copy.js`, MAIN world).

Country list lives in `COUNTRIES` in `guard.js`; README's "37 countries/regions" is a copy of that count.

## Guard, in request order

Each layer exists because the one before it can't cover the case, so keep every layer when editing.

1. **`rules.json` (static DNR)** — strips the `x-apple-store-front` request header and blocks Apple's `processRedirectUrl` XHR/sub_frame.
2. **`background.js` (service worker)** — on `webNavigation.onBeforeNavigate`, sets the storefront cookies for the URL's country, and installs a **per-tab session rule** (ids `10000`–`19999`) that rewrites that tab's `/cn/...` requests back to the target country. Ids are allocated from that range and must be released on tab close and on switch to CN; capacity is one rule per tab.
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

## Content vs. address bar

Apple can answer a country path with a server-side `302` to a storefront it prefers instead — observed as `apps.apple.com/gb/... -> 302 -> /cn -> 301 -> /cn/iphone/today`, which renders CN content while the address bar still reads `/gb/`. It also bounced countryless paths, so during one of these windows *every* path collapsed to `/cn`.

**It is intermittent and it is not caused by this extension.** Verified with a same-machine control: a bare Chrome (no extension loaded) and a Chrome with the extension, run minutes apart, produced identical results — both `lang="en-GB"`, 80 `/gb/` links, 0 `/cn/` links, a single `/gb/iphone/today` navigation and no bounce. The same commit's browser suite passed in 38s and failed in 1m50 within the same session. When the bounce is active it hits any client on that network path, extension or not.

**Root cause (measured, not guessed): the egress IP itself flips between GeoIP verdicts at Apple.** The evidence chain:

- mihomo's own log shows `apps.apple.com` TCP connections matched `YuShe[日本 01]` **continuously, including inside the bounce window** — the routing rule never changed.
- The egress IP was the same address before, during and after the bounce window (`31.223.184.121`, G-Core Labs Tokyo), confirmed by two independent paths (curl through the dev sandbox proxy and curl through Clash's mixed port) that share the same landing IP.
- Node architecture in the subscription: user -> mainland relay (`117.149.251.176`, China Mobile) -> G-Core Tokyo landing. mihomo logged `failed to create session: dial tcp 117.149.251.176:23031` warnings inside the window — the relay was flapping while the landing IP stayed constant.
- curl (sandbox path, no Clash involvement) and Chrome (Clash path) bounced **together**, which is only possible if they share the landing IP.

So: the proxy's *routing rules* were correct the whole time (`apps.apple.com -> YuShe -> Japan`); what flaps is **Apple's GeoIP classification of the landing IP**. G-Core Labs is a CDN/cloud provider with mainland-China presence, and its ranges are inconsistently classified — Apple's edges alternate between treating `31.223.x.x` as Japan and as China. Each verdict lasts minutes. A fix belongs at the node level (use a landing IP whose GeoIP classification Apple reads consistently — e.g. a different node), not in the extension and not in the routing rules.

Two consequences that *are* proven and worth keeping:

- **`main_frame` must stay out of the per-tab country rewrite rule.** With it, the two sides fight: Apple `302`s `/gb` -> `/cn`, the extension `307`s `/cn` -> `/gb`, forever, and the tab dies with `ERR_TOO_MANY_REDIRECTS`. Reproduced live. No redirect target avoids it — Apple rejects every country path it dislikes equally. A hard error page is worse than the CN content being fixed, so the rule covers only `["xmlhttprequest", "sub_frame"]`, which cannot loop this way. Both test layers assert the exclusion.
- **When Apple bounces, the extension cannot recover the content.** The HTML came from Apple's servers, so `guard.js` can rewrite the address bar but cannot un-download it. There is no client-side override — see the header dead end below.
- **Do not "fix" a red browser suite by relaxing assertions until the egress is confirmed.** Use the bare-Chrome control above instead: it separates "the extension is broken" from "the network is delivering CN content".

### `x-apple-store-front` looks like the fix and is a dead end

Apple does honour this header — it overrides the egress judgement. Measured, with the egress reading as China: no header → `302 -> /cn` for every country path *and* for a countryless path; `x-apple-store-front: 143444-2,29` → `200` whose payload reads `"storefront":{"cc":"GB","id":"143444"}` (GB `143444`, US `143441`). The `<id>-<n>,<n>` shape matters — `143444-1,29` returns `400`.

It still cannot be used here:

| request | with the header |
|---|---|
| app page `/gb/app/...` | `200` but **JSON** (`storePlatformData`), not the SPA shell |
| category page `/gb/iphone/today` | **`404`** |

Setting it on a navigation switches Apple into its store-front API mode, so the tab never gets an HTML page. It is only usable on XHR/sub_frame — and the SPA's own API paths already carry `/gb/`, so it buys nothing there. **Do not "fix" the CN bounce by setting this header on `main_frame`.** It is also why `rules.json` removes the header rather than setting it: a stale storefront value on Apple's own API calls is worse than none.

## Behaviour rules to keep

- **The tab reload is deliberate.** Cookies land after the request that carried the navigation, so `background.js` reloads the tab once after setting them; `net::ERR_ABORTED` on the first navigation is expected. Same URL reloading 3 times within 5s means the guard is looping, and it clears all state and gives up — that silent give-up is the first thing to check when protection "stops working".
- **Same-storefront link clicks become document navigations.** After a storefront change Apple's SPA sends App API requests with an empty Bearer token and gets 429; a full navigation reloads Apple's bootstrap. Keep it even though it looks like a regression against SPA smoothness.
- **Switching to CN is an opt-out**, not a redirect: clear `__asgc`/`__asgp`/`geo` and the sessionStorage mirrors, set `switching`, drop the tab's session rule, then assign `window.location.href` — `location.assign()`/`replace()` are patched and would rewrite the CN URL away.
- **A URL with no country prefix means the user left the storefront**, so `background.js` wipes guard state and tells `state.js` to clear the intent.
- `guard.js` also unlocks text selection and copy on App Store pages (`enableSelection` plus `stopImmediatePropagation` on copy/cut/contextmenu/selectstart). Unrelated to redirects, and intentional.
- The `cookie` header must survive: removing it in `rules.json` breaks storefront targeting.
- **`pendingAppUrl` only answers for the same App.** `guarded()` may substitute the remembered App page only when the incoming `/cn/` URL is that same App (compare paths with the country prefix stripped). Every other route keeps its own path and only swaps the storefront prefix. Using it unconditionally turns it into a global hijack: from an App page, `pushState("/cn/iphone/apps")` lands back on the App and category navigation looks dead. Cover both directions in tests — a different App keeps its path, the same App is restored.
- **Every domain `background.js` clears cookies on needs a host permission.** It removes `geo`/`itspod` from `apple.com` and `itunes.apple.com`, not just `apps.apple.com`. Without those entries Chrome rejects each call with `No host permissions for cookies at url`, and `Promise.allSettled` swallows it, so storefront state silently stops clearing. The unit-test fake `chrome` doesn't enforce permissions, so only a real browser run catches it; `test.mjs` asserts the domains line up.

## Testing

Run both layers after changing extension behaviour — `npm test`, then `npm run test:browser` (see `package.json`).

- **Unit (`test.mjs`)** runs `guard.js`, `background.js`, `state.js` and `fanqie-copy.js` in `vm` sandboxes with fake `chrome` and DOM; `runAt(href, storage, cookie, …)` is the guard entry point. It also pins manifest shape: content-script order, `document_start`, MAIN vs ISOLATED worlds, and host-permission coverage — so a manifest edit fails here first. Its fake `chrome` does **not** enforce host permissions, so a permission gap can only be caught by the browser layer.
- **Browser (`puppeteer-test.mjs`)** loads the unpacked extension in Chrome for Testing and asserts real outcomes: GB protection, CN/JP switching, category navigation, App-page 429 prevention, SPA route repair, per-tab DNR isolation and cleanup on tab close. It copies sources into a temp extension dir from an explicit `EXTENSION_FILES` list — **a new source file must be added there, or the run silently uses the old bundle.** It also requires a `chrome-extension://.../background.js` service-worker target before trusting results, and uses temp extension/profile dirs so it never touches the user's profile. **Poll for that worker target rather than sleeping a fixed interval** — an MV3 worker starts lazily and took ~3s here, which surfaced as a spurious "service worker should be running" failure.
- **This suite depends on the network egress, and it says so.** Apple serves the storefront the egress implies and 302s every other country path, so from an egress Apple reads as China the whole page collapses to `/cn/` and no storefront switching can be exercised. The same commit passed in 38s and failed in 1m50 on this machine minutes apart, purely from a proxy node switch. The suite detects the state up front and fails with an explicit message naming the cause, rather than timing out on a selector three steps later. **Do not "fix" a red run by relaxing the assertions until you have confirmed the egress** — that is how a regression gets waved through.
- Stable Chrome may ignore `--load-extension` and automate without the extension; that's why the suite uses `puppeteer.executablePath()`. Install the browser with `npx --no-install puppeteer browsers install chrome` — `--no-install` matters because the revision comes from the pinned `puppeteer` version, and a newer one resolves to a build the launcher then rejects with "Browser was not found at the configured executablePath". `npm install` alone won't fetch it: puppeteer's postinstall is blocked here. The canonical launch flags live in `puppeteer-test.mjs`, not in this file.
