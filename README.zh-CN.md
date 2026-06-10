# opencli-plugin-ima

[English README](README.md)

用于 OpenCLI 的 ima.copilot 插件，当前目标是对指定 ima.copilot 知识库进行一次性问答。

## 功能范围

当前优先支持的工作流很窄：

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" -f json
```

`ask` 默认使用 `--transport auto`：

1. 优先使用本机 ima.copilot 登录态调用直接 API。
2. 如果直接 API 返回鉴权或业务错误，并且 macOS Accessibility 能看到前台 ima.copilot 的问答输入框，则使用 UI fallback。
3. 如果 UI 输入框不可见，或 UI fallback 失败，则在 ima.copilot 真实 Chromium WebContents 中执行同款前端 API 调用。
4. 返回一次生成结果。

该插件只面向“一问一答”。它不管理多轮对话状态。

当直接 API 遇到 ima 业务错误 `600001` 时，WebContents transport 会在真实 ima 页面上下文中调用前端 API，让账号、设备和 bkn 等请求头由 app 内 native bridge 提供：

```bash
opencli ima kb --transport webcontents -f json
```

## 已验证基线

- ima.copilot app：`147.0.7727.4575`（`CFBundleVersion: 7727.4575`）
- macOS app path：`/Applications/ima.copilot.app`
- 开发中观察到的 bundle id：`com.tencent.imamac`
- 已验证工作流：通过 WebContents transport 对指定知识库完成一次问答。
- UI transport 保留为 macOS fallback，但要求问答输入框对 Accessibility 可见。
- WebContents transport 已验证能力：知识库列表、文档列表、一次性问答。
- API transport 已实现，但真实 app 运行中仍可能返回 `600001`，因此仍视为实验路径。

## 安装

本地开发目录安装：

```bash
npm install
npm test
opencli plugin install file://$(pwd)
opencli ima setup --activate
```

从 GitHub 安装：

```bash
opencli plugin install github:whynpc9/opencli-plugin-ima
```

## 命令

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `opencli ima setup [--activate]` | read | 检查 app、Accessibility、API Cookie 和 Keychain 准备状态。 |
| `opencli ima status` | read | 汇总当前 ima.copilot 窗口、UI composer 和 API 登录态。 |
| `opencli ima kb [--query <name>] [--transport api\|webcontents]` | read | 列出或搜索知识库。 |
| `opencli ima kb-info [--query <name>] [--transport api\|webcontents]` | read | 列出更完整的知识库元数据。 |
| `opencli ima ls --kb <name> [--path <folder>]` | read | 列出知识库目录下的文档和文件夹；支持 API、UI fallback 或显式 WebContents。 |
| `opencli ima export <document> [--output <path>]` | read | 按标题或 mediaId 下载文档。 |
| `opencli ima ask <question> --kb <name>` | write | 对指定知识库提一个问题。 |
| `opencli ima ask <question> --kb-id <id>` | write | 按知识库 id 提问；direct API 失败时 `auto` 可退回 WebContents。 |
| `opencli ima dump [--output <file>]` | read | 导出 macOS Accessibility tree，用于调试选择器。 |

### 问答示例

自动选择 transport：

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" --timeout 90 -f json
```

强制使用 UI fallback：

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" --transport ui --timeout 90 -f json
```

强制使用直接 API：

```bash
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --transport api -f json
```

强制在 ima.copilot 真实 WebContents 中执行：

```bash
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --transport webcontents -f json
```

### 知识库示例

列出所有可访问知识库的详细信息：

```bash
opencli ima kb-info --transport webcontents -f json
```

按名称搜索知识库信息：

```bash
opencli ima kb-info --query "我的知识库" --transport webcontents -f json
```

### 文档示例

列出知识库根目录：

```bash
opencli ima ls --kb "我的知识库" -f json
```

列出子目录：

```bash
opencli ima ls --kb-id "<KnowledgeBaseId>" --path "资料目录/子目录" -f json
```

通过真实 WebContents 列出文档：

```bash
opencli ima ls --kb-id "<KnowledgeBaseId>" --transport webcontents -f json
```

下载文档：

```bash
opencli ima export "示例文档.pdf" --kb "我的知识库" --output ~/Downloads -f json
```

按 mediaId 下载：

```bash
opencli ima export --media-id "<MediaId>" --output ~/Downloads/example.pdf -f json
```

通过 WebContents 解析下载地址后下载：

```bash
opencli ima export --media-id "<MediaId>" --kb-id "<KnowledgeBaseId>" --transport webcontents --output ~/Downloads/example.pdf -f json
```

## 运行要求

- macOS，且已安装 `/Applications/ima.copilot.app`。
- ima.copilot 已登录。当前已测试 app 版本为 `147.0.7727.4575`。
- 如果使用 UI transport，运行 OpenCLI 的终端进程需要 macOS Accessibility 权限。
- 如果 API transport 需要解密本机 Cookie，需要允许读取 `ima.copilot Safe Storage` 的 macOS Keychain 项。
- 如果使用 WebContents transport，Node.js runtime 需要提供全局 `WebSocket`；推荐 Node.js 22+。

Windows 支持尚未完成。代码中已经加入平台适配层，便于后续实现 Windows WebContents 启动、profile 发现和本地安全存储能力；详见 [Platform Adapter and OS Differences](docs/platform-adapter.md)。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `IMA_KB_ID` | 默认 API knowledge-base id。 |
| `IMA_COOKIE` / `IMA_COOKIE_HEADER` | 用于 API 实验的完整 `x-ima-cookie` 字符串。 |
| `IMA_SAFE_STORAGE_PASSWORD` | Chromium safe-storage password；用于替代 Keychain 读取。 |
| `IMA_KEYCHAIN_TIMEOUT_MS` | 单次 Keychain 读取超时时间。 |
| `IMA_SWIFT_TIMEOUT_MS` | Swift Accessibility 子进程超时时间。 |
| `IMA_API_BASE` | 覆盖 `https://ima.qq.com/cgi-bin`。 |
| `IMA_API_ENDPOINT` | 覆盖 `assistant_nl/knowledge_base_qa`。 |
| `IMA_EXTENSION_VERSION` | 覆盖 extension version 请求头。 |
| `IMA_GUID` / `IMA_Q36` / `IMA_IUA` | API 实验中覆盖设备 Cookie 字段。 |
| `IMA_WEBCONTENTS_CDP_PORT` | WebContents transport 使用的本地 CDP 端口；默认 `9227`。 |
| `IMA_WEBCONTENTS_LAUNCH` | 设为 `0` 时要求用户自行启动可访问 CDP 的 ima.copilot。 |

