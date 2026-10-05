# cf-worker-redmine-replacement

## Cloud Agent

Publish reusable code, tests, technical design and reproducible verification here first; this repository is also an implementation portfolio. Use generated fixtures and example configuration so public commits contain no personal or installation-specific information. Then transfer reviewed public changes to the private deployment repository and apply its configuration and tuning there. See [the publication rules](AGENTS.md). Supply private deployment configuration before deploying any app.

[apps/cloud-agent](apps/cloud-agent/README.md) contains the Cloudflare Agents/Pi
team-chat agent and SSO management source. Start cloud continuation with its
[handoff](apps/cloud-agent/docs/CLOUD_HANDOFF.md). Deployment branding and identity are supplied through private configuration.

## CF Observe

The telemetry explorer is available in [apps/cf-observe](apps/cf-observe/README.md).
It serves its dashboard from Workers, accepts OTLP logs/traces/metrics, streams
durably accepted events live, and archives compressed originals to private R2 in
10-second batches. Live display targets about one second after ingestion; it does
not wait for R2 archival. See the app's verification report for measured checks.

Use Node >=22.13 and run `npm ci` from this repository root, then
`npm run test:observe`, `npm run dry-run:observe`, or `npm run demo:observe`.
For local workerd development, run
`npm run -w @cf-worker-apps/cf-observe init:secrets` then `npm run dev:observe`.

---

A self-hostable, Redmine-style project / issue management app that runs entirely on
**Cloudflare Workers**, built with **TanStack Start** (SSR + file-based routing) and
**TanStack Router**, backed by **Cloudflare D1** (SQLite), **R2** (file attachments),
and **KV** (session revocation).

> Deploy a single Worker, get projects · issues · time tracking · gantt · roadmap ·
> wiki · attachments · members · permissions · activity feed · search — all without
> running a server.

---

## Status

