# Visit Gateway

The reusable Gateway module lets a host keep Channel App traffic and authenticated MCP reads on one service boundary. It adds no account system, model, clinical storage or public deployment route. The host imports `handleVisitGateway` for Channel `/read` and calls `readGatewayVisit` directly from its authenticated MCP adapter.

```js
import { handleVisitGateway, readGatewayVisit } from "../workers/visit/gateway.js";

// Channel service ingress. It accepts only {target,input} at POST /read.
return handleVisitGateway(request, env);

// Inside authenticated server code, after deriving these from current auth policy.
const actor = { kind: "mcp", identity: { subjectId, siteId } };
return readGatewayVisit(env, actor, { action: "patientSearch", query: "Synthetic" });
```

`readGatewayVisit` accepts a strict actor union: `{kind:"channel",target:{channelId,groupId,rootMessageId,managerId}}` or `{kind:"mcp",identity:{subjectId,siteId}}`. Channel inputs retain search, visit selection and deterministic draft support. MCP permits only `patientSearch` and `visitSelect`, with no draft or write path. Runtime validation rejects mixed variants and extra properties. Adjacent `.d.ts` declarations let a strict TypeScript host import the JS module and reject MCP draft calls during compilation.

## Two independent keys

| Worker | Inbound authentication | Outbound binding and authentication |
| --- | --- | --- |
| Events | Existing platform signature and bound root capability | `VISIT_API` points to Gateway; its existing `VISIT_SERVICE_TOKEN` holds the ingress credential |
| Gateway host | Channel `/read` verifies `VISIT_INGRESS_TOKEN`; MCP uses the host's current server authentication | `VISIT_API` points to backend; `VISIT_SERVICE_TOKEN` holds a different backend credential |
| Visit backend | Verifies the backend `VISIT_SERVICE_TOKEN` | Fixed Supabase RPC using its own private API credential |

Both service keys require at least 32 characters. The backend key cannot authenticate Channel ingress, and the ingress key cannot authenticate the backend. Store both keys in the installation's secret manager and platform bindings. The Events Worker never receives the backend key or database credential. The Gateway does not need a database URL/key. It forwards to the fixed `https://visit.internal/read` service-binding URL, with redirects disabled and a 15-second timeout. Supabase remains a backend-only fetch with a 10-second timeout.

The `/read` HTTP helper never accepts an MCP identity, even with a valid Channel ingress key. Missing/mixed identity sources and caller-selected tenant/source/site fields are rejected before delegation. A host must authenticate MCP through its existing protected MCP route, derive the subject and permitted site on the server, and call the in-process helper. Do not route a user-provided `identity`, role or dataset into that helper.

## Backend and RPC identity

The backend accepts exactly one of these bodies:

```js
{ target: { channelId, groupId, rootMessageId, managerId }, input }
{ identity: { subjectId, siteId }, input } // MCP reads only
```

The backend validates subject IDs against `[A-Za-z0-9_:-]{1,255}` and site IDs against `[A-Za-z0-9_-]{1,128}`. It constructs the RPC actor itself:

```js
// Existing Channel actor is unchanged.
{ tenantId: env.TENANT_ID, channelId, groupId, rootMessageId, managerId }
// MCP has a separate source and no Channel fallback.
{ tenantId: env.TENANT_ID, source: "mcp", subjectId, siteId }
```

`source` and tenant never come from the client. An MCP failure must not downgrade to a Channel manager or another site's identity. The private RPC must resolve a single enabled subject/site link within the fixed tenant and recheck current SSO/staff status and actual visit-read permission on every call. Multiple/disabled links, inactive subjects, denied sites and out-of-scope records fail closed. Channel manager authorization retains its separate current mapping. A successful host login or possession of the ingress key alone is not clinical authorization.

Both paths use the existing strict [visit DTOs](VISIT_WORKFLOW.md), output projection, 20-row limits and 64 KiB bounds. Draft output uses the same shared result validator as Events and Gateway. Extra backend profile fields are discarded. Errors return bounded named codes rather than raw backend details. Calls have no clinical cache, durable receipt, Pi session, D1 transcript or Channel write; a retry performs a fresh authorized read.

## Checks

```sh
npm run -w @cf-worker-apps/cloud-agent build:events
npm run -w @cf-worker-apps/cloud-agent build:visit
npm run -w @cf-worker-apps/cloud-agent gateway-check
npm run -w @cf-worker-apps/cloud-agent gateway-typecheck
```

The native workerd check executes the actual signed Events → Gateway → backend binding chain and mocks only the fixed Supabase RPC. It checks distinct keys, identity spoof/mixed-shape rejection, fixed tenant/source, read-only MCP, revocation, patient/visit links, result projection/bounds and unchanged drafts without a Pi/D1 binding. The test's fixture MCP endpoint supplies a fixed generated server identity; it does not implement production authentication. The TypeScript check verifies the declared actor/action boundary. These checks do not prove a host's live SSO policy or an installation RPC's actual permission mapping.
