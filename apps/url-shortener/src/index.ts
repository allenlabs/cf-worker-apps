// HTTP entrypoint — Hono on Cloudflare Workers.
//
// POST /api/shorten  { url, code? }         → { code, url }
// GET  /api/links/:code                     → { url, createdAt, clicks, ownerEmail? }
// GET  /:code                               → 302 to the long URL (no auth)
// GET  /                                    → tiny HTML form

import { Hono } from 'hono';
import { z } from 'zod';
import { ShortenError, incrementClicks, resolveImpl, shortenImpl } from './shorten';

interface Env {
  LINKS: KVNamespace;
  DEFAULT_CODE_LENGTH: string;
  ADMIN_EMAILS: string;
}

const app = new Hono<{ Bindings: Env }>();

const shortenSchema = z.object({
  url: z.string().min(1),
  code: z.string().optional(),
});

app.post('/api/shorten', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = shortenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const admins = c.env.ADMIN_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
  const ownerEmail = c.req.header('x-user-email')?.trim();
  if (admins.length > 0 && (!ownerEmail || !admins.includes(ownerEmail))) {
    return c.json({ error: 'Not authorised.' }, 403);
  }
  try {
    const out = await shortenImpl({
      kv: c.env.LINKS,
      url: parsed.data.url,
      ownerEmail,
      codeLength: Number(c.env.DEFAULT_CODE_LENGTH || '7'),
      customCode: parsed.data.code,
    });
    return c.json(out, 201);
  } catch (e) {
    if (e instanceof ShortenError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.get('/api/links/:code', async (c) => {
  const record = await resolveImpl(c.env.LINKS, c.req.param('code'));
  if (!record) return c.json({ error: 'not found' }, 404);
  return c.json(record);
});

app.get('/:code{[A-Za-z0-9_-]{3,32}}', async (c) => {
  const code = c.req.param('code');
  const record = await resolveImpl(c.env.LINKS, code);
  if (!record) return c.text('Short link not found', 404);
  c.executionCtx.waitUntil(incrementClicks(c.env.LINKS, code));
  return c.redirect(record.url, 302);
});

app.get('/', (c) =>
  c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>URL Shortener</title>
<style>body{font-family:system-ui;max-width:38rem;margin:3rem auto;padding:0 1rem;color:#1f3a47}
input,button{font-size:1rem;padding:.5rem;margin:.25rem 0;width:100%;box-sizing:border-box}
button{background:#2f6688;color:#fff;border:0;border-radius:4px;cursor:pointer}
button:hover{background:#28526e}.out{font-family:ui-monospace,Menlo,monospace;background:#f1f7fb;padding:.75rem;border-radius:4px;margin-top:1rem}</style>
<h1>URL Shortener</h1>
<form id=f>
  <input id=u name=url placeholder="https://example.com/long-url" required>
  <input id=c name=code placeholder="custom code (optional)">
  <button>Shorten</button>
</form>
<div id=o></div>
<script>
document.getElementById('f').onsubmit = async (e)=>{e.preventDefault();
  const url=document.getElementById('u').value;const code=document.getElementById('c').value||undefined;
  const r=await fetch('/api/shorten',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,code})});
  const j=await r.json();
  document.getElementById('o').innerHTML=r.ok?'<div class=out>'+location.origin+'/'+j.code+' &rarr; '+j.url+'</div>':'<div class=out style="background:#fde2cf">'+(j.error||'error')+'</div>';};
</script>
</head></html>`));

export default app;
