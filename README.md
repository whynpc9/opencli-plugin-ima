# opencli-plugin-ima

[中文文档](README.zh-CN.md)

OpenCLI plugin for one-shot and session-based Q&A against a selected `ima.copilot` knowledge base.

## What It Does

The first supported workflow is intentionally narrow:

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" -f json
```

`ask` uses `--transport auto` by default:

1. Try the local ima API using the existing ima.copilot login state.
2. If the API returns an auth/business error, use the foreground ima.copilot UI through macOS Accessibility when the question composer is visible.
3. If the UI composer is not visible or UI fallback fails, run the same frontend API call inside ima.copilot's real Chromium WebContents.
4. Return one generated answer.

By default this remains one question and one answer. WebContents transport can also continue a previous `ima ask` session with `--session continue` or an explicit `--session-id`.

For API calls that fail with ima business error `600001`, the WebContents transport runs the frontend API call inside ima.copilot's real Chromium page so native bridge account/device headers come from the app itself:

```bash
opencli ima kb --transport webcontents -f json
```

## Tested Baseline

- ima.copilot app: `147.0.7727.4575` (`CFBundleVersion: 7727.4575`)
- macOS app path: `/Applications/ima.copilot.app`
- Bundle id observed during development: `com.tencent.imamac`
- Windows app root observed during development: `%LOCALAPPDATA%\ima.copilot`
- Supported workflow verified: one question against one selected knowledge base through WebContents transport; UI transport is retained as a macOS fallback when the composer is visible to Accessibility.
- WebContents transport verified on macOS and Windows: knowledge-base list, document list, document download URL resolution, and one-shot Q&A return success from the real ima page context.
- API transport is implemented but still treated as experimental for real app runs because it can return `600001`.

## Install

From a local development checkout:

```bash
npm install
npm test
opencli plugin install file://$(pwd)
opencli ima setup --activate
```

After publishing to GitHub:

```bash
opencli plugin install github:whynpc9/opencli-plugin-ima
```

## Commands

| Command | Access | Description |
| --- | --- | --- |
| `opencli ima setup [--activate]` | read | Check app, Accessibility, WebContents, API cookie, and Keychain readiness. |
| `opencli ima status` | read | Summarize current ima.copilot window, WebContents, and API login state. |
| `opencli ima kb [--query <name>] [--transport auto\|api\|webcontents]` | read | List or search knowledge bases; `auto` prefers WebContents on Windows. |
| `opencli ima ls --kb <name> [--path <folder>]` | read | List documents and folders in a knowledge base path; `auto` can fall back to WebContents. |
| `opencli ima export <document> [--output <path>]` | read | Download a document by title or mediaId; `auto` can resolve URLs through WebContents. |
| `opencli ima ask <question> --kb <name>` | write | Ask one question against a named knowledge base. |
| `opencli ima ask <question> --kb-id <id>` | write | Ask by knowledge-base id; auto can fall back to WebContents when direct API fails. |
| `opencli ima dump [--output <file>]` | read | Dump macOS Accessibility or Windows WebContents diagnostics for debugging. |

### Ask Examples

Use automatic transport selection:

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" --timeout 90 -f json
```

