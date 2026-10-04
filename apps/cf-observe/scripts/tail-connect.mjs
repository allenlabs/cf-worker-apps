import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectTail } from './lib/tail-management.mjs';

const args=process.argv.slice(2);
const value=name=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
const apply=args.includes('--apply'), all=args.includes('--all-repo');
const selected=value('--workers')?.split(',');
if(!all && !selected) throw new Error('Use --all-repo or --workers=hub-web,inbox-api. Default is a read-only plan; add --apply to connect.');
const token=process.env.CLOUDFLARE_API_TOKEN, account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token || !/^[a-f0-9]{32}$/.test(account||'')) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the shell.');
const collector=value('--collector') || 'cf-observe-tail';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const files=execFileSync('git',['ls-files','--','apps/**/wrangler.toml'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const candidates=[];
for(const path of files) {
    const text=await readFile(resolve(root,path),'utf8');
    const name=text.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if(name && name!==collector && name!=='cf-observe') candidates.push({name,config:path});
}
async function api(path,options={}) {
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{
        method:options.method || 'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:options.body ? JSON.stringify(options.body) : undefined,signal:AbortSignal.timeout(30000),
    });
    const data=await response.json();
    if(!response.ok || !data.success) throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(data.errors?.map(e=>({code:e.code,message:e.message})))}`);
    return data.result;
}
const deployed=new Set((await api('/workers/scripts')).map(w=>w.id));
if(apply && !deployed.has(collector)) throw new Error('Deploy the Tail collector before attaching producers.');
const available=candidates.filter(c=>deployed.has(c.name));
if(selected?.some(n=>!available.some(c=>c.name===n))) throw new Error('Requested Worker is not both deployed and represented by a tracked repository config.');
const targets=available.filter(c=>all || selected.includes(c.name));
const report={createdAt:new Date().toISOString(),apply,collector,notDeployed:candidates.filter(c=>!deployed.has(c.name)),workers:[]};
const directory=resolve(root,'.cf-observe');
await mkdir(directory,{recursive:true});
const reportPath=resolve(directory,`tail-${apply?'apply':'plan'}-${Date.now()}.json`);
for(const target of targets) {
    const result=await connectTail(api,target.name,collector,apply);
    report.workers.push({...result,config:target.config});
    // Save each confirmed result so an interrupted run can be inspected safely.
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(`${target.name}: ${result.applied?'connected':result.changed?'would connect':'already connected'}`);
}
console.log(`Report: ${reportPath}; ${targets.length} deployed repository Workers. Non-deployed: ${report.notDeployed.length}.`);
