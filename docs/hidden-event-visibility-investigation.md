# Hidden event input validation

Confirmed on the unchanged published OpenClaw 2026.9.9 Gateway using synthetic
HA, a mock model, and a synthetic message channel after live plugin enable.
Alice's running installation was not modified.

## Working public API path

Tag the submitted event using `inputProvenance` with kind `internal_system`,
the plugin's own ID as `sourceTool`, the reserved run ID, and the captured source
session key. Register a synchronous public `before_message_write` hook that
returns the same message with `display: false` only when:

- it is a user-role message;
- its provenance belongs to this plugin and is internal;
- its source session key matches the hook's current session.

Do not block persistence, rewrite the role, imitate cron/subagent provenance,
hide assistant messages, or use a private core import. The event's full text and
stable ID remain available to the model and in the durable transcript. Existing
`onUserMessagePersisted` event-ID verification still works; display hiding does
not replace the receipt with model completion.

## Observed result

- The model received the complete event and original conversation context.
- The outbox recorded confirmed persistence.
- Public `chat.history` omitted the full event trigger and raw JSON.
- The original user conversation remained visible.
- The agent sent one synthetic alert and retained its reply in public history.
- Real process crash/recovery retained delivered history, marked interrupted work
  uncertain, did not replay either event, and required explicit manual review.

The first runtime-fragment experiment required mock-model changes because hidden
context is reprojected at model boundaries. The successful path above retains the
existing full prompt and uses display metadata instead. It avoids a visible
generic trigger and avoids changing the receipt mechanism.

## Limits

This validates the public contract on the default runtime. The user subsequently confirmed Native Codex's input mirror and the macOS client's live display with 0.1.4-rc.4.
The hook is a newly declared plugin capability that must appear in installation
review; focused negative tests now verify isolation from ordinary messages, other producers, sessions, and assistant replies. Hiding a message
does not delete or encrypt it: it remains accessible through authorized raw
transcript access. Existing visible events are not retroactively edited.

The experimental changes were restored after testing. Candidate 0.1.4-rc.4
now implements the validated hook with focused visibility-isolation tests. The
previous 0.1.4-rc.3 tarball remains unchanged. The prototype diff is saved locally as
`artifacts/hidden-event-visibility-prototype.patch` for review.
