# `@allenlabs/cli` — `al`

Zero-friction CLI for the Allen Labs ADHD-developer SaaS suite. **One
command, no banner, no spinner.** Capture an idea before the thought
evaporates, then back to flow.

```bash
al "look into 502s on /search"        # → ✓ #42
al focus start "fixing 502s"          # → ✓ focus #7  (25 min — ends at 14:47)
```

## Install (local, from source)

The CLI lives in a monorepo workspace; from the repo root:

```bash
npm install
npm run -w @allenlabs/cli link
al login
```

`npm run link` is shorthand for `npm run build && npm link`, which puts
the `al` binary on your `$PATH`.

## Subcommands

```
al "thought goes here"            # default → inbox capture
al inbox capture <text...>        # explicit form
al inbox list                     # list unread
al inbox done <id>                # mark done
al inbox drop <id>                # mark dropped

al focus start <text...> [-m 25]  # start a session (default 25 min)
al focus stop                     # end the current session
al focus distract <label...>      # log a distraction
al focus status                   # show current session (zero-latency)

al ctx save <name> [--note ...]   # snapshot cwd/branch/tmux/files/processes
al ctx restore <name|id>          # print + clipboard the cd command
al ctx list                       # 20 most-recent snapshots
al ctx delete <id> [-y]           # delete (confirm unless --yes)

al login                          # interactive setup
al config                         # show resolved config + endpoint health
al shell-prompt                   # one-line snippet for PS1 (see below)
al --version
```

Global flags:

- `--verbose` — diagnostics on stderr (e.g. the exact POST URL).
- `--json` — machine-readable output: `al inbox list --json | jq .items`.

## Config

Lives at `~/.config/allenlabs/cli.json` (chmod `0600`). Run `al login` to
seed it; it walks you through endpoint + HMAC secret for each app and
smoke-tests `/health`.

Secrets come from `pass-cli` (`Inbox API HMAC`, `Focus API HMAC`,
`Context API HMAC` items in the `Development` vault) when available;
otherwise you paste them.

## Working-context snapshots

`al ctx save "fixing auth bug"` shells out to `git`, `tmux`, `ls`, and
`ps` to capture *where you were* — cwd, branch, porcelain status, MRU
files, tmux window list, top-CPU processes — and POSTs the lot to
`context-api.allenlabs.org`. Every source is best-effort: no git repo,
no `$TMUX`, missing binary → that source is skipped, the rest still
ship.

`al ctx restore <name|id>` prints the snapshot, bumps `restored_count`
server-side, and copies a quoted `cd '<cwd>'` to your clipboard
(`pbcopy` / `wl-copy` / `xclip`, first one that works). Add
`--print-only` to skip the clipboard write.

## Shell prompt integration

`al shell-prompt` prints **nothing** when there's no active session, so
it's safe to embed unconditionally in your `$PS1`.

Bash:

```bash
PROMPT_COMMAND='AL_FOCUS=$(al shell-prompt 2>/dev/null)'
PS1='${AL_FOCUS:+[$AL_FOCUS] }'"$PS1"
```

Zsh:

```zsh
precmd() { AL_FOCUS="$(al shell-prompt 2>/dev/null)" }
PROMPT='${AL_FOCUS:+[$AL_FOCUS] }'"$PROMPT"
```

While a session is active your prompt grows a `[focus 14m left]` badge —
ADHD time-blindness defeated by a 12-character status line.

## HMAC scheme

Same shape as `inbox-api` / `focus-api`:

```
X-Client-Id   the configured client_id
X-Timestamp   Date.now() (ms) as a string
X-Signature   base64(HMAC-SHA256(secret, `${ts}\n${body}`))
```

Body is the JSON-serialised request body (empty string for GET).

## Tests

```bash
npm test                  # vitest run
npm run test:coverage     # 100% on lib/* (HMAC, config, humans, output, session-store)
```

The command modules (`src/commands/*`) are thin glue over `src/lib/*` and
are wrapped in `/* v8 ignore */` blocks — the lib coverage carries the
contract.

## Publishing

Not yet published to npm. Use `npm run link` for local testing.
