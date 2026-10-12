# Home Assistant Events for OpenClaw

A small TypeScript plugin for persistent, agent-owned smart-home event subscriptions. Home Assistant's WebSocket listener runs continuously; an agent runs only when its subscription matches.

This complements the official Home Assistant MCP server. MCP handles discovery, current state, and control. This plugin handles future state transitions, numeric crossings, and sustained states. It never calls Home Assistant control services, selects a notification channel, or injects unmatched events into chat.

**Status:** 0.1.4, MIT licensed. Repository remains private pending publication approval. Supported host: **OpenClaw 2026.9.9**, Node **24.16+ on the 24.x line or 26.1+**. SDK contracts are experimental; other host versions are not claimed compatible. See [verified contracts](docs/sdk-contracts.md) and [release readiness](docs/release-readiness.md).

## Install in a test Gateway

Build from source:

```sh
npm ci --ignore-scripts
npm run check
npm pack
```

Install the generated `openclaw-home-assistant-events-0.1.4.tgz` using OpenClaw's supported plugin installer, then enable `openclaw-home-assistant-events`. Package installation may require a Gateway restart. Do this in a separate test Gateway before enabling it in an existing installation.

The package ships built JavaScript, its manifest, documentation, and a short optional discoverability skill. Nothing requires the official HA MCP integration to be installed, although it is the recommended companion for entity discovery.

## Native settings and credentials

Open the plugin's settings in OpenClaw and configure:

| Setting | Meaning |
| --- | --- |
| Home Assistant URL | HTTPS base URL; reverse-proxy base paths are supported |
| Access token | Select a secret source, provider, and secret name; the field is marked sensitive |
| Allowed agent IDs | Explicit IDs of configured agents; no agent is implicitly authorized |
| Allow insecure HTTP | Default false; explicit opt-in for a trusted local network |

The allowed-agent setting is an ordinary array. The public generic form does not provide a dynamic agent picker. Enable/disable the listener through OpenClaw's plugin enablement control.

Example plugin configuration (inside the existing `plugins.entries` map):

```json
{
  "openclaw-home-assistant-events": {
    "enabled": true,
    "config": {
      "url": "https://ha.example.com",
      "accessToken": {
        "source": "env",
        "provider": "default",
        "id": "HOME_ASSISTANT_TOKEN"
      },
      "allowedAgents": ["main"]
    }
  }
}
```

Supply `HOME_ASSISTANT_TOKEN` to the Gateway through its existing secret/environment setup. OpenClaw resolves declared secret inputs; the plugin reads the prepared credential from the candidate plugin API runtime configuration. File and exec SecretRefs are also accepted by the manifest. Unresolved credentials fail startup. The native form uses separate source, provider, and secret-name fields. For the simplest setup, save the token in Settings → Secrets, select `store`, enter provider `default`, and enter the saved secret name. Existing plaintext configurations must be migrated to a reference before applying this version.

Credentials never enter subscriptions, delivery payloads, or plugin logs. HA long-lived tokens may permit more than listening: this plugin is read-only in behavior, not a guarantee that the token itself has read-only privileges. Use a suitable HA account and protect the token and Gateway host.

## Agent tools

Only explicitly allowed agents receive the tools. Ownership comes from OpenClaw's trusted tool context; agents cannot supply or change an owner ID.

| Tool | Purpose |
| --- | --- |
| `ha_events_subscribe` | Persist a one-shot or recurring watcher |
| `ha_events_list` | List the caller's watchers, including consumed one-shots |
| `ha_events_remove` | Remove a caller-owned watcher and cancel unsubmitted events |
| `ha_events_status` | Inspect listener health and pending/running/delivered/uncertain/failed records |
| `ha_events_resolve` | Resolve a reviewed uncertain/failed event as delivered, dismissed, or explicitly retried |

Example subscription:

```json
{
  "entityId": "cover.garage",
  "trigger": { "type": "state_for", "state": "open", "durationMs": 1200000 },
  "oneShot": true,
  "instruction": "Let me know that the garage has stayed open for twenty minutes."
}
```

Use exact entity IDs, states, and units from HA MCP. A subscribe result contains the persistent `id`, owner, validated input, and creation timestamp. Removal accepts `{ "subscriptionId": "<returned UUID>" }`. Work already submitted to OpenClaw may still complete, including a submission racing with removal.

### Trigger semantics

