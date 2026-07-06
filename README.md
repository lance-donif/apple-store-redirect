# Apple Store Redirect Guard

阻止 Apple 在线商店根据 IP 把中国以外的页面重定向到中国。

[English](README_EN.md)

## 问题

访问非中国区 App Store 链接时，Apple 会根据你的 IP 强制跳转到中国区的 Today 页面。

## 功能

| 能力 | 说明 |
|------|------|
| 保持目标国家/地区 | 访问 `/us/`、`/jp/` 等国家码链接时，页面不会跳转回中国 |
| 支持客户端重定向拦截 | 即使页面脚本尝试跳转中国，也会被改回目标国家/地区 |
| 多国/地区可用 | 任何非中国区的 `apps.apple.com/{国家码}/...` 链接均可生效 |

## 安装

1. 打开 Chrome / Edge，进入 `chrome://extensions/`（或 `edge://extensions/`）。
2. 打开「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目目录。
