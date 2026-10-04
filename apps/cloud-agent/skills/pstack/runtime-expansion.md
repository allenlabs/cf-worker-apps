# Shell and Git research

Status: **NOT_INSTALLED**. This is a source-based continuation note, not an implementation or deployment claim. Sources were checked on 2026-10-05.

## Workers-based JavaScript and Git

Cloudflare's experimental `@cloudflare/shell` provides an isolated JavaScript environment with filesystem operations. Its durable Workspace uses SQLite and optional R2. `createGit` uses isomorphic-git against the virtual filesystem, and `gitTools` exposes Git operations through Code Mode with host-injected credentials. It does not run Bash or POSIX commands. This option could cover reading, editing and committing repository files after explicit tool integration. It would not execute pstack's Bun, Bash, `gh` or external model launcher scripts as written. The package is experimental and may change. [Official shell README](https://github.com/cloudflare/agents/blob/main/packages/shell/README.md)

## Linux execution

Cloudflare's Agents sandbox guide attaches a Linux container to an agent Durable Object. The example exposes a command-running tool. Different agent names receive separate sandboxes, and turns for the same agent reach the same sandbox. The sandbox cannot read the agent's storage, bindings or environment variables; Internet access is separately allowed. This is a candidate for actual shell scripts, dependencies and build/test commands. The published example uses Think, so its Pi integration must be designed and verified in this project before adoption. [Official Agents sandbox guide](https://developers.cloudflare.com/agents/tools/sandbox/)

## Continuation decision

If the next goal is only virtual file editing and Git operations, prototype the Workers-based option. If the next goal includes executing the upstream pstack toolchain, prototype a Linux sandbox and identify required binaries first. This is an engineering recommendation inferred from the documented capabilities.

Keep model OAuth credentials inside the existing credential Durable Objects. Give any execution environment only the scoped tool inputs or repository access it actually needs. Preserve the existing account and thread pinning during either prototype. Demonstrate one isolated test workspace and a real command or Git result before changing the adapter's capability declaration. Child-agent orchestration remains a separate integration question.