Force UI fallback, useful when API returns `600001`:

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" --transport ui --timeout 90 -f json
```

Force direct API, useful when you already know the knowledge-base id:

```bash
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --transport api -f json
```

Force experimental WebContents API execution inside ima.copilot:

```bash
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --transport webcontents -f json
```

Start a clean WebContents session, then continue it:

```bash
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --session new --transport webcontents -f json
opencli ima ask "继续上一轮，列出三个重点" --kb-id "<KnowledgeBaseId>" --session continue --transport webcontents -f json
```

Continue a known session id:

```bash
opencli ima ask "继续追问" --session-id "<SessionId>" --transport webcontents -f json
```

Select a model or thinking mode:

```bash
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --model ds-v3.2 --transport webcontents -f json
opencli ima ask "请深入分析" --kb-id "<KnowledgeBaseId>" --model ds-v3.2 --think deep --transport webcontents -f json
opencli ima ask "请总结这个知识库" --kb-id "<KnowledgeBaseId>" --model-type 5 --model-id "<ModelId>" --transport webcontents -f json
```

### Document Examples

List the root of a knowledge base:

```bash
opencli ima ls --kb "我的知识库" -f json
```

List a subfolder:

```bash
opencli ima ls --kb-id "<KnowledgeBaseId>" --path "资料目录/子目录" -f json
```

List through ima.copilot's real WebContents:

```bash
opencli ima ls --kb-id "<KnowledgeBaseId>" --transport webcontents -f json
```

Force UI fallback against the currently visible ima.copilot knowledge-base page:

```bash
opencli ima ls --transport ui -f json
```

Download by title. `auto` tries direct API first, then WebContents, then falls back to a local preview URL if the document has been opened in ima.copilot before:

```bash
opencli ima export "示例文档.pdf" --kb "我的知识库" --output ~/Downloads -f json
```

Download by mediaId:

```bash
opencli ima export --media-id "<MediaId>" --output ~/Downloads/example.pdf -f json
```

Download after resolving the document URL in ima.copilot's real WebContents:

```bash
opencli ima export --media-id "<MediaId>" --kb-id "<KnowledgeBaseId>" --transport webcontents --output ~/Downloads/example.pdf -f json
```

## Runtime Requirements

- macOS with `/Applications/ima.copilot.app` installed, or Windows with ima.copilot installed under `%LOCALAPPDATA%\ima.copilot`.
- ima.copilot is logged in. The currently tested app version is `147.0.7727.4575`.
- macOS Accessibility permission for the terminal/OpenCLI process if UI transport is used.
- macOS Keychain access for `ima.copilot Safe Storage` if API transport decrypts local cookies.
- Windows DPAPI current-user access and a readable Chromium `Local State` file if API transport decrypts local cookies on Windows.
- `sqlite3` on `PATH` if direct API transport reads Chromium cookies from the local Cookie DB.
- Node.js runtime with a global `WebSocket` implementation if WebContents transport is used. Node.js 22+ is recommended.

Windows support is implemented for the WebContents path. Direct API can now attempt DPAPI cookie-key decryption, but it is still experimental and may return ima business error `600001`; Windows UI Automation is currently a sanitized status probe, not a UI transport fallback. See [Platform Adapter and OS Differences](docs/platform-adapter.md).

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `IMA_KB_ID` | Default API knowledge-base id. |
| `IMA_COOKIE` / `IMA_COOKIE_HEADER` | Complete `x-ima-cookie` cookie string for API development. |
| `IMA_SAFE_STORAGE_PASSWORD` | Chromium safe-storage password, used instead of Keychain lookup. |
| `IMA_KEYCHAIN_TIMEOUT_MS` | Per-attempt Keychain read timeout. |
| `IMA_DPAPI_TIMEOUT_MS` | Windows DPAPI cookie-key decrypt timeout. |
| `IMA_SWIFT_TIMEOUT_MS` | Swift Accessibility subprocess timeout override. |
| `IMA_API_BASE` | Override `https://ima.qq.com/cgi-bin`. |
| `IMA_API_ENDPOINT` | Override `assistant_nl/knowledge_base_qa`. |
| `IMA_EXTENSION_VERSION` | Override extension version header. |
| `IMA_GUID` / `IMA_Q36` / `IMA_IUA` | Override device cookie fields during API experiments. |
| `IMA_MODEL_TYPE` / `IMA_MODEL_ID` | Override ask model fields for API and WebContents experiments. |
| `IMA_SESSION_STATE_FILE` | Override the local file used to remember the last WebContents ask session id. |
| `IMA_WEBCONTENTS_CDP_PORT` | Override the local CDP port used by WebContents transport. Defaults to `9227`. |
| `IMA_WEBCONTENTS_LAUNCH` | Set to `0` to require an already-running CDP-enabled ima.copilot instead of launching one. |

## Development

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

Project layout:

```text
opencli-plugin.json        Plugin metadata
package.json               npm metadata and publish file boundary
LICENSE                    MIT license
CHANGELOG.md               Release notes
DEVELOPMENT.md             Local validation and release checklist
ask.ts                     Knowledge-base Q&A command with one-shot, session, and model controls
kb.ts                      Knowledge-base listing/search command
setup.ts                   Local readiness check
status.ts                  Runtime status summary
dump.ts                    Accessibility tree dump command
ls.ts                      Knowledge-base document listing command
export.ts                  Knowledge-base document export command
lib/api.js                 Direct ima API transport
lib/webcontents.js         API execution inside ima.copilot's real Chromium WebContents
lib/documents.js           Local preview URL extraction and file download helpers
lib/ax.js                  Swift Accessibility UI transport
lib/uia.js                 Sanitized Windows UI Automation status probe
lib/platform.js            OS-specific paths, app launch, profile, and safe-storage adapters
test/*.test.js             Unit and command registration tests
docs/                      Experiment notes and implementation evidence
```