- `state`: `{ "type": "state", "to": "home", "from": "not_home" }`. `from` is optional. Only a change into the target fires; a current-state snapshot does not simulate an arrival. Attribute-only updates do not fire.
- `numeric`: `{ "type": "numeric", "above": 80 }`, `{ "type": "numeric", "below": 20 }`, or both bounds. Strict comparisons; equality does not satisfy a bound. Only entry into the satisfying range fires, including a recovery from an unknown/non-numeric value into that range. Remaining inside does not repeat.
- `state_for`: `{ "type": "state_for", "state": "open", "durationMs": 1200000 }`. Counting begins no earlier than watcher creation. Leaving the state or removing the entity cancels the duration. A recurring watcher fires once per matching HA `last_changed` transition. Reconnect/restart requires a fresh snapshot before timers can fire; HA's reported transition time reconciles continuity.

`oneShot` defaults to true. Claiming a match persists consumption and its delivery together. It does not discard a failed dispatch: the outbox retains it. Separate recurring watchers are explicit; subscribing twice intentionally creates two watchers.

## Return to the originating conversation

A subscription captures its creating agent and exact session identity from OpenClaw's trusted tool context. Subscription arguments cannot choose a different session, owner, sender, or notification destination. A match continues that conversation through public `api.runtime.agent.runEmbeddedAgent`. The original history is available; save a self-contained instruction too, since conversations may later be compacted.

Event inputs are tagged as this plugin's internal messages. A synchronous public transcript hook marks only those user-role inputs in their originating session as non-displayed. The full event remains persisted for the agent, receipts, and audit; ordinary user messages and agent replies remain visible. Installation review includes this transcript hook. Existing visible event messages are not retroactively changed.

The plugin passes the captured sender, channel/account, and source route context and the current session permission mode. Normal host tool policy still applies; it does not force-enable message tools or request privileged grants. Reset/deletion fails closed rather than silently sending into a new conversation. Recreate the watcher after a reset. Subagent-created subscriptions are rejected. Legacy subscriptions without a source session need recreation; legacy accepted deliveries become uncertain for review.

On OpenClaw 2026.9.9, timers started during live plugin activation can inherit an expired Gateway request context. The plugin obtains fresh admission through its own internal loopback HTTP route before dispatching one saved event. This requires no Gateway update or admin token and does not send a user notification. Each request uses a random, in-memory, one-use credential; the route rejects non-loopback peers, request bodies, wrong methods, and replayed credentials. Concurrent wake calls coalesce. The client follows no redirects, and service shutdown or a lost connection cancels the admitted dispatch while preserving uncertain-event review.

The Gateway HTTP listener must accept connections on `127.0.0.1`. `loopback`, `lan`, and `auto` binding are compatible; a custom bind must be `127.0.0.1` or `0.0.0.0`. Gateway TLS and tailnet-only binding are not supported by this version. External TLS termination through an existing proxy can coexist with a loopback HTTP Gateway. Do not expose the internal route through a proxy or disable certificate checks. The plugin sends no idle wake requests; it makes one local request per due delivery. Requests stay open through the agent attempt, with an overall deadline of the configured agent timeout plus 30 seconds. A deadline or disconnect may leave an uncertain event; it never proves that the agent performed no action.

Payload shape:

```json
{
  "type": "home_assistant_event",
  "eventId": "<stable match ID>",
  "subscription": {
    "id": "<watcher UUID>",
    "instruction": "Previously authorized task",
    "oneShot": true
  },
  "event": {
    "entityId": "cover.garage",
    "from": "closed",
    "to": "open",
    "occurredAt": 1791556200000
  }
}
```

The instruction and observed state are distinct. State strings are untrusted external data. The owning agent decides what to do and how to reach its user. The plugin does not send user notifications. Captured source routing describes the original conversation, not a new user-notification destination.

### Handoff and manual review

| Status | Meaning | Recovery |
| --- | --- | --- |
| `pending` | Queued; runtime has not been invoked | Safe preflight retries with backoff |
| `running` | Attempt recorded durably before invocation | On restart becomes uncertain |
| `delivered` | Runtime confirmed this event persisted in the session transcript | Never automatically repeated |
| `uncertain` | Interrupted execution or missing/invalidated transcript evidence | Explicit manual review |
| `failed` | Definite preflight rejection or exhausted preflight retries | Inspect and resolve |
| `dismissed` | Reviewer chose to stop pursuing this event | Never repeated |

