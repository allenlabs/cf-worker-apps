const preferred = [{ id: "gpt-6-luna", alias: "빠르게", label: "빠르게 (GPT-6 Luna)" }, { id: "gpt-6.1-sol", alias: "기본", label: "기본 (GPT-6.1 Sol)" }, { id: "gpt-6-astra", alias: "깊게", label: "깊게 (GPT-6 Astra)" }];
export const thinkingChoices = [["off", "끔"], ["minimal", "최소"], ["low", "낮음"], ["medium", "보통"], ["high", "높음"], ["xhigh", "매우높음"], ["max", "최대"]].map(([value, label]) => ({ value, label }));
export function configuredModels(env) {
  let ids; try { ids = env.ALLOWED_OPENAI_MODELS ? JSON.parse(env.ALLOWED_OPENAI_MODELS) : [env.OPENAI_MODEL]; } catch { throw Error("model_config_invalid"); }
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(id => typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length || !ids.includes(env.OPENAI_MODEL)) throw Error("model_config_invalid");
  return [...preferred.filter(item => ids.includes(item.id)), ...ids.filter(id => !preferred.some(item => item.id === id)).map(id => ({ id, label: id }))];
}

const requireValue = (ok, code) => { if (!ok) throw Error(code); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function startInput(value) {
  requireValue(keys(value, value?.action === "create" ? ["action", "operationId", "intent", "confirmed"] : value?.action === "status" ? ["action", "operationId"] : ["action"]) && ["options", "create", "status"].includes(value.action), "command_start_input_invalid");
  if (value.action !== "options") requireValue(uuid(value.operationId), "command_start_input_invalid");
  if (value.action === "create") {
    requireValue(value.confirmed === true && keys(value.intent, ["modelId", "thinkingLevel", "workflow"]) && typeof value.intent.modelId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.intent.modelId) && thinkingChoices.some(row => row.value === value.intent.thinkingLevel), "command_start_input_invalid");
    requireValue(value.intent.workflow === undefined || keys(value.intent.workflow, ["name", "revision"]) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.intent.workflow.name ?? "") && value.intent.workflow.name.length <= 64 && /^[a-f0-9]{64}$/.test(value.intent.workflow.revision ?? ""), "command_start_input_invalid");
  }
  return value;
}

export function selectedSkill(value) {
  requireValue(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 2 && Object.keys(value).every(key => ["name", "revision"].includes(key)) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name ?? "") && value.name.length <= 64 && /^[a-f0-9]{64}$/.test(value.revision ?? ""), "command_skill_invalid");
  return { name: value.name, revision: value.revision };
}
