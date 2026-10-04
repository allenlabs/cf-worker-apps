// Today doesn't own any tables — it's a read-only aggregator across the
// pm.*, inbox.* and focus.* schemas owned by the other apps.  This file
// exists only so `drizzle()` has a typed `schema` argument and the rest of
// the boilerplate keeps the same shape as inbox / focus.
//
// All today reads are raw SQL via `db.execute(sql\`…\`)`; no Drizzle table
// definitions are needed.

export {};
