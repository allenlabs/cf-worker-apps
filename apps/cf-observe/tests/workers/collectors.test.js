import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, test } from 'vitest';
import tailWorker from '../../src/collectors/tail.js';

test('Tail sends sanitized records through a real Worker service binding into the durable journal', async () => {
  const id = crypto.randomUUID();
  const ctx = createExecutionContext();
  tailWorker.tail([{
    scriptName: 'runtime-tail-producer', eventTimestamp: Date.now(), outcome: 'ok',
    event: { request: { method: 'GET', url: 'https://example.com/work?token=must-not-be-saved', headers: { authorization: 'must-not-be-saved' } }, response: { status: 200 } },
    logs: [{ timestamp: Date.now(), level: 'info', message: [`tail-runtime-${id}`, { password: 'must-not-be-saved', result: 'visible' }] }],
    exceptions: [],
  }], { OBSERVE: exports.default, INGEST_TOKEN: env.INGEST_TOKEN }, ctx);
  await waitOnExecutionContext(ctx);
  const response = await exports.default.fetch('https://observe.test/api/events?' + new URLSearchParams({
    from: String(Date.now() - 60000), to: String(Date.now() + 60000), q: id,
  }), { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.events).toHaveLength(1);
  expect(page.events[0].service).toBe('runtime-tail-producer');
  expect(page.events[0].message).toContain('visible');
  expect(JSON.stringify(page)).not.toContain('must-not-be-saved');
  const detail = await exports.default.fetch('https://observe.test/api/event?' + new URLSearchParams({
    id: page.events[0].id, seq: String(page.events[0].seq), receivedAt: String(page.events[0].receivedAt),
  }), { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } });
  expect(detail.status).toBe(200);
  expect(JSON.stringify(await detail.json())).not.toContain('must-not-be-saved');
});
