# Plugin-only admission prototype

## Constraint and result

The Gateway remains on OpenClaw 2026.9.9. No core edits, updates, private SDK
imports, trusted-plugin impersonation, or production changes were used.

A plugin-owned HTTP route registered through public `api.registerHttpRoute`
provides a fresh request admission. The lifecycle scheduler makes a loopback POST
to that route; its handler awaits the existing outbox drain and normal-agent
dispatch. This is internal work admission, not transport of a notification to a
user. The existing captured session, sender policy, allowed-agent checks,
transcript receipt, and uncertain-delivery protections remain in use.

The route uses `auth: 'plugin'`, exact matching, POST-only admission, a direct
loopback socket address check, and timing-safe comparison of a random 256-bit
service-owned bearer credential. The credential stays in memory and rotates
when the service starts or stops. No Gateway admin credential is required.
The request supplies no prompt, destination, agent, session, or device action;
the handler processes the plugin's saved queue.

## Disposable tests

With only the plugin prototype changed, `scripts/smoke.mjs --hot-dispatch`
passed live enable with protected-store credentials, HA synchronization, exact
originating-session persistence/history, one standard message-tool send to the
synthetic channel, actual process crash recovery, no replay, and manual review.

Additional requests confirmed missing authorization, incorrect authorization,
and GET are rejected with HTTP 403. These are targeted probes, not a complete
security or cross-platform certification.

The reviewed prototype diff is saved at
`artifacts/plugin-loopback-admission-prototype.patch`. Prototype source edits were
restored after testing. Candidate 0.1.4-rc.3 now contains a modular, hardened
implementation in `src/local-wake.ts`; it does not apply that prototype patch or
modify the Gateway.

## Hardened candidate and remaining validation

- The transport now uses one-use in-memory credentials, one event per admitted
  request, no request bodies, no redirects, concurrent-call coalescing, due-work
  gating, transport backoff, disconnect/deadline cancellation, and shutdown joining
  handler cleanup. It awaits execution before responding. Unit tests cover these
  boundaries and stale-credential rejection after stopping/restarting a binding.
- Validate loopback listening and HTTP/TLS configuration. The experiment uses
  plain HTTP bound to loopback. Do not disable certificate verification to make
  TLS installations work.
- Extend real Gateway validation to replacement while an agent is running and
  slow native-model execution, beyond the unit cancellation/deadline probes.
- Confirm route capability disclosure in native installation review and check
  coexistence with proxies or route policy. No settings should expose it publicly.
- Validate native Codex handoff separately. The tested synthetic model uses the
  default OpenClaw runtime; that proves the admission solution, not every runtime.

The tradeoff is one additional local HTTP hop and an authenticated internal route
to maintain. It requires no known feature compromise, but it is not downside-free.
The user subsequently confirmed native Codex handoff and a real alert; 0.1.4 includes the hardened implementation.

## Other projects

Related OpenClaw reports describe the same expired-root failure in Slack,
channels, Talk, and meetings. Their documented corrections are host-side context
boundaries; they are not proof of this plugin-only transport workaround:

- https://github.com/openclaw/openclaw/issues/108135
- https://github.com/openclaw/openclaw/issues/110697
- https://github.com/openclaw/openclaw/issues/134081
- https://github.com/openclaw/openclaw/issues/142610

The pinned SDK's root-admission helpers are not public plugin exports, and its
scheduled-session-turn workflow returns without scheduling for third-party
plugins. The HTTP route is a distinct public API path that avoids those limits.
