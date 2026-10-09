// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

const state = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  currentUser: { id: 'user-one', name: 'User One' },
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

  const render = async (management: string) => {
    vi.stubEnv('VITE_CODEX_BRIDGE_MANAGEMENT', management)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    const setPreferredModel = vi.fn<AuthenticatedApi['setPreferredModel']>(async () => {})
    const completeOnboarding = vi.fn<AuthenticatedApi['completeOnboarding']>(async () => {})
    state.authenticatedApi = {
      listModels: async () => [
        { type: 'agent', id: 'model-one', name: 'First model' },
        { type: 'agent', id: 'model-two', name: 'Second model' },
      ],
      getAiConfig: async () => ({ enabled: false }),
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
})