| Surface | Status |
|---|---|
| Schema + Drizzle + migrations | ✅ stable |
| Server-function **impls** (auth, projects, issues, members, versions, categories, time-entries, wiki, attachments, activities, search) | ✅ unit-tested at 100% (lines/statements/functions/branches) |
| React components (`app/components/*`) | ✅ jsdom-tested |
| Wrangler integration (D1 / KV / R2 / WebCrypto / JOSE / cookies) | ✅ exercised end-to-end inside Miniflare via `tests/workers/` |
| `createServerFn` wrappers + routes | ⚠️ Updated for TanStack Start 1.168 (`getRequest`, `setCookie`, `inputValidator`, modern SSR entry shapes, dedicated `auth-runtime.server.ts`).  **Client environment now builds successfully** via `npx vite build`; the **SSR environment build still trips on the start-manifest plugin** (a known follow-up — needs the route manifest input wired correctly). |
| `npm run dev` / `npm run deploy` | ⚠️ Same blocker — `vite build` finishes the client environment but not the SSR pipeline yet.  Use [`npm run test:workers`](#2-run-the-test-suite) to exercise Cloudflare bindings + auth flow until that's fixed. |

If you only want to consume the server-fn impls (e.g. wire them into Hono on a
Worker, or use them in scripts), you can do so today — they are pure functions
of `(db, ...)`.

---

## Why

Redmine is great but feels heavy: Ruby + Passenger + Postgres/MySQL + Apache, plus
SMTP, cron jobs, file storage… This project squeezes the same model into one
edge-deployed Worker. No servers to patch, no database backups to schedule (D1
handles it), no S3 to wire up (R2 is a binding).

## Feature parity

| Module           | Status |
|------------------|--------|
| Projects (CRUD, hierarchy, public/private) | ✅ |
| Issues with tracker / status / priority / assignee / category / version / parent | ✅ |
| Issue notes (markdown) + audit-trail journal | ✅ |
| Watchers                                   | ✅ |
| Time tracking with activities + filters    | ✅ |
| Roadmap (versions with % closed)           | ✅ |
| Gantt chart (SVG)                          | ✅ |
| Wiki (markdown, revisions, per-project)    | ✅ |
| Files / attachments (R2)                   | ✅ |
| Activity feed (global + per project)       | ✅ |
| Search (issues + wiki)                     | ✅ |
| Roles & permissions (Manager / Developer / Reporter, customisable) | ✅ |
| Auth: email + password (PBKDF2) + GitHub OAuth | ✅ |
| Admin: user list, lock/unlock, promote     | ✅ |
| Per-project module toggles                 | ✅ |

## Tech stack

- **Edge runtime:** Cloudflare Workers (module worker, `nodejs_compat`)
- **Framework:** TanStack Start 1.168 + TanStack Router 1.170, file-based & type-safe
- **UI:** React 19, Tailwind CSS
- **DB:** Cloudflare D1 + Drizzle ORM 0.45
- **Files:** Cloudflare R2
- **Sessions:** signed JWT (jose 6) in HttpOnly cookies; revocation via KV
- **Markdown:** marked 18 + lightweight HTML sanitiser
- **Build:** Vite 8 + `@cloudflare/vite-plugin`, deployed via wrangler

---

## Getting started

### 0. Prerequisites
- Node ≥ 20 (developed on Node 26)
- A Cloudflare account with Workers, D1, R2 and KV enabled
- `npx wrangler login`

### 1. Install

```bash
git clone https://github.com/allenlabs/cf-worker-redmine-replacement.git
cd cf-worker-redmine-replacement
npm install         # .npmrc sets legacy-peer-deps for the TanStack Start beta range
npx @tanstack/router-cli generate   # produces app/routeTree.gen.ts (gitignored)
```

### 2. Run the test suite

```bash
npm run test            # all 3 projects (node + jsdom + workers / miniflare)
npm run test:coverage   # node + jsdom with v8 coverage + 100% thresholds
npm run test:workers    # workers project only (miniflare D1/KV/R2)
```

Current run: **198 tests** across 22 files, **100% lines / statements /
functions / branches**.

### 3. Create Cloudflare resources

```bash
wrangler d1 create redmine
wrangler kv namespace create SESSION_KV
wrangler r2 bucket create cf-redmine-files
# copy the printed ids into wrangler.toml
```

### 4. Local secrets

```bash
cp .dev.vars.example .dev.vars
# at minimum set JWT_SECRET
```

### 5. Migrate + seed

```bash
npm run db:migrate:local
npm run db:seed:local
```

### 6. Dev / Deploy

> ⚠️ **Not yet verified end-to-end.**  The SSR runtime entry (`app/client.tsx`,
> `app/ssr.tsx`) targets TanStack Start 1.168 but has not been booted in dev
> mode by the maintainer.  Use [`npm run test:workers`](#2-run-the-test-suite)
> to validate Cloudflare bindings + auth flow today.

```bash
npm run dev             # vite dev (TODO: verify)
npm run build           # vite build (TODO: verify)
npm run deploy          # build + wrangler deploy (TODO: verify)
```

---

## GitHub OAuth setup (optional)

1. <https://github.com/settings/developers> → New OAuth App
2. **Authorization callback URL:** `{PUBLIC_BASE_URL}/oauth/github/callback`
3. Copy the Client ID + Secret, set them with `wrangler secret put …`
4. The "Sign in with GitHub" button appears on `/login` automatically.

On first GitHub login, an account is created using the GitHub `login` and primary
verified email. Subsequent logins match by GitHub ID first, then by email.

---

## Project layout

```
.
├── vite.config.ts             # Vite + @cloudflare/vite-plugin + tanstackStart
├── vitest.config.ts           # 3 projects: node + jsdom + workers
├── wrangler.toml              # D1 / KV / R2 / vars / asset binding
├── drizzle/
│   ├── 0001_initial.sql       # full schema migration
│   └── seed.sql               # default trackers / statuses / priorities / roles
├── app/
│   ├── client.tsx             # client hydrate entry
│   ├── ssr.tsx                # cloudflare-module SSR entry
│   ├── router.tsx             # TanStack Router + react-query bridge
│   ├── test-worker.ts         # tiny Worker for wrangler integration tests
│   ├── styles/app.css         # Tailwind + Redmine-inspired tokens
│   ├── lib/                   # env types, formatters, permissions enum
│   ├── db/                    # Drizzle schema + D1 client factory
│   ├── server/                # server-fn impls + thin createServerFn wrappers
│   │   ├── auth.ts            #   pure impls (testable without TanStack Start)
│   │   ├── auth-runtime.ts    #   SSR-aware helpers (getEnv, requireUser, …)
│   │   └── *.ts               #   one file per topic
│   ├── components/            # Layout, ProjectSidebar, badges, Markdown
│   └── routes/                # file-based routes (routeTree.gen.ts auto-generated)
├── tests/
│   ├── _setup/                # in-memory D1 (better-sqlite3), KV/R2 fakes, jsdom setup
│   ├── lib/                   # format, permissions
│   ├── server/                # *Impl integration tests
│   ├── components/            # React component tests
│   └── workers/               # SELF.fetch against test-worker inside Miniflare
└── public/                    # static assets (favicon)
```

## Permissions model

Inspired by Redmine. Each role has a JSON `permissions` array; see
`drizzle/seed.sql` for the default Manager / Developer / Reporter sets, and
`app/lib/permissions.ts` for the full enum. The server-side `requirePermission`
helper enforces them on every mutating server function.

Admins (users with `admin = 1`) bypass all per-project checks.

## Notes / known limitations

- The Gantt is read-only SVG (no drag-resize) — keeps the bundle tiny.
- Email notifications are intentionally omitted (no SMTP on the edge); plug in
  Cloudflare Email Routing or Postmark/Resend via a queue if you need them.
- Custom fields are not implemented yet (would slot in via a small extra table).
- See `Status` table above for what's verified vs still on the TODO list.

## License

MIT
