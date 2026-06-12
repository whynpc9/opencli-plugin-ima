# Changelog

## Unreleased

- Added WebContents ask session controls: `--session new`, `--session continue`, and `--session-id`.
- Added ask model controls: `--model`, `--model-type`, `--model-id`, and `--think`.
- Added Windows WebContents launch support using the local ima.copilot install, Chromium `User Data` junctions, and `CLIENT-TYPE=windows`.
- Added WebContents fallback for `ima kb --transport auto`, `ima ls --transport auto`, and `ima export --transport auto`.
- Updated setup/status diagnostics to report WebContents readiness.
- Added Windows `ima dump` WebContents target diagnostics.
- Added Windows DPAPI support for decrypting the Chromium cookie encryption key and AES-GCM cookie payloads.
- Added a sanitized Windows UI Automation status probe; Windows UI transport remains unimplemented.

## 0.1.0 - 2026-06-09

- Added `ima ask` for one-shot knowledge-base Q&A.
- Added automatic transport selection: direct local API first, macOS Accessibility UI fallback when available, and WebContents fallback when UI is unavailable.
- Added `ima kb`, `ima ls`, `ima export`, `ima setup`, `ima status`, and `ima dump`.
- Added local build, test, and package dry-run workflow.
- Added anonymized experiment documentation under `docs/`.
