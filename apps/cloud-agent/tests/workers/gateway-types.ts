import { readGatewayVisit } from "../../workers/visit/gateway.js";
import type { VisitGatewayEnvironment } from "../../workers/visit/gateway.js";
import { visitIdentity, visitTarget } from "../../workers/visit/contract.js";

declare const env: VisitGatewayEnvironment;
const identity = visitIdentity({ subjectId: "fixture-subject", siteId: "fixture-site" });
const target = visitTarget({ channelId: "fixture-channel", groupId: "fixture-group", rootMessageId: "fixture-root", managerId: "fixture-manager" });
const fields = { kind: "arrival", concernArea: "Confirmed", revision: "no", schedulingExceptions: "None", externalNameChecked: "yes" } satisfies import("../../workers/visit/contract.js").ArrivalFields;
readGatewayVisit(env, { kind: "mcp", identity }, { action: "patientSearch", query: "Synthetic" });
readGatewayVisit(env, { kind: "mcp", identity }, { action: "visitSelect", patientId: "10000000-0000-0000-0000-000000000001" });
readGatewayVisit(env, { kind: "channel", target }, { action: "draft", patientId: "10000000-0000-0000-0000-000000000001", visitId: "20000000-0000-0000-0000-000000000001", fields });
// @ts-expect-error MCP actors have no draft operation.
readGatewayVisit(env, { kind: "mcp", identity }, { action: "draft", patientId: "10000000-0000-0000-0000-000000000001", visitId: "20000000-0000-0000-0000-000000000001", fields });
// @ts-expect-error An actor cannot mix Channel and MCP identity sources.
readGatewayVisit(env, { kind: "mcp", identity, target }, { action: "patientSearch", query: "Synthetic" });
const mixedActor: { kind: "mcp"; identity: typeof identity; target: typeof target } = { kind: "mcp", identity, target };
// @ts-expect-error Mixed variables cannot bypass the exclusive actor variants.
readGatewayVisit(env, mixedActor, { action: "patientSearch", query: "Synthetic" });
