import { createRenderScheduler, mergeEventWindow, eventPage, healthSummary, emptyState, connectionExamples, MAX_RETAINED_EVENTS, DISPLAY_PAGE_SIZE } from './live-state.js';
const $ = id => document.getElementById(id);
const state = { events: new Map(), kind: '', live: true, socket: null, reconnect: null, revision: 0, query: null, cursor: null, complete: false, loading: false, queryAbort: null, scanned: { manifests: 0, segments: 0, compressedBytes: 0 }, selected: null, detail: null, showBatch: false, health: null, authenticated: false, healthTimer: null, healthLoading: false, healthCheckedAt: null, healthError: '', rowOffset: 0, evicted: 0, rejected: 0 };
const MAX_VISIBLE = MAX_RETAINED_EVENTS;
const renderScheduler = createRenderScheduler(() => render(), () => drawChart([...state.events.values()]));
const titles = { '': '모든 이벤트', logs: '로그', traces: '트레이스', metrics: '메트릭' };
const number = n => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3 }).format(n);
function time(ms) {
    const d = new Date(ms);
    return `${d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function shortTime(ms) {
    return new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function notice(message = '', error = false) {
    $('notice').hidden = !message;
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
}
async function api(path, options = {}) {
    const r = await fetch(path, { credentials: 'same-origin', ...options });
    let data;
    try {
        data = await r.json();
    }
    catch {
        throw new Error(`응답을 읽을 수 없습니다 (${r.status}).`);
    }
    if (!r.ok) {
        const e = new Error(data.error || `요청 실패 (${r.status})`);
        e.status = r.status;
        throw e;
    }
    return data;
}
function handleError(e) {
    if (e.name === 'AbortError')
        return;
    if (e.status === 401) {
        state.authenticated = false;
        stopHealthPolling();
        stopSocket();
        if (!$('loginDialog').open)
            $('loginDialog').showModal();
    }
    else
        notice(e.message, true);
}
function connection(text, on = false) {
    $('connectionText').textContent = text;
    $('connectionDot').classList.toggle('connected', on);
}
function stopSocket() {
    if (state.reconnect)
        clearTimeout(state.reconnect);
    state.reconnect = null;
    if (state.socket) {
        state.socket.onclose = null;
        state.socket.close();
        state.socket = null;
    }
    connection(state.live ? '연결 준비' : 'Live 일시정지');
}
function merge(events, live = false) {
    const result = mergeEventWindow(state.events, events, { live });
    state.evicted += result.evicted;
    state.rejected += result.rejected;
    queueRender();
}
function queueRender() {
    renderScheduler.schedule();
}
function filters() {
    return { kind: state.kind, service: $('serviceInput').value.trim(), q: $('searchInput').value.trim(), traceId: $('traceInput').value.trim().toLowerCase() };
}
async function connectLive(revision) {
    if (!state.live || $('rangeInput').value === 'custom') {
        connection('Live 일시정지');
        return;
    }
    const url = new URL('/api/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [k, v] of Object.entries(filters()))
        if (v)
            url.searchParams.set(k, v);
    await new Promise(resolve => {
        const ws = new WebSocket(url);
        state.socket = ws;
        let opened = false;
        const fallback = setTimeout(resolve, 4000);
        ws.onopen = () => {
            opened = true;
            clearTimeout(fallback);
            if (revision !== state.revision) {
                ws.close();
                resolve();
                return;
            }
            connection('Live 연결됨', true);
            resolve();
        };
        ws.onmessage = event => {
            if (revision !== state.revision)
                return;
            if (event.data === 'pong')
                return;
            let message;
            try {
                message = JSON.parse(event.data);
            }
            catch {
                return;
            }
            if (message.type === 'events')
                merge(message.events || [], true);
            if (message.type === 'persisted') {
                for (const e of state.events.values())
                    if (e.seq <= message.throughSeq)
                        e.storage = 'r2';
                queueRender();
            }
            if (message.type === 'hello') {
                state.health = { ...state.health, ...message.health };
                state.healthCheckedAt = Date.now();
                state.healthError = '';
                updateHealth();
            }
        };
        ws.onerror = () => {
            connection('Live 연결 확인 필요');
            resolve();
        };
        ws.onclose = event => {
            clearTimeout(fallback);
            resolve();
            if (revision !== state.revision || !state.live)
                return;
            connection('재연결 중');
            if (event.code === 4001) {
                handleError({ status: 401 });
                return;
            }
            notice(opened ? 'Live 연결이 끊겼습니다. 연결을 복구하면서 이력을 다시 조회합니다.' : 'Live 연결을 확인 중입니다. 저장된 데이터는 조회할 수 있습니다.');
            state.reconnect = setTimeout(() => search(), 5000);
        };
    });
}
function selectedRange() {
    const end = Date.now();
    if ($('rangeInput').value === 'custom') {
        const from = new Date($('fromInput').value).getTime(), to = new Date($('toInput').value).getTime();
        if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
            throw new Error('올바른 시작·종료 시간을 지정하세요.');
        return { from, to };
    }
    return { from: end - Number($('rangeInput').value), to: end };
}
async function search() {
    const revision = ++state.revision;
    state.queryAbort?.abort();
    state.queryAbort = null;
    state.loading = false;
    stopSocket();
    notice();
    state.events.clear();
    renderScheduler.cancel();
    state.rowOffset = 0;
    state.evicted = state.rejected = 0;
    state.cursor = null;
    state.complete = false;
    state.scanned = { manifests: 0, segments: 0, compressedBytes: 0 };
    try {
        state.query = { ...selectedRange(), ...filters(), limit: 200 };
        render();
        queueRender();
        await connectLive(revision);
        if (revision !== state.revision)
            return;
        await loadPage(revision);
        await refreshHealth();
    }
    catch (e) {
        handleError(e);
    }
}
async function loadPage(revision = state.revision) {
    if (state.loading || !state.query)
        return;
    const controller = new AbortController();
    state.queryAbort = controller;
    state.loading = true;
    $('searchButton').disabled = true;
    $('loadMore').disabled = true;
    render();
    try {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(state.query))
            if (v !== undefined && v !== '')
                params.set(k, String(v));
        if (state.cursor)
            params.set('cursor', state.cursor);
        const page = await api('/api/events?' + params, { signal: controller.signal });
        if (revision !== state.revision)
            return;
        const previouslyRejected = state.rejected;
        merge(page.events);
        // A concurrent Live burst can fill the window while this history page is loading.
        // Keep its previous cursor rather than skipping records that did not fit.
        if (state.rejected === previouslyRejected) {
            state.cursor = page.nextCursor;
            state.complete = page.complete;
        }
        else state.complete = false;
        for (const k of ['manifests', 'segments', 'compressedBytes'])
            state.scanned[k] += page.scanned[k] || 0;
        render();
    }
    catch (e) {
        if (revision === state.revision)
            handleError(e);
    }
    finally {
        if (revision === state.revision) {
            state.loading = false;
            state.queryAbort = null;
            $('searchButton').disabled = false;
            $('loadMore').disabled = false;
            render();
        }
    }
}
function stopHealthPolling() {
    if (state.healthTimer !== null) clearInterval(state.healthTimer);
    state.healthTimer = null;
}
function startHealthPolling() {
    stopHealthPolling();
    state.healthTimer = setInterval(refreshHealth, 15000);
}
async function refreshHealth() {
    if (!state.authenticated || document.hidden || state.healthLoading) return;
    state.healthLoading = true;
    try {
        const health = await api('/api/health');
        if (!state.authenticated) return;
        state.health = health;
        state.healthCheckedAt = Date.now();
        state.healthError = '';
        updateHealth();
        render();
    }
    catch (error) {
        state.healthError = '운영 상태를 갱신하지 못했습니다. 마지막 확인 값을 표시합니다.';
        updateHealth();
        handleError(error);
    }
    finally {
        state.healthLoading = false;
    }
}
function ago(milliseconds) {
    if (milliseconds === null) return '기록 없음';
    if (milliseconds < 1000) return '방금';
    if (milliseconds < 60000) return `${Math.floor(milliseconds / 1000)}초 전`;
    if (milliseconds < 3600000) return `${Math.floor(milliseconds / 60000)}분 전`;
    if (milliseconds < 86400000) return `${Math.floor(milliseconds / 3600000)}시간 전`;
    return `${Math.floor(milliseconds / 86400000)}일 전`;
}
function mib(bytes = 0) {
    return `${number(bytes / 1024 / 1024)} MiB`;
}
function updateHealth() {
    if (!state.health)
        return;
    const health = state.health, summary = healthSummary(health);
    $('flushLabel').textContent = `R2 기본 쓰기 간격 ${number(health.r2FlushMs / 1000)}초`;
    $('demoBadge').hidden = !health.demo;
    $('healthChecked').textContent = state.healthCheckedAt ? `마지막 확인 ${time(state.healthCheckedAt)} · 활성 화면에서 15초마다 갱신` : '운영 상태 확인 중';
    $('lastReceived').textContent = summary.lastReceivedAt === null ? '수신 기록 없음' : new Date(summary.lastReceivedAt).toLocaleString('ko-KR');
    $('bufferUsage').textContent = `${number(health.pendingBatches || 0)} / ${number(health.maxPendingBatches || 256)} 배치 · ${mib(health.pendingBytes)}${health.maxPendingBytes ? ` / ${mib(health.maxPendingBytes)}` : ''}`;
    $('bufferPressure').value = Math.min(100, (summary.utilization || 0) * 100);
    $('bufferPressure').setAttribute('aria-label', `버퍼 사용률 ${number((summary.utilization || 0) * 100)}%`);
    $('oldestPending').textContent = summary.oldestPendingAgeMs === null ? '대기 중인 배치 없음' : `가장 오래된 대기 배치: ${ago(summary.oldestPendingAgeMs)} 수락`;
    $('lastArchived').textContent = summary.lastArchivedAgeMs === null ? '아직 보관 완료 기록 없음' : `${ago(summary.lastArchivedAgeMs)} 보관 완료`;
    $('lastArchived').title = health.lastArchivedAt ? new Date(health.lastArchivedAt).toLocaleString('ko-KR') : '';
    $('archiveStatus').textContent = summary.archiveState === 'error' ? 'R2 쓰기 재시도 중' : summary.archiveState === 'pending' ? '영속 버퍼에서 R2 보관 대기' : '보관 대기 없음';
    $('archiveStatus').classList.toggle('operation-error', summary.archiveState === 'error');
    $('healthWarning').hidden = !health.lastError && !state.healthError;
    $('healthWarning').textContent = health.lastError ? `R2 쓰기 실패 · 수락한 데이터는 영속 버퍼에 남아 있습니다. 연속 실패 ${number(health.failureCount || 0)}회${health.nextRetryAt ? ` · 다음 재시도 ${time(health.nextRetryAt)}` : ''}.` : state.healthError;
    $('sourceEmpty').hidden = summary.sources.length > 0;
    const fragment = document.createDocumentFragment();
    for (const source of summary.sources) {
        const row = document.createElement('tr');
        cell(row, source.sourceId, 'source-name');
        const received = cell(row, source.status === 'never' ? '아직 수신 없음' : ago(source.ageMs));
        received.title = source.lastReceivedAt ? new Date(source.lastReceivedAt).toLocaleString('ko-KR') : '이 소스에서 수락한 배치가 없습니다';
        cell(row, number(source.acceptedEvents || 0));
        cell(row, `${number(source.acceptedBatches || 0)} · ${mib(source.acceptedBytes)}`);
        fragment.append(row);
    }
    $('sourceRows').replaceChildren(fragment);
}
function cell(row, text, cls = '') {
    const td = document.createElement('td');
    td.textContent = text;
    td.className = cls;
    row.append(td);
    return td;
}
function traceFilter(trace) {
    $('traceInput').value = trace;
    search();
}
function render() {
    const events = [...state.events.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.seq - a.seq || b.index - a.index);
    const page = eventPage(state.events, state.rowOffset);
    state.rowOffset = page.offset;
    const errors = events.filter(e => ['ERROR', 'FATAL'].includes(e.severity)).length;
    const services = [...new Set(events.map(e => e.service))].sort();
    $('statEvents').textContent = number(events.length);
    $('statErrors').textContent = number(errors);
    $('statServices').textContent = number(services.length);
    $('statBuffered').textContent = number(events.filter(e => e.storage === 'buffer').length);
    $('statErrorRate').textContent = `로딩한 결과 중 ${events.length ? (errors / events.length * 100).toFixed(1) : 0}%`;
    $('navCount').textContent = number(events.length);
    $('resultCount').textContent = number(events.length);
    $('tableTitle').textContent = titles[state.kind];
    $('services').replaceChildren(...services.map(s => {
        const o = document.createElement('option');
        o.value = s;
        return o;
    }));
    const fragment = document.createDocumentFragment();
    for (const e of page.events) {
        const tr = document.createElement('tr');
        const t = cell(tr, time(e.receivedAt), 'time');
        const date = document.createElement('span');
        date.className = 'date';
        date.textContent = new Date(e.receivedAt).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
        t.append(date);
        const type = cell(tr, '');
        const tag = document.createElement('span');
        tag.className = 'tag ' + (e.kind === 'logs' ? String(e.severity).toLowerCase() : e.kind);
        tag.textContent = e.kind === 'logs' ? e.severity : e.kind.toUpperCase();
        type.append(tag);
        const sub = document.createElement('span');
        sub.className = 'sub-tag';
        sub.textContent = e.kind === 'metrics' ? e.metricType || 'point' : e.kind === 'traces' ? 'span' : 'log record';
        type.append(sub);
        const service = cell(tr, '');
        const name = document.createElement('span');
        name.className = 'service-name';
        name.textContent = e.service;
        name.title = e.service;
        service.append(name);
        if (e.sourceId) {
            const source = document.createElement('span');
            source.className = 'sub-tag';
            source.textContent = e.sourceId;
            service.append(source);
        }
        const message = cell(tr, '');
        const open = document.createElement('button');
        open.className = 'event-button';
        open.textContent = e.message || '(내용 없음)';
        open.title = e.message;
        open.addEventListener('click', () => showDetail(e));
        message.append(open);
        if (e.traceId) {
            const trace = document.createElement('button');
            trace.className = 'trace-link';
            trace.textContent = `trace ${e.traceId.slice(0, 20)}…`;
            trace.title = e.traceId;
            trace.addEventListener('click', () => traceFilter(e.traceId));
            message.append(trace);
        }
        const value = e.kind === 'traces' ? `${number(e.durationMs || 0)} ms` : e.kind === 'metrics' ? `${e.value ?? '—'} ${e.unit || ''}` : '—';
        cell(tr, value, 'number-value');
        cell(tr, e.storage === 'r2' ? 'R2' : 'buffer', e.storage === 'r2' ? 'storage-r2' : 'storage-buffer');
        fragment.append(tr);
    }
    $('eventRows').replaceChildren(fragment);
    $('emptyState').hidden = events.length > 0;
    const empty = emptyState({ loading: state.loading, complete: state.complete, hasCursor: Boolean(state.cursor), lastReceivedAt: healthSummary(state.health || {}).lastReceivedAt, hasFilters: Boolean(state.kind || state.query?.q || state.query?.service || state.query?.traceId) });
    $('emptyTitle').textContent = empty.title;
    $('emptyMessage').textContent = empty.message;
    $('emptyConnect').hidden = !empty.connect;
    $('loadMore').hidden = !state.cursor || events.length >= MAX_VISIBLE;
    $('pageStatus').textContent = events.length >= MAX_VISIBLE || state.rejected ? '화면 보관 한도에 도달했습니다. 과거 이력은 시간 범위를 나눠 조회하거나 저장소의 export 명령을 사용하세요.' : !state.query ? '조회 대기' : state.complete ? '요청한 수집 시간 범위 조회 완료' : state.cursor ? '일부 결과입니다. 다음 페이지에 더 많은 데이터가 있을 수 있습니다.' : '조회를 진행하고 있습니다.';
    $('rowWindow').textContent = page.total ? `${number(page.offset + 1)}–${number(page.offset + page.events.length)} / 화면에 보관한 ${number(page.total)}개` : '표시할 행 없음';
    $('previousRows').disabled = !page.hasPrevious;
    $('nextRows').disabled = !page.hasNext;
    $('latestRows').hidden = !page.hasPrevious;
    $('windowNotice').hidden = !state.evicted && !state.rejected;
    $('windowNotice').textContent = state.evicted ? `Live 화면은 최신 ${number(MAX_VISIBLE)}개를 유지합니다. 화면에서 제외된 항목 ${number(state.evicted)}개 · 서버에 저장된 데이터는 삭제되지 않았습니다. 현재 결과 JSON에는 화면에 보관한 항목만 포함됩니다.` : `화면 한도로 ${number(state.rejected)}개를 추가하지 못했습니다. 현재 결과는 전체 이력이 아닙니다. 조회 기간을 나누거나 export 명령으로 보관 데이터를 조회하세요.`;
    const mb = (state.scanned.compressedBytes / 1024 / 1024).toFixed(2);
    $('queryCost').textContent = `이번 조회: 인덱스 ${state.scanned.manifests} · 파일 ${state.scanned.segments} · 압축 ${mb} MiB · SQL scan 0`;
}
const ns = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs))
        e.setAttribute(k, String(v));
    return e;
}
function drawChart(events) {
    const target = $('activityChart');
    target.replaceChildren();
    for (const y of [20, 60, 100])
        target.append(svg('line', { x1: 0, y1: y, x2: 1000, y2: y, class: 'chart-grid' }));
    const from = state.query?.from ?? Date.now() - 3600000, to = state.live && $('rangeInput').value !== 'custom' ? Date.now() : state.query?.to ?? Date.now(), width = Math.max(1, to - from);
    $('axisFrom').textContent = shortTime(from);
    $('axisTo').textContent = shortTime(to);
    $('metricSelect').hidden = state.kind !== 'metrics';
    if (state.kind === 'metrics') {
        $('chartTitle').textContent = '메트릭 포인트';
        $('chartCaption').textContent = '로딩한 gauge / sum 원시값 · rate로 변환하지 않음';
        $('chartLegend').textContent = 'Values';
        const eligible = events.filter(e => ['gauge', 'sum'].includes(e.metricType));
        const names = [...new Set(eligible.map(e => `${e.service} / ${e.metricName}`))].sort();
        const current = $('metricSelect').value;
        $('metricSelect').replaceChildren(...names.map(n => {
            const o = document.createElement('option');
            o.value = n;
            o.textContent = n;
            return o;
        }));
        if (names.includes(current))
            $('metricSelect').value = current;
        const pts = eligible.filter(e => `${e.service} / ${e.metricName}` === $('metricSelect').value).map(e => ({ e, v: Number(e.value) })).filter(p => Number.isFinite(p.v) && !(typeof p.e.value === 'string' && /^[-+]?\d+$/.test(p.e.value) && !Number.isSafeInteger(p.v)));
        const lo = Math.min(0, ...pts.map(p => p.v)), hi = Math.max(1, ...pts.map(p => p.v));
        for (const { e, v } of pts) {
            const circle = svg('circle', { cx: Math.max(0, Math.min(1000, (e.receivedAt - from) / width * 1000)), cy: 105 - (v - lo) / (hi - lo) * 90, r: 3, class: 'metric-point' });
            const title = svg('title');
            title.textContent = `${time(e.receivedAt)} · ${e.value} ${e.unit || ''}`;
            circle.append(title);
            target.append(circle);
        }
        $('chartNote').textContent = '속성이 다른 시계열의 포인트가 함께 포함될 수 있습니다.';
    }
    else if (state.kind === 'traces' && state.query?.traceId) {
        $('chartTitle').textContent = 'Trace waterfall';
        $('chartCaption').textContent = '현재 로딩된 span만 표시 · 최대 12개';
        $('chartLegend').textContent = 'Span duration';
        const spans = events.filter(e => e.kind === 'traces').sort((a, b) => a.timestamp - b.timestamp).slice(0, 12);
        const start = Math.min(...spans.map(e => e.timestamp)), end = Math.max(...spans.map(e => e.timestamp + (e.durationMs || 0)));
        const spanWidth = Math.max(1, end - start);
        spans.forEach((e, i) => {
            const rect = svg('rect', { x: (e.timestamp - start) / spanWidth * 1000, y: i * 9, width: Math.max(2, (e.durationMs || 0) / spanWidth * 1000), height: 6, rx: 2, class: 'trace-bar' });
            const title = svg('title');
            title.textContent = `${e.message} · ${e.durationMs} ms`;
            rect.append(title);
            target.append(rect);
        });
        $('chartNote').textContent = '완료된 span의 시작 시간과 duration 기준';
    }
    else {
        $('chartTitle').textContent = '이벤트 분포';
        $('chartCaption').textContent = '로딩한 결과 기준 · 전체 기간의 총계가 아닙니다';
        $('chartLegend').textContent = 'Events';
        $('chartNote').textContent = '미리 집계하지 않고, 현재 결과만 표시';
        const bins = Array.from({ length: 70 }, () => 0);
        for (const e of events) {
            const i = Math.max(0, Math.min(69, Math.floor((e.receivedAt - from) / width * 70)));
            bins[i]++;
        }
        const max = Math.max(1, ...bins);
        bins.forEach((n, i) => {
            const h = n ? Math.max(3, n / max * 90) : 1;
            const rect = svg('rect', { x: i * 1000 / 70 + 2, y: 108 - h, width: 1000 / 70 - 4, height: h, rx: 2, class: 'volume-bar' + (i > 59 ? ' recent' : '') });
            const title = svg('title');
            title.textContent = `${n} events`;
            rect.append(title);
            target.append(rect);
        });
    }
}
function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function showDetail(event) {
    state.selected = event;
    state.detail = null;
    state.showBatch = false;
    $('detailTitle').textContent = event.message.slice(0, 110) || '저장된 이벤트';
    $('detailMeta').textContent = `${event.service} · ${event.kind} · 수집 ${new Date(event.receivedAt).toLocaleString('ko-KR')} · 발생 ${new Date(event.timestamp).toLocaleString('ko-KR')}`;
    $('rawContent').textContent = '저장된 이벤트를 읽고 있습니다…';
    $('traceButton').hidden = !event.traceId;
    if (!$('detailDialog').open)
        $('detailDialog').showModal();
    try {
        const data = await api('/api/event?' + new URLSearchParams({ id: event.id, seq: event.seq, receivedAt: event.receivedAt }));
        if (state.selected?.id !== event.id)
            return;
        state.detail = data;
        renderDetail();
    }
    catch (e) {
        $('rawContent').textContent = e.message;
    }
}
function renderDetail() {
    if (!state.detail)
        return;
    $('rawContent').textContent = JSON.stringify(state.showBatch ? state.detail.batch : state.detail.event.raw, null, 2);
    $('rawToggle').textContent = state.showBatch ? '선택한 이벤트만 보기' : '저장된 배치 전체 보기';
    $('detailExplanation').textContent = state.showBatch ? '서버에 실제로 저장된 배치입니다. 수집 시 적용한 필터링 결과가 반영됩니다. 새 Protobuf 수집은 원본 wire 바이트를 제외한 해독 결과를 보관합니다.' : '선택한 이벤트의 저장 데이터를 표시합니다. 수집 시 필터링·가림 처리한 내용이 반영되며, 다른 이벤트와 공유하는 resource/scope도 포함합니다.';
}
$('searchForm').addEventListener('submit', e => {
    e.preventDefault();
    search();
});
for (const button of document.querySelectorAll('[data-kind]'))
    button.addEventListener('click', () => {
        state.kind = button.dataset.kind;
        for (const b of document.querySelectorAll('[data-kind]'))
            b.classList.toggle('active', b === button);
        search();
    });
$('rangeInput').addEventListener('change', () => {
    $('customRange').hidden = $('rangeInput').value !== 'custom';
    if ($('rangeInput').value === 'custom') {
        const local = ms => {
            const d = new Date(ms);
            return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        };
        $('fromInput').value = local(Date.now() - 3600000);
        $('toInput').value = local(Date.now());
    }
    else
        search();
});
$('loadMore').addEventListener('click', () => loadPage());
$('liveButton').addEventListener('click', () => {
    state.live = !state.live;
    $('liveButton').setAttribute('aria-pressed', String(state.live));
    $('liveButtonText').textContent = state.live ? 'Live 켜짐' : 'Live 꺼짐';
    if (state.live)
        search();
    else
        stopSocket();
});
$('exportButton').addEventListener('click', () => download(`cf-observe-loaded-${Date.now()}.json`, { query: state.query, complete: state.complete && !state.evicted && !state.rejected, windowEvicted: state.evicted, windowRejected: state.rejected, note: 'Retained previews only, including live additions after the query end. Inspect an event to download its stored data, with the ingestion filtering policy applied. This is not a full archive export.', events: [...state.events.values()] }));
$('previousRows').addEventListener('click', () => { state.rowOffset -= DISPLAY_PAGE_SIZE; render(); });
$('nextRows').addEventListener('click', () => { state.rowOffset += DISPLAY_PAGE_SIZE; render(); });
$('latestRows').addEventListener('click', () => { state.rowOffset = 0; render(); });
$('emptyConnect').addEventListener('click', () => {
    $('onboarding').open = true;
    $('onboarding').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('onboardingSummary').focus();
});
$('metricSelect').addEventListener('change', () => drawChart([...state.events.values()]));
$('closeDetail').addEventListener('click', () => $('detailDialog').close());
$('rawToggle').addEventListener('click', () => {
    state.showBatch = !state.showBatch;
    renderDetail();
});
$('downloadRaw').addEventListener('click', () => {
    if (state.detail)
        download(`cf-observe-raw-${state.selected.id}.json`, state.showBatch ? state.detail.batch : state.detail.event.raw);
});
$('traceButton').addEventListener('click', () => {
    const id = state.selected.traceId;
    $('detailDialog').close();
    traceFilter(id);
});
$('loginDialog').addEventListener('cancel', e => e.preventDefault());
$('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
        await api('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: $('viewerToken').value }) });
        $('viewerToken').value = '';
        $('loginDialog').close();
        state.authenticated = true;
        startHealthPolling();
        search();
    }
    catch (error) {
        $('loginError').textContent = error.message;
    }
});
$('logoutButton').addEventListener('click', async () => {
    ++state.revision;
    state.queryAbort?.abort();
    state.loading = false;
    state.authenticated = false;
    stopHealthPolling();
    renderScheduler.cancel();
    stopSocket();
    state.live = false;
    $('liveButton').setAttribute('aria-pressed', 'false');
    $('liveButtonText').textContent = 'Live 꺼짐';
    state.events.clear();
    state.health = null;
    state.detail = null;
    state.selected = null;
    state.evicted = state.rejected = state.rowOffset = 0;
    $('sourceRows').replaceChildren();
    render();
    await api('/api/session', { method: 'DELETE' });
    $('loginDialog').showModal();
});
const examples = connectionExamples(location.origin);
for (const id of ['curl', 'otlp', 'workers', 'publish', 'tail'])
    $(`${id}Example`).textContent = examples[id];
for (const node of document.querySelectorAll('[data-endpoint]'))
    node.textContent = new URL(node.dataset.endpoint, location.origin).href;
for (const button of document.querySelectorAll('[data-copy]'))
    button.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText($(button.dataset.copy).textContent);
            $('copyStatus').textContent = '복사했습니다. <SOURCE_INGEST_TOKEN>을 실제 소스 전용 토큰으로 설정하세요.';
        }
        catch {
            $('copyStatus').textContent = '클립보드에 접근하지 못했습니다. 아래 코드를 선택해 직접 복사하세요.';
        }
    });
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshHealth();
});
window.addEventListener('beforeunload', () => { stopSocket(); stopHealthPolling(); renderScheduler.cancel(); });
try {
    state.health = await api('/api/health');
    state.authenticated = true;
    state.healthCheckedAt = Date.now();
    startHealthPolling();
    updateHealth();
    await search();
}
catch (e) {
    handleError(e);
}
