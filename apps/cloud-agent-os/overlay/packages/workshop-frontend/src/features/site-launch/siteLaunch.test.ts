import { describe, expect, it } from 'vitest'
import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'
import { SiteLaunchSession, parseSiteLaunchParentOrigins } from './siteLaunch'

const ORIGIN = 'https://portal.example.com'
const TICKET = 'a'.repeat(64)
const NEXT_TICKET = 'b'.repeat(64)
const SITE: SiteLaunchRedemption = {
  workspaceId: 'site-workspace',
  siteContext: { id: 'clinic', environment: 'stg', displayName: 'Clinic', timezone: 'Asia/Seoul' },
}

const pending = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const harness = (origins = [ORIGIN]) => {
  const parent = {} as Window
  const sent: Array<{ message: unknown; origin: string }> = []
  const workspaces: string[] = []
  const states: string[] = []
  const session = new SiteLaunchSession({ allowedOrigins: origins, parent,
    post: (message, origin) => sent.push({ message, origin }),
    onWorkspace: result => workspaces.push(result.workspaceId), onState: state => states.push(state.status),
  })
  const message = (data: unknown, origin = ORIGIN, source: MessageEventSource = parent) =>
    session.receive({ data, origin, source })
  const initialize = () => message({ type: 'cloud-agent-os:host-init', protocol: 1 })
  const launch = (ticket = TICKET) => message({ type: 'cloud-agent-os:site-launch', protocol: 1, ticket })
  return { session, sent, workspaces, states, message, initialize, launch }
}

