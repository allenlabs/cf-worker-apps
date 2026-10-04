# @cf-worker-apps/notion-gateway

Central Notion integration gateway.  Holds OAuth tokens for one or more
connected Notion workspaces and exposes a small JSON API that any other
authorized application can call to:

* connect a "resource" (e.g. PM's `project/42`) to a Notion Database;
* push an updated record onto the mapped Database;
* archive the corresponding page when the source record is deleted.

The gateway never sees the consumer apps' user accounts — every API
request is authenticated with HMAC-SHA256 over a shared secret.

## Workers

| Worker | Hostname | Purpose |
|---|---|---|
| `notion-gateway-api` | `notion-api.example.invalid` | HMAC-signed JSON API consumed by other apps. |
| `notion-gateway-web` | `notion.example.invalid` | Notion OAuth start/callback + admin UI (SSO-gated). |

Both workers share the same Hyperdrive binding (the deployment PostgreSQL
instance, `notion_gateway` schema).

## API contract

All endpoints are POST under `https://notion-api.example.invalid/v1/*`,
require the headers `X-Client-Id`, `X-Timestamp`, `X-Signature`, and
accept/return JSON.  The signature is base64 HMAC-SHA256 over
`${timestamp}\n${body}` with the shared secret from
`notion_gateway.app_clients.hmac_secret`.

| Endpoint | Body | Returns |
|---|---|---|
| `/v1/oauth-start-token` | `{ app_resource, return_to }` | `{ start_url }` (redirect target for the user's browser) |
| `/v1/workspaces/list` | `{}` | `{ workspaces: [...] }` |
| `/v1/databases/list` | `{ workspace_id }` | `{ databases: [{ id, title }] }` |
| `/v1/databases/inspect` | `{ workspace_id, database_id }` | `{ database, suggested, suggested_mapping }` — `suggested_mapping` is the canonical key (added so consumer apps don't need to re-implement the field-to-property heuristic); `suggested` is the legacy alias and references the same object |
| `/v1/connections/get` | `{ app_resource }` | `{ connection }` (or null) |
| `/v1/connections/list` | `{}` | `{ connections: [...] }` |
| `/v1/connections/upsert` | `{ app_resource, workspace_id?, database_id, database_title, mapping }` | `{ connection }` |
| `/v1/connections/delete` | `{ app_resource }` | `{ ok: true }` |
| `/v1/pages/upsert` | `{ app_resource, app_record, fields }` | `{ page_id, created }` |
| `/v1/pages/delete` | `{ app_resource, app_record }` | `{ ok, archived }` |

## Notion webhook receiver

Web worker route: `POST https://notion.example.invalid/webhooks/notion`.

* First-time registration: Notion POSTs `{ verification_token }` with no
  signature; the row lands in `webhook_subscriptions` as `pending` and
  surfaces in the admin landing page so the operator can paste it back
  into Notion.
* Subsequent events: header `X-Notion-Signature: sha256=<hex>` is
  `HMAC-SHA256(rawBody, verification_token)`; on first verified event
  the row transitions to `verified`.  Verified payloads are translated
  via `getInverseMapping` and fanned out (with the gateway's outbound
  HMAC headers) to the calling app's `app_clients.webhook_url`.
* Replay protection: events older than 5 minutes (per the body's
  `timestamp` field) are rejected.

## Setup

```bash
# 1. Run the migrations against the deployment database.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0001_initial.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0002_webhooks.sql

# 2. Set secrets on both workers.
cd workers/api
wrangler secret put NOTION_CLIENT_ID
wrangler secret put NOTION_CLIENT_SECRET
wrangler secret put WORKSPACE_TOKEN_KEY      # 32 random bytes, base64
wrangler secret put OTEL_BEARER_TOKEN
wrangler secret put OTEL_ACCESS_ID
wrangler secret put OTEL_ACCESS_SECRET

cd ../web
# repeat the same `wrangler secret put …` invocations.

# 3. Rotate the seeded PM client secret (the migration plants a random
#    placeholder so the row exists).
psql "$DATABASE_URL" -c "UPDATE notion_gateway.app_clients
  SET hmac_secret = encode(gen_random_bytes(32), 'base64')
  WHERE client_id = 'pm';"

# 4. Deploy.
wrangler deploy --config workers/api/wrangler.toml
wrangler deploy --config workers/web/wrangler.toml
```

## Tests

```bash
npm test                  # unit tests
npm run test:coverage     # with v8 coverage (100% thresholds)
```

Shared modules + handler `*Impl` functions are unit-covered against a
PGlite-backed Drizzle instance; the OTel-wrapped Hono entrypoints and
the inline route handlers are excluded from the unit coverage report
(they're exercised by deploy smoke tests).
