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
| `rules.json` | Declarative Net Request rule; removes `x-apple-store-front` header only |
| `guard.js` | Content script; blocks client-side redirects, uses `__asgc` cookie as fallback, and injects the country switcher |
| `test.mjs` | Node.js unit tests for `guard.js` behavior |
| `README.md` / `README_EN.md` | User-facing Chinese / English documentation |
| `country-switch.png` | Screenshot of the country switcher menu |

## Testing

```bash
npm test
```

Tests run `guard.js` in a minimal VM context and verify redirect interception logic.

## Common Gotchas

- **Country State Persistence**: Because Apple's server-side 302 redirects might clear `sessionStorage` or overwrite the `geo` cookie, `background.js` and `guard.js` use a custom `__asgc` (Apple Store Guard Country) cookie as the reliable source of truth.
- The country switcher menu is injected by `guard.js` using `MutationObserver` because Apple Store pages are a Svelte SPA and re-render the DOM.
- Switching to CN bypasses the intercepted `location.assign()` by using `window.location.href` directly, and clears the stored fallback country from cookies and `sessionStorage`.
- The `geo` cookie must be preserved in requests; do not remove the `cookie` header in `rules.json`.