describe('site launch trust boundary', () => {
  it('requires configured canonical origins and fails closed for malformed build configuration', () => {
    expect(parseSiteLaunchParentOrigins(JSON.stringify([ORIGIN]))).toEqual([ORIGIN])
    for (const value of [undefined, '', '*', '{}', '["*"]', '["https://portal.example.com/path"]', '["null"]',
      '["http://portal.example.com"]', '["https://portal.example.com:443"]',
      '["https://example.workers.dev"]', '["https://user@example.com"]',
      JSON.stringify([ORIGIN, ORIGIN]), JSON.stringify(Array.from({ length: 11 }, (_, i) => `https://site${i}.example`))]) {
      expect(parseSiteLaunchParentOrigins(value)).toEqual([])
    }
  })

  it('announces ready once only after own authentication resolves and a valid parent initializes', () => {
    const h = harness()
    h.initialize()
    expect(h.sent).toEqual([])
    h.session.setAuthentication(null, true)
    h.initialize()
    expect(h.sent).toEqual([{ message: { type: 'cloud-agent-os:ready', protocol: 1 }, origin: ORIGIN }])
  })

  it('accepts no parent messages when the deployment flag is absent', () => {
    const h = harness([])
    h.session.setAuthentication({ redeemSiteLaunch: async () => SITE }, true)
    h.initialize(); h.launch()
    expect(h.sent).toEqual([])
    expect(h.workspaces).toEqual([])
  })

  it('rejects wrong origins, sibling windows, loose schemas and direct ticket messages before host-init', () => {
    const h = harness()
    h.session.setAuthentication({ redeemSiteLaunch: async () => SITE }, true)
    h.launch()
    h.message({ type: 'cloud-agent-os:host-init', protocol: 1 }, 'https://evil.example')
    h.message({ type: 'cloud-agent-os:host-init', protocol: 1 }, ORIGIN, {} as Window)
    h.message({ type: 'cloud-agent-os:host-init', protocol: 1, site: 'injected' })
    h.message({ type: 'cloud-agent-os:host-init', protocol: 2 })
    expect(h.sent).toEqual([])
    h.initialize()
    for (const data of [null, [], { type: 'cloud-agent-os:site-launch', protocol: 1, ticket: 'short' },
      { type: 'cloud-agent-os:site-launch', protocol: 1, ticket: TICKET, workspaceId: 'injected' }]) h.message(data)
    expect(h.workspaces).toEqual([])
    expect(h.states).not.toContain('busy')
  })

  it('binds one initialized parent origin even when several parent origins are allowed', () => {
    const h = harness([ORIGIN, 'https://other.example'])
    h.session.setAuthentication({ redeemSiteLaunch: async () => SITE }, true)
    h.initialize()
    h.message({ type: 'cloud-agent-os:host-init', protocol: 1 }, 'https://other.example')
    h.message({ type: 'cloud-agent-os:site-launch', protocol: 1, ticket: TICKET }, 'https://other.example')
    expect(h.states).not.toContain('busy')
  })

  it('redeems once, ignores concurrent and replayed tickets, and returns no identity or ticket', async () => {
    const h = harness(); const result = pending<SiteLaunchRedemption>(); const redeemed: string[] = []
    h.session.setAuthentication({ redeemSiteLaunch: ticket => { redeemed.push(ticket); return result.promise } }, true)
    h.initialize(); h.launch(); h.launch(); h.launch(NEXT_TICKET)
    expect(redeemed).toEqual([TICKET])
    result.resolve(SITE); await result.promise; await Promise.resolve()
    h.launch()
    expect(h.workspaces).toEqual(['site-workspace'])
    expect(h.sent.at(-1)).toEqual({ message: { type: 'cloud-agent-os:site-launch-result', protocol: 1, status: 'ready' }, origin: ORIGIN })
  })

  it('keeps a signed-out pending ticket in memory until ordinary sign-in completes', async () => {
    const h = harness(); const redeemed: string[] = []
    h.session.setAuthentication(null, true); h.initialize(); h.launch()
    expect(h.sent.at(-1)?.message).toEqual({ type: 'cloud-agent-os:site-launch-result', protocol: 1,
      status: 'error', code: 'site_launch_sign_in_required' })
    h.session.setAuthentication({ redeemSiteLaunch: async ticket => { redeemed.push(ticket); return SITE } }, true)
    await Promise.resolve(); await Promise.resolve()
    expect(redeemed).toEqual([TICKET]); expect(h.workspaces).toEqual(['site-workspace'])
  })

  it('requires reauthentication for old sessions without spending their pending ticket', async () => {
    const h = harness(); const redeemed: string[] = []
    h.session.setAuthentication({ redeemSiteLaunch: async () => { throw new Error('site_launch_sign_in_required') } }, true)
    h.initialize(); h.launch(); await Promise.resolve(); await Promise.resolve()
    expect(h.states.at(-1)).toBe('sign-in-required')
    h.session.setAuthentication(null, true)
    h.session.setAuthentication({ redeemSiteLaunch: async ticket => { redeemed.push(ticket); return SITE } }, true)
    await Promise.resolve(); await Promise.resolve()
    expect(redeemed).toEqual([TICKET]); expect(h.workspaces).toEqual(['site-workspace'])
  })

  it.each(['site_launch_expired', 'site_launch_invalid', 'site_launch_disabled'])('reports %s safely and permits a fresh retry ticket', async code => {
    const h = harness(); const redeemed: string[] = []
    h.session.setAuthentication({ redeemSiteLaunch: async ticket => {
      redeemed.push(ticket)
      if (ticket === TICKET) throw new Error(code)
      return SITE
    } }, true)
    h.initialize(); h.launch(); await Promise.resolve(); await Promise.resolve()
    expect(h.sent.at(-1)?.message).toEqual({ type: 'cloud-agent-os:site-launch-result', protocol: 1, status: 'error', code })
    h.launch(); h.launch(NEXT_TICKET); await Promise.resolve(); await Promise.resolve()
    expect(redeemed).toEqual([TICKET, NEXT_TICKET]); expect(h.workspaces).toEqual(['site-workspace'])
  })

  it('drops a late completion after unmount rather than opening a stale site workspace', async () => {
    const h = harness(); const result = pending<SiteLaunchRedemption>()
    h.session.setAuthentication({ redeemSiteLaunch: () => result.promise }, true)
    h.initialize(); h.launch(); h.session.dispose(); result.resolve(SITE)
    await result.promise; await Promise.resolve()
    expect(h.workspaces).toEqual([]); expect(h.sent).toHaveLength(1)
  })

  it('drops completions from the previous authenticated principal and never displays raw errors', async () => {
    const h = harness(); const result = pending<SiteLaunchRedemption>()
    h.session.setAuthentication({ redeemSiteLaunch: () => result.promise }, true)
    h.initialize(); h.launch(); h.session.setAuthentication(null, true)
    result.resolve(SITE); await result.promise; await Promise.resolve()
    expect(h.workspaces).toEqual([])
    h.session.setAuthentication({ redeemSiteLaunch: async () => { throw new Error('private-sensitive-detail') } }, true)
    await Promise.resolve(); await Promise.resolve()
    expect(h.sent.at(-1)?.message).toEqual({ type: 'cloud-agent-os:site-launch-result', protocol: 1,
      status: 'error', code: 'site_launch_failed' })
  })
})
