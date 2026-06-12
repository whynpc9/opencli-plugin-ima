# Platform Adapter and OS Differences

日期：2026-06-09

本文说明 `opencli-plugin-ima` 当前的系统差分设计。目标是在保留已验证 macOS 能力的前提下，把 Windows 支持和后续仍需补齐的能力集中到清晰边界内。

本文不记录真实知识库名称、真实业务问题、真实答案、Cookie、Token、Keychain 输出、截图或本机用户绝对路径。

## 结论

当前可运行实现以 WebContents 为主，macOS 与 Windows 均已接入该路径：

- 直接 API：依赖本机 ima Chromium profile、Cookie DB 和平台 cookie 解密后端；macOS 走 Keychain，Windows 已能通过 DPAPI 解 Chromium cookie key，但 direct API 仍是实验路径。
- WebContents：依赖平台 app 启动命令、临时 profile link/junction、CDP 端口和真实 ima 页面 native bridge。
- UI fallback：依赖 macOS Accessibility 和 Swift 脚本；Windows 目前只有匿名化 UI Automation 状态探针，尚未实现 UI transport。
- Recent export fallback：依赖本机 ima profile 中最近打开过的预览 URL，macOS 与 Windows 均可扫描默认 profile。

Windows 已可通过 WebContents 完成知识库搜索、问答、文档列表和下载。平台差异集中在 `lib/platform.js`，业务 transport 继续复用请求构造、响应解析和命令入口。

## 当前边界

平台无关逻辑：

- OpenCLI 命令注册：`ask.ts`、`kb.ts`、`ls.ts`、`export.ts`、`setup.ts`、`status.ts`。
- 直接 API 的 endpoint、payload、SSE 解析和知识库/文档结构归一化：`lib/api.js`。
- WebContents 中执行的前端 API payload、session 初始化、SSE 解析：`lib/webcontents.js`。
- 下载 URL 后的文件落盘：`lib/documents.js`。

平台相关逻辑：

- app 标识、app 路径、profile 路径、Cookie DB 路径。
- native app 启动、退出和进程检测。
- WebContents CDP 启动方式。
- Chromium Cookie 解密后端。
- UI 自动化后端。
- recent preview fallback 的 profile 扫描根目录。

这些内容应优先通过 `lib/platform.js` 扩展，不应继续散落在各个 transport 文件中。

## `lib/platform.js` 职责

`getImaRuntimeConfig()` 返回当前系统的运行时配置：

- `os` / `label`：平台标识。
- `displayName`：app 显示名。
- `identifiers`：bundle id、知识库扩展 id、Cookie host、`CLIENT-TYPE`。
- `paths`：app path、app support dir、profile dir、mmkv dir、Cookie DB、Preferences、Local State、extension root。
- `commands`：进程检测相关 pattern。
- `capabilities`：当前平台已实现的能力开关。
- `pending`：该平台剩余待补事项。

当前 capability 含义：

| Capability | macOS | Windows 当前状态 | 说明 |
| --- | --- | --- | --- |
| `uiTransport` | 已实现 | 未实现 | macOS 走 Accessibility；Windows 仍需要完整 UI Automation 后端。 |
| `apiCookieDecryption` | 已实现 | 已实现 key/payload 解密 | macOS 走 Keychain；Windows 走 DPAPI + Local State + AES-GCM，但 direct API 仍可能缺 native bridge 上下文。 |
| `keychainSafeStorage` | 已实现 | 不适用 | macOS Keychain 专属。 |
| `webContentsLaunch` | 已实现 | 已实现 | macOS 走 `open` + CDP 参数；Windows 走 `ima.copilot.exe` + CDP 参数和临时 junction。 |
| `recentPreviewScan` | 已实现 | 已实现 | Windows 默认扫描 `%LOCALAPPDATA%\ima.copilot\User Data\Default` 下的本机 profile。 |

## macOS 已实现后端

macOS 默认配置：

- app path：`/Applications/ima.copilot.app`
- bundle id：`com.tencent.imamac`
- profile root：`~/Library/Application Support/com.tencent.imamac/Default`
- app support root：`~/Library/Application Support/com.tencent.imamac`
- knowledge extension id：`nkohmbngmopdajidckglcoehlaeepeoi`
- Cookie host：`khmgfdkajnigikondkcjbaflpjflfiee`
- default `CLIENT-TYPE`：`mac`

macOS WebContents 启动流程集中在 `launchImaForWebContents({ port })`：

1. 请求 ima.copilot 退出。
2. 等待原进程退出。
3. 创建临时 profile 符号链接，目标为真实 app support root。
4. 使用 `open -n -a <appPath> --args ...` 启动。
5. 传入 `--remote-debugging-port`、`--remote-allow-origins=*` 和 `--enable-features=TencentRemoteDebugSwitch`。

macOS direct API Cookie 解密集中在 `readImaSafeStoragePassword()`：

1. 优先使用 `IMA_SAFE_STORAGE_PASSWORD`。
2. 否则通过 macOS Keychain 读取 Safe Storage password。
3. `lib/api.js` 继续负责 Chromium Cookie AES 解密和请求头构造。

macOS UI fallback 仍保留在 `lib/ax.js`：

