# ima.copilot 调用实验记录

日期：2026-06-09  
项目：`<workspace>/opencli-plugin-ima`  
目标：为 OpenCLI 插件优先支持“指定知识库的一问一答”，并验证可行调用路径。

匿名化说明：本文保留 ima.copilot、OpenCLI、接口路径、错误码、插件文件名等技术信息；本机用户名、真实项目绝对路径、真实知识库名称、具体业务问题和业务答案细节均已替换为占位符。

## 结论摘要

当前可用方案是：`opencli ima ask` 先尝试直接 API；API 遇到 ima 业务鉴权错误时，自动退回到正在运行的 ima.copilot UI，通过 macOS Accessibility 选择知识库、输入问题、等待答案并读取结果。

实际端到端命令已验证：

```bash
IMA_KEYCHAIN_TIMEOUT_MS=30000 opencli ima ask "业务问题B" --kb "业务知识库B" --timeout 90 -f json
```

结果：成功，`Transport` 为 `ui`，知识库为 `业务知识库B`，返回了完整答案。

当前判断：

- 直接 API 路径可以读取本地登录态和 Cookie，但在当前环境持续返回 `600001`，无法单独完成知识库列表和问答。
- WebContents 路径已经验证可以在真实 ima 页面上下文中成功调用知识库列表、文档列表和一问一答 API，说明 native bridge 页面态可以补足直接 Node API 缺失的上下文。
- ima 原生 UI 路径可以完成目标场景，但它会真实操作本机 ima.copilot，并在 ima 里留下问答历史。
- OpenCLI 插件目前已经将 UI 路径接入 `ask` 命令作为 fallback。

## 环境与前提

- App：`/Applications/ima.copilot.app`
- Bundle ID：`com.tencent.imamac`
- 数据目录：`~/Library/Application Support/com.tencent.imamac`
- Cookie DB：`~/Library/Application Support/com.tencent.imamac/Default/Extension Cookies`
- Cookie host：`khmgfdkajnigikondkcjbaflpjflfiee`
- API base：`https://ima.qq.com/cgi-bin`
- QA endpoint：`/assistant_nl/knowledge_base_qa`
- 知识库页面：`chrome-extension://nkohmbngmopdajidckglcoehlaeepeoi/index.html`

必需授权：

- macOS Accessibility：用于 UI fallback 读取/操作 ima 界面。
- macOS Keychain：用于 API 路径解密 Chromium Cookie。首次可能需要批准 `ima.copilot Safe Storage`。

## 实验矩阵

| 路径 | 目标 | 结果 | 结论 |
| --- | --- | --- | --- |
| CDP / remote debugging | 通过 DevTools 协议控制 WebContents | 需要非默认 `--user-data-dir` 和 `TencentRemoteDebugSwitch` feature flag | 可作为显式实验路径 |
| WebContents API | 在真实 ima 页面内执行前端 API | 知识库列表、文档列表、一问一答接口返回成功 | 可绕过直接 Node API 的 `600001`，已接入显式 transport 和 `ask auto` 后段 fallback |
| 直接 API + 本地 Cookie | 调 `knowledge_tab_reader/*` 和 `assistant_nl/knowledge_base_qa` | 登录态可读，但接口返回 `600001` | 可保留为优先尝试，但当前环境不可单独完成 |
| Computer Use | 直接操作 ima UI | 成功选择知识库、输入问题、读取答案 | 证明 UI 路径可行 |
| Swift Accessibility | 在 OpenCLI 插件内本地操作 UI | 成功完成一问一答 | 当前 fallback 实现 |
| OpenCLI 命令入口 | `opencli ima ask --kb ...` | 成功，`Transport: ui` | 当前用户场景已跑通 |

## WebContents API 路径

实现位置：

- `lib/webcontents.js`
- `kb.ts` / `kb.js`
- `ask.ts` / `ask.js`
- `ls.ts` / `ls.js`
- `export.ts` / `export.js`

关键发现：

- ima.copilot 是 Chromium app，而不是 Electron app。
- 普通 `--remote-debugging-port` 不会暴露可用 CDP。
- app 内存在 `TencentRemoteDebugSwitch` 相关开关；启动时需要 `--enable-features=TencentRemoteDebugSwitch`。
- Chromium 还要求 remote debugging 使用非默认 `--user-data-dir`。
- 使用临时 `--user-data-dir` 可以打开 CDP，但没有真实登录态。
- 使用临时符号链接指向本机 ima profile 所在目录，可以让 CDP WebContents 复用真实登录态，同时不复制 profile 文件。

已验证 bridge：

- `chrome.imaFrame.invokeWithCallback` 可用。
- `getDeviceInfo` 可返回设备标识、guid、q36、qua 等字段。
- `getAccountInfo` 在真实 profile 中返回已登录状态，并能提供构造请求头所需字段。

