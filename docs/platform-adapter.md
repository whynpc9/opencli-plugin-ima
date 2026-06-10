# Platform Adapter and OS Differences

日期：2026-06-09

本文说明 `opencli-plugin-ima` 当前的系统差分设计。目标是在保留已验证 macOS 能力的前提下，把未来 Windows 支持需要补的内容集中到清晰边界内。

本文不记录真实知识库名称、真实业务问题、真实答案、Cookie、Token、Keychain 输出、截图或本机用户绝对路径。

## 结论

当前可运行实现仍以 macOS 为主：

- 直接 API：依赖本机 ima Chromium profile、Cookie DB 和 macOS Keychain。
- WebContents：依赖 macOS app 启动命令、profile 符号链接、CDP 端口和真实 ima 页面 native bridge。
- UI fallback：依赖 macOS Accessibility 和 Swift 脚本。
- Recent export fallback：依赖本机 ima profile 中最近打开过的预览 URL。

Windows 还不能开箱运行。现阶段已经完成的架构调整是新增 `lib/platform.js`，把系统差异集中到平台适配层，业务 transport 继续复用原来的请求构造、响应解析和命令入口。

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
- `paths`：app path、app support dir、profile dir、mmkv dir、Cookie DB、Preferences、extension root。
- `commands`：进程检测相关 pattern。
- `capabilities`：当前平台已实现的能力开关。
- `pending`：该平台剩余待补事项。

当前 capability 含义：

| Capability | macOS | Windows 当前状态 | 说明 |
| --- | --- | --- | --- |
| `uiTransport` | 已实现 | 未实现 | macOS 走 Accessibility；Windows 需要 UI Automation 后端。 |
| `apiCookieDecryption` | 已实现 | 未实现 | macOS 走 Keychain；Windows 需要 DPAPI/Local State 解密。 |
| `keychainSafeStorage` | 已实现 | 不适用 | macOS Keychain 专属。 |
| `webContentsLaunch` | 已实现 | 未实现 | macOS 走 `open` + CDP 参数；Windows 需要启动 `ima.exe` 并验证 CDP。 |
| `recentPreviewScan` | 已实现 | 仅有路径接口 | Windows 需要确认 profile 根目录和缓存文件布局。 |

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

## Windows 待实现后端

优先级建议：

1. **先实现 WebContents 后端。** 这是最接近当前成功路径的跨平台方案，业务 API payload 可以复用。
2. **暂缓直接 API Cookie 解密。** Windows DPAPI 解密成本较高，且 direct API 在 macOS 真实环境中仍可能返回 `600001`。
3. **暂缓 UI Automation fallback。** 只有 WebContents 无法稳定运行时，再考虑 Windows UIA。

Windows WebContents 需要补：

- 发现或配置 `ima.exe` 路径。
- 发现真实 profile root。
- 验证 Windows 版 ima 是否支持 `TencentRemoteDebugSwitch` 和 CDP。
- 实现进程退出、启动和检测。
- 实现非默认 `--user-data-dir` 的登录态复用方式。候选方案包括目录 junction、符号链接、只读复制或用户显式指定 profile alias。
- 验证 `/json/list` 中 target URL 是否仍包含 `chrome://allknowledge/` 或同一知识库扩展 id。
- 验证 `chrome.imaFrame.invokeWithCallback` 在 Windows WebContents 中是否提供 `getAccountInfo` 和 `getDeviceInfo`。

Windows direct API 需要补：

- 发现 Cookie DB 和 Preferences 位置。
- 读取 Chromium `Local State` 中的 encrypted key。
- 通过 Windows DPAPI 解密 key。
- 解密 Cookie DB 中 `encrypted_value`。
- 验证 `CLIENT-TYPE` 是否应为 `windows`、`pc` 或其他真实前端值。
- 确认补齐这些字段后是否仍会返回 `600001`。

Windows UI fallback 需要补：

- 选择 UI Automation 技术栈。
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

- `ask --transport auto` 策略是 direct API first；API 失败后先用可见的 macOS UI composer；UI 不可用或失败时继续尝试 WebContents。
- 因为 WebContents 可能重启 ima.copilot 并开启本地 CDP 端口，修改平台启动逻辑后必须做真实 app smoke。
- 新增 Windows 支持时，优先修改 `lib/platform.js`，再少量接入 transport。
- 不要把 Windows 发现阶段的真实路径、Cookie、Token、截图或知识库内容提交到仓库。
- 修改平台层后至少运行：

```bash
npm test
npm pack --dry-run
```

- 新增 Windows 实测结果时，只记录匿名化结论：平台、ima 版本、transport、成功/失败、错误码或匿名化错误摘要。
