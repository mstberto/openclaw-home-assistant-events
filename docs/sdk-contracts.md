# Verified OpenClaw contracts

Verified on 2026-10-09 against the npm **openclaw@2026.9.9** package, its exported declarations, and its bundled documentation. Current online/main docs describe features that this published package does not expose. Type checking uses the actual npm package, not locally invented SDK declarations.

## Public imports

- `openclaw/plugin-sdk/core`: `OpenClawPluginApi` (type only).
- `openclaw/plugin-sdk/plugin-entry`: `definePluginEntry`, `buildJsonPluginConfigSchema`.

No private imports, direct core database access, HTTP hook bridge, shell-triggered agent, or normal-chat fallback are used. Other imports are Node public APIs and ordinary npm libraries.

## Registration, activation, and ownership

`registerTool(factory, { names })` supplies trusted `context.agentId`, plus optional live invocation/input assertions. The factory hides tools for disallowed owners; operations recheck allowlist and ownership. Public manifest `contracts.tools` declares tool ownership and `activation.onStartup: true` starts the listener even with no watchers.

The published `registerService` contract is v1: `id`, `reload.configPrefixes`, asynchronous `start(context)` and `stop(context)`. Context provides committed config, a public state directory, logger, and health reporting. It does **not** provide the newer v2 service scheduler shown on main. Our small lifecycle-owned scheduler joins background work on stop. Configured agent IDs come from canonical `agents.entries`.

`configSchema`, `configGroups`, `uiHints.sensitive`, and `configContracts.secretInputs.paths` provide generic native settings, redaction, and SecretRef materialization. The plugin receives runtime config; it does not implement a secret provider or persist credentials. The integration smoke test uses a synthetic environment SecretRef.

## Third-party dispatch

The public `api.runtime.subagent.run` supports background service callers with plugin identity and a live Gateway binding. Parameters include a canonical `agent:<owner>:subagent:<event>` session key, `message`, `deliver: false`, and `idempotencyKey`. We forward lifecycle revocation through `assertCurrent`. No model override, completion delivery, or added tools are requested.

`waitForRun({ runId, timeoutMs })` reports `ok`, `error`, `timeout`, or `pending`. Observation timeout does not cancel or prove failure. Accepted sessions use the owning agent's configured model and normal background-session tool policy; policy still decides which actions it can perform. The Gateway owns acceptance and subsequent execution.

`api.runtime.hooks.dispatchHookAgentTurn` is unsuitable: published docs restrict it to bundled/trusted official installations and `externalContentSource: "email"`. We do not pretend HA is email or bypass that trust gate. `runEmbeddedAgent` is also public, but the isolated background API provides the desired accepted-run receipt and idempotency input without manually managing transcript identity.

## Persistence limitation and chosen implementation

The npm 2026.9.9 documentation explicitly restricts `api.runtime.state.openKeyedStore` and other native store openers to bundled/trusted official plugins. Current online/main docs say they are available to all loaded plugins. We follow the published contract and do **not** call the restricted opener.

The public service state directory plus a plugin-owned atomic file and `proper-lockfile` gives this independent plugin durable state without private SQLite access or trust impersonation. A single document commits watcher consumption, dedup, and outbox admission together. The repository serializes all updates and reloads the disk record, so failed or uncertain writes do not leave a misleading in-memory committed state. Corruption is never replaced silently. Future adoption of a public native store requires a tested version gate and explicit migration.

## Sources

- [OpenClaw building plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [OpenClaw background work](https://docs.openclaw.ai/plugins/sdk-runtime/background-work)
- [OpenClaw state and system](https://docs.openclaw.ai/plugins/sdk-runtime/state-and-system)
- [Manifest configuration and secrets](https://docs.openclaw.ai/plugins/manifest/config-and-secrets)
- [Public OpenClaw repository](https://github.com/openclaw/openclaw), reference checkout `4360894cc86b1c9a2389dad2a1530d9f8d9cbc32` (main comparison only)
- [npm version used for type checks](https://www.npmjs.com/package/openclaw/v/2026.9.9)
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)

Public SDK APIs are experimental. Version pinning is deliberate. Do not relax it solely because a newer host keeps the same method names.