Delivery is **transcript persistence**, not successful model execution, notification delivery, or a live UI push. The public persistence callback is tracked with its invalidation callback; the plugin records the receipt when the runtime attempt settles. A model failure after confirmed persistence does not cause another event dispatch. A crash before the receipt is saved leaves uncertain work even when the transcript already contains the event. OpenClaw may independently resume the admitted agent turn after restart; uncertain status prevents the plugin from submitting another turn, not the host from continuing its own work.

Use `ha_events_status` to inspect the event ID, saved instruction, originating session, attempt ID, timestamps, and review reason. Check that conversation's history before deciding what happened. Resolve only after explicit user review:

```json
{ "deliveryId": "<event ID>", "resolution": "delivered" }
```

Other resolutions are `dismissed` and `retry`. Retry also requires `"acknowledgeDuplicateRisk": true`; it creates a new attempt for the same event and may repeat an action already performed. Only the owning allowed agent can review its records. Running work cannot be resolved while executing. Review does not retarget reset/deleted conversations; recreate their subscriptions instead.

## Reliability and operational limits

The listener authenticates, waits for subscription acknowledgment, takes a current-state snapshot, and replays buffered observed events without losing transitions already included in that snapshot. Heartbeat/deadline checks detect silent connections. Reconnect uses exponential backoff with jitter up to 60 seconds. Invalid credentials stop reconnect attempts until the service is restarted with corrected credentials.

Subscriptions, logical duration state, match deduplication, and the outbox persist in:

```text
<Gateway service stateDir>/plugins/openclaw-home-assistant-events/state.json
```

The file is private (0600 on POSIX) inside a private directory (0700), with a maintained single-writer lock. Each change writes and syncs a temporary file, atomically renames it, then syncs the directory. State is versioned and validated; corruption fails startup rather than silently deleting watchers. Stop joins listener work, timers, queue processing, and persistence before releasing ownership. After an abrupt crash a stale lock may delay startup by about ten seconds. Back up this directory separately; do not assume OpenClaw's private plugin-state database contains it. The file contains household state and instructions, so protect backups too.

Bounds: 1,000 subscriptions, 5,000 outstanding/failed delivery records, 10,000 recent dedup IDs, and 16 MiB persisted JSON. The HA snapshot payload is capped at 8 MiB; synchronization buffers at most 10,000 events. These conservative v0.1 limits are fixed. Up to 1,000 delivered/dismissed audit records are retained. Unresolved records are never silently pruned. Removing a watcher preserves running and uncertain attempts for review. Queue saturation fails closed and is reported; transitions while saturated may be missed.

Preflight retries use exponential backoff and twelve attempts. The queue saves running intent before invoking the runtime. Only definite pre-invocation failures are automatically retried; all inconclusive runtime attempts require review. Configuration reload aborts service-owned execution and future admissions under the old allowlist.

**Guarantees have boundaries:**

- HA's live stream has no durable replay. Events during disconnects or processing failures may be missed. Snapshots reconcile duration conditions but do not invent missed state/numeric transitions.
- Embedded run IDs are not host idempotency keys. Automatic replay of interrupted execution is deliberately prohibited. Pending events survive restart; running events become uncertain.
- Transcript handoff does not prove the agent executed its task or sent a notification. Real channel/UI delivery and host permissions remain the agent/host's responsibility. The smoke test exercises a real message tool against a synthetic transport and reads history through the Gateway's public `chat.history` API; it is not a test of Alice's live channels or automatic UI push updates.
- Normal chat turns and event turns share session sequencing. Reset/deletion can invalidate a queued event. Events may wait behind a long foreground turn.
- Persistence assumes a local POSIX filesystem with atomic rename, directory fsync, and reliable lock timestamps. Network filesystems and Windows durability have not been validated.

## Development

```sh
npm run check
npm run test:smoke
npm run test:hot-dispatch
npm pack --dry-run
```

The smoke test launches a disposable Gateway, synthetic HA WebSocket server, and synthetic model endpoint in temporary state, with mock credentials. It must not use production configuration. CI checks Node 24 and 26, strict types, tests, builds, production dependency audit, and packaging. A manual release workflow prepares a package artifact and never publishes it automatically.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SDK contract notes](docs/sdk-contracts.md), and [release readiness](docs/release-readiness.md).
