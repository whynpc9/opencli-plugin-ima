# Effective ima.copilot Call Methods

日期：2026-06-09

本文总结当前项目中已经证明可有效调用 ima.copilot 的实现方法。本文只描述匿名化技术路径，不记录真实知识库名称、真实业务问题、真实答案、Cookie、Token 或本机用户路径。

## 当前有效路径

当前稳定方案是：通过 OpenCLI 本地命令调用插件，插件优先尝试直接 API；直接 API 不可用时，如果 macOS Accessibility 能看到 ima.copilot 问答输入框，则操作正在运行的 UI 完成一问一答；如果 UI 输入框不可见或 UI fallback 失败，则自动退回真实 WebContents 路径。

WebContents 方案会把 API 调用搬到 ima.copilot 的真实 Chromium WebContents 中执行。这样账号、设备和 bkn 等请求头通过 ima 页面里的 `chrome.imaFrame` native bridge 获取，而不是由 Node.js 直接拼接。

推荐显式 UI 命令：

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" --transport ui --timeout 90 -f json
```

默认自动策略：

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" --timeout 90 -f json
```

`--transport auto` 会先调用直接 API；如果 API 返回业务鉴权错误或其他失败，则检查 UI composer。composer 可见时走 UI transport；composer 不可见或 UI fallback 失败时，继续尝试 WebContents transport。

显式 WebContents 调用：

```bash
opencli ima kb --transport webcontents -f json
```

## 已验证基线

- ima.copilot app：`147.0.7727.4575`
- `CFBundleVersion`：`7727.4575`
- app path：`/Applications/ima.copilot.app`
- bundle id：`com.tencent.imamac`
- 已验证能力：基于指定知识库名称的一问一答，返回完整答案。
- 已验证 WebContents 能力：在 macOS 和 Windows 的真实 ima 页面上下文中调用知识库列表、文档列表、下载 URL 解析和一问一答 API，返回成功结果。
- Windows WebContents 基线：ima.copilot 安装于 `%LOCALAPPDATA%\ima.copilot`，通过临时 junction 复用真实 `User Data`，`CLIENT-TYPE` 使用 `windows`。
- 可靠 transport：`webcontents`
- fallback transport：`ui`
- 实验 transport：`api`

## UI Transport 实现方法

实现位置：

- `ask.ts`
- `lib/ax.js`

核心流程：

1. 通过 `ask.ts` 注册 `ima ask` OpenCLI 命令。
2. 用户传入问题和知识库名称：`opencli ima ask "<question>" --kb "<knowledgeBaseName>"`。
3. `ask.ts` 在 `--transport ui` 或 `auto` 且 UI composer 可见时调用 `askIma`。
4. `lib/ax.js` 激活本机 ima.copilot app。
5. 通过 Swift Accessibility 脚本读取当前窗口树。
6. 按可见知识库名称点击左侧知识库。
7. 找到 `基于知识库提问` 输入区域。
8. 设置输入值，发送 Return。
9. 持续读取 Accessibility 文本，等待生成状态结束且答案稳定。
10. 从问题之后的文本中抽取答案，并清理检索状态文本。

这个实现依赖本机 macOS 能力，不依赖 Codex 的 Computer Use 工具。Computer Use 只用于早期验证 UI 路径可行，不能作为 OpenCLI 插件运行时依赖。

## 前置条件

UI transport 需要：

- macOS。
- `/Applications/ima.copilot.app` 已安装。
- ima.copilot 已登录。
- ima.copilot 中能看到目标知识库名称。
- 运行 OpenCLI 的终端进程具备 macOS Accessibility 权限。

API transport 还需要：

- 本机 ima.copilot Chromium Cookie DB 可读。
- macOS Keychain 允许读取 `ima.copilot Safe Storage`，或通过环境变量提供安全存储密码。
- Windows 上需要可读的 Chromium `Local State`，并且当前 Windows 用户可以通过 DPAPI 解密其中的 cookie key。
- 当前 direct API 的 Cookie DB 读取仍依赖 `sqlite3` CLI。

WebContents transport 还需要：

- Node.js runtime 提供全局 `WebSocket`。建议 Node.js 22+。
- ima.copilot 能以本地 CDP 端口启动，或已经由用户显式启动了可访问的 CDP 端口。
- 本机桌面会话可信，因为该方案会开启本地调试端口。
- Windows 上 WebContents 需要 `%LOCALAPPDATA%\ima.copilot\Application\ima.copilot.exe` 和 `%LOCALAPPDATA%\ima.copilot\User Data\Default` 存在；direct API DPAPI cookie-key 解密已接入但仍是实验路径，Windows UI Automation fallback 仍未实现。

