import type { HookEventMap, HookName, PmContext, PmHost, PmPlugin } from './types';

/**
 * Build a host from an ordered plugin list. Plugins listed earlier run earlier
 * for a given hook (registration order = dispatch order), which preserves the
 * pre-inversion ordering (e.g. relations before notifications).
 *
 * `dependsOn` is validated eagerly: a plugin may not depend on an id that isn't
 * registered before it, so a misconfigured host fails loudly at startup rather
 * than silently dropping a contribution.
 */
export function createPmHost(plugins: PmPlugin[]): PmHost {
  const ids = new Set<string>();
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`Plugin "${p.id}" depends on "${dep}", which is not registered before it.`);
      }
    }
    if (ids.has(p.id)) throw new Error(`Duplicate plugin id "${p.id}".`);
    ids.add(p.id);
  }

  // Index hooks by name into ordered arrays for fan-out.
  const subscribers = new Map<HookName, Array<(ctx: PmContext, event: unknown) => Promise<void>>>();
  for (const p of plugins) {
    const hooks = p.hooks;
    if (!hooks) continue;
    for (const name of Object.keys(hooks) as HookName[]) {
      const fn = hooks[name];
      if (!fn) continue;
      const list = subscribers.get(name) ?? [];
      list.push(fn as (ctx: PmContext, event: unknown) => Promise<void>);
      subscribers.set(name, list);
    }
  }

  return {
    pluginIds: plugins.map((p) => p.id),
    has(id) {
      return ids.has(id);
    },
    async dispatch<K extends HookName>(name: K, ctx: PmContext, event: HookEventMap[K]) {
      const list = subscribers.get(name);
      if (!list) return;
      // Sequential so ordering + error propagation match the old inline calls.
      for (const fn of list) {
        await fn(ctx, event);
      }
    },
  };
}