- Node 侧激活 app 通过平台层执行。
- Swift Accessibility 脚本仍是 macOS 专属 UI 后端。
- 非 macOS 会直接返回 UI transport 未实现，而不是尝试运行 Swift。

## Windows 已实现后端

Windows WebContents 已接入当前成功路径；direct API 已补齐 DPAPI cookie-key 解密边界，但仍保留为实验路径；UI fallback 仍保留为后续工作。

Windows 默认配置：

- app root：`%LOCALAPPDATA%\ima.copilot`
- app path：`%LOCALAPPDATA%\ima.copilot\Application\ima.copilot.exe`
- profile root：`%LOCALAPPDATA%\ima.copilot\User Data\Default`
- app support root：`%LOCALAPPDATA%\ima.copilot\User Data`
- Local State：`%LOCALAPPDATA%\ima.copilot\User Data\Local State`
- knowledge extension id：`nkohmbngmopdajidckglcoehlaeepeoi`
- Cookie host：`khmgfdkajnigikondkcjbaflpjflfiee`
- default `CLIENT-TYPE`：`windows`
- observed bundle id：`com.tencent.imawin`

Windows WebContents 启动流程集中在 `launchImaForWebContents({ port })`：

1. 退出正在运行的 `ima.copilot.exe` 进程。
2. 等待原进程退出。
3. 创建临时 junction，目标为真实 Chromium `User Data` 目录。
4. 启动 `ima.copilot.exe`。
5. 传入 `--user-data-dir=<junction>`、`--remote-debugging-port`、`--remote-allow-origins=*` 和 `--enable-features=TencentRemoteDebugSwitch`。
6. 通过 `/json/list` 选择 `chrome://allknowledge/`、知识库扩展页或 `chrome://home/` target。
7. 在页面中调用 `chrome.imaFrame.invokeWithCallback` 获取账号和设备 header，再执行 browser `fetch`。

已验证的匿名化能力：

- WebContents target 可以在 Windows 上暴露 `chrome.imaFrame.invokeWithCallback`。
- `getAccountInfo` 和 `getDeviceInfo` 可用于构造知识库请求 header。
- 知识库搜索、按知识库名称的一问一答、根目录文档列表、下载 URL 解析和实际下载均通过真实 WebContents smoke。
- `ask --transport auto` 在 Windows 上可以经 API/UI 失败后落到 WebContents。
- `kb --transport auto` 在 Windows 无显式 API cookie 时优先使用 WebContents。
- `ls --transport auto` 和 `export --transport auto` 在 direct API 失败后会尝试 WebContents。
- `dump` 在 Windows 上写出 WebContents target 诊断信息；Accessibility tree dump 仍是 macOS 专属。

Windows direct API 当前边界：

- 已发现 Cookie DB、Preferences 和 Local State 位置。
- 已实现读取 Chromium `Local State` 中的 encrypted key。
- 已实现通过 Windows DPAPI 解密 key。
- 已实现解密 Cookie DB 中 `v10`/`v11`/`v20` AES-GCM `encrypted_value`。
- 仍依赖本地 `sqlite3` CLI 读取 Cookie DB；无该命令时 direct API 还不能进入 cookie 行解析。
- 验证 `CLIENT-TYPE` 是否应为 `windows`、`pc` 或其他真实前端值。
- 确认补齐这些字段后是否仍会返回 `600001`。

Windows UI fallback 仍需要补：

- 已选择 PowerShell + .NET UIAutomationClient 作为低依赖探针技术栈。
- 当前仅返回进程数、窗口数和候选输入框数量，不导出 UI 文本。
- 实现窗口激活、知识库选择、输入框定位、输入问题、等待回答稳定和答案抽取。
- 明确权限提示和失败诊断。

## 环境变量扩展点

平台层支持以下 override，用于实机 discovery 和临时验证：

- `IMA_DISPLAY_NAME`
- `IMA_BUNDLE_ID`
- `IMA_APP_PATH`
- `IMA_APP_SUPPORT_DIR`
- `IMA_PROFILE_DIR`
- `IMA_PROCESS_PATTERN`
- `IMA_KNOWLEDGE_EXTENSION_ID`
- `IMA_COOKIE_HOST`
- `IMA_CLIENT_TYPE`

这些变量只能作为本地运行配置，不应写入文档示例中的真实用户路径、真实账号信息或真实业务数据。

## 维护规则

- `ask --transport auto` 策略是 direct API first；API 失败后先用可见的 macOS UI composer；UI 不可用或失败时继续尝试 WebContents。在 Windows 上 UI transport 未实现，因此会继续尝试 WebContents。
- 因为 WebContents 可能重启 ima.copilot 并开启本地 CDP 端口，修改平台启动逻辑后必须做真实 app smoke。
- 新增平台支持时，优先修改 `lib/platform.js`，再少量接入 transport。
- 不要把 Windows 发现阶段的真实路径、Cookie、Token、截图或知识库内容提交到仓库。
- 修改平台层后至少运行：

```bash
npm test
npm pack --dry-run
```

- 新增 Windows 实测结果时，只记录匿名化结论：平台、ima 版本、transport、成功/失败、错误码或匿名化错误摘要。