## WebContents Transport 实现方法

实现位置：

- `lib/webcontents.js`
- `kb.ts`
- `ask.ts`
- `ls.ts`
- `export.ts`

核心流程：

1. 检查本机 CDP 端口是否已有 ima.copilot。
2. 如果没有，并且未设置 `IMA_WEBCONTENTS_LAUNCH=0`，则退出并重新启动 ima.copilot。
3. 启动参数包括独立 `--user-data-dir`、`--remote-debugging-port`、`--remote-allow-origins=*` 和 `--enable-features=TencentRemoteDebugSwitch`。
4. `--user-data-dir` 指向一个临时符号链接，目标是本机 ima app support 目录，用于复用真实登录态，同时避免把 profile 内容复制进项目。
5. 通过 CDP 找到优先目标页：`chrome://allknowledge/`、ima 知识库扩展页或 `chrome://home/`。
6. 在目标页中执行 `Runtime.evaluate`。
7. 目标页脚本调用 `chrome.imaFrame.invokeWithCallback` 获取 `getAccountInfo` 和 `getDeviceInfo`。
8. 目标页脚本构造 `x-ima-cookie`、`x-ima-bkn`、`from_browser_ima`、`extension_version`。
9. 目标页脚本使用 browser `fetch` 调 ima 前端 API。
10. Node.js 只接收 API 返回的结构化结果，不记录 Cookie、Token 或真实业务内容。

已验证结果：

- 在临时空 profile 中，native bridge 可用，但账号未登录，知识库列表 API 返回未登录类业务码。
- 在真实 profile WebContents 中，native bridge 返回已登录状态，知识库列表 API 返回 `code=0`。
- 在真实 profile WebContents 中，文档列表命令返回了文档/文件夹行。
- 在真实 profile WebContents 中，Q&A 通过 `session_logic/init_session` + `assistant/qa` 返回了答案。
- 这说明知识库读取类接口和一问一答接口都可以通过真实 WebContents 绕过直接 Node API `600001`。

当前限制：

- `webcontents` 目前会参与 `ask --transport auto` 的后段 fallback：API 失败且 UI composer 不可见，或 UI fallback 失败时会尝试 WebContents。
- 因此默认 `ask` 在 API/UI 都不可用时，可能退出并重启 ima.copilot，也可能开启本地 CDP 端口。
- 如果 CDP 不可达，该 transport 可能退出并重启 ima.copilot。
- 已实测知识库列表、文档列表和一问一答成功；导出的命令路径已经接入，但仍需要更多真实 app 样本验证。

## 直接 API 路径状态

实现位置：

- `lib/api.js`
- `kb.ts`
- `ask.ts`

已实现能力：

- 读取本机 ima 登录 Cookie。
- 通过 Keychain 解密 Chromium Cookie。
- 构造 ima 前端 API 所需请求头。
- 搜索/枚举知识库。
- 按知识库目录读取文档列表的命令接口。
- 调用 `assistant_nl/knowledge_base_qa` 并解析 SSE 响应。

当前状态：

- 单元测试覆盖了知识库列表解析、分页解析、QA SSE 消息合并和引用计数。
- 真实环境中直接 API 仍可能返回 `600001`。
- 因此 API transport 当前不能作为唯一可依赖路径。
- WebContents transport 证明 `600001` 很可能来自 Node 直接调用缺少 native bridge 页面态，而不是单纯 Cookie 字段不足。

注意：WebContents Q&A 没有继续使用直接 API 的 `assistant_nl/knowledge_base_qa`。真实前端路径是先创建会话，再发问答：

1. `session_logic/init_session`
2. `assistant/qa`

`assistant/qa` 请求体包含 `session_id`、`robot_type: 5`、`question_type: 2`、`command_info.type: 14`、`model_info`、`history_info` 和 `client_tools`。这是当前 `ask --transport webcontents` 的实现依据。

`ask --transport webcontents` 默认仍会新建 session，以保持干净 one-shot 上下文。显式传 `--session-id` 时会跳过 `init_session` 并复用该 session；传 `--session continue` 时会使用本地 session-state 文件中最近一次 WebContents ask 的 session id。本地状态只保存 session id 和知识库标识，不保存真实问题或答案。

