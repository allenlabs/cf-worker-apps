import { startIntent } from "./command-settings.js";
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, max) => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b-\x1f]/.test(value);
const id = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const requireValue = (ok, code = "workflow_input_invalid") => { if (!ok) throw Error(code); };
export const workflowEditable = field => !field.source || field.source.startsWith("reservation.") || field.source === "intake.concernText";
export const workflowPath = "references/workflow.json";
export const workflowSources = Object.freeze(["patient.label", "patient.reference", "visit.date", "visit.status", "reservation.at", "reservation.type", "reservation.status", "reservation.procedureText", "reservation.note", "reservation.pod", "intake.concernText"]);
export const workflowHash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export function workflowDefinition(value) {
  requireValue(keys(value, ["schemaVersion", "title", "source", "fields", "template", "confirmations"]) && value.schemaVersion === 1 && text(value.title, 200) && value.title.trim() && ["none", "visit-context"].includes(value.source) && Array.isArray(value.fields) && value.fields.length <= 20 && Array.isArray(value.confirmations) && value.confirmations.length <= 10 && text(value.template, 4000) && value.template.trim() && encoder.encode(JSON.stringify(value)).length <= 32768 && !/(?:https?:\/\/|javascript:|<\/?script\b)/i.test(JSON.stringify(value)), "workflow_definition_invalid");
  const fieldIds = new Set();
  const fields = value.fields.map(field => {
    requireValue(keys(field, ["id", "label", "type", "required", "maxLength", "choices", "source"]) && id(field.id) && !fieldIds.has(field.id) && text(field.label, 200) && field.label.trim() && ["text", "choice"].includes(field.type) && typeof field.required === "boolean" && Number.isInteger(field.maxLength) && field.maxLength >= 1 && field.maxLength <= 1000, "workflow_definition_invalid");
    requireValue(field.source === undefined || value.source === "visit-context" && workflowSources.includes(field.source), "workflow_definition_invalid");
    requireValue(field.type === "text" ? field.choices === undefined : Array.isArray(field.choices) && field.choices.length > 0 && field.choices.length <= 20 && new Set(field.choices).size === field.choices.length && field.choices.every(choice => text(choice, field.maxLength) && choice.trim().length > 0), "workflow_definition_invalid");
    fieldIds.add(field.id); return { ...field };
  });
  const placeholders = [...value.template.matchAll(/{{([a-z][a-z0-9_]{0,63})}}/g)];
  requireValue(placeholders.every(match => fieldIds.has(match[1])) && !value.template.replace(/{{([a-z][a-z0-9_]{0,63})}}/g, "").match(/{{|}}/), "workflow_definition_invalid");
  const checks = new Set(); const confirmations = value.confirmations.map(check => { requireValue(keys(check, ["id", "label"]) && id(check.id) && !checks.has(check.id) && text(check.label, 300) && check.label.trim(), "workflow_definition_invalid"); checks.add(check.id); return { ...check }; });
  return { schemaVersion: 1, title: value.title, source: value.source, fields, template: value.template, confirmations };
}
export function workflowFromSkill(skill) {
  const resource = skill?.resources?.find(row => row.path === workflowPath);
  if (!resource) return null;
  requireValue(typeof resource.content === "string" && encoder.encode(resource.content).length <= 32768, "workflow_definition_invalid");
  let value; try { value = JSON.parse(resource.content); } catch { throw Error("workflow_definition_invalid"); }
  return workflowDefinition(value);
}
export function workflowInput(value) {
  requireValue(object(value) && ["catalog", "prefill", "prepare", "send", "status"].includes(value.action));
  if (value.action === "catalog") { requireValue(keys(value, ["action"])); return { action: value.action }; }
  if (value.action === "status") { requireValue(keys(value, ["action", "operationId", "draftToken"]) && uuid(value.operationId) && text(value.draftToken, 4096)); return { ...value }; }
  const common = ["action", "name", "revision", "selection"];
  requireValue(typeof value.name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name) && value.name.length <= 64 && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision));
  requireValue(value.selection === undefined || keys(value.selection, ["patientId", "visitId"]) && uuid(value.selection.patientId) && (value.selection.visitId === undefined || value.selection.visitId === null || uuid(value.selection.visitId)));
  if (value.selection !== undefined) value = { ...value, selection: { patientId: value.selection.patientId, visitId: value.selection.visitId ?? null } };
  if (value.action === "prefill") { requireValue(keys(value, common)); return { ...value }; }
  requireValue(keys(value, value.action === "send" ? [...common, "intent", "finalText", "values", "operationId", "draftToken", "confirmed", "confirmations"] : [...common, "intent", "finalText", "values"]) && object(value.values) && Object.keys(value.values).length <= 20 && Object.entries(value.values).every(([key, val]) => id(key) && text(val, 1000)) && encoder.encode(JSON.stringify(value.values)).length <= 16384);
  if (value.finalText !== undefined) workflowFinalText(value.finalText);
  if (value.intent !== undefined) { startIntent(value.intent); requireValue(value.intent.workflow === undefined); }
  if (value.action === "send") requireValue(uuid(value.operationId) && text(value.draftToken, 4096) && value.confirmed === true && Array.isArray(value.confirmations) && value.confirmations.length <= 10 && value.confirmations.every(id), "workflow_confirmation_required");
  return { ...value };
}
export function workflowSource(context) {
  const visit = context?.visits?.find(row => row.id === context.selectedVisitId);
  requireValue(context?.patient && (context.selectedVisitId === null || visit), "visit_selection_required");
  const reservation = !visit || visit.reservationId === null ? null : context.reservations.find(row => row.id === visit.reservationId);
  requireValue(!visit || visit.reservationId === null || reservation, "visit_response_invalid");
  return { patient: { id: context.patient.id, label: context.patient.label, reference: context.patient.reference }, visit: visit ? { id: visit.id, date: visit.date, status: visit.status, reservationId: visit.reservationId } : null, reservation: reservation ? { id: reservation.id, at: reservation.at, type: reservation.type, status: reservation.status, procedureText: reservation.procedureText ?? null, note: reservation.note ?? null, pod: reservation.pod ?? null } : null, intake: { concernText: context.intake?.concernText ?? null } };
}
export function workflowPrefill(definition, source = null) {
  return Object.fromEntries(definition.fields.map(field => { const [section, key] = field.source?.split(".") ?? []; const candidate = field.source ? source?.[section]?.[key] ?? "" : ""; return [field.id, typeof candidate === "string" && candidate.length <= field.maxLength && (field.type !== "choice" || field.choices.includes(candidate)) ? candidate : ""]; }));
}
export function workflowFinalText(value) {
  requireValue(text(value, 4000) && !/[\x7f-\x9f]/.test(value) && value.trim() && encoder.encode(value).length <= 16000, "workflow_final_text_invalid");
  return value;
}
export function workflowRender(definition, input, source = null, finalText) {
  requireValue(keys(input, definition.fields.map(field => field.id)) && Object.keys(input).length === definition.fields.length, "workflow_values_invalid");
  const derived = workflowPrefill(definition, source), values = {};
  for (const field of definition.fields) {
    const value = input[field.id]; requireValue(text(value, field.maxLength) && (!field.required || value.trim()) && (field.type !== "choice" || value === "" && !field.required || field.choices.includes(value)) && (workflowEditable(field) || value === derived[field.id]), "workflow_values_invalid"); values[field.id] = value;
  }
  const output = finalText === undefined ? definition.template.replace(/{{([a-z][a-z0-9_]{0,63})}}/g, (_, key) => values[key]) : workflowFinalText(finalText);
  requireValue(output.trim() && output.length <= 4000 && encoder.encode(output).length <= 16000, "workflow_output_too_large");
  return { values, text: output };
}
