# External coding-agent backends

Cursor and Devin expose cloud APIs that can support persistent coding-agent conversations in this application. These integrations are feasible but are not implemented here. This review uses public documentation and source available on 2026-10-23. It does not establish any installation's API entitlement or successful agent execution.

## Model calls and agent sessions

The current inference bridge supplies model responses to the OS agent loop. The OS owns its tools and conversation state. Cursor and Devin cloud APIs instead create remote agent sessions with their own execution environments, tools, repository access, and usage accounting. Cursor explicitly distinguishes its agent APIs from a standalone model-inference API in its [API overview](https://cursor.com/docs/api).

An integration should keep remote agent sessions separate from ordinary model providers. Substituting one of these endpoints into an OpenAI-compatible model configuration would not supply the required session protocol.

## Supported integration routes

| Route | Conversation lifecycle | Execution host | Fit for Workers |
| --- | --- | --- | --- |
| Cursor Cloud Agents v1 | Durable agents, individual runs, streamed text and tool events, follow-up runs, cancellation | Cursor cloud | Authenticated HTTPS and SSE |
| Devin Cloud API v3 | Create and inspect sessions, read messages, send follow-ups, sleep or terminate | Devin cloud | Authenticated HTTPS with polling |
| Cursor or Devin CLI through ACP | New and resumed sessions, streamed updates, permission requests, cancellation | A machine running the CLI | Requires a separate process host |

Cursor documents run streaming and reconnection using `Last-Event-ID`. One run can be active per agent. Its [Cloud Agents API reference](https://cursor.com/docs/cloud-agent/api/endpoints) defines the agent, run, streaming, cancellation, repository, and model operations. Prefer REST from Workers. The Node-first [Cursor SDK](https://cursor.com/docs/sdk/typescript) ships platform binaries, and Workers compatibility is unverified.

Devin v3 uses organization-scoped session endpoints and Bearer credentials. Service users suit shared automation. Personal access tokens inherit the human owner's permissions. The [authentication reference](https://docs.devin.ai/api-reference/authentication) and [migration guide](https://docs.devin.ai/api-reference/getting-started/migration-guide) distinguish v3 from legacy APIs. Its [common flows](https://docs.devin.ai/api-reference/common-flows) use polling for messages and status. A public token-streaming contract was not established in the reviewed documentation. Sleep and permanent termination need separate user actions because only the former allows a session to resume.

API access and usage depend on the provider's current plan and account permissions. Verify those before integration. Repository-backed work also needs the provider's source-control connection and repository permissions. A product subscription alone is not evidence that its cloud API is available.

## Paseo's local approach

[Paseo's provider contract](https://paseo.sh/docs/providers) launches installed and authenticated agent CLIs as subprocesses. Its generic ACP adapter translates input, events, permissions, and cancellation. At source commit `582beeb10bf7a0dc2297f35529f78df89dee9358`, the [ACP provider catalog](https://github.com/getpaseo/paseo/blob/582beeb10bf7a0dc2297f35529f78df89dee9358/packages/app/src/data/acp-provider-catalog.ts) includes `cursor-agent acp` and `devin acp`. Both vendors document their ACP commands in the [Cursor ACP guide](https://cursor.com/docs/cli/acp) and [Devin CLI reference](https://docs.devin.ai/cli/reference/commands#devin-acp).

Plain Workers cannot launch these processes. Cloudflare exposes `node:child_process` as a [stub](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-nodechild_process-module). A local-workspace integration therefore needs a separate machine or supported container execution service with an authenticated bridge. The cloud API routes do not need that bridge.

## Recommended application boundary

Add a remote-agent session adapter with a discriminated provider type, separate credentials, selected repository, upstream session or agent ID, run ID, status, and event cursor. Resolve credentials on the server. Normalize provider events for the existing chat display without pretending that the OS tool loop executed them.

Persist the upstream identifiers before relying on a browser stream. Browser disconnection must not mean cancellation. Recover through the provider's status and events. Workers can stream while the client remains connected, but `waitUntil()` extends execution for only 30 seconds after disconnection under the documented [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#duration).

Start with a cloud API already covered by the operator's plan. Cursor provides a documented SSE path. Devin provides a polling conversation path. Add ACP only when work must use a local checkout, local tools, or an existing CLI account. An ACP host introduces deployment and connectivity requirements that the direct cloud APIs avoid.
