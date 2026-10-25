# Shared-author Notion Events correction

**Goal:** Preserve human instructions and edits when an automated companion writes through the same person identity, without claiming an attribution mechanism that the connection does not provide.

**Design:** [Shared-author provenance contract](../../../apps/notion-events/PROVENANCE.md).

## Decisions

Author ID, name, creator and `by-you` are not writer provenance. All callbacks become metadata-only notifications with unknown attribution and automatic response disabled. Original source and complete observed comments remain archived. Owner-reported exact write acknowledgments provide diagnostic snapshot equality only; they do not suppress events or change queued retry bytes. Automatic responder activation remains blocked until the actual writer enforces a durable pre-write barrier.

## Implementation

- [x] Add failing same-person identity and creator-edit regressions, then preserve person events even when IDs appear in bot/ignored configuration.
- [x] Receive created and updated source events with distinct event names, exact page/name subscription matching and unchanged source-event-ID deduplication.
- [x] Preserve edits, formatting changes and restored text as notifications, including updates to previously automated comments.
- [x] Record exact page/comment/revision/versioned-rich-text-hash acknowledgments and expose diagnostic inspection without human/assistant attribution.
- [x] Enforce metadata-only callback flags and retain earlier unsafe queued payloads for explicit review rather than rewriting or replaying them.
- [x] Verify the complete app suite, syntax, dry-run bundle and public diff before main integration. Do not create a live connection, credentials or deployment.

Observed verification: 58 Node tests, 18 bundled Worker verification groups, syntax checks and dry-run build passed. Independent review found no remaining Critical/Important code defect. The live writer barrier is still an activation blocker, not a passed test.

## Activation remains blocked

The writer's pre-write receipt barrier is unverified and is not implemented in the active connector by this source change. A post-hoc receipt cannot close the webhook-before-registration race. Metadata flags do not physically prevent a separate connector from posting if an external task ignores the notification-only contract. Automatic comment-response tasks must remain disabled; do not present synthetic distinct-writer tests as verification of the real connection.
