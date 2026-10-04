export function demoBatch(index, now = Date.now()) {
    const services = ['api-gateway', 'checkout-worker', 'agent-runner', 'media-service'];
    const service = services[index % services.length];
    const receivedAt = now - (420 - index) * 5000;
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'deployment.environment.name', value: { stringValue: 'demo' } }] };
    const traceId = (Math.floor(index / 4) + 1).toString(16).padStart(32, '0'), spanId = (index + 1).toString(16).padStart(16, '0');
    const stamp = BigInt(receivedAt) * 1000000n;
    const base = { id: crypto.randomUUID(), receivedAt, encoding: 'json' };
    if (index % 5 === 1) {
        const duration = 5 + (index * 47) % 330;
        return { ...base, signal: 'traces', payload: { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'demo.tracing' }, spans: [{ traceId, spanId, parentSpanId: index % 4 ? (index).toString(16).padStart(16, '0') : '', name: ['GET /api/projects', 'POST /api/checkout', 'workflow.execute', 'R2.get'][index % 4], kind: 2, startTimeUnixNano: stamp.toString(), endTimeUnixNano: (stamp + BigInt(duration) * 1000000n).toString(), status: { code: index % 31 === 1 ? 2 : 1 }, attributes: [{ key: 'http.response.status_code', value: { intValue: index % 31 === 1 ? '500' : '200' } }] }] }] }] } };
    }
    if (index % 5 === 2)
        return { ...base, signal: 'metrics', payload: { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'demo.metrics' }, metrics: [{ name: 'worker.cpu.utilization', unit: '%', gauge: { dataPoints: [{ timeUnixNano: stamp.toString(), asDouble: Math.round((35 + Math.sin(index / 11) * 18 + index % 9) * 10) / 10, attributes: [{ key: 'region', value: { stringValue: 'demo-region' } }] }] } }] }] }] } };
    const failed = index % 19 === 0, warning = index % 23 === 0;
    const messages = ['Request completed successfully', 'Workflow step finished · generate-report', 'Cache hit for project configuration', 'Artifact uploaded to R2', 'Task run completed · 4 actions', 'Telemetry batch accepted', 'Customer-free synthetic demo event', 'Provider request completed'];
    return { ...base, signal: 'logs', payload: { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'demo.logger', version: '1.0' }, logRecords: [{ timeUnixNano: stamp.toString(), observedTimeUnixNano: stamp.toString(), severityNumber: failed ? 17 : warning ? 13 : 9, severityText: failed ? 'ERROR' : warning ? 'WARN' : 'INFO', body: { stringValue: failed ? 'Upstream request failed · retry scheduled' : warning ? 'Request duration exceeded demo threshold' : messages[index % messages.length] }, traceId, spanId, attributes: [{ key: 'demo.synthetic', value: { boolValue: true } }, { key: 'request.id', value: { stringValue: `demo-request-${index}` } }] }] }] }] } };
}
