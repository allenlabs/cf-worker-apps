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

The OS Workshop Worker uses the `CODEX_BRIDGE` service binding with entrypoint `CloudAgentInference`, plus `CODEX_BRIDGE_MODEL` and the same `CODEX_BRIDGE_ALLOWED_USER_IDS`. The wrapper's `modelBridge` configuration generates these settings.

Seed an OS agent model using the existing `addModel` flow: provider `openai`, the configured model ID, and an empty `apiToken`. When the binding is configured, the adapter rejects alternative models, credentials, endpoints, custom headers, and non-user initiators. If the binding is absent, upstream OS model selection remains unchanged.

The caller must derive `initiator.id` from an authenticated server session. The pilot's OIDC Gatekeeper validates issuer, verified email and subject before assigning the canonical email-based OS user ID. The binding trusts the OS Worker to supply this identity; it does not authenticate arbitrary browsers. Keep this binding unavailable to unrelated Workers. No HTTP inference route is registered.

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

## Pilot capabilities and limits

- Supports streamed text, thinking, tool calls, and text tool results, including a second inference turn after tool execution. Tool execution remains in the existing OS agent loop. Images, audio and image tool results are rejected.
- Input is limited to 1 MiB, 256 messages, 64 tools, and 128 content blocks per message. Output is limited to 512 KiB per NDJSON frame and 8 MiB per call. Output tokens default to 4,096 and cannot exceed 8,192. Full partial-message snapshots can reach the output ceiling on long turns.
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

The fixture uses the real installed Codex provider with fake credentials and a local SSE responder. It verifies streaming text, tool-call/result roundtrip, fixed model and account boundaries, user allowlisting, rejected images and oversized input, malformed UTF-8/envelope/output bounds, sanitized provider errors, explicit cancellation reaching the provider AbortSignal before its deadline, server deadline, and token accounting. It makes no production call. Run the OS wrapper build separately to validate the adapter against the pinned backend TypeScript configuration. Live SSO, one Codex call, and read-only MCP execution remain deployment acceptance checks.
