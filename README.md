# opencli-plugin-ima

OpenCLI plugin for one-shot Q&A against a selected `ima.copilot` knowledge base.

## What It Does

The first supported workflow is intentionally narrow:

```bash
opencli ima ask "请总结这个知识库" --kb "我的知识库" -f json
```

`ask` uses `--transport auto` by default:

1. Try the local ima API using the existing ima.copilot login state.
2. If the API returns an auth/business error, fall back to the foreground ima.copilot UI through macOS Accessibility.
3. Return one generated answer.

This is designed for one question and one answer. It does not try to manage multi-turn conversations.

## Tested Baseline

- ima.copilot app: `147.0.7727.4575` (`CFBundleVersion: 7727.4575`)
- macOS app path: `/Applications/ima.copilot.app`
- Bundle id observed during development: `com.tencent.imamac`
- Supported workflow verified: one question against one selected knowledge base through UI transport; API transport is implemented but still treated as experimental.

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
| `opencli ima setup [--activate]` | read | Check app, Accessibility, API cookie, and Keychain readiness. |
| `opencli ima status` | read | Summarize current ima.copilot window and API login state. |
| `opencli ima kb [--query <name>]` | read | List or search knowledge bases through the API path. |
| `opencli ima ask <question> --kb <name>` | write | Ask one question against a named knowledge base. |
| `opencli ima ask <question> --kb-id <id>` | write | Ask by API knowledge-base id; no UI fallback unless `--kb` is also provided. |
| `opencli ima dump [--output <file>]` | read | Dump the macOS Accessibility tree for selector debugging. |

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

## Runtime Requirements

- macOS with `/Applications/ima.copilot.app` installed.
- ima.copilot is logged in. The currently tested app version is `147.0.7727.4575`.
- macOS Accessibility permission for the terminal/OpenCLI process if UI transport is used.
- macOS Keychain access for `ima.copilot Safe Storage` if API transport decrypts local cookies.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `IMA_KB_ID` | Default API knowledge-base id. |
| `IMA_COOKIE` / `IMA_COOKIE_HEADER` | Complete `x-ima-cookie` cookie string for API development. |
| `IMA_SAFE_STORAGE_PASSWORD` | Chromium safe-storage password, used instead of Keychain lookup. |
| `IMA_KEYCHAIN_TIMEOUT_MS` | Per-attempt Keychain read timeout. |
| `IMA_SWIFT_TIMEOUT_MS` | Swift Accessibility subprocess timeout override. |
| `IMA_API_BASE` | Override `https://ima.qq.com/cgi-bin`. |
| `IMA_API_ENDPOINT` | Override `assistant_nl/knowledge_base_qa`. |
| `IMA_EXTENSION_VERSION` | Override extension version header. |
| `IMA_GUID` / `IMA_Q36` / `IMA_IUA` | Override device cookie fields during API experiments. |

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
ask.ts                     One-shot knowledge-base Q&A command
kb.ts                      Knowledge-base listing/search command
setup.ts                   Local readiness check
status.ts                  Runtime status summary
dump.ts                    Accessibility tree dump command
lib/api.js                 Direct ima API transport
lib/ax.js                  Swift Accessibility UI transport
test/*.test.js             Unit and command registration tests
docs/                      Experiment notes and implementation evidence
```

OpenCLI scans plugin root `.ts` and `.js` files. TypeScript plugins are transpiled during `opencli plugin install`; `npm run build` mirrors that step locally and emits `*.js` next to the root command files.

For real app validation and release steps, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Strategy Note

Strategy: `LOCAL` plus direct ima API, with macOS Accessibility UI fallback.

Contract:

- API path: local ima login state, local Chromium Cookie DB, and ima frontend API endpoints.
- UI path: visible ima.copilot knowledge-base UI, question composer, and generated answer text.

Evidence:

- Current tested app: `/Applications/ima.copilot.app`, version `147.0.7727.4575`, bundle id `com.tencent.imamac`.
- API endpoints observed in local frontend:
  - `knowledge_tab_reader/search_knowledge_base`
  - `knowledge_tab_reader/get_knowledge_base_list`
  - `assistant_nl/knowledge_base_qa`
- API requests need `x-ima-cookie`, `from_browser_ima`, `extension_version`, and `x-ima-bkn`.
- API can currently return `600001` even when local cookies are present; UI fallback has completed the target workflow.

## Known Limits

- UI transport operates the real ima.copilot app and may create visible Q&A history.
- UI transport requires the target knowledge-base name to be visible/selectable in the current ima UI.
- `ReferencesFound` on UI transport is best-effort and may be affected by UI text structure.
- Direct API transport still needs more work around native bridge refresh/device/crypto context before it can be the only transport.

See [docs/ima-copilot-call-experiments.md](docs/ima-copilot-call-experiments.md) for the anonymized experiment log.

## License

MIT. See [LICENSE](LICENSE).
