# Offline UI fixture test: no page navigation or network API calls.
import json, re, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
evidence=Path(os.environ.get('UI_EVIDENCE_DIR', root/'ui-evidence'))
evidence.mkdir(parents=True,exist_ok=True)
fixture=json.loads(subprocess.check_output(['node',str(root/'scripts/ui-fixtures.mjs')],text=True))
html=(root/'public/index.html').read_text()
html=re.sub(r'<link[^>]+>|<script[^>]+></script>', '', html)
css=(root/'public/style.css').read_text()
app=(root/'public/app.js').read_text()
mock=r'''
const location={href:'https://local-demo.invalid/'};
window.fixture=FIXTURE;
window.calls=[]; window.delayNext=false;
window.fetch=async (path,options={})=>{
 const url=new URL(path,location.href);const p=url.searchParams;
 const json=(x,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}}));
 if(url.pathname==='/api/health')return json({demo:true,r2FlushMs:10000,pendingBatches:0,pendingEvents:0});
 if(url.pathname==='/api/session')return json({ok:true});
 if(url.pathname==='/api/event')return json(window.fixture.details[p.get('id')]);
 if(url.pathname==='/api/events'){
   window.calls.push(p.get('kind')||'all');
   if(window.delayNext){window.delayNext=false;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,350);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});}
   const rows=window.fixture.rows.filter(e=>(!p.get('kind')||e.kind===p.get('kind'))&&(!p.get('service')||e.service===p.get('service'))&&(!p.get('traceId')||e.traceId===p.get('traceId'))&&(!p.get('q')||e.message.toLowerCase().includes(p.get('q').toLowerCase()))).sort((a,b)=>b.seq-a.seq);
   const offset=Number(p.get('cursor')||0),end=offset+200;
   return json({events:rows.slice(offset,end),complete:end>=rows.length,nextCursor:end<rows.length?String(end):null,scanned:{manifests:2,segments:4,compressedBytes:21300}});
 }
 return json({error:'fixture route not found'},404);
};
window.WebSocket=class {constructor(){this.readyState=0;this.openTimer=setTimeout(()=>{this.readyState=1;this.onopen?.();},5);}close(){clearTimeout(this.openTimer);this.readyState=3;this.onclose?.({code:1000});}send(){}};
'''.replace('FIXTURE',json.dumps(fixture))
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1512,'height':1100},device_scale_factor=1)
 errors=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.set_content(html)
 page.add_style_tag(content=css)
 page.add_script_tag(type='module',content=mock+'\n'+app)
 page.wait_for_function("document.getElementById('resultCount').textContent==='200'")
 page.screenshot(path=str(evidence/'dashboard-desktop.png'),full_page=False)
 page.locator('.event-button').first.click()
 page.wait_for_function("document.getElementById('rawContent').textContent.includes('demo')")
 page.screenshot(path=str(evidence/'dashboard-inspector.png'),full_page=False)
 page.locator('#closeDetail').click()
 page.locator('[data-kind="metrics"]').click()
 page.wait_for_function("document.getElementById('chartTitle').textContent==='메트릭 포인트' && document.getElementById('resultCount').textContent==='84'")
 # Reproduce search-change while an earlier request is waiting.
 page.evaluate('window.delayNext=true')
 page.locator('[data-kind="logs"]').click()
 page.wait_for_function("window.calls.at(-1)==='logs'")
 page.locator('[data-kind="traces"]').click()
 page.wait_for_timeout(650)
 assert page.evaluate('window.calls.at(-1)')=='traces', 'New search was skipped while old request remained in flight'
 page.wait_for_function("document.getElementById('resultCount').textContent==='84'")
 page.locator('[data-kind=""]').click()
 page.wait_for_function("document.getElementById('resultCount').textContent==='200'")
 page.set_viewport_size({'width':390,'height':844})
 page.screenshot(path=str(evidence/'dashboard-mobile.png'),full_page=False)
 assert page.locator('[data-kind=""]').evaluate('(el)=>el.clientHeight')<50, 'Mobile navigation label unexpectedly wraps'
 assert not errors, errors
 print(json.dumps({'offline_fixture_checks':'PASS','console_errors':errors,'checks':['initial list','inspector','metric rendering','search race','mobile layout']},ensure_ascii=False))
 browser.close()
