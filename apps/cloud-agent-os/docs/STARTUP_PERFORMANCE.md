# Chat startup performance

## Design

Keep every existing conversation, selected bot, permission check and model input. Reduce startup waiting by running two pairs of independent reads concurrently:

- `OverseerForClient.newChat`: load the authenticated user's chat context and, when selected, the same user's exact bot revision together. Create the chat only after both succeed. A failed lookup must create no chat or initial message. Standard chats must not request a bot.
- Agent prompt preparation: describe standard formats and list connectable vendors together. Construct the same prompt and invoke inference only after both return. An outward hook rejection must prevent inference; the hooks' existing best-effort fallback for underlying lookup failures remains unchanged.

This is a scheduling change using `Promise.all`, without caching, additional retries, dependencies, new telemetry, changed timeouts or storage changes. Keep each read's existing Durable Object reset handling. Both operations in each pair are reads, and neither consumes the other's result.

Keeping the serial order would retain an unnecessary dependency. Adding caches would require invalidation and permission-lifetime rules. Concurrent reads are the smallest change for this scope. This choice is an implementation decision under the requested performance work.

## Implementation plan

1. Add integration regressions around the real client/agent path using deferred reads. Confirm that the second read starts before the first completes, and neither chat creation nor inference starts early. Observe these tests fail against the serial implementation.
2. Add a final ordered patch for the two startup locations. Preserve method signatures, exact arguments, owner scope, bot revision validation, explicit errors and prompt contents.
3. Verify successful reads, outward rejections, standard chats, reverse completion order and reset recovery. Use controlled synthetic delays for before/after measurements; identify them as synthetic rather than production TTFT.
4. Run the complete backend test suite and applicable build/typecheck, wrapper tests, changed-file lint and independent review. Publish reusable source only. A subsequent production rollout requires a separate report of changes and validation.

## Review focus

- A selected bot becoming unavailable must not leave a partial chat.
- An unavailable user context must not permit chat creation.
- A prompt hook rejecting must not start inference. Existing underlying lookup fallbacks retain their previous behavior.
- Reversed completion order must not swap results or change prompt data.
- Standard chats and existing reset recovery must retain their previous behavior.

## Measurement limits

Worker invocation wall time can include a WebSocket's entire lifetime. It does not measure time to first token. Production TTFT requires separate boundaries for submitting a message, starting inference, receiving the first text delta and painting it. No production latency improvement is claimed from controlled-delay tests alone.

## Controlled measurements

The real Workerd client/agent paths were exercised with synthetic dependencies delayed by 30ms and 50ms, five samples per variant. These are local measurements with fake model responses, without live data or external inference.

| Measured path | Serial samples (ms) | Concurrent samples (ms) | Median before / after |
|---|---|---|---|
| Selected-bot chat creation, including persistence | 87, 84, 85, 83, 85 | 55, 52, 52, 52, 52 | 85 / 52ms |
| Agent entry to first faux provider callback | 1076, 409, 319, 341, 313 | 989, 399, 294, 276, 410 | 341 / 399ms |

The selected-bot fixture demonstrates the removed serial wait. The broader agent measurement did not demonstrate an improvement: its post-change median was higher, and the ranges overlap substantially. Native startup and other preparation dominate this small sample. The deferred-read regressions establish concurrency and unchanged outputs independently of these timing samples. Neither measurement is production TTFT.

## Regression harness

Faux Overseer clients provide an empty site-context accessor only when one was not supplied. Existing accessors, including inherited and read-only getters, retain their identity and values; a configured site still denies a collaborator. The tracing fixture keeps its request alive through queued callbacks and the following agent turn, and checks both provider calls and successful closed spans. These changes repair test setup without changing production permission checks, span behavior or timeouts.

## Verification

Validated on 2026-10-26 with the pinned upstream and its real Workerd test pool:

- Full native backend: 95 files, 1,842 tests passed.
- Configured RPC integration: 3 passed; 4 remain skipped by the upstream suite's existing CI-timeout guard.
- Wrapper: 132 tests passed, none skipped; syntax/type checks passed.
- Official build check: 776 selected backend tests, 515 frontend tests, 35 MCP tests and all five Worker dry-runs passed. The final test-only repairs leave all 96 backend source files byte-identical to that passed build.
- Full upstream lint remains at 127 errors and 291 warnings. Its diagnostics match the previous baseline after excluding shifted line numbers; this change adds no diagnostics. The changed test files have no lint errors.

Applying the final patches produces the exact source and tests used by the full native and RPC runs.
