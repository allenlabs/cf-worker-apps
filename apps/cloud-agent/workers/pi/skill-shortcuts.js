import { selectedSkill } from "./command-settings.js";
import { workflows } from "./command-start.js";
import { commandAllowed } from "./source-history.js";
const requireValue = (ok, code) => { if (!ok) throw Error(code); };
const alias = text => text.replace(/\s+/gu, "").toLocaleLowerCase("ko");
export async function shortcutCatalog(owner, target) {
  commandAllowed(target, owner.env);
  requireValue(owner.ctx.id.toString() === owner.env.Credentials.idFromName("owner").toString(), "command_skill_actor_denied");
  return workflows(owner);
}
export async function resolveShortcut(owner, target, input) {
  requireValue(typeof input === "string" && input.trim().length > 0 && input.length <= 100 && !/[\x00-\x1f]/.test(input), "command_shortcut_invalid");
  const rows = (await shortcutCatalog(owner, target)).filter(row => row.name === input || alias(row.definition.title) === alias(input));
  requireValue(rows.length === 1, "command_shortcut_unavailable");
  return { name: rows[0].name, revision: rows[0].revision };
}
export async function suggestShortcuts(owner, target, query) {
  requireValue(typeof query === "string" && query.length <= 100 && !/[\x00-\x1f]/.test(query), "command_shortcut_invalid");
  return { choices: (await shortcutCatalog(owner, target)).filter(row => alias(row.name).includes(alias(query)) || alias(row.definition.title).includes(alias(query))).slice(0, 10).map(row => ({ name: row.definition.title, value: row.name })) };
}
export async function skillAskSnapshot(owner, target, selection) {
  commandAllowed(target, owner.env); selectedSkill(selection);
  requireValue(owner.ctx.id.toString() === owner.env.Credentials.idFromName("owner").toString(), "command_skill_actor_denied");
  return owner.ctx.storage.transaction(async transaction => {
    const row = (await transaction.get("skillCatalog") || []).find(row => row.name === selection.name && row.enabled && row.revision === selection.revision);
    const manifestVersion = await transaction.get("skillManifestVersion"), manifest = manifestVersion && await transaction.get("skillManifest:" + manifestVersion);
    requireValue(row && manifest?.skills.some(skill => skill.name === selection.name && skill.version === selection.revision), "workflow_skill_unavailable");
    return { manifestVersion, skillName: selection.name, skillRevision: selection.revision, skillAutomatic: true };
  });
}
