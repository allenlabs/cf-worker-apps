import { readFile } from 'node:fs/promises';
const origin = process.env.OBSERVE_URL;
let viewer = process.env.VIEWER_TOKEN;
if (!viewer && process.env.OBSERVE_SECRETS_FILE)
    viewer = JSON.parse(await readFile(process.env.OBSERVE_SECRETS_FILE,'utf8')).VIEWER_TOKEN;
if (!origin || !viewer) throw new Error('Set OBSERVE_URL and VIEWER_TOKEN (or OBSERVE_SECRETS_FILE).');
const url = new URL('/api/archive/check',origin);
if(url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname))
    throw new Error('Remote archive inspection requires HTTPS');
if(process.argv[2]) {
    const hour = /^\d+$/.test(process.argv[2]) ? Number(process.argv[2]) : Date.parse(process.argv[2]);
    if(!Number.isSafeInteger(hour)) throw new Error('Pass an ISO UTC hour or Unix milliseconds.');
    url.searchParams.set('hour',String(hour));
}
const response = await fetch(url,{headers:{authorization:`Bearer ${viewer}`},signal:AbortSignal.timeout(30000)});
const result = await response.json();
if(!response.ok) throw new Error(`Archive inspection failed (${response.status}): ${result.error || 'request rejected'}`);
console.log(JSON.stringify(result,null,2));
if(['warning','incomplete'].includes(result.status)) process.exitCode=2;
