# Shared-author connections: notification only

Some Notion connections post automated comments under the same authenticated person identity as the human owner. Author IDs, display names, `by-you`, `created_by` and the webhook's `integration_id` cannot distinguish the person's instructions from a companion's output. `created_by` identifies the original creator, not necessarily the editor.

This relay does not claim that distinction is solved. **Automatic responder activation is blocked:** the active writer has not been shown to participate in a durable pre-write receipt barrier. Do not connect these events to a task that automatically posts comments or executes comment instructions. Metadata flags cannot prevent another connector from writing if an external task ignores this contract.

## Enforced notification contract

Created and updated comments produce separate event names and subscriptions. Every callback contains metadata and an authenticated archive reference, with `notification_contract:"metadata-only-v1"`, `notification_only:true`, `automatic_response_allowed:false` and `attribution:"unknown"`. Comment text, author names and author IDs are not included in callback data. Full original source and observed comment content remain in owner-scoped archives for manual review. No human or assistant identity is inferred.

A person event is never excluded by matching the configured bot or ignored-author ID. Optional source filters apply only to created events whose signed authors are all known non-person bots/agents. Mixed person/bot events and every update remain eligible. The retrieved creator ID is not a suppression signal: a person may edit a comment originally created by a bot.

All updates remain notifications, including text edits, formatting changes, restored text and attachment changes. Webhooks do not contain historical comment snapshots; a later GET can observe a newer edit or restoration. The archive distinguishes the source event's timestamp from the fetched observation. It cannot reconstruct an intermediate revision the API no longer exposes.

## Exact receipts are diagnostic evidence

`record_posted_comment({page_id,comment})` records the **complete original acknowledged Comment object** already returned to a writer. It requires the exact comment ID, full supported rich text and `last_edited_time`. An ID-only acknowledgment is insufficient; do not fill missing fields by guessing or silently substituting a later API read.

The tuple is owner, workspace, exact page, comment ID, revision timestamp, hash version and semantic rich-text hash. The hash includes links, mention targets, equations and formatting. Different comment IDs never match, even with identical text. A changed revision or content does not match. Unsupported or pending attachments and incomplete snapshots remain unclassified, rather than using temporary file URLs as provenance.

`inspect_event_provenance({event_id})` can report `exact_snapshot_receipt_match:true` with `receipt_evidence:"owner_reported_exact_snapshot"`. This is equality with an owner's record, **not proof of who wrote the comment**. Attribution stays unknown and automatic response remains disabled. Registration does not suppress notifications, change an already queued callback, cancel delivery or replay an event. In particular, a receipt must never hide a later human edit or restoration.

## Activation blocker and future writer contract

A receipt registered after posting can arrive after the webhook has already been delivered. Fixed delays cannot close that race. A reliable automatic writer would have to open an owner/page-scoped durable intent **before** writing, hold relevant callbacks while the write outcome is unknown, persist the actual acknowledgment, and release the barrier only after classification. Timeout or uncertain write results must remain explicit and must not manufacture an acknowledgment. Every human edit still requires separate treatment.

That barrier is not implemented or enforced in the active connector by this source change. `activation_blocker:"writer_prewrite_receipt_barrier_unverified"` remains visible in status and provenance tools. Notification-only manual review can be tested separately after approved setup; automatic comment-response tasks must remain disabled until the writer contract is implemented and verified. Receiving `comment.updated` also requires selecting that event in Notion's webhook setup; code support alone does not enable the external subscription.

Earlier queued callbacks with unclassified text are retained as `dead` with `legacy_payload_requires_review`. Their original bytes are not rewritten under the same event ID or automatically resent. Normal retry is refused until an explicit migration is designed and reviewed. Raw sources and complete archives are retained.

References: [Notion comment object](https://developers.notion.com/reference/comment-object), [comment updated](https://developers.notion.com/reference/webhooks/comment-updated), [event delivery](https://developers.notion.com/reference/webhooks-events-delivery).
