// Minimal Durable Object smoke worker — verifies DOs deploy on this account
// before we build the real Yjs collab backend on top.
export class SmokeDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async fetch(): Promise<Response> {
    let n = (await this.state.storage.get<number>('n')) ?? 0;
    n += 1;
    await this.state.storage.put('n', n);
    return new Response(JSON.stringify({ ok: true, count: n }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}

export default {
  async fetch(req: Request, env: { SMOKE: DurableObjectNamespace }): Promise<Response> {
    const id = env.SMOKE.idFromName('smoke');
    return env.SMOKE.get(id).fetch(req);
  },
};
