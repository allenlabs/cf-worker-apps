// Browser-independent policies shared by the dashboard and its regression tests.
export const MAX_RETAINED_EVENTS = 10000;
export const DISPLAY_PAGE_SIZE = 500;
const newestFirst = (a, b) => b.receivedAt - a.receivedAt || b.seq - a.seq || b.index - a.index;

export function mergeEventWindow(events, incoming, { live = false, maximum = MAX_RETAINED_EVENTS } = {}) {
    let rejected = 0, evicted = 0;
    for (const event of incoming) {
        const prior = events.get(event.id);
        if (!live && !prior && events.size >= maximum) {
            rejected++;
            continue;
        }
        events.set(event.id, prior?.storage === 'r2' && event.storage === 'buffer' ? { ...event, storage: 'r2' } : event);
    }
    if (live && events.size > maximum) {
        const overflow = [...events.values()].sort(newestFirst).slice(maximum);
        for (const event of overflow) {
            events.delete(event.id);
            evicted++;
        }
    }
    return { rejected, evicted };
}

export function eventPage(events, offset = 0, pageSize = DISPLAY_PAGE_SIZE) {
    const sorted = [...events.values()].sort(newestFirst);
    offset = Math.max(0, Math.min(Math.floor(offset / pageSize) * pageSize, Math.max(0, Math.floor((sorted.length - 1) / pageSize) * pageSize)));
    return { events: sorted.slice(offset, offset + pageSize), total: sorted.length, offset, hasPrevious: offset > 0, hasNext: offset + pageSize < sorted.length };
}

export function createRenderScheduler(renderRows, renderChart, timers = globalThis) {
    let rowsTimer = null, chartTimer = null;
    return {
        schedule() {
            if (rowsTimer === null)
                rowsTimer = timers.setTimeout(() => { rowsTimer = null; renderRows(); }, 200);
            if (chartTimer === null)
                chartTimer = timers.setTimeout(() => { chartTimer = null; renderChart(); }, 1000);
        },
        cancel() {
            if (rowsTimer !== null) timers.clearTimeout(rowsTimer);
            if (chartTimer !== null) timers.clearTimeout(chartTimer);
            rowsTimer = chartTimer = null;
        },
    };
}

export function healthSummary(health = {}, now = Date.now()) {
    now = Number.isFinite(health.serverNow) ? health.serverNow : now;
    const age = value => Number.isFinite(value) ? Math.max(0, now - value) : null;
    const ratios = [
        [health.pendingBytes, health.maxPendingBytes],
        [health.pendingBatches, health.maxPendingBatches],
    ].filter(([used, maximum]) => Number.isFinite(used) && maximum > 0).map(([used, maximum]) => used / maximum);
    const sources = (health.sources || []).map(source => ({
        ...source,
        ageMs: age(source.lastReceivedAt),
        status: Number.isFinite(source.lastReceivedAt) ? 'received' : 'never',
    })).sort((a, b) => (b.lastReceivedAt ?? -1) - (a.lastReceivedAt ?? -1));
    const timestamps = sources.map(source => source.lastReceivedAt).filter(Number.isFinite);
    if (Number.isFinite(health.lastReceivedAt)) timestamps.push(health.lastReceivedAt);
    return {
        sources, lastReceivedAt: timestamps.length ? Math.max(...timestamps) : null,
        utilization: ratios.length ? Math.max(0, ...ratios) : null,
        oldestPendingAgeMs: age(health.oldestPendingAt),
        lastArchivedAgeMs: age(health.lastArchivedAt),
        archiveState: health.lastError ? 'error' : health.pendingBatches ? 'pending' : 'clear',
    };
}

export function emptyState({ loading = false, complete = false, hasCursor = false, lastReceivedAt = null, hasFilters = false } = {}) {
    if (loading || (!complete && !hasCursor))
        return { title: '저장된 이벤트를 조회하고 있습니다', message: '임시 영속 버퍼와 R2 보관 이력을 함께 확인합니다.', connect: false };
    if (hasCursor)
        return { title: '다음 페이지에 일치하는 이벤트가 있을 수 있습니다', message: '한 번의 조회에는 읽기 예산이 있습니다. 아래에서 다음 결과를 불러오세요.', connect: false };
    if (lastReceivedAt === null)
        return { title: '아직 수집 기록이 없습니다', message: '수집 연결 안내에서 Workers 또는 서버·컨테이너를 연결하세요. 첫 수신 후 이 화면에 표시됩니다.', connect: true };
    if (hasFilters)
        return { title: '현재 필터에 맞는 이벤트가 없습니다', message: '서비스 이름, 검색어, Trace ID 또는 수집 시간 범위를 변경하세요.', connect: false };
    return { title: '이 수집 시간 범위에는 이벤트가 없습니다', message: '조회 시간을 넓히거나 소스별 마지막 수신 시각을 확인하세요. 조용한 소스가 반드시 장애인 것은 아닙니다.', connect: false };
}

export function connectionExamples(origin) {
    const base = new URL(origin).origin;
    return {
        curl: `# Bash: 소스 전용 수집 토큰을 터미널에서 입력합니다.\nread -rsp "Ingest token: " CF_OBSERVE_INGEST_TOKEN; echo\ncurl --fail-with-body "${base}/api/ingest" \\\n  -H "Authorization: Bearer \${CF_OBSERVE_INGEST_TOKEN}" \\\n  -H "Content-Type: application/json" \\\n  --data '{"service":"my-worker","message":"collector.connected"}'\nunset CF_OBSERVE_INGEST_TOKEN`,
        otlp: `# 애플리케이션 SDK → 같은 호스트의 Collector\nOTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_SERVICE_NAME=my-service\n\n# Collector 프로세스 환경 (examples/otel-collector.yaml)\nOBSERVE_URL=${base}\nINGEST_TOKEN=<SOURCE_INGEST_TOKEN>\n\n# Collector 없이 SDK가 직접 보내는 경우의 목적지\n# OTEL_EXPORTER_OTLP_ENDPOINT=${base}\n# Authorization 헤더에 해당 소스의 Bearer 수집 토큰을 설정하세요.`,
        workers: `# producer Worker의 wrangler.toml에 추가\n[[services]]\nbinding = "OBSERVE"\nservice = "cf-observe"`,
        tail: `# producer Worker의 wrangler.toml 최상위에 추가\n# 기존 tail_consumers가 있으면 이 항목을 기존 배열에 병합\ntail_consumers = [{ service = "cf-observe-tail" }]`,
        publish: `// src/collectors/publisher.js의 publishEvents를 가져와 사용\n// exportId: export마다 고유하고, 재시도 중에는 동일한 ID\nawait publishEvents({\n  binding: env.OBSERVE,\n  token: env.OBSERVE_INGEST_TOKEN,\n  events: [{ service: 'my-worker', message: 'task.started' }],\n  idempotencyKey: exportId\n});`,
    };
}
