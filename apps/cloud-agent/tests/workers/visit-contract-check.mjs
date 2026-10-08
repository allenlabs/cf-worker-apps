import assert from "node:assert/strict";
import { performedResult, visitOutputSize, visitResult } from "../../workers/visit/contract.js";

const id = number => "40000000-0000-4000-8000-" + String(number).padStart(12, "0");
const activity = { id: id(1), performedOn: "2026-10-01", podLabel: "7D", types: ["Procedure A"], fkCount: 4, reservationId: null, parentId: null };
const menu = { abbreviation: "Procedure A", name: "Synthetic procedure", location: null, surgeryName: null, product: null, isSurgery: false };
const summary = { procedureText: "Procedure A", pod: "1. POD 7D: Procedure A" };
const evidence = { ...summary, activities: [activity], menu: [menu] };
const context = { mode: "test", kind: "context", patient: { id: id(100), label: "Synthetic patient", reference: null }, reservations: [], visits: [], selectedVisitId: null, performed: evidence, observedAt: "2026-10-08T00:00:00Z" };
const select = { action: "visitSelect", patientId: id(100), visitId: null };

assert.deepEqual(performedResult(summary), summary, "Older summaries remain supported");
assert.deepEqual(performedResult({ procedureText: null, pod: null, activities: [], menu: [] }), { procedureText: null, pod: null, activities: [], menu: [] });
assert.deepEqual(visitResult(context, select).performed, evidence, "Evidence is available without selecting a schedule");
assert.throws(() => visitResult(context, { ...select, patientId: id(101) }), /visit_response_invalid/, "Patient boundary still applies");
const projected = performedResult({ ...evidence, hidden: "PRIVATE-MARKER", activities: [{ ...activity, hidden: "PRIVATE-MARKER" }], menu: [{ ...menu, hidden: "PRIVATE-MARKER" }] });
assert.deepEqual(projected, evidence, "Only declared evidence fields survive");
assert.notEqual(projected.activities[0].types, activity.types, "Projection owns its arrays");
assert.doesNotMatch(JSON.stringify(projected), /PRIVATE-MARKER/);

const validRows = [
  { ...activity, performedOn: null, podLabel: "Unknown date", types: [], fkCount: 0 },
  { ...activity, performedOn: "2024-02-29", podLabel: "x".repeat(80), types: ["x".repeat(1000)], fkCount: Number.MAX_SAFE_INTEGER, reservationId: id(2), parentId: id(3) },
  { ...activity, types: ["😀".repeat(500)] },
  { ...activity, types: Array(1000).fill("A") },
];
for (const row of validRows) assert.deepEqual(performedResult({ ...evidence, activities: [row] }).activities, [row]);
const validMenu = { abbreviation: "a".repeat(300), name: "n".repeat(300), location: "l".repeat(300), surgeryName: "s".repeat(300), product: "p".repeat(300), isSurgery: null };
assert.deepEqual(performedResult({ ...evidence, menu: [validMenu, { ...menu, isSurgery: true }] }).menu, [validMenu, { ...menu, isSurgery: true }]);
assert.equal(performedResult({ ...evidence, activities: Array.from({ length: 200 }, (_, index) => ({ ...activity, id: id(index + 1) })) }).activities.length, 200);
assert.equal(performedResult({ ...evidence, menu: Array(300).fill(menu) }).menu.length, 300);

const invalidRows = [
  null, [], {},
  ...["id", "performedOn", "podLabel", "types", "fkCount", "reservationId", "parentId"].map(key => Object.fromEntries(Object.entries(activity).filter(([field]) => field !== key))),
  { ...activity, id: "bad-id" },
  ...["2026-02-29", "2026-02-30", "2026-13-01", "0000-01-01", "infinity", "-infinity", "2026-10-01T00:00:00Z", 1].map(performedOn => ({ ...activity, performedOn })),
  ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map(fkCount => ({ ...activity, fkCount })),
  ...["", "   ", "x".repeat(81), "A\nB", "A\u2028B"].map(podLabel => ({ ...activity, podLabel })),
  ...[null, "A", [null], [""], ["   "], ["x".repeat(1001)], ["😀".repeat(501)], Array(1001).fill("A"), Array(1)].map(types => ({ ...activity, types })),
  ...["\0", "\n", "\t", "\u007f", "\u0085", "\u2028", "\u2029"].map(control => ({ ...activity, types: ["A" + control + "B"] })),
  { ...activity, reservationId: "bad-id" }, { ...activity, parentId: "bad-id" },
];
for (const row of invalidRows) assert.throws(() => performedResult({ ...evidence, activities: [row] }), /visit_response_invalid/);
const invalidMenu = [
  null, [], {},
  ...Object.keys(menu).map(key => Object.fromEntries(Object.entries(menu).filter(([field]) => field !== key))),
  ...["", " ", "x".repeat(301), "A\nB"].map(abbreviation => ({ ...menu, abbreviation })),
  ...["name", "location", "surgeryName", "product"].flatMap(key => [2, "x".repeat(301), "A\0B"].map(value => ({ ...menu, [key]: value }))),
  { ...menu, isSurgery: "false" }, { ...menu, isSurgery: 0 },
];
for (const row of invalidMenu) assert.throws(() => performedResult({ ...evidence, menu: [row] }), /visit_response_invalid/);
for (const value of [
  { ...summary, activities: [] }, { ...summary, menu: [] },
  { ...evidence, activities: null }, { ...evidence, menu: null },
  { ...evidence, activities: {} }, { ...evidence, menu: {} },
  { ...evidence, activities: Array(1) }, { ...evidence, menu: Array(1) },
  { ...evidence, activities: [activity, activity] },
  { ...evidence, activities: Array.from({ length: 201 }, (_, index) => ({ ...activity, id: id(index + 1) })) },
  { ...evidence, menu: Array(301).fill(menu) },
]) assert.throws(() => performedResult(value), /visit_response_invalid/);
const large = performedResult({ ...evidence, activities: [{ ...activity, types: Array(100).fill("x".repeat(1000)) }] });
assert.throws(() => visitOutputSize(large), /visit_response_too_large/, "The whole response byte cap still rejects evidence without truncating it");
console.log("Visit performed evidence contract checks passed");
