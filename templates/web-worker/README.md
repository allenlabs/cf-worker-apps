# Web-worker template (TanStack Start UI on Cloudflare Workers)

Canonical config for a new `apps/<app>/workers/web/` UI worker. Copy these files
and adjust the placeholders. They encode two non-obvious gotchas that have bitten
the whole suite — keep them intact.

## Files
- `wrangler.toml` → `apps/<app>/workers/web/wrangler.toml`
- `vite.config.ts` → `apps/<app>/vite.config.ts`
- `public/favicon.svg` → `apps/<app>/workers/web/public/favicon.svg` (give it a per-app color)

## The two gotchas (do NOT regress)

1. **`assets` / `workers_dev` must be top-level in wrangler.toml, ABOVE any
   `[section]`.** TOML assigns keys to the most recent table header, so an
   `assets = {...}` line placed under `[placement]` becomes `placement.assets`,
   wrangler silently drops it, and **no static assets are served** — CSS/JS and
   the favicon fall through to the worker (307→login when the session lapses, or
   404), so pages render unstyled. Verify after deploy: `wrangler deploy` should
   print "Read N files from the assets directory" and the bindings list should
   include `env.ASSETS`.

2. **`vite.config.ts` must set `publicDir`** to `workers/web/public`. Vite
   defaults `publicDir` to `<cwd>/public`, which doesn't exist in this layout, so
   `favicon.svg` (and anything else in public/) never ships → `/favicon.svg`
   404s.

## Recommended: exempt static assets from the root auth gate

Because the worker handles every path here (CF serves matching assets first, but
the worker is the fallback), the `__root.tsx` `beforeLoad` auth gate should let
public bundles through so a lapsed JWT can never 307 a stylesheet to
`/auth/login`. Copy `lib/public-paths.ts` (`isStaticAssetPath`) from
`apps/project-management` and, in `__root.tsx beforeLoad`:

```ts
const isPublic = pathname
  ? PUBLIC_PATHS.has(pathname) || isStaticAssetPath(pathname)
  : false;
if (isPublic) return;            // before the token check
```

## Verify a deploy
```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://<app>.allenlabs.org/assets/<the-app-css>.css   # → 200 text/css
curl -s -o /dev/null -w "%{http_code}\n" https://<app>.allenlabs.org/favicon.svg  # → 200
```
