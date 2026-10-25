import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeployment, generateConfigs, buildCommands } from '../scripts/config.mjs';
const fixture = () => ({ accountId:'a'.repeat(32),origin:'https://os.example.com',mcp:false,
  workers:{context:'os-context',workshop:'os-workshop',router:'os-router'},
  resources:{blueprintsKvNamespaceId:'1'.repeat(32),avatarsKvNamespaceId:'2'.repeat(32),contextKvNamespaceId:'3'.repeat(32),blueprintContentBucket:'os-blueprints'},
  auth:{mode:'access',issuer:'https://example.cloudflareaccess.com',audience:'example-audience',allowedEmails:['owner@example.com']},
  admins:['owner@example.com'],modelBridge:{service:'inference-example',model:'example',allowedUserIds:['owner@example.com']},
  agentMemory:{namespace:'personal-os-memory',capture:'all-conversations'} });
const bases = Object.fromEntries(['context','workshop','router'].map(name=>[name,{main:'src/index.ts',migrations:[{tag:'v1'}]}]));
test('native memory is wired to Workshop only, with explicit single-user opt-in',()=>{
  const config = parseDeployment(fixture());
  const generated = generateConfigs(config,bases);
  assert.deepEqual(generated.workshop.agent_memory,[{binding:'OS_AGENT_MEMORY',namespace:'personal-os-memory'}]);
  assert.equal(generated.workshop.vars.AUTO_MEMORY_OWNER,'owner@example.com');
  assert.equal(generated.workshop.vars.AUTO_MEMORY_NAMESPACE,'personal-os-memory');
  assert.equal(generated.router.agent_memory,undefined);
  assert.deepEqual(generated.workshop.migrations,bases.workshop.migrations);
});
test('frontend disclosure flag is derived from the same validated deployment opt-in',()=>{
  const enabled = buildCommands(fixture()).find(command=>command.args.includes('@gadgets/workshop-frontend'));
  assert.equal(enabled.env.VITE_NATIVE_AGENT_MEMORY,'true');
  const config = fixture(); delete config.agentMemory;
  const disabled = buildCommands(config).find(command=>command.args.includes('@gadgets/workshop-frontend'));
  assert.equal(disabled.env.VITE_NATIVE_AGENT_MEMORY,'false');
  assert.equal(generateConfigs(config,bases).workshop.agent_memory,undefined);
});
test('multi-user deployment cannot silently turn on single-user transcript capture',()=>{
  const config=fixture(); config.auth.allowedEmails.push('other@example.com');
  assert.throws(()=>parseDeployment(config),/exactly one/);
});
