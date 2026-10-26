# Fast mode provider contract

Reviewed against official provider documentation on 2026-10-26. Fast is an explicit request for a separate processing tier. Reasoning effort, output limits, tools, memory, permissions and conversation identity retain their existing behavior. Fast starts off. Turning it off omits the tier override; provider/project defaults may still apply.

| Connection | Request | Support and billing conditions |
| --- | --- | --- |
| OpenAI native API | `service_tier: "priority"` | Exact documented model allowlist on the official endpoint. Premium token prices vary by model. Model support does not prove account entitlement. |
| SIWC OAuth subscription | Bridge `serviceTier: "priority"` | Requires the selected account's current model metadata to advertise support. May consume extra allowance or credits. General API model support does not replace this check. |
| Codex subscription | Bridge `serviceTier: "priority"` | Documented model allowlist. Account entitlement remains unverified by the bundled catalog. Included allowance consumption is 2.5 times Standard; purchased credits and Enterprise PAYG use 2 times Standard. |
| Legacy untagged subscription bridge | No Fast option | The effective subscription account/provider has no verified Fast selection metadata. The control remains unavailable and Standard routing is preserved. |
| Anthropic native API | `speed: "fast"` | Claude Opus 5.5 GA. Requires an eligible Start, Build or Scale account; premium prices apply. Preview models with separate entitlement requirements remain unavailable. |
| Gemini native API | SDK `config.serviceTier: "priority"` | Exact documented text-model allowlist. Requires paid Tier 2 or 3; prices are 75–100% above Standard. Provider overflow can use Standard processing. |
| Workers AI, Ollama | No Fast option | No verified provider Fast tier in these adapters. Queue rejection or a smaller reasoning budget is a separate feature. |
| Arbitrary compatible/custom endpoints | No Fast option | API-shape compatibility does not prove tier support. A reviewed provider adapter is required. |

Native provider support is tied to the canonical API endpoint or a server-owned native-provider Gateway route. The server checks the effective route before advertising support. A legacy bridge takes precedence over an API-shaped configuration and cannot inherit native Fast capability. A provider label or a copied capability flag cannot grant support. Subscription and scoped-provider access are revalidated through their existing authorization paths.

The OpenAI allowlist follows the Fast tables in the [official pricing reference](https://developers.openai.com/api/docs/pricing.md). GPT-5.5 and GPT-5.4 Fast pricing is limited to context below 272K. Future family names and arbitrary dated snapshots do not inherit support. See the [Fast guide](https://developers.openai.com/api/docs/guides/fast-mode) for tier behavior.

The [SIWC model and inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) requires the current OAuth bearer's model catalog and the public Responses API. SIWC retains `store: false` and `stream: true`. The implementation preserves the existing bounded account-specific Fast metadata validation.

Codex's [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) maps the local `fast` selection to the request value `priority`. Its [Speed guide](https://learn.chatgpt.com/docs/agent-configuration/speed) defines supported models and usage multipliers. A bundled model list proves protocol/model support only. Provider rejection is surfaced without changing the user's tier or creating a paid experiment.

Anthropic's [Fast guide](https://platform.claude.com/docs/en/build-with-claude/fast-mode) distinguishes GA Opus 5.5 from preview models that require a beta header and entitlement. Opus 4.6 may accept a Fast request while executing at Standard speed and is therefore excluded.

Gemini's [Priority inference guide](https://ai.google.dev/gemini-api/docs/generate-content/priority-inference) documents the JavaScript `config.serviceTier` parameter, model list, paid tier requirements and overflow behavior. Image models with conflicting support statements and custom-tool variants absent from that table are excluded.

No live inference latency, account entitlement, billing rate or hosted deployment is verified by synthetic tests. This change does not update subscriptions, permissions, credentials, accounts or running Workers.

## Verification

The final reviewed overlay composes against pinned upstream `4358072f8cb1bc9ddfb6ee11122e194c76cd71e0`. Its prepared source fingerprint is `20563cc26a63`.

| Check | Result |
| --- | --- |
| OS wrapper tests with optional compiler and CLI checks enabled | 132 passed, 0 failed, 0 skipped |
| Generated backend suites selected by `build --check` | 814 passed across 46 files |
| Generated frontend suites selected by `build --check` | 516 passed across 33 files |
| MCP account OAuth regression | 35 passed |
| Backend and frontend `tsc --noEmit`; both wrapper/runtime package type checks | Passed |
| Synthetic Access configuration build and Worker dry-runs | Passed; four dry-runs, no deployment |
| Changed subscription runtime `test:coverage` | Passed; administrator workerd function coverage 90/95. Pi and rendered browser coverage are not claimed. |
| Chromium component interaction | Passed default-off, mouse and Space toggles, sixth send argument, disabled unsupported state, billing copy and layout. Auth, branding, modal and toast boundaries use synthetic stubs. |
| Independent whole-change review and scoped fix review | Both findings addressed; no remaining actionable finding |

Tests first reproduced missing native request tiers, missing Home forwarding, the Codex bridge rejection, and the legacy-bridge capability bypass. The six backend suites covering the final fix passed all 187 tests. The complete configured check then passed on the final source.

Reproduction uses `npm run -w @cf-worker-apps/cloud-agent-os test`, `node scripts/build.mjs --config deployment.access.example.json --check` from the OS wrapper, and `npm run -w @cf-worker-apps/cloud-agent test:coverage`. Optional wrapper build checks require the installed compiler and CLI paths described in their test files. A writable XDG cache/config/data directory is required on restricted hosts.

The generated workspace's full `lint:check` still reports the same 127 errors as the unchanged baseline, with no added error diagnostics or suppressions. Repository-wide test coverage and hosted CI are not claimed; this repository intentionally has no GitHub Actions workflow. Verification uses synthetic provider responses and local workerd/browser execution, without live inference or hosted login checks.
