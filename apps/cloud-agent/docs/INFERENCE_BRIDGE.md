# Cloudflare OS subscription inference pilot

Cloudflare OS can use an existing Cloud Agent Codex account through the `CloudAgentInference` Worker service binding. OAuth access and refresh tokens stay in the existing Credentials Durable Object. The adapter preserves the upstream OS agent loop and its tools; it replaces only model transport.

## Configuration

Configure the Cloud Agent Worker with server-owned values:

| Variable | Meaning |
| --- | --- |
| `INFERENCE_BRIDGE_ACCOUNT_ID` | Existing Credentials object ID: `owner` or `account-<uuid>` |
| `INFERENCE_BRIDGE_MODEL` | One installed `openai-codex` model ID |
| `INFERENCE_BRIDGE_ALLOWED_USER_IDS` | JSON array of canonical lowercase verified email IDs; 1–20 entries |
| `INFERENCE_BRIDGE_TIMEOUT_MS` | Optional provider-stream deadline, 1,000–120,000 ms; default 120,000 |
| `INFERENCE_BRIDGE_REQUEST_ENCODING` | Optional `native` (default) or `identity`; applies only to this service entrypoint |

The OS Workshop Worker uses the `CODEX_BRIDGE` service binding with entrypoint `CloudAgentInference`, plus `CODEX_BRIDGE_MODEL` and the same `CODEX_BRIDGE_ALLOWED_USER_IDS`. The wrapper's `modelBridge` configuration generates these settings.

Seed an OS agent model using the existing `addModel` flow: provider `openai`, the configured model ID, and an empty `apiToken`. When the binding is configured, the adapter rejects alternative models, credentials, endpoints, custom headers, and non-user initiators. If the binding is absent, upstream OS model selection remains unchanged.

The caller must derive `initiator.id` from an authenticated server session. The pilot's OIDC Gatekeeper validates issuer, verified email and subject before assigning the canonical email-based OS user ID. The binding trusts the OS Worker to supply this identity; it does not authenticate arbitrary browsers. Keep this binding unavailable to unrelated Workers. No HTTP inference route is registered.

`native` forwards the installed provider's fetch arguments unchanged, including zstd compression when available. `identity` retains the provider's exact serialized JSON for the current call and sends it without the `content-encoding` header. The endpoint, model, account, remaining provider-supplied headers, context, tools, signal, and response handling remain the same; the runtime computes `Content-Length` for the selected wire body. This option is read only by `CloudAgentInference`; ordinary Cloud Agent and Channel Talk subscription requests keep their existing transport. Unknown values fail configuration validation before credential access.

