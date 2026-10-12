# Changelog

## 0.1.4

- Fix agent dispatch after live plugin activation using an authenticated, one-use loopback request on the unchanged OpenClaw 2026.9.9 host.
- Preserve the originating session model/runtime and Gateway configuration.
- Hide only plugin-owned internal event inputs while keeping agent replies and ordinary messages visible. Retain full event persistence and reliable receipts.
- Harden request authentication, concurrency, cancellation, shutdown, redirects, deadlines, and transport backoff. Uncertain events still require explicit review.
- Add hot-activation, visibility, and transport regressions to CI. Direct Gateway TLS and tailnet-only listening remain unsupported.

Validation: 53 automated tests; disposable Gateway live activation, exact-session delivery, hidden input/visible reply, actual crash recovery, and no replay; successful user-reported native Codex/macOS alert and visibility test.
