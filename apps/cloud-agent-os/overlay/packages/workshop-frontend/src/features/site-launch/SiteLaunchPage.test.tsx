// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi, SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('../../LoginPage', () => ({ default: ({ onLoginSuccess }: { onLoginSuccess: () => void }) =>
  <button onClick={onLoginSuccess}>Ordinary OS sign-in</button> }))

import { RpcContext } from '../../RpcContext'
import { SiteLaunchAuthContext } from './SiteLaunchAuthContext'
import { SiteLaunchPage } from './SiteLaunchPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SiteLaunchPage', () => {
  let root: Root | undefined
  const origin = 'https://portal.example.com'
  const sent: Array<{ payload: unknown; origin: string }> = []
  const parent = { postMessage: (payload: unknown, target: string) => sent.push({ payload, origin: target }) }
  const onLoginSuccess = vi.fn()
  const onReauthenticate = vi.fn()
  const onLaunched = vi.fn()
  let auth: { authenticatedApi: RpcStub<AuthenticatedApi> | null; isLoading: boolean;
    onLoginSuccess: () => void; onReauthenticate: () => void; onLaunched: (result: SiteLaunchRedemption) => void }

  const tree = () => <StrictMode><RpcContext.Provider value={{ stub: {} as RpcStub<PublicApi>, connectionLost: false }}>
    <SiteLaunchAuthContext.Provider value={auth}><SiteLaunchPage /></SiteLaunchAuthContext.Provider>
  </RpcContext.Provider></StrictMode>
  const render = async (api: Pick<AuthenticatedApi, 'redeemSiteLaunch'> | null = null, enabled = true) => {
    vi.stubEnv('VITE_SITE_LAUNCH_PARENT_ORIGINS', enabled ? JSON.stringify([origin]) : '')
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window)
    auth = { authenticatedApi: api as RpcStub<AuthenticatedApi> | null, isLoading: false, onLoginSuccess, onReauthenticate, onLaunched }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(tree()))
  }
  const message = async (data: unknown, from = origin) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: from, source: parent as unknown as Window }))
    await Promise.resolve(); await Promise.resolve()
  })
  const initialize = () => message({ type: 'cloud-agent-os:host-init', protocol: 1 })
  const launch = () => message({ type: 'cloud-agent-os:site-launch', protocol: 1, ticket: 'a'.repeat(64) })
  const site: SiteLaunchRedemption = { workspaceId: 'trusted-site-workspace',
    siteContext: { id: 'site', environment: 'production', displayName: 'Site', timezone: 'Asia/Seoul' } }

  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); sent.length = 0
    localStorage.clear(); sessionStorage.clear()
  })

  it('renders a safe unavailable page and accepts no launch without a deployment allowlist', async () => {
    await render(null, false); await initialize(); await launch()
    expect(document.body.textContent).toContain('Site launch is unavailable')
    expect(sent).toEqual([]); expect(navigate).not.toHaveBeenCalled()
  })

  it('waits for its own auth readiness before replying to the initialized parent', async () => {
    await render(); auth = { ...auth, isLoading: true }
    await act(async () => root!.render(tree())); await initialize()
    expect(sent).toEqual([])
    auth = { ...auth, isLoading: false }; await act(async () => root!.render(tree()))
    expect(sent).toEqual([{ payload: { type: 'cloud-agent-os:ready', protocol: 1 }, origin }])
  })

  it('offers ordinary OS sign-in and resumes its memory-only ticket after sign-in', async () => {
    await render(); await initialize(); await launch()
    expect(document.body.textContent).toContain('Ordinary OS sign-in')
    const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Ordinary OS sign-in')!
    await act(async () => button.click()); expect(onLoginSuccess).toHaveBeenCalledOnce()
    auth = { ...auth, authenticatedApi: { redeemSiteLaunch: async () => site } as unknown as RpcStub<AuthenticatedApi> }
    await act(async () => root!.render(tree()))
    expect(navigate).toHaveBeenCalledWith({ to: '/workspace/$id', params: { id: 'trusted-site-workspace' }, search: {}, hash: '', replace: true })
    expect(onLaunched).toHaveBeenCalledWith(site)
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
    expect(sent.at(-1)?.payload).toEqual({ type: 'cloud-agent-os:site-launch-result', protocol: 1, status: 'ready' })
  })

  it('provides an explicit ordinary reauthentication button for an old OS session', async () => {
    await render({ redeemSiteLaunch: async () => { throw new Error('site_launch_sign_in_required') } })
    await initialize(); await launch()
    const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Sign in again')!
    expect(button).toBeDefined()
    await act(async () => button.click()); expect(onReauthenticate).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('shows safe expiry instructions without leaking raw errors or opening an old workspace', async () => {
    await render({ redeemSiteLaunch: async () => { throw new Error('site_launch_expired') } })
    await initialize(); await launch()
    expect(document.body.textContent).toContain('expired')
    expect(document.body.textContent).toContain('Retry')
    expect(navigate).not.toHaveBeenCalled()
  })
})