模型切换通过 `model_info` 完成：`--model`/`--model-type` 设置 `model_type`，`--model-id` 设置可选 `model_id`，`--think` 会映射到已知的 thinking/non-thinking 成对模型。UI transport 不保证模型或 session 控制；在 `auto` 中出现会话控制会跳过 API/UI，出现模型控制会跳过 UI fallback。

Windows 4.28.6 前端的模型列表来自 `model_manage/get_models`。已验证 `ds-v3.2` 使用 `model_type=3`，`ds-v3.2 --think deep` 使用 `model_type=1`；旧的 `4/5` 会返回模型失效。

后续若要继续完善 API transport，应优先研究 native bridge 相关上下文，例如账号刷新、设备信息和加密会话，而不是只继续补 Cookie 字段。

## 文档列表与导出路径

实现位置：

- `ls.ts`
- `export.ts`
- `lib/api.js`
- `lib/documents.js`

`ima ls` 使用 `knowledge_tab_reader/get_knowledge_list`，按 `knowledgeBaseId` 和 `folderId` 列出当前目录内容。根目录的 `folderId` 使用 `knowledgeBaseId`，子目录通过 `--path "目录/子目录"` 逐层解析。

示例：

```bash
opencli ima ls --kb "我的知识库" --path "资料目录" -f json
```

`ima ls --transport auto` 会在 API 失败后尝试 UI fallback。UI fallback 使用 macOS Accessibility 读取当前 ima.copilot 知识库列表文本，并解析如下可见模式：

- 文件夹：`N 项 5/26更新`
- 文件：`PDF 5/26`、`PPT 4/2` 等

示例：

```bash
opencli ima ls --transport ui -f json
```

UI fallback 不能通过 `--kb-id` 验证目标知识库；使用它时应传 `--kb "我的知识库"`，或先在 ima.copilot 中切到目标知识库/目录再运行 `--transport ui`。如果当前 ima Chromium WebArea 没有向 macOS Accessibility 暴露列表文本，UI fallback 会返回空结果或导航失败。

`ima export` 支持两类下载入口：

1. API-first：按 `--media-id` 解析下载 URL，或先通过 `--kb/--kb-id --path` 按标题定位文档，再解析下载 URL。
2. Recent fallback：扫描本地 ima profile 中最近打开过的文档预览 URL，提取其中的 `originUrl` 后直接下载。

示例：

```bash
opencli ima export "示例文档.pdf" --kb "我的知识库" --output ~/Downloads -f json
```

当前真实环境中，文档列表 API 和下载 URL API 仍可能返回 `600001`。已经验证可行的导出路线是：先在 ima.copilot 中打开目标文档预览，再使用 recent fallback 中的 `originUrl` 下载。这个方法只依赖本机 ima profile 中已经存在的预览 URL，不需要把 Cookie、Token 或真实文档信息写入代码。

## 错误处理约定

- 如果用户强制 `--transport api`，API 失败时直接报错，不退回 UI。
- 如果用户使用 `--transport auto`，API 失败后会优先尝试可用 UI；如果 UI 不可用或只提供 `--kb-id`，会继续尝试 WebContents。
- 如果只提供 `--kb-id`，UI fallback 不可用，因为 UI 只能按可见知识库名称选择；但 WebContents fallback 可以继续使用 `--kb-id`。
- 如果使用 `--session-id` 或 `--session continue/new`，只走 WebContents；direct API 和 UI 都不会用于继续指定 WebContents session。
- 如果使用 `--model`、`--model-type`、`--model-id` 或 `--think`，API 和 WebContents 会透传模型字段；UI fallback 会被跳过。
- 如果目标知识库不在当前 UI 可见区域，UI transport 可能失败。
- UI transport 会真实操作 ima.copilot，并可能留下问答历史。

## 维护建议

- 改动调用链前先跑 `npm test`。
- 改动发布边界前跑 `npm pack --dry-run`。
- 改动文档前确认没有写入真实知识库名称、真实问题、真实答案、Cookie、Token 或本机用户路径。
- 不要把 Codex Computer Use 调用写成插件运行时能力；插件应只依赖 Node.js、OpenCLI、本机 app 和 macOS Accessibility。
- 新增真实 app 验证结果时，只记录匿名化问题、匿名化知识库名和 transport 结果。
