# Verified OpenClaw contracts

Verified on 2026-10-09 against the npm **openclaw@2026.9.9** package, its exported declarations, and its bundled documentation. Current online/main docs describe features that this published package does not expose. Type checking uses the actual npm package, not locally invented SDK declarations.

## Public imports

- `openclaw/plugin-sdk/core`: `OpenClawPluginApi` (type only).
- `openclaw/plugin-sdk/plugin-entry`: `definePluginEntry`, `buildJsonPluginConfigSchema`.

No private imports, direct core database access, HTTP hook bridge, shell-triggered agent, or CLI dispatch bridge are used. Other imports are Node public APIs and ordinary npm libraries.

## Registration, activation, and ownership

`registerTool(factory, { names })` supplies trusted `context.agentId`, plus optional live invocation/input assertions. The factory hides tools for disallowed owners; operations recheck allowlist and ownership. Public manifest `contracts.tools` declares tool ownership and `activation.onStartup: true` starts the listener even with no watchers.

The published `registerService` contract is v1: `id`, `reload.configPrefixes`, asynchronous `start(context)` and `stop(context)`. Context provides committed config, a public state directory, logger, and health reporting. It does **not** provide the newer v2 service scheduler shown on main. Our small lifecycle-owned scheduler joins background work on stop. Configured agent IDs come from canonical `agents.entries`.

`configSchema`, `configGroups`, `uiHints.sensitive`, and `configContracts.secretInputs.paths` provide generic native settings, redaction, and SecretRef materialization. Service config can retain the authored reference during activation. During replacement activation the global prepared snapshot can still describe the previous generation. The service reads the candidate plugin API’s host-validated `api.pluginConfig.accessToken` instead; it does not implement a secret provider or persist credentials. The native schema exposes a structured reference, including `store`, rather than a string/object union that falls back to a JSON editor. The integration smoke test uses a synthetic environment SecretRef.

## Third-party dispatch

The public `api.runtime.agent.runEmbeddedAgent` supports lifecycle service callers with plugin identity. We use the trusted tool context's session key, the public `agent.session.getSessionEntry` session UUID, captured sender/channel/account context, and current permission mode. No model override or extra tool grant is supplied. A session UUID changed by reset/deletion is not adopted automatically. Gateway writer admission also rejects a stale UUID or agent/session ownership mismatch.

`onUserMessagePersisted` identifies the current submitted event's transcript handoff; `onUserMessagePersistenceInvalidated` revokes that evidence. We record `delivered` only when persistence remains confirmed after the attempt settles, even if later model/tool execution failed. Model completion alone is not a receipt. This API does not automatically transport the final reply to an external channel or promise a live dashboard update. The event is available in canonical chat history; the agent's message tool can execute normal permitted actions.

Actual disposable Gateway tests verified existing-session continuity, normal message execution against a synthetic channel, public `chat.history` visibility, shared-session sequencing, restart persistence, sender-specific group tool denials, reset rejection, cross-agent rejection, and cancellation before launch.

Run IDs **do not deduplicate** embedded calls: replaying the same ID executed twice in the probe. The outbox durably reserves `running` before invoking the API. Startup converts interrupted/legacy accepted work to `uncertain`; it is never automatically replayed. Explicit manual retry acknowledges duplicate risk. This is a handoff lifecycle, not exactly-once external action execution.

`api.runtime.subagent.run` was tested but abandoned because the published subagent layer hard-denies standard `message` and `sessions_send` tools. `completionDelivery: current-requester` only applies within an authenticated inbound `before_dispatch` hook, not a later HA event. Hook-agent dispatch and `runtime.gateway.request` are restricted to bundled/trusted official plugins; the latter rejection was confirmed against the actual Gateway. We do not impersonate trusted plugins or HA content as email.

## Persistence limitation and chosen implementation

The npm 2026.9.9 documentation explicitly restricts `api.runtime.state.openKeyedStore` and other native store openers to bundled/trusted official plugins. Current online/main docs say they are available to all loaded plugins. We follow the published contract and do **not** call the restricted opener.

The public service state directory plus a plugin-owned atomic file and `proper-lockfile` gives this independent plugin durable state without private SQLite access or trust impersonation. A single document commits watcher consumption, dedup, and outbox admission together. The repository serializes all updates and reloads the disk record, so failed or uncertain writes do not leave a misleading in-memory committed state. Corruption is never replaced silently. Future adoption of a public native store requires a tested version gate and explicit migration.

## Sources

- [OpenClaw building plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [OpenClaw agent runtime](https://docs.openclaw.ai/plugins/sdk-runtime/agent)
- [OpenClaw background work](https://docs.openclaw.ai/plugins/sdk-runtime/background-work)
- [OpenClaw state and system](https://docs.openclaw.ai/plugins/sdk-runtime/state-and-system)
- [Manifest configuration and secrets](https://docs.openclaw.ai/plugins/manifest/config-and-secrets)
- [Public OpenClaw repository](https://github.com/openclaw/openclaw), reference checkout `4360894cc86b1c9a2389dad2a1530d9f8d9cbc32` (main comparison only)
- [npm version used for type checks](https://www.npmjs.com/package/openclaw/v/2026.9.9)
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)

Public SDK APIs are experimental. Version pinning is deliberate. Do not relax it solely because a newer host keeps the same method names.
