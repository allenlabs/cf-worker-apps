# url-shortener

A single-worker URL shortener on Cloudflare Workers + KV.

- **POST `/api/shorten`** `{ url, code? }` → mints a code (optionally a custom one)
- **GET `/:code`** → 302 redirect, async-increments the per-link click counter
- **GET `/api/links/:code`** → JSON view of the stored record
- **GET `/`** → tiny HTML form for casual use

## Run / deploy

```bash
cd apps/url-shortener
wrangler kv namespace create LINKS    # paste id into wrangler.toml
npm run dev
npm run deploy
```

## Tests

`vitest` with two projects:

```bash
npm run test            # unit (pure shortenImpl + KV fake) + workers (real Miniflare)
npm run test:coverage   # 100% threshold on src/*
```

## Why single worker

Lookup latency dominates; the redirect path is a single KV read.  Async work
(click counters) goes through `executionCtx.waitUntil`, which is enough for
this scale.  If we ever needed analytics aggregation, a queue + a second
worker would slot in naturally — see `webhook-relay/` for that pattern.
