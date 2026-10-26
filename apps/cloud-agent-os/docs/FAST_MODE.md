# Fast mode provider contract

Reviewed against official provider documentation on 2026-10-26. Fast is an explicit request for a separate processing tier. Reasoning effort, output limits, tools, memory, permissions and conversation identity retain their existing behavior. Fast starts off. Turning it off omits the tier override; provider/project defaults may still apply.

| Connection | Request | Support and billing conditions |
| --- | --- | --- |
| OpenAI native API | `service_tier: "priority"` | Exact documented model allowlist on the official endpoint. Premium token prices vary by model. Model support does not prove account entitlement. |
| SIWC OAuth subscription | Bridge `serviceTier: "priority"` | Requires the selected account's current model metadata to advertise support. May consume extra allowance or credits. General API model support does not replace this check. |
| Codex subscription | Bridge `serviceTier: "priority"` | Documented model allowlist and an explicit per-model `supportsFast: true` from the connected inference bridge. Account entitlement remains unverified. Included allowance consumption is 2.5 times Standard; purchased credits and Enterprise PAYG use 2 times Standard. |
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

Codex Fast requires both the updated OS and the separately managed inference bridge from `apps/cloud-agent/workers/pi/inference-entrypoint.js`. A bridge that omits the existing optional per-model `supportsFast` flag leaves Codex Fast unavailable in the OS; Standard remains available. Only the updated bridge advertises this flag for a ready Codex connection, a compatible bridge policy and an allowlisted model. The OS also validates the model allowlist and removes the raw catalog flag before publishing its derived capability. This advertisement establishes adapter support, not the connected account's Fast entitlement.

The existing optional field is accepted by the older OS schema, so updating the bridge first also preserves its Standard catalog. New sends, retries and restart revalidate the current catalog; support loss fails explicitly without silently changing an opted-in turn to Standard. The OS wrapper does not deploy the separately managed bridge. Deploying only the updated OS is compatible with an older bridge but does not activate Codex Fast. The app never retries a rejected selection through a different provider or billing route.

## Verification

The final reviewed overlay composes against pinned upstream `4358072f8cb1bc9ddfb6ee11122e194c76cd71e0`. Its prepared source fingerprint is `d3f810c486ec`. It combines feature head `0ebb1d8949cc3b5eab8010cedb58185fff86bf6f`, main `6f3a3e8bff8d69ac77239eb3023e878125ea570a` and the explicit bridge-capability gate. Bot loading, lossless archives, memory sources and both earlier performance changes retain their verified source bytes.

| Check | Result |
| --- | --- |
| OS wrapper tests with optional compiler and CLI checks enabled | 132 passed, 0 failed, 0 skipped |
| Generated backend suites selected by the personal OAuth check, plus Access regressions | 807 passed across 45 files, plus 17 across 2 files; 824 unique tests |
| Generated frontend suites selected by `build --check` | 516 passed across 33 files |
| MCP account OAuth regression | 35 passed |
| Backend and frontend `tsc --noEmit`; both wrapper/runtime package type checks | Passed |
| Personal OAuth configuration build and Worker dry-runs | Passed; five dry-runs, no deployment or live authentication |
| Changed subscription runtime `test:coverage` | Passed; administrator workerd function coverage 90/95. Pi and rendered browser coverage are not claimed. |
| Chromium component interaction on feature head `0ebb1d8` | Passed default-off, mouse and Space toggles, sixth send argument, disabled unsupported state, billing copy and layout. UI source is unchanged by the integration gate. Auth, branding, modal and toast boundaries use synthetic stubs. |
| Independent whole-change and final compatibility review | No remaining Critical/Important finding. Live authentication and actual account entitlement remain unverified. |

Tests first reproduced missing native request tiers, missing Home forwarding, the Codex bridge rejection, and the legacy-bridge capability bypass. Integration then reproduced three cases in which an older bridge incorrectly gained Codex Fast support. The final four focused backend suites passed all 79 tests, and the complete configured check passed on the same final source. The bridge fixture verifies catalog compatibility, readiness/policy/model boundaries and actual SDK serialization for all four Codex models using synthetic responses. A direct UserDO Codex capability-loss transition is source-reviewed rather than a new executable regression.

Reproduction uses `npm run -w @cf-worker-apps/cloud-agent-os test`, `node scripts/build.mjs --config deployment.access.example.json --check` from the OS wrapper, and `npm run -w @cf-worker-apps/cloud-agent test:coverage`. Optional wrapper build checks require the installed compiler and CLI paths described in their test files. A writable XDG cache/config/data directory is required on restricted hosts.

The generated workspace's full `lint:check` still reports the same 127 errors as the unchanged baseline, with no added error diagnostics or suppressions. Repository-wide test coverage and hosted CI are not claimed; this repository intentionally has no GitHub Actions workflow. Verification uses synthetic provider responses and local workerd/browser execution, without live inference or hosted login checks.
