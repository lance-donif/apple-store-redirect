# Apple Store Redirect Guard

Prevents Apple from redirecting non-China App Store URLs to `https://apps.apple.com/cn/iphone/today` based on your IP.

[中文](README.md)

## Problem

When you visit a non-China App Store link such as `https://apps.apple.com/us/app/12-twelves/id6447656121`, Apple may detect your IP as being in China and redirect the page to the China Today page instead of the app listing you requested.

## Solution

This extension sets the `geo` cookie to the country code in the URL (e.g., `/us/` → `geo=US`) before the request reaches Apple, so the server treats it as a request for that storefront and does not force a redirect to China.

## Installation

1. Open Chrome / Edge and go to `chrome://extensions/` (or `edge://extensions/`).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select this project folder.
4. Visit a non-China App Store URL to verify.

## Technical Notes

- `background.js`: Writes the `geo` cookie before navigation and clears the `itspod` cookie for non-China pages.
- `rules.json`: Only removes the `x-apple-store-front` request header; it keeps cookies intact so the storefront hint is preserved.
- `guard.js`: Page-level fallback that intercepts history / location / navigation API redirects to the China Today page and rewrites them back to the target country.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest |
| `background.js` | Service Worker that sets/clears cookies |
| `rules.json` | Declarative Net Request rules |
| `guard.js` | Content script that blocks client-side redirects |
| `test.mjs` | Unit tests |

## Test

```bash
npm test
```
