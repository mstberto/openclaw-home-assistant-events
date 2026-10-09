# Home Assistant Events for OpenClaw

A small TypeScript plugin for persistent, agent-owned smart-home event subscriptions. Home Assistant's WebSocket listener runs continuously; an agent runs only when its subscription matches.

This complements the official Home Assistant MCP server. MCP handles discovery, current state, and control. This plugin handles future state transitions, numeric crossings, and sustained states. It never calls Home Assistant control services, selects a notification channel, or injects routine events into normal chat.

**Status:** 0.1.0 candidate, MIT licensed. Repository remains private pending publication approval. Supported host: **OpenClaw 2026.9.9**, Node **24.16+ on the 24.x line or 26.1+**. SDK contracts are experimental; other host versions are not claimed compatible. See [verified contracts](docs/sdk-contracts.md) and [release readiness](docs/release-readiness.md).

## Install in a test Gateway

Build from source:

```sh
npm ci --ignore-scripts
npm run check
npm pack
```

Install the generated `openclaw-home-assistant-events-0.1.0.tgz` using OpenClaw's supported plugin installer, then enable `openclaw-home-assistant-events`. Package installation may require a Gateway restart. Do this in a separate test Gateway before enabling it in an existing installation.

The package ships built JavaScript, its manifest, documentation, and a short optional discoverability skill. Nothing requires the official HA MCP integration to be installed, although it is the recommended companion for entity discovery.

## Native settings and credentials

Open the plugin's settings in OpenClaw and configure:

| Setting | Meaning |
| --- | --- |
| Home Assistant URL | HTTPS base URL; reverse-proxy base paths are supported |
| Access token | Prefer an OpenClaw SecretRef; the native settings field is marked sensitive |
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

Supply `HOME_ASSISTANT_TOKEN` to the Gateway through its existing secret/environment setup. OpenClaw resolves declared secret inputs; the plugin receives only the materialized credential. File and exec SecretRefs are also accepted by the manifest. Unresolved credentials fail startup. A plaintext string is supported for host compatibility, but is not the recommended storage method.

Credentials never enter subscriptions, delivery payloads, or plugin logs. HA long-lived tokens may permit more than listening: this plugin is read-only in behavior, not a guarantee that the token itself has read-only privileges. Use a suitable HA account and protect the token and Gateway host.

## Agent tools

Only explicitly allowed agents receive the tools. Ownership comes from OpenClaw's trusted tool context; agents cannot supply or change an owner ID.

| Tool | Purpose |
| --- | --- |
| `ha_events_subscribe` | Persist a one-shot or recurring watcher |
| `ha_events_list` | List the caller's watchers, including consumed one-shots |
| `ha_events_remove` | Remove a caller-owned watcher and cancel unsubmitted events |
| `ha_events_status` | Check listener synchronization and caller-owned delivery status |

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

## Isolated event execution

A matched event creates a dedicated background session for its owning agent via the public `api.runtime.subagent.run` API, with `deliver: false` and a stable idempotency key. No normal conversation is selected and no automatic completion route is supplied. The agent uses its configured model and tools, subject to host policy; the plugin supplies no model override or broader tool grant.

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

The instruction and observed state are distinct. State strings are untrusted external data. The owning agent decides what to do and, if needed, how to reach its user using existing permissions and tools. Because the run is isolated, the instruction should contain enough context to perform the task; the plugin does not copy normal chat history or infer an outbound destination. Agent policy may restrict communication tools in a background session.

## Reliability and operational limits

The listener authenticates, waits for subscription acknowledgment, takes a current-state snapshot, and replays buffered observed events without losing transitions already included in that snapshot. Heartbeat/deadline checks detect silent connections. Reconnect uses exponential backoff with jitter up to 60 seconds. Invalid credentials stop reconnect attempts until the service is restarted with corrected credentials.

Subscriptions, logical duration state, match deduplication, and the outbox persist in:

```text
<Gateway service stateDir>/plugins/openclaw-home-assistant-events/state.json
```

The file is private (0600 on POSIX) inside a private directory (0700), with a maintained single-writer lock. Each change writes and syncs a temporary file, atomically renames it, then syncs the directory. State is versioned and validated; corruption fails startup rather than silently deleting watchers. Stop joins listener work, timers, queue processing, and persistence before releasing ownership. After an abrupt crash a stale lock may delay startup by about ten seconds. Back up this directory separately; do not assume OpenClaw's private plugin-state database contains it. The file contains household state and instructions, so protect backups too.

Bounds: 1,000 subscriptions, 5,000 outstanding/failed delivery records, 10,000 recent dedup IDs, and 16 MiB persisted JSON. The HA snapshot payload is capped at 8 MiB; synchronization buffers at most 10,000 events. These conservative v0.1 limits are fixed. Completed deliveries leave the outbox; consumed watchers and failed deliveries remain until their owning agent removes the watcher. Queue saturation fails closed and is reported; transitions while saturated may be missed.

Admission retries use stable IDs, exponential backoff, and twelve attempts, then retain a failed record. Accepted run IDs are saved and polled. Observation timeouts keep the accepted record; a known terminal run failure is retained without automatically repeating actions. Removed agents' watchers stay stored and suspended; configuration reload stops future admissions under the old allowlist, while host-accepted work retains its own lifecycle.

**Guarantees have boundaries:**

- HA's live stream has no durable replay. Events during disconnects or processing failures may be missed. Snapshots reconcile duration conditions but do not invent missed state/numeric transitions.
- Dispatch is at-least-once admission with bounded retries and dedup, not exactly-once user notification. A crash between host acceptance and receipt persistence can cause replay after the host's dedup retention expires.
- Host acceptance or agent completion does not prove a notification was delivered. Accepted runs with uncertain terminal state remain visible; the plugin does not blindly resubmit them.
- The host retains isolated sessions according to its session lifecycle. This plugin does not delete agent execution history automatically.
- Persistence assumes a local POSIX filesystem with atomic rename, directory fsync, and reliable lock timestamps. Network filesystems and Windows durability have not been validated.

## Development

```sh
npm run check
npm run test:smoke
npm pack --dry-run
```

The smoke test launches a disposable Gateway, synthetic HA WebSocket server, and synthetic model endpoint in temporary state, with mock credentials. It must not use production configuration. CI checks Node 24 and 26, strict types, tests, builds, production dependency audit, and packaging. A manual release workflow prepares a package artifact and never publishes it automatically.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SDK contract notes](docs/sdk-contracts.md), and [release readiness](docs/release-readiness.md).