Identity encoding is a controlled transport comparison supported by the [official Codex client's uncompressed Responses path](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/codex-rs/core/src/client.rs). It does not establish that compression caused a provider failure. A 403 is returned through the same sanitized error path without automatically issuing an alternate request. The captured JSON is held in call-local memory only and is excluded from diagnostics and persistent stores.

## RPC contract

`infer(input)` accepts the versioned common subset of Pi 0.99.1 and 1.0.2:

```typescript
{
  version: 1,
  requestId: string, // UUID
  userId: string,   // server-authenticated, allowlisted ID
  context: { systemPrompt?: string, messages: Message[], tools?: Tool[] },
  options: { reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh", maxTokens?: number }
}
```

It returns `{stream, cancellation}`. `stream` is a byte-oriented ReadableStream of UTF-8 NDJSON `{version: 1, event}` envelopes. `cancellation` is a per-call RPC capability with `cancel()`. The adapter explicitly cancels the provider and disposes this capability; transferred stream cancellation alone did not stop the provider promptly in the native fixture. There is no global request registry.

The bridge validates input before credential access, fixes the account and model on the server, and emits only validated Pi event fields. Provider failures become generic error codes. Request IDs are correlation values, not replay or idempotency keys.

## Failure diagnostics

For a non-aborted provider error, the bridge emits one `console.warn` with the fixed prefix `inference_bridge_diagnostic` and a JSON object containing only these fields:

| Fields | Values |
| --- | --- |
| `phase` | `credential`, `provider_setup`, `fetch`, or `response` |
| `credentialAccessFailed`, `fetchAttempted`, `responseReceived` | Booleans |
| `status` | Observed HTTP status (100–599), or `null` |
| `category` | `upstream_blocked`, `permission_denied`, `invalid_response`, `success`, `auth_required`, `rate_limited`, `upstream_error`, or `null` |
| `contentType` | `json`, `html`, `sse`, `other`, `missing`, or `null` |
| `challenge` | Observed challenge-header classification, or `null` |
| `responseRedirected`, `responseFinalEndpointExpected` | Response redirect flag and exact expected-endpoint match, or `null` when unobserved |
| `cfErrorType` | `1000`, `1016`, `1101`, `1102`, `521`, `522`, `523`, `524`, `525`, `526`, `1020`, `1009`, `1015`, `other`, or `null` |
| `cfErrorOriginPresent` | Presence of the error-origin header, or `null` when unobserved |
| `htmlAttentionRequired`, `htmlJustAMoment`, `htmlErrorDetails`, `htmlErrorCode`, `htmlCode1020`, `htmlCode1009`, `htmlCode1015`, `htmlBlockedPhrase` | Known literal HTML marker booleans, or `null` when HTML was not inspected |
| `htmlTruncated` | Whether HTML was truncated at the 64 KiB inspection bound, or `null` when unobserved |
| `requestEndpointExpected`, `requestAuthorizationPresent`, `requestAccountPresent`, `requestContentTypePresent`, `requestAcceptPresent` | Shape booleans, or `null` when unobserved |
| `requestWireEncoding` | `identity`, `zstd`, `other`, or `null` |
| `requestWireKind` | `string`, `bytes`, `stream`, `other`, or `null` |
| `requestWireByteLength` | Observed safe integer byte length from 0 through 16 MiB, or `null` when unavailable or outside that diagnostic bound |
| `payloadStoreFalse`, `payloadStreamTrue`, `payloadInputArray`, `payloadToolSchemaValid` | Shape booleans, or `null` when unobserved |

The record excludes identities, account IDs, request IDs, tokens, header values, prompts, tool definitions, response bodies, and raw error messages. It is projected from existing provider observations rather than serializing provider diagnostics. Successful calls, cancellation, input rejection, and bridge framing failures do not emit this provider diagnostic. A logging failure cannot change the stream or its public error codes.

`credential` means the existing credential-access call threw; it does not identify why. `provider_setup` means the provider failed before the observed inference HTTP attempt. `fetch` means the latest fetch attempt began but no response observation was received. The bridge clears prior request and response observations before each fetch attempt, so a failed retry does not retain an earlier HTTP classification. `response` describes the latest observed response, not overall inference success: a status of 200 with category `success` can still precede an SSE protocol or provider failure. A 403 classification alone cannot establish whether account policy, provider access, or network protection caused the denial. A missing observation remains `null`; it is not evidence that a field was absent.

The final-endpoint check records only whether the response URL exactly matches the expected Codex endpoint. Unsupported Cloudflare error-header values become `other`; malformed diagnostic enum values become `null`. HTML markers classify known literal templates from the existing provider's bounded inspection; unknown templates produce false marker booleans. A marker or error code is evidence of the observed response shape, not proof of its cause. The request wire length measures the body passed to fetch, including compression when used; observing it never reads a stream body or changes request transport. Its 16 MiB diagnostic bound does not enforce a request-size limit.

For deployment diagnosis, inspect the fixed prefix in a temporary Worker tail without persisting the stream or collecting unrelated payloads. The bridge adds no diagnostic store or correlation registry. A live tail, unlike mocked verification, can establish which phase and safe HTTP metadata occurred for an actual call; it does not prove provider eligibility or successful model output.

## Pilot capabilities and limits

- Supports streamed text, thinking, tool calls, and text tool results, including a second inference turn after tool execution. Tool execution remains in the existing OS agent loop. Images, audio and image tool results are rejected.
- Input is limited to 1 MiB, 256 messages, 64 tools, and 128 content blocks per message. Output is limited to 512 KiB per NDJSON frame and 8 MiB per call. The bridge validates `maxTokens` as an integer from 1 through 8,192 and forwards it with a default of 4,096. The installed Codex request builder ignores this option, so it provides no enforceable output-token cap. Byte, frame, and provider-stream deadline limits still apply. Full partial-message snapshots can reach the output ceiling on long turns.
- Provider-stream cancellation has a configured deadline; the OS adapter has a 125-second watchdog. Credentials status is read before that deadline starts. A refresh already in progress keeps the existing credential refresh HTTP timeout. This is not a hard end-to-end 120-second RPC deadline.
- OS persists token counts from the response. API cost fields are zero because these calls use subscription authentication; zero is not a statement about subscription billing or remaining allowance. Usage is not merged into Cloud Agent's `pi_committed_usage` ledger, and this pilot does not expose provider quota information.
- This is a transport integration test, not a replacement for the Cloud Agent harness. Existing credential IDs, Channel Talk thread ownership, tenant records, and account selection policies are unchanged. A mock pass cannot establish live provider availability or subscription eligibility.

## Verification

From the repository root, run the native two-Worker fixture:

```sh
npm --prefix apps/cloud-agent run inference-bridge-check
```

For the pinned OS/runtime cross-version check, install the pinned OS dependencies and provide its source checkout:

```sh
CLOUDFLARE_OS_SOURCE=/absolute/path/to/cloudflare-os \
  npm --prefix apps/cloud-agent run inference-bridge-check
```

The fixture uses the real installed Codex provider with fake credentials and a local SSE responder. It runs the complete behavior checks with default native and identity encoding, verifies explicit native selection, and compares exact Unicode/tool JSON against the decoded native zstd body and every provider-supplied header except `content-encoding`. It verifies correct runtime framing and an ordinary subscription-provider control that retains zstd under the same identity-configured Worker. It rejects unknown encoding settings before credential lookup or provider HTTP. It verifies streaming text, tool-call/result roundtrip, fixed model and account boundaries, user allowlisting, rejected images and oversized input, malformed UTF-8/envelope/output bounds, sanitized provider errors, explicit cancellation reaching the provider AbortSignal before its deadline, server deadline, and token accounting. Failure regressions distinguish credential/setup failures, fetch exceptions, HTTP 403/challenges without automatic retry, HTTP 200 followed by SSE failure, and a retryable HTTP response followed by a failed fetch. The retry case enables one retry only in the generated test bundle and uses the real provider retry loop; production retry options are unchanged. The fixture also checks response redirects and endpoint classification, request wire shape and byte length, Cloudflare error headers, known and unknown HTML templates, bounded-value sanitization, fixed-schema redaction, one terminal log, observer failure isolation, and no success/cancellation diagnostics. It makes no production call. Run the OS wrapper build separately to validate the adapter against the pinned backend TypeScript configuration. Live SSO, one Codex call, and read-only MCP execution remain deployment acceptance checks.

The installed-provider and pinned OS/runtime cross-version fixtures passed both complete native and identity checks, including 14 failure scenarios per encoding, credential-wait cancellation/deadline, exact JSON/header preservation, and the unaffected ordinary-provider control. The app typecheck passed. The required `test:coverage` run passed all behavioral checks but ended with `Profiler is not enabled` (exit 2). Coverage remains unmeasured; thresholds were not lowered. These generated-credential results do not establish that identity encoding fixes a live provider denial.
