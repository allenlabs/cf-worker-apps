-- Drop the interim PM-side Notion tables.  All Notion connection /
-- page-link state has moved to the central notion-gateway; PM now calls
-- the gateway over HMAC-signed HTTP instead of holding mapping rows
-- locally.
--
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0004_drop_notion.sql

SET search_path = pm, public;

DROP TABLE IF EXISTS pm.notion_issue_links;
DROP TABLE IF EXISTS pm.notion_connections;
