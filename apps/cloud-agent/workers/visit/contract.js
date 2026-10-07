const encoder = new TextEncoder();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const text = (value, max) => typeof value === "string" && value.length <= max && !value.includes("\0");
const requireValue = (ok, code = "visit_input_invalid") => { if (!ok) throw Error(code); };
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

export function visitInput(value) {
  const common = ["action", "patientId", "visitId"];
  requireValue(object(value));
  if (value.action === "patientSearch") {
    requireValue(keys(value, ["action", "query"]) && text(value.query, 64) && value.query.trim().length >= 2);
    return { action: value.action, query: value.query.trim() };
  }
  requireValue(["visitSelect", "draft"].includes(value.action) && uuid(value.patientId) && (value.visitId === undefined || value.visitId === null || uuid(value.visitId)));
  if (value.action === "visitSelect") {
    requireValue(keys(value, common));
    return { action: value.action, patientId: value.patientId, visitId: value.visitId ?? null };
  }
  requireValue(keys(value, [...common, "fields"]) && uuid(value.visitId), "visit_selection_required");
  const fields = value.fields;
  requireValue(keys(fields, ["kind", "concernArea", "revision", "schedulingExceptions", "externalNameChecked"]) && ["arrival", "treatment"].includes(fields.kind) && text(fields.concernArea, 200) && text(fields.schedulingExceptions, 500) && ["unknown", "yes", "no"].includes(fields.revision) && ["unknown", "yes", "no"].includes(fields.externalNameChecked));
  return { action: value.action, patientId: value.patientId, visitId: value.visitId, fields: { kind: fields.kind, concernArea: fields.concernArea.trim(), revision: fields.revision, schedulingExceptions: fields.schedulingExceptions.trim(), externalNameChecked: fields.externalNameChecked } };
}

export function visitTarget(value) {
  requireValue(keys(value, ["channelId", "groupId", "rootMessageId", "managerId"]) && ["channelId", "groupId", "rootMessageId", "managerId"].every(key => typeof value[key] === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value[key])), "visit_target_invalid");
  return { channelId: value.channelId, groupId: value.groupId, rootMessageId: value.rootMessageId, managerId: value.managerId };
}

export function visitIdentity(value) {
  requireValue(keys(value, ["subjectId", "siteId"]) && typeof value.subjectId === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value.subjectId) && typeof value.siteId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.siteId), "visit_identity_invalid");
  return { subjectId: value.subjectId, siteId: value.siteId };
}

export function visitGatewayActor(value) {
  requireValue(object(value));
  if (value.kind === "channel") {
    requireValue(keys(value, ["kind", "target"]));
    return { kind: "channel", target: visitTarget(value.target) };
  }
  requireValue(value.kind === "mcp" && keys(value, ["kind", "identity"]));
  return { kind: "mcp", identity: visitIdentity(value.identity) };
}

export const visitErrors = Object.freeze(["visit_input_invalid", "visit_target_invalid", "visit_identity_invalid", "visit_selection_required", "visit_not_configured", "visit_record_denied", "visit_not_found_for_patient", "visit_backend_unavailable", "visit_response_invalid", "visit_response_too_large"]);

export async function visitJson(message, limit = 65536) {
  const reader = message.body?.getReader();
  requireValue(reader, "visit_response_invalid");
  const parts = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw Error("visit_response_too_large"); }
      parts.push(value);
    }
    const bytes = new Uint8Array(length); let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error.message === "visit_response_too_large") throw error;
    throw Error("visit_response_invalid");
  } finally { reader.releaseLock(); }
}

const backendValue = ok => requireValue(ok, "visit_response_invalid");
const nullableText = (value, max) => value === null || text(value, max);
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value));
function patient(value) {
  backendValue(object(value) && uuid(value.id) && text(value.label, 200) && value.label.trim().length > 0 && nullableText(value.reference, 120));
  return { id: value.id, label: value.label, reference: value.reference };
}
function unique(values) { backendValue(new Set(values.map(value => value.id)).size === values.length); }

