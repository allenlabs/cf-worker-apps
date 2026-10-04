import { afterEach, expect, test, vi } from 'vitest';
import { createRenderScheduler, mergeEventWindow, eventPage, healthSummary, emptyState, connectionExamples } from '../public/live-state.js';

const event = (seq, storage = 'buffer') => ({ id: `batch:${seq}`, seq, index: 0, receivedAt: seq * 1000, storage });
afterEach(() => vi.useRealTimers());

test('a full live window continues receiving the newest events and preserves archived state on replay', () => {
    const events = new Map([event(1), event(2), event(3, 'r2')].map(e => [e.id, e]));
    const result = mergeEventWindow(events, [event(3), event(4), event(5)], { live: true, maximum: 3 });
    expect(result).toEqual({ evicted: 2, rejected: 0 });
    expect(eventPage(events).events.map(e => e.seq)).toEqual([5, 4, 3]);
    expect(events.get('batch:3').storage).toBe('r2');
    expect(mergeEventWindow(events, [event(1)], { live: true, maximum: 3 })).toEqual({ evicted: 1, rejected: 0 });
    expect(eventPage(events).events.map(e => e.seq)).toEqual([5, 4, 3]);
});

test('historical pagination never replaces a previously loaded row at the window limit', () => {
    const events = new Map([event(4), event(5)].map(e => [e.id, e]));
    expect(mergeEventWindow(events, [event(3), event(2), event(1)], { maximum: 3 })).toEqual({ evicted: 0, rejected: 2 });
    expect(eventPage(events).events.map(e => e.seq)).toEqual([5, 4, 3]);
    expect(mergeEventWindow(events, [event(4, 'r2')], { maximum: 3 }).rejected).toBe(0);
    expect(events.get('batch:4').storage).toBe('r2');
});

test('display pages allow access to every retained row with a bounded DOM row count', () => {
    const events = new Map(Array.from({ length: 1200 }, (_, i) => [event(i).id, event(i)]));
    expect(eventPage(events).events).toHaveLength(500);
    const second = eventPage(events, 500);
    expect(second.events).toHaveLength(500);
    expect(second.events[0].seq).toBe(699);
    expect(second.hasPrevious).toBe(true);
    expect(second.hasNext).toBe(true);
    const last = eventPage(events, 1000);
    expect(last.events).toHaveLength(200);
    expect(last.hasNext).toBe(false);
    expect(eventPage(new Map(), 500).offset).toBe(0);
    expect(eventPage(events, 99999).offset).toBe(1000);
});

test('burst rendering delivers rows at 200ms without delaying the independent 1s chart update', () => {
    vi.useFakeTimers();
    const rows = vi.fn(), chart = vi.fn();
    const scheduler = createRenderScheduler(rows, chart);
    scheduler.schedule();
    vi.advanceTimersByTime(199);
    scheduler.schedule();
    expect(rows).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rows).toHaveBeenCalledTimes(1);
    expect(chart).not.toHaveBeenCalled();
    scheduler.schedule();
    vi.advanceTimersByTime(800);
    expect(rows).toHaveBeenCalledTimes(2);
    expect(chart).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(1000);
    expect(rows).toHaveBeenCalledTimes(2);
    expect(chart).toHaveBeenCalledTimes(1);
});

test('source silence stays a last-seen fact while archive errors and backlog pressure are explicit', () => {
    const health = healthSummary({
        serverNow: 100000, pendingBytes: 400, maxPendingBytes: 1000,
        pendingBatches: 9, maxPendingBatches: 10, oldestPendingAt: 97000,
        lastArchivedAt: 90000, lastError: 'R2 unavailable',
        sources: [{ sourceId: 'daily-cron', lastReceivedAt: 1000, acceptedEvents: 1 }],
    }, 999999);
    expect(health.utilization).toBe(0.9);
    expect(health.oldestPendingAgeMs).toBe(3000);
    expect(health.lastArchivedAgeMs).toBe(10000);
    expect(health.lastReceivedAt).toBe(1000);
    expect(health.sources[0].status).toBe('received');
    expect(health.sources[0].ageMs).toBe(99000);
    expect(health.archiveState).toBe('error');
    expect(healthSummary({ sources: [{ sourceId: 'new', lastReceivedAt: null }] }).sources[0].status).toBe('never');
    expect(healthSummary({}).lastReceivedAt).toBeNull();
    expect(healthSummary({}).utilization).toBeNull();
    expect(healthSummary({ pendingBatches: 1, oldestPendingAt: 2000 }, 1000).oldestPendingAgeMs).toBe(0);
});

test('empty results distinguish first connection, filters, scan continuation and a completed empty range', () => {
    expect(emptyState({ loading: true }).title).toContain('조회');
    expect(emptyState({ hasCursor: true }).title).toContain('다음 페이지');
    expect(emptyState({ complete: true, lastReceivedAt: null }).title).toContain('수집');
    expect(emptyState({ complete: true, lastReceivedAt: 1000, hasFilters: true }).title).toContain('필터');
    expect(emptyState({ complete: true, lastReceivedAt: 1000 }).title).toContain('시간');
});

test('connection examples use this deployment and credential placeholders without account identifiers', () => {
    const examples = connectionExamples('https://observe.example');
    expect(examples.curl).toContain('https://observe.example/api/ingest');
    expect(examples.curl).toContain('${CF_OBSERVE_INGEST_TOKEN}');
    expect(examples.otlp).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=https://observe.example');
    expect(examples.otlp).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
    expect(examples.otlp).not.toMatch(/VIEWER_TOKEN|localStorage|sessionStorage/);
});
