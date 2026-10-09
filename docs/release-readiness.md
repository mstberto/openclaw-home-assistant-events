# Release readiness

0.1.0 is an implementation candidate held in a private repository. No npm publication or deployment to a running user installation is part of this work.

## Verified locally

- Strict TypeScript compiles against the published OpenClaw 2026.9.9 declarations.
- Automated tests cover ownership, disallowed-owner suspension, indexed matching, numeric crossings, one-shots, duplicates, microsecond transitions, duration cancellation/restart, outbox retries, accepted-run observations, atomic file persistence, corruption, lock exclusion, scheduler shutdown, and the HA protocol/reconnect lifecycle.
- The disposable Gateway smoke test loaded the third-party package through a separate state directory, resolved an environment SecretRef, authenticated and subscribed to a synthetic HA server, created a watcher through the public tool endpoint, continued the originating normal conversation, persisted the event, exercised the standard message tool against a synthetic channel, exposed the event through chat.history, and tested a real process crash followed by uncertain recovery and manual resolution.
- Package build and contents inspection ensure built JavaScript, manifest, skill, MIT license, and documentation are shipped. CI repeats strict types, tests, build, production audit, and packaging on Node 24 and 26.

## Remaining gates before public release

1. Owner approval to make the repository public; separately approve any npm publication.
2. Run the GitHub CI workflows and inspect the results.
3. Test native GUI save/edit/redaction on a clean OpenClaw 2026.9.9 instance with a real HA test instance. The smoke test proves environment SecretRef resolution; it does not visually test settings or file/exec secret providers.
4. Exercise a real owning agent's permitted user communication tools and real GUI/channel history in the originating conversation. The plugin deliberately supplies no destination and does not guarantee those tools are enabled by host policy.
5. Test suspend/wake, credential rotation, Gateway restarts under load, and local filesystem durability on each intended platform. Windows and network filesystems are not certified.
6. Verify the documented backup procedure and housekeeping for retained delivery audit records. Limits are fixed in v0.1; heavy workloads need an explicit storage design review.

The published host still restricts native plugin-state stores and hook-agent dispatch. See [SDK contracts](sdk-contracts.md) for the public filesystem persistence alternative and the public background agent API used here. Do not silently replace either with private imports.

## Dependency audit

The production plugin dependency audit reports no known vulnerabilities. Updating the test runner removed its initial critical advisory findings. The full development tree still reports five advisories (three high, two moderate) inside the npm package bundled by the pinned OpenClaw SDK; compatible audit fixes cannot replace those bundled files. They are outside the shipped plugin runtime dependencies, but remain a development-tree caveat. The exact host pin is retained for reproducible compatibility verification. Recheck advisories before publishing and update the SDK only alongside compatibility testing.

The manual release workflow creates a tarball artifact only; it never changes repository visibility, creates credentials, or publishes to npm.

## Dispatch pivot validation

Normal-agent dispatch replaces the restricted subagent API. Unit tests cover transcript receipt/invalidation, no replay of delivered/uncertain work, preflight-only retries, running reservation before effects, failed reservation/final writes, interrupted recovery, review ownership and duplicate-risk acknowledgement, and exact session identity guards. The disposable integration uses only synthetic credentials/transport/model and a separate Gateway state directory. Live Alice deployment is not authorized by these results. Automatic live dashboard refresh and real external delivery have not been claimed.

The disposable OpenClaw Control UI was also opened and inspected: it displayed the original request, both matched-event payloads, standard message-tool output, and the host's restart-recovery notice in the same Main Session. This validates history rendering after connection/reload; automatic live push updates and Alice's real notification channels remain separate checks.
