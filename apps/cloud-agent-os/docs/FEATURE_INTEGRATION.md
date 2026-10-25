# Requested feature integration

Inventory snapshot verified against all remote heads and GitHub branches on 2026-10-25: `main` at `d2d2414` and `feat/bdots-bot-workspaces` at `34209e4`, with no open pull requests. At that snapshot the feature branch was four commits ahead with no divergent commits. No branch is deleted by this reconciliation.

| Requested capability | Implementation evidence | Main at inventory | Integration result |
| --- | --- | --- | --- |
| Bot library, per-bot instructions and recoverable context | `128752a`, [bot workspaces](BOT_WORKSPACES.md) | Pending | Included |
| Native per-bot Agent Memory and durable conversation capture | `3d6fea7`, [native memory](NATIVE_AGENT_MEMORY.md) | Pending | Included |
| Common owner context, selected/all bot recall and main bot | `8724334`, isolation and full-build corrections `34209e4`, [shared memory](SHARED_BOT_MEMORY.md) | Pending | Included |
| Account-scoped SIWC model selection and Fast mode | `d2c0e5a`, `d2d2414` | Included | Preserved |
| SIWC-only inference, native OpenCode loop, scoped resources, approved plugins and named subscriptions | `be656f6`, `1c8fbcc`, `b62c69c`, `a0ddafa`, `5dc0f44` | Included | Preserved |
| Independent personal Notion MCP Events Worker | `23146ec`, [design](../../../docs/superpowers/specs/2026-10-25-personal-notion-events.md), [shared-author correction](../../notion-events/PROVENANCE.md) | In implementation | Notification-only source included; automatic responder activation blocked |

Cursor and Devin integrations remain feasibility notes in [agent backends](AGENT_BACKENDS.md), not implemented functionality. Browser teaching and scheduled routines are explicitly outside the bot-workspace scope; their absence is not evidence of an unfinished request.

## Reconciliation

Preserve all four requested feature commits and every branch reference. Verify the combined tree, including the existing Channel Talk server after generic helper extraction, before integration. Recheck remote main before any push and stop for concurrent changes rather than overwrite them. Historical author names with no linked GitHub login do not establish a second person's active work.

The combined source tree passed the local integration checks recorded in [Notion Events verification](../../notion-events/VERIFICATION.md), including the complete OS configured build and runtime tests. Remote main was fast-forwarded from `d2d2414` to source commit `23146ec`; the existing feature branch was preserved. All four original feature commits and the independent Events implementation are now included in main. Live activation and external indexing are separate, unverified operations.

Source integration and deployment are separate operations. Review repository triggers and independent Cloudflare Builds/Pages connections before updating a deployment branch; absence of GitHub Actions alone does not establish absence of deployment automation. Keep installation-specific trigger inventories and access receipts in private operational records. This reconciliation changes no deployment settings or security controls.

An optional host plugin runner can consume a clean checkout's HEAD when configured to use it as source. Its existence in reusable source is not evidence of an active installation. Review any actual installation coupling before integration.