OpenCLI scans plugin root `.ts` and `.js` files. TypeScript plugins are transpiled during `opencli plugin install`; `npm run build` mirrors that step locally and emits `*.js` next to the root command files.

For real app validation and release steps, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Strategy Note

Strategy: `LOCAL` plus direct ima API, real-WebContents API execution, and macOS Accessibility UI fallback when the composer is available.

Contract:

- API path: local ima login state, local Chromium Cookie DB, and ima frontend API endpoints.
- WebContents path: local CDP connection to ima.copilot, native `chrome.imaFrame` bridge calls for account/device headers, and browser `fetch` from the real app page. On Windows this relaunches ima.copilot with a temporary junction pointing to the real Chromium `User Data` directory.
- UI path: visible ima.copilot knowledge-base UI, question composer, and generated answer text.

Evidence:

- Current tested app: `/Applications/ima.copilot.app`, version `147.0.7727.4575`, bundle id `com.tencent.imamac`.
- Windows WebContents smoke: version `147.0.7727.4575`, `CLIENT-TYPE=windows`, knowledge-base search, one-shot Q&A, document listing, and document download completed through the real WebContents context.
- API endpoints observed in local frontend:
  - `knowledge_tab_reader/search_knowledge_base`
  - `knowledge_tab_reader/get_knowledge_base_list`
  - `assistant_nl/knowledge_base_qa`
- API requests need `x-ima-cookie`, `from_browser_ima`, `extension_version`, and `x-ima-bkn`.
- API can currently return `600001` even when local cookies are present; UI fallback has completed the target workflow.
- WebContents API execution has returned successful knowledge-base list responses in the real app context where direct Node API returned `600001`.
- WebContents document listing has also returned rows from the real app context.
- WebContents Q&A succeeds when it follows the frontend session path: `session_logic/init_session` followed by `assistant/qa`; explicit `--session-id` and cached `--session continue` reuse the `assistant/qa` session id.
- `ask` can pass `model_info.model_type` and optional `model_info.model_id` through API and WebContents transports. UI transport does not support model switching.
- `ask --transport auto` now uses WebContents after API failure when the UI composer is not visible or UI fallback fails.
- `ls --transport auto` and `export --transport auto` now try WebContents after direct API failure before using UI/recent fallbacks.

## Known Limits

- UI transport operates the real ima.copilot app and may create visible Q&A history.
- WebContents transport may quit and relaunch ima.copilot with local CDP enabled if no CDP endpoint is already available.
- Because WebContents participates in `ask --transport auto` after API/UI failure, default `ask` may also relaunch ima.copilot and open the local CDP port.
- On Windows, WebContents launch uses a temporary directory junction to the local ima.copilot `User Data` directory so the relaunched app keeps the current login state.
- WebContents transport opens a local debugging port. Use it only in a trusted local desktop session.
- `ima ask --transport webcontents` creates a real ima Q&A session and may leave visible history in the local app account.
- `ima ask --session continue` uses a local session-state file that stores session ids and knowledge-base identifiers, but not questions or answers. Use `IMA_SESSION_STATE_FILE` to redirect it.
- Session controls require WebContents transport. In `auto`, session controls skip direct API and UI because those paths cannot continue a known WebContents session.
- Model controls are supported by API and WebContents transports. In `auto`, UI fallback is skipped when model controls are present because UI automation cannot guarantee the selected model.
- UI transport requires the target knowledge-base name to be visible/selectable in the current ima UI.
- `ReferencesFound` on UI transport is best-effort and may be affected by UI text structure.
- Direct API transport still needs more work around native bridge refresh/device/crypto context before it can be the only transport.
- Windows direct API transport can decrypt Chromium cookie keys through DPAPI, but still depends on `sqlite3` for reading the local Cookie DB and may return `600001`; use WebContents for the reliable path.
- Windows UI transport and Accessibility dumps are not implemented. `status`/`setup` can run a sanitized UI Automation probe, while `ima dump` writes a WebContents target diagnostic on Windows.
- `ima ls` API transport depends on `knowledge_tab_reader/get_knowledge_list`; in the current real environment this endpoint can return `600001`.
- `ima ls` UI fallback reads the visible ima.copilot list through macOS Accessibility when Chromium exposes the WebArea content. It cannot verify `--kb-id`; use `--kb` or switch ima.copilot to the target knowledge base before `--transport ui`.
- `ima export --transport recent` can only download documents whose preview URL is already present in the local ima.copilot profile, usually after opening the document once in the app.

See [docs/ima-copilot-call-experiments.md](docs/ima-copilot-call-experiments.md) for the anonymized experiment log.

## License

MIT. See [LICENSE](LICENSE).
