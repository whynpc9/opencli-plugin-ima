# Development

## Local Setup

```bash
npm install
npm test
opencli plugin install file://$(pwd)
```

Restart the terminal after installing the plugin so OpenCLI reloads the plugin registry.

## Verification Checklist

Run checks that do not operate a real ima account:

```bash
npm test
npm pack --dry-run
SENSITIVE_PATTERN="real-user|real-kb-name|real-question|absolute-home-path"
rg -n "$SENSITIVE_PATTERN" . --glob '!node_modules/**'
```

Run checks that inspect or operate the local ima.copilot app:

```bash
opencli ima setup --activate
opencli ima status -f json
opencli ima ask "请总结这个知识库" --kb "我的知识库" --transport ui --timeout 90 -f json
```

The UI transport controls the foreground ima.copilot app and may create visible Q&A history.

## Release Checklist

1. Update `CHANGELOG.md`.
2. Confirm `README.md` lists the tested ima.copilot version.
3. Run `npm test`.
4. Run `npm pack --dry-run` and confirm the tarball only includes plugin source, runtime libraries, scripts, and documentation.
5. Replace the README GitHub install placeholder with the published repository owner.
