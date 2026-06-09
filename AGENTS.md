# AGENTS.md

## Project Context

This repository implements an OpenCLI plugin for one-shot Q&A against a selected ima.copilot knowledge base.

Before changing ima.copilot call behavior, read:

- `docs/effective-ima-call-methods.md`
- `docs/ima-copilot-call-experiments.md`

Before changing OS-specific paths, app launch, profile, safe-storage, or UI automation behavior, also read:

- `docs/platform-adapter.md`

The current reliable runtime path is `ima ask --kb <knowledgeBaseName>` through macOS Accessibility UI transport. Direct API transport exists and has unit coverage, but it is still experimental in real app runs because it can return ima business error `600001`.

## Development Rules

- Keep root command files in TypeScript: `ask.ts`, `kb.ts`, `setup.ts`, `status.ts`, `dump.ts`, `ls.ts`, and `export.ts`.
- OpenCLI scans plugin root command files. Do not move commands under `src/` unless the install/build strategy is updated and tested.
- Generated root `*.js` files are local build artifacts and are intentionally ignored by Git.
- Do not add runtime dependencies on Codex Computer Use. It may be used for manual experiments, but the plugin runtime must work through OpenCLI, Node.js, local app state, and macOS Accessibility/API code.

## Privacy Rules

Do not commit:

- Real knowledge base names.
- Real user questions or business answers.
- Cookies, tokens, Keychain output, or decrypted login state.
- Absolute local user paths.
- Screenshots or Accessibility dumps containing private ima content.

Use anonymized placeholders in documentation, tests, and examples.

## Required Checks

Before committing implementation or documentation changes, run:

```bash
npm test
npm pack --dry-run
```

For privacy review, run a focused scan for any real terms introduced during the task. Keep the scan pattern task-specific and do not commit real sensitive terms into documentation.
