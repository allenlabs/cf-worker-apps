/** Synthetic fixtures for the optional offline browser test; no Cloudflare access. */
import {demoBatch} from './demo-data.mjs';
import {normalize,preview} from '../src/protocol.js';
const batches=Array.from({length:420},(_,i)=>({...demoBatch(i),seq:i+1}));
const rows=batches.flatMap(b=>normalize(b).map(e=>({...preview(e),storage:'r2'})));
const details=Object.fromEntries(batches.flatMap(b=>normalize(b).map(e=>[e.id,{event:e,storage:'r2',batch:b}])));
console.log(JSON.stringify({rows,details}));
