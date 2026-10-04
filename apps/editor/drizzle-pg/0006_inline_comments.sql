-- Phase 8: inline (text-anchored) comments.
--
-- editor.comments.thread_id — NULL means a page-level comment (the Phase 4
-- behaviour, unchanged); a non-null UUID-as-text groups the messages of one
-- inline thread, keyed to the `comment` mark's data-thread-id in the doc. The
-- composite index backs the per-thread fetch and the "open threads" rollup.

ALTER TABLE editor.comments ADD COLUMN IF NOT EXISTS thread_id text;

CREATE INDEX IF NOT EXISTS comments_thread_idx ON editor.comments(page_id, thread_id);
