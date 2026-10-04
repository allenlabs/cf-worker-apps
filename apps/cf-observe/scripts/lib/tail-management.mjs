const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(value);
export function planTailConsumers(producer, collector, existing = []) {
    if (!validName(producer) || !validName(collector)) throw new Error('Invalid Worker name');
    if (producer === collector || producer === 'cf-observe') throw new Error('Refusing recursive telemetry collection');
    if (!Array.isArray(existing) || existing.some(c => !c || !validName(c.service))) throw new Error('Invalid existing tail consumers');
    return existing.some(c => c.service === collector && !c.environment && !c.namespace)
        ? existing.map(c => ({...c})) : [...existing.map(c => ({...c})), { service: collector }];
}
export async function connectTail(api, producer, collector, apply = false) {
    planTailConsumers(producer, collector);
    const path = `/workers/scripts/${producer}/script-settings`;
    const settings = await api(path);
    const before = settings.tail_consumers || [];
    const after = planTailConsumers(producer,collector,before);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (apply && changed) {
        const result = await api(path,{method:'PATCH',body:{tail_consumers:after}});
        if (JSON.stringify(result.tail_consumers) !== JSON.stringify(after))
            throw new Error(`Tail settings verification failed for ${producer}; inspect remote settings before retrying`);
    }
    return {producer,collector,before,after,changed,applied:apply && changed};
}