已验证 API：

```text
knowledge_tab_reader/get_knowledge_base_list -> HTTP 200, code=0
knowledge_tab_reader/get_knowledge_list -> HTTP 200, returned document/folder rows
session_logic/init_session -> HTTP 200, returned session id
assistant/qa -> HTTP 200, returned SSE MESSAGE answer
```

该结果发生在真实 ima WebContents 中；同一类知识库接口在直接 Node API 调用中曾返回 `600001`。因此当前判断是：`600001` 主要与缺少真实页面 native bridge 和前端会话上下文有关，而不是单纯缺 Cookie。

问答路径对齐过程：

```text
assistant_nl/knowledge_base_qa -> SSE opened, COMPLETED event returned ima business failure
assistant_nl/operation_qa -> SSE opened, COMPLETED event returned ima business failure
真实前端请求 -> session_logic/init_session + assistant/qa
复现真实前端请求 -> success, answer returned
```

当前判断：Q&A 不能只把旧直接 API 的 `assistant_nl/knowledge_base_qa` 放进 WebContents 执行；必须按真实前端先创建 session，再调用 `assistant/qa`。

当前插件接入：

- `opencli ima kb --transport webcontents`
- `opencli ima kb-info --transport webcontents`
- `opencli ima ask --transport webcontents`
- `opencli ima ls --transport webcontents`
- `opencli ima export --transport webcontents`

`webcontents` 已进入 `ask --transport auto` 的后段 fallback：直接 API 失败后，如果 UI composer 不可见或 UI fallback 失败，则继续尝试 WebContents。该路径仍可能退出并重启 ima.copilot，同时会开启本地 CDP 端口。

## 直接 API 路径

实现位置：

- `lib/api.js`
- `kb.ts` / `kb.js`
- `ask.ts` / `ask.js`

已实现能力：

- 从 ima Chromium profile 读取 Cookie DB。
- 通过 Keychain 读取 Safe Storage password 解密 `IMA-TOKEN`、`IMA-REFRESH-TOKEN`、`IMA-UID` 等 Cookie。
- 构造前端同款请求头：
  - `x-ima-cookie`
  - `from_browser_ima: 1`
  - `extension_version`
  - `x-ima-bkn`
- 构造知识库相关 endpoint：
  - `knowledge_tab_reader/search_knowledge_base`
  - `knowledge_tab_reader/get_knowledge_base_list`
  - fallback `knowledge_tab_reader/get_home_page_data`
  - `assistant_nl/knowledge_base_qa`
- 从本地 mmkv 缓存补充 device 信息：
  - `IMA-GUID`
  - `IMA-Q36`
  - 尝试补充 `IMA-IUA`

已验证状态：

```json
{
  "ApiReady": "yes",
  "TokenCookie": "yes",
  "CookieRows": 5,
  "ExtensionVersion": "4.28.6"
}
```

失败现象：

```text
ima API knowledge_tab_reader/get_knowledge_base_list failed: 服务繁忙，请稍后重试 (code=600001)
fallback get_home_page_data failed: ima API knowledge_tab_reader/get_home_page_data failed: 服务繁忙，请稍后重试 (code=600001)
```

对照实验：

- 提高 Keychain timeout 后，Keychain 解密通过，仍返回 `600001`。
- 补充 `IMA-GUID`、`IMA-Q36` 后，仍返回 `600001`。
- 人工设置合成 `IMA_IUA` 后，仍返回 `600001`。
- 尝试不同 `IMA_EXTENSION_VERSION`（例如 `4.41.3`、`4.29.6`）后，仍返回 `600001`。
- 检查 `Preferences` 中 token 有效期，显示仍在未来；因此 `600001` 更像是 native bridge 刷新态、设备态、加密会话或服务端上下文不完整，而不是单纯过期。

当前判断：

- API 路径仍有价值，因为它是最干净的非 UI 自动化路径。
- 当前环境下 API 不能作为唯一方案。
- 后续若要继续攻 API，需要重点研究 native bridge 的 `refreshToken`、`getAccountInfo`、`getDeviceInfo`、secure request/crypto session，而不是继续只调 Cookie。

## Computer Use 路径

实验目的：验证 ima UI 是否能被本机自动化工具实际读取和操作。

关键观察：

- Computer Use 能看到知识库列表：
  - `个人知识库A`
  - `业务知识库B`
  - `业务知识库C`
  - `业务知识库D`
  - `技术知识库E`
- 能看到问答输入框：`基于知识库提问`
- 能看到生成结果和知识库检索状态，例如：
  - `找到了7篇知识库资料`
  - 具体答案文本

实测 1：`个人知识库A`

问题：

```text
通用问题A
```

结果：

```text
这个知识库主要关于某行业的多场景应用，包括主题A、主题B、主题C等具体实践。
```

