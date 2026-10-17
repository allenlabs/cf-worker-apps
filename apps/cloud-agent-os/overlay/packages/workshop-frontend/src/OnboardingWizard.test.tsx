// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiGatewayInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

const state = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  currentUser: { id: 'user-one', name: 'User One' },
  isAdmin: false,
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => state }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./AddModelModal', () => ({ default: () => <div data-testid="model-editor" /> }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import OnboardingWizard from './OnboardingWizard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Onboarding model management', () => {
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const render = async (management: string, config: AiGatewayInfo = { enabled: false }, isAdmin = false) => {
    state.isAdmin = isAdmin
    vi.stubEnv('VITE_CODEX_BRIDGE_MANAGEMENT', management)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    const setPreferredModel = vi.fn<AuthenticatedApi['setPreferredModel']>(async () => {})
    const completeOnboarding = vi.fn<AuthenticatedApi['completeOnboarding']>(async () => {})
    state.authenticatedApi = {
      listModels: async () => [
        { type: 'agent', id: 'model-one', name: 'First model' },
        { type: 'agent', id: 'model-two', name: 'Second model' },
      ],
      getAiConfig: async () => config,
      listGatekeeperVendors: async () => [],
      subscribeConnectedAccounts: () => Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} }),
      setPreferredModel, completeOnboarding,
    } as unknown as RpcStub<AuthenticatedApi>
    const onComplete = vi.fn<() => void>()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<OnboardingWizard onComplete={onComplete} />))
    return { setPreferredModel, completeOnboarding, onComplete }
  }

  const click = async (text: string) => {
    const button = Array.from(document.body.querySelectorAll('button'))
      .find(element => element.textContent?.includes(text))
    if (!button) throw new Error(`Missing button: ${text}`)
    await act(async () => button.click())
  }

  it('lets each user save their model choice without offering credentials or BYO tutorial', async () => {
    const { setPreferredModel, completeOnboarding, onComplete } = await render('admin')
    expect(document.body.querySelector('[data-testid="model-editor"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Add new model')
    expect(document.body.textContent).not.toContain('Bring your own models')
    await click('Next')
    await click('Second model')
    await click('Next')
    await click("Let's build")
    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith('model-two')
    expect(completeOnboarding).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('keeps personal model setup and tutorial in user-managed mode', async () => {
    await render('user')
    expect(document.body.querySelector('[data-testid="model-editor"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Add new model')
    expect(document.body.textContent).toContain('Bring your own models')
  })
  it.each([true, false])('follows runtime personal-provider policy with a shared subscription (%s)', async userModelsEnabled => {
    await render('admin', { enabled: true, transport: 'subscription', userModelsEnabled,
      enabledProviders: ['openai'], builtInModelIds: ['model-one'] })
    expect(document.body.querySelector('[data-testid="model-editor"]') !== null).toBe(userModelsEnabled)
    expect(document.body.textContent?.includes('Add new model')).toBe(userModelsEnabled)
    expect(document.body.textContent?.includes('Bring your own models')).toBe(userModelsEnabled)
  })

  it.each([true, false])('opens organization SIWC setup for an admin while preserving personal-provider policy (%s)', async userModelsEnabled => {
    const { completeOnboarding, onComplete } = await render('admin', {
      enabled: true, transport: 'subscription', userModelsEnabled,
      enabledProviders: ['openai'], builtInModelIds: ['model-one'],
      setupUrl: '/gatekeeper/subscription',
    }, true)
    await click('Next')
    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/gatekeeper/subscription"]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Connect organization SIWC subscription')
    expect(link?.target).toBe('_blank')
    expect(link?.rel).toBe('noopener noreferrer')
    expect(document.body.querySelector('[data-testid="model-editor"]') !== null).toBe(userModelsEnabled)
    expect(completeOnboarding).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not offer organization setup to a non-admin', async () => {
    await render('admin', { enabled: true, transport: 'subscription', userModelsEnabled: true,
      enabledProviders: ['openai'], builtInModelIds: ['model-one'], setupUrl: '/gatekeeper/subscription' })
    await click('Next')
    expect(document.body.textContent).not.toContain('Connect organization SIWC subscription')
  })

  it('does not offer organization setup when the server omits the capability', async () => {
    await render('admin', { enabled: true, transport: 'subscription', userModelsEnabled: true,
      enabledProviders: ['openai'], builtInModelIds: ['model-one'] }, true)
    await click('Next')
    expect(document.body.textContent).not.toContain('Connect organization SIWC subscription')
  })

  it('does not offer organization setup for an AI Gateway catalog', async () => {
    await render('admin', { enabled: true, userModelsEnabled: true,
      enabledProviders: ['openai'], builtInModelIds: ['model-one'], setupUrl: '/gatekeeper/subscription' }, true)
    await click('Next')
    expect(document.body.textContent).not.toContain('Connect organization SIWC subscription')
  })

})
