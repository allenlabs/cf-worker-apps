import { publishEvents } from './publish.mjs';
export default {
    async fetch(request, env) {
        const started = Date.now();
        // Replace with your actual operation. Never send tokens or patient/customer payloads.
        const result = { ok: true };
        await publishEvents({ binding: env.OBSERVE, token: env.OBSERVE_INGEST_TOKEN, events: [{
                    service: 'example-worker', severity: 'INFO', message: 'example operation completed',
                    timestamp: new Date().toISOString(), attributes: { duration_ms: Date.now() - started, method: request.method }
                }] });
        return Response.json(result);
    }
};
// Awaiting telemetry changes request latency/failure semantics. For noncritical logs,
// ctx.waitUntil(publishEvents(...)) is possible but is NOT a durable delivery guarantee.
// Critical audit events should have an application-owned durable outbox and retry policy.
