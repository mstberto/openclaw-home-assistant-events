# Contributing

Use Node 24.16+ on the 24.x line, or Node 26.1+. Run `npm ci --ignore-scripts` then `npm run check`. Keep OpenClaw imports within documented `openclaw/plugin-sdk/*` entrypoints. The supported host is pinned to 2026.9.9; changing it requires checking its published declarations and bundled docs, not just main-branch documentation.

Keep conditions deterministic and free of model calls. Never add user notification routing to the listener. Test failure behavior whenever changing persistence, ownership, reconnect, or dispatch. Use temporary directories and synthetic credentials; do not test against someone's live Gateway without permission.

Before submitting a release, follow [the release checklist](docs/release-readiness.md). Security issues belong in a private report to the maintainer; avoid publishing tokens, state files, or private household information in issues.