## 开发

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

项目结构：

```text
opencli-plugin.json        插件元数据
package.json               npm 元数据和发布文件边界
LICENSE                    MIT license
CHANGELOG.md               变更记录
DEVELOPMENT.md             本地验证和发布检查清单
ask.ts                     一次性知识库问答命令
kb.ts                      知识库列表/搜索命令
kb-info.ts                 详细知识库元数据列表命令
setup.ts                   本地准备状态检查
status.ts                  运行时状态摘要
dump.ts                    Accessibility tree 导出命令
ls.ts                      知识库文档列表命令
export.ts                  知识库文档导出命令
lib/api.js                 直接 ima API transport
lib/webcontents.js         在真实 ima Chromium WebContents 中执行 API
lib/documents.js           本地预览 URL 提取和文件下载辅助
lib/ax.js                  Swift Accessibility UI transport
lib/platform.js            OS-specific 路径、app 启动、profile 和 safe-storage 适配
test/*.test.js             单元测试和命令注册测试
docs/                      实验记录和实现证据
```

OpenCLI 会扫描插件根目录下的 `.ts` 和 `.js` 命令文件。TypeScript 插件会在 `opencli plugin install` 时转译；`npm run build` 会在本地模拟该步骤，并在根命令文件旁生成 `*.js`。

真实 app 验证和发布步骤见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 策略说明

当前策略是：`LOCAL` + direct ima API + real-WebContents API execution + macOS Accessibility UI fallback。

约定：

- API path：使用本机 ima 登录态、本地 Chromium Cookie DB 和 ima 前端 API endpoint。
- WebContents path：连接本机 ima.copilot CDP，通过真实页面的 `chrome.imaFrame` native bridge 获取账号/设备请求头，并在页面中执行 browser `fetch`。
- UI path：操作可见 ima.copilot 知识库 UI、问答输入框和生成结果文本。

证据：

- 当前测试 app：`/Applications/ima.copilot.app`，版本 `147.0.7727.4575`，bundle id `com.tencent.imamac`。
- 观察到的 API endpoint：
  - `knowledge_tab_reader/search_knowledge_base`
  - `knowledge_tab_reader/get_knowledge_base_list`
  - `assistant_nl/knowledge_base_qa`
- API 请求需要 `x-ima-cookie`、`from_browser_ima`、`extension_version` 和 `x-ima-bkn`。
- direct API 当前仍可能返回 `600001`。
- WebContents 在真实 app 页面上下文中已返回成功的知识库列表、文档列表和问答结果。
- WebContents Q&A 使用真实前端 session 路径：先 `session_logic/init_session`，再 `assistant/qa`。
- `ask --transport auto` 会在 API 失败且 UI composer 不可见或 UI fallback 失败时使用 WebContents。

## 已知限制

- UI transport 会操作真实 ima.copilot app，可能留下可见问答历史。
- WebContents transport 在没有可用 CDP endpoint 时，可能退出并重新启动 ima.copilot。
- 因为 WebContents 已参与 `ask --transport auto` 的后段 fallback，默认 `ask` 在 API/UI 都不可用时也可能重启 ima.copilot 并开启本地 CDP 端口。
- WebContents transport 会开启本地调试端口，只应在可信本机桌面会话中使用。
- `ima ask --transport webcontents` 会创建真实 ima Q&A session，可能在本机 app 账号中留下历史。
- UI transport 要求目标知识库名称在当前 UI 中可见/可选择。
- UI transport 的 `ReferencesFound` 是 best-effort，可能受 UI 文本结构影响。
- Direct API transport 仍需要继续研究 native bridge refresh、device 和 crypto context，才能成为唯一主路径。
- `ima ls` 的 API transport 依赖 `knowledge_tab_reader/get_knowledge_list`，真实环境中该 endpoint 可能返回 `600001`。
- `ima export --transport recent` 只能下载本机 ima.copilot profile 中已经存在预览 URL 的文档，通常需要先在 app 中打开过该文档。

匿名化实验记录见 [docs/ima-copilot-call-experiments.md](docs/ima-copilot-call-experiments.md)。

## License

MIT。详见 [LICENSE](LICENSE)。
