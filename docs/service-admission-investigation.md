# Service admission investigation

Tested against the published OpenClaw 2026.9.9 package. No production installation files,
configuration, subscriptions, or delivery records were modified.

## Confirmed failure

An existing-session dispatch after live plugin activation rejects at
`command-queue-fmu8Xs-B.mjs:563` with `GatewayDrainingError`. The rejection occurs
before transcript persistence. A disposable Gateway with mock HA, model, and
channel reproduces the same failure, independent of Codex.

Service timers created inside `service.start` inherit the activating request's
root-work admission. Once that request releases its root, subsequent enqueue
calls refuse the inherited context even when the global Gateway fence is open.

## Prototype host correction

The experimental host change wraps the invocation of `service.start` with the
host's existing `runOutsideGatewayRootWorkAdmission`. It clears only the
request-owned root admission while preserving the other async scopes and plugin
startup consumer. This is a host implementation change, not a private import in
the plugin. The generated build patch is saved in
`artifacts/openclaw-service-admission-prototype.patch` for review, not installation.
The local SDK files were restored after the experiment.

With the prototype, `node scripts/smoke.mjs --hot-dispatch` passed:

- protected-store credential resolution and listener synchronization after live enable;
- event persistence and public chat history in the exact originating conversation;
- normal agent message-tool execution exactly once against a synthetic channel;
- actual process crash, recovery of interrupted delivery as uncertain, and no replay;
- explicit review and duplicate-risk acknowledgement requirements.

A focused host admission probe additionally reproduced rejection under a released
root, verified the corrected callback retains an independent owner/policy async
scope, and confirmed that real suspension and restart still reject enqueue.

## Limits and historical decision

No change to session routing, event ownership, sender policy, user notification
responsibility, or duplicate prevention was needed. This does not prove that a
host-wide service lifecycle change has no side effects for every plugin. The
prototype needs source-level host regression tests for startup, reload, rollback,
cancellation, and shutdown before adoption. The user subsequently confirmed native Codex handoff and a real alert with the plugin-only path.

The pinned public plugin SDK does not export the root-admission helper. Its
scheduled-session-turn implementation returns without scheduling for non-bundled
plugins. Moving to that API is not an equivalent third-party fix. Subagent and
hook alternatives retain the previously documented limitations.

Do not ship a private core import, change trusted-plugin identity, patch the production installation's
installed core, or automatically replay uncertain production events. The clean
direction is a reviewed host correction or supported SDK capability, followed by
the hot-activation regression and native Codex validation.

Related primary-source reports describe the same class of inherited-context failure:

- https://github.com/openclaw/openclaw/issues/108135
- https://github.com/openclaw/openclaw/issues/110697
- https://github.com/openclaw/openclaw/issues/142610

The subsequent [plugin-only admission investigation](plugin-only-admission-investigation.md) found a public HTTP-route path on the unchanged host. Candidate 0.1.4-rc.3 uses that path; this host prototype is not required or shipped.