实测 2：`业务知识库B`

问题：

```text
业务问题B
```

结果：返回完整业务规则，核心结论为：

```text
优先选择主要异常或特殊情况；只有没有异常或特殊情况时，才选择默认业务分类。
```

结论：

- UI 路径能完成优先目标。
- Computer Use 本身适合实验验证，但 OpenCLI 插件不能依赖 Codex 的 Computer Use 工具，所以需要用本地可执行的 Accessibility 实现。

## Swift Accessibility 路径

实现位置：

- `lib/ax.js`

核心动作：

1. 激活 `ima.copilot`。
2. 获取当前窗口 Accessibility tree。
3. 如果提供 `--kb`，点击左侧知识库名称。
4. 找到 `基于知识库提问` 输入区域。
5. 设置输入框 value。
6. 发送 Return。
7. 每秒读取 Accessibility 文本。
8. 等到答案稳定并且不再处于生成状态。
9. 从问题后的文本中抽取答案。

已修正问题：

- 原始 Swift 子进程固定 10 秒超时，真实问答会被 Node 提前杀掉。已改为随 `--timeout` 增加。
- `clickElement` 原本在 `AXPress` 返回 success 后直接返回，但静态文本并不一定真的被点击，导致知识库未切换。已改为始终执行坐标点击。
- 答案抽取会把 `找到了 N 篇知识库资料` 混进答案，已做清理。

当前限制：

- UI fallback 依赖 ima 前台窗口和 Accessibility 授权。
- UI fallback 会在 ima.copilot 中留下真实问答历史。
- `ReferencesFound` 在 UI 路径目前是启发式解析，可能受历史问答干扰，不应作为强语义字段依赖。
- 若左侧没有可见的指定知识库名称，UI fallback 会失败。必要时需要先让 UI 滚动或搜索知识库。

## OpenCLI 插件入口

当前命令：

```bash
opencli ima ask "<question>" --kb "<knowledgeBaseName>" --timeout 90 -f json
```

当前策略：

1. 调 `askImaApi`。
2. 如果 API 成功，返回 `Transport: api`。
3. 如果 API 失败且提供了 `--kb`，先检查 UI composer；composer 可见时调用 `askIma` UI fallback。
4. 如果 UI composer 不可见、UI fallback 失败，或只提供了 `--kb-id`，继续调用 `askImaWebContents`。
5. 如果 WebContents 也失败，错误中同时包含 API、UI 和 WebContents 的失败上下文。

实际验证：

```bash
IMA_KEYCHAIN_TIMEOUT_MS=30000 opencli ima ask "请用一句话回答：这个知识库包含哪些主题？" --kb "个人知识库A" --timeout 60 -f json
```

返回：

```json
{
  "Status": "success",
  "Transport": "ui",
  "KnowledgeBase": "个人知识库A",
  "Answer": "这个知识库主要包含主题A、主题B、主题C以及主题D等内容。",
  "ReferencesFound": 7
}
```

实际验证：

```bash
IMA_KEYCHAIN_TIMEOUT_MS=30000 opencli ima ask "业务问题B" --kb "业务知识库B" --timeout 90 -f json
```

返回成功，`Transport: ui`，答案为业务知识库B中的规则类回答。

## 最终业务答案样例

知识库：`业务知识库B`  
问题：`业务问题B`

答案要点：

- 应优先选择主要异常或特殊情况。
- 没有异常或特殊情况时，才选择默认业务分类。
- 存在多个候选项时，选择影响最大、资源消耗最多的候选项。
- 出现更严重的新发或加重情况时，选择该更严重情况。
- 某些结果类、状态类或统计类字段不能作为主分类依据。

## 后续建议

短期：

- 保持 `ask --kb` 的 API 优先策略，但在 UI composer 不可见时自动退回 WebContents。
- 在 README 中明确 UI fallback 的副作用：会操作真实 ima UI，并留下问答历史。
- 为 UI fallback 增加更可靠的当前知识库确认逻辑，避免误选或未切换。
- 将 `ReferencesFound` 标记为 best-effort，或先从 UI 输出中移除。

中期：

- 继续逆向 native bridge，重点是：
  - `getAccountInfo`
  - `refreshToken`
  - `getDeviceInfo`
  - `EncryptData` / `DecryptData`
  - secure request headers：`x-ima-cm`、`x-ima-ckey`、`x-ima-ctk`
- 如果能在本地进程中复现 native bridge 所需上下文，再把 API 路径提升为主路径。

长期：

- 继续保留 transport 参数，例如 `--transport auto|api|webcontents|ui`，用于问题定位和用户显式选择。
- 增加 UI 集成测试脚本，覆盖：
  - 知识库切换
  - 输入框定位
  - 生成中状态
  - 空结果
  - 超时
  - 答案抽取