export function visitResult(value, input) {
  backendValue(object(value) && ["test", "live"].includes(value.mode));
  if (input.action === "draft") {
    backendValue(value.kind === "draft" && object(value.draft) && text(value.draft.text, 4000) && Array.isArray(value.draft.missingFields) && value.draft.missingFields.length <= 4 && new Set(value.draft.missingFields).size === value.draft.missingFields.length && value.draft.missingFields.every(field => ["concernArea", "revision", "schedulingExceptions", "externalNameChecked"].includes(field)) && typeof value.draft.ready === "boolean" && value.draft.ready === (value.draft.missingFields.length === 0) && date(value.observedAt) && value.observedAt.includes("T"));
    return { mode: value.mode, kind: "draft", draft: { text: value.draft.text, missingFields: value.draft.missingFields, ready: value.draft.ready }, observedAt: value.observedAt };
  }
  if (input.action === "patientSearch") {
    backendValue(value.kind === "patients" && Array.isArray(value.patients) && value.patients.length <= 20);
    const patients = value.patients.map(patient); unique(patients);
    return { mode: value.mode, kind: "patients", patients };
  }
  backendValue(value.kind === "context" && object(value.patient) && value.patient.id === input.patientId && Array.isArray(value.reservations) && value.reservations.length <= 20 && Array.isArray(value.visits) && value.visits.length <= 20 && value.selectedVisitId === input.visitId && date(value.observedAt) && value.observedAt.includes("T"));
  const selectedPatient = patient(value.patient);
  const selectedReservationId = value.visits.find(row => object(row) && row.id === input.visitId)?.reservationId ?? null;
  const reservations = value.reservations.map(row => {
    backendValue(object(row) && uuid(row.id) && (row.at === null || date(row.at)) && nullableText(row.type, 80) && nullableText(row.status, 80) && (row.id !== selectedReservationId || (row.procedureText === undefined || nullableText(row.procedureText, 1000)) && (row.note === undefined || nullableText(row.note, 1000)) && (row.pod === undefined || nullableText(row.pod, 40))));
    return { id: row.id, at: row.at, type: row.type, status: row.status, ...(row.id !== selectedReservationId || row.procedureText === undefined ? {} : { procedureText: row.procedureText }), ...(row.id !== selectedReservationId || row.note === undefined ? {} : { note: row.note }), ...(row.id !== selectedReservationId || row.pod === undefined ? {} : { pod: row.pod }) };
  });
  const reservationIds = new Set(reservations.map(row => row.id)); unique(reservations);
  const visits = value.visits.map(row => {
    backendValue(object(row) && uuid(row.id) && (row.date === null || date(row.date)) && (row.reservationId === null || uuid(row.reservationId) && reservationIds.has(row.reservationId)) && nullableText(row.status, 80));
    return { id: row.id, date: row.date, reservationId: row.reservationId, status: row.status };
  });
  unique(visits); backendValue(input.visitId === null || visits.some(row => row.id === input.visitId));
  const intake = input.visitId === null || value.intake === undefined ? undefined : value.intake;
  backendValue(intake === undefined || object(intake) && nullableText(intake.concernText, 1000));
  return { mode: value.mode, kind: "context", patient: selectedPatient, reservations, visits, selectedVisitId: value.selectedVisitId, ...(intake === undefined ? {} : { intake: { concernText: intake.concernText } }), observedAt: value.observedAt };
}

export function visitDraft(context, fields) {
  const visit = context.visits.find(value => value.id === context.selectedVisitId);
  requireValue(visit, "visit_selection_required");
  const missingFields = [];
  if (!fields.concernArea) missingFields.push("concernArea");
  if (fields.revision === "unknown") missingFields.push("revision");
  if (!fields.schedulingExceptions) missingFields.push("schedulingExceptions");
  if (fields.externalNameChecked !== "yes") missingFields.push("externalNameChecked");
  const lines = [fields.kind === "arrival" ? "[상담 도착 안내 초안]" : "[치료실 안내 초안]", "대상: " + context.patient.label, "식별 참고: " + (context.patient.reference || "확인 필요"), "선택한 방문: " + (visit.date || "날짜 확인 필요"), "상담·치료 부위: " + (fields.concernArea || "미입력"), "재수술 여부: " + ({ unknown: "확인 필요", yes: "예", no: "아니요" }[fields.revision]), "일정 예외: " + (fields.schedulingExceptions || "미입력"), "외부 시스템 이름 확인: " + ({ unknown: "확인 필요", yes: "확인함", no: "확인하지 않음" }[fields.externalNameChecked])];
  if (context.mode === "test") lines.unshift("가상 테스트 자료 · 실제 환자 정보가 아닙니다.");
  return { mode: context.mode, kind: "draft", draft: { text: lines.join("\n"), missingFields, ready: missingFields.length === 0 }, observedAt: context.observedAt };
}

export function visitOutputSize(value) { requireValue(encoder.encode(JSON.stringify(value)).length <= 65536, "visit_response_too_large"); return value; }
