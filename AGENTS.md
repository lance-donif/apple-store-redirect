# 项目说明

## 项目结构

这是 Chrome/Edge Manifest V3 扩展。App Store 功能保留 URL 指定的地区意图，处理客户端回退和页面路由变化；番茄阅读器的复制解锁由独立脚本承担。国家列表的来源是 `guard.js` 中的 `COUNTRIES`。

## 请求与页面处理

- `rules.json` 移除 `x-apple-store-front` 请求头，并阻断 `processRedirectUrl` 的 XHR 和子框架请求。普通 Cookie 请求头保持原状。
- `background.js` 在顶层导航时同步地区 Cookie，为每个标签页维护一条会话规则。规则 ID 位于 10000–19999，作用对象为 XHR 和子框架；规则分配与更新由同一队列串行处理。
- 当前规则与目标规则完整等价时，后台跳过规则更新。切换到 CN、离开地区路径或关闭标签页时，对应规则被移除。
- `guard.js` 在 MAIN world 的 `document_start` 阶段拦截 History、Navigation 和 Location 导航方法，并在必要时修复地址及通知页面路由。
- `state.js` 在 ISOLATED world 转发页面与后台之间的切区消息。MAIN world 脚本通过此通道使用扩展能力，切区等待具有一秒兜底上限。

## 状态与隐私

| 存储项 | 当前用途 |
| --- | --- |
| `geo` | Apple 的地区 Cookie，可由网站重新写入 |
| `__asgc` | 扩展记录的目标地区 |
| `__asgp` | URL 编码后的应用 pathname，不含查询参数或片段 |
| `itspod` | 地区同步时清理的 Apple Cookie |
| `appleStoreRedirectGuard.country` | 标签页会话中的目标地区 |
| `appleStoreRedirectGuard.appPath` | 标签页会话中的完整应用路径，包含原查询参数和片段 |
| `appleStoreRedirectGuard.switching` | 主动退出保护的一次性标记 |

页面恢复优先读取标签页会话；只有 Cookie 可用时，恢复目标不包含查询参数或片段。旧版应用路径 Cookie 在页面启动时净化。循环保护日志只记录事件和标签页标识。

页面脚本与后台均会写入守护状态，键名和含义构成两端契约。Cookie 在匹配的站点作用域中共享，标签页会话与 DNR 规则分别按标签页管理。

## 行为边界

- 服务器可以返回不同地区的页面。地址栏恢复为目标国家不代表响应内容已经属于该地区。
- 地区重写规则排除主文档，避免与服务器重定向形成循环。请求头修改也不提供恢复完整海外 HTML 的保证。
- Cookie 准备可能触发一次文档重载；重复重载具有计数和时间窗口限制，超过上限时清理守护状态。
- 同区链接使用完整文档导航，保留 Apple 页面初始化过程。
- 当前 CN 选择会移除守护意图与标签页规则，并设置 `geo=CN`；国家切换使用 `location.href`。
- 没有地区前缀的导航会清除守护意图。
- 记忆中的应用地址仅用于恢复同一应用；其他应用和分类保留各自路径。
- 国家菜单的外部点击监听每个文档注册一次，事件发生时查询当前菜单节点。
- App Store 的文本选择与复制解锁属于独立页面行为；番茄复制解锁只作用于阅读页面。
- 安装或更新时会清理配置中列出的 Apple 站点数据。HTTP 缓存与站点 Service Worker/CacheStorage 的处理路径不同。
- Cookie 清理涉及的站点与 manifest 的 host permissions 对应。

## 验证入口

`package.json` 定义单元与浏览器验证命令。行为变更的项目回归包含 `npm test` 和 `npm run test:browser` 两层。

`test.mjs` 使用 VM 和模拟浏览器接口，覆盖状态、路由、规则及 manifest 契约。模拟接口不等同于真实浏览器权限检查。

`puppeteer-test.mjs` 使用与 Puppeteer 配套的 Chrome for Testing、临时扩展目录和临时用户目录，并等待扩展 Service Worker。测试不读取个人浏览器资料。浏览器打包文件列表位于 `EXTENSION_FILES`。

真实浏览器验证依赖 Apple 返回的内容与网络条件。网络导致的地区差异与插件回归分别记录，现有断言保留其原有验收含义。
