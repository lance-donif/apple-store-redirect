# Apple Store Redirect Guard

阻止 Apple 在线商店根据 IP 自动将非中国区页面重定向到 `https://apps.apple.com/cn/iphone/today`。

[English](README_EN.md)

## 问题

当你访问任意非中国区 App Store 链接（例如 `https://apps.apple.com/us/app/12-twelves/id6447656121`）时，如果 Apple 根据你的 IP 判断你位于中国，就会将页面重定向到中国区 Today 页面，而不是你想看的应用详情页。

## 解决方案

本扩展会在你访问 `apps.apple.com` 的非中国区 URL 时，把 `geo` Cookie 设置为该 URL 对应的国家码（例如 `/us/` → `geo=US`），让 Apple 服务器以为你请求的是该国家/地区的商店，从而不再强制跳转到中国区。

## 安装

1. 打开 Chrome / Edge，进入 `chrome://extensions/`（或 `edge://extensions/`）。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目目录。
4. 访问任意非中国区 App Store 链接测试效果。

## 技术要点

- `background.js`：在页面导航前写入 `geo` Cookie，并清理可能导致错误的 `itspod` Cookie。
- `rules.json`：仅移除请求中的 `x-apple-store-front` 头，保留 `cookie`，避免 Apple 丢失地区信息。
- `guard.js`：页面级兜底，拦截 history / location / navigation API 向中国 Today 页的跳转，并将 URL 改回目标国家/地区。

## 文件说明

| 文件 | 作用 |
|------|------|
| `manifest.json` | 扩展清单 |
| `background.js` | Service Worker，设置/清理 Cookie |
| `rules.json` | 声明式网络请求规则 |
| `guard.js` | 内容脚本，拦截客户端重定向 |
| `test.mjs` | 单元测试 |

## 测试

```bash
npm test
```
