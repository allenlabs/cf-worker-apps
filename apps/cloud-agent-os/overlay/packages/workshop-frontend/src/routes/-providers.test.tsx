// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiGatewayInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

const state = vi.hoisted(() => ({ authenticatedApi: null as RpcStub<AuthenticatedApi> | null }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi }) }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('../AddModelModal', () => ({ default: () => <div data-testid="model-editor" /> }))
vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import { Route } from './providers'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Models selection on the providers route', () => {
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    localStorage.clear()
    state.authenticatedApi = null
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const render = async (config: AiGatewayInfo | Promise<AiGatewayInfo>, management = 'admin') => {
    vi.stubEnv('VITE_CODEX_BRIDGE_MANAGEMENT', management)
    const setQuickModel = vi.fn<AuthenticatedApi['setQuickModel']>(async () => {})
    const setPreferredModel = vi.fn<AuthenticatedApi['setPreferredModel']>(async () => {})
    state.authenticatedApi = {
      listModels: async () => [
        { type: 'agent', id: 'codex-subscription', name: 'Codex subscription' },
        { type: 'agent', id: 'old-personal', name: 'Old personal model' },
      ],
      getQuickModel: async () => null,
      getPreferredModel: async () => null,
      getAiConfig: async () => config,
      setQuickModel,
      setPreferredModel,
    } as unknown as RpcStub<AuthenticatedApi>
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const Page = Route.options.component!
    await Page.preload?.()
    await act(async () => root!.render(<Page />))
    return { setQuickModel, setPreferredModel }
  }

  const subscription: AiGatewayInfo = {
    enabled: true, transport: 'subscription', userModelsEnabled: false,
    enabledProviders: ['openai'], builtInModelIds: ['codex-subscription'],
  }

  const actions = async (index = 0) => {
    const trigger = document.body.querySelectorAll<HTMLButtonElement>('[aria-label="Provider actions"]')[index]
    await act(async () => trigger.click())
    return Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(item => item.textContent)
  }

  it.each(['admin', 'user'])('offers personal quick-model selection without credential management for subscription transport (%s build)', async management => {
    const { setQuickModel } = await render(subscription, management)
    expect(document.body.textContent).toContain('Quick model:')
    expect(document.body.textContent).not.toContain('AI Gateway mode:')
    expect(document.body.querySelector('[data-testid="model-editor"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Add provider')
    const row = Array.from(document.body.querySelectorAll<HTMLElement>('[role="button"]'))
      .find(element => element.textContent?.includes('Codex subscription'))!
    await act(async () => row.click())
    expect(setQuickModel).toHaveBeenCalledExactlyOnceWith('codex-subscription')
    await act(async () => row.click())
    expect(setQuickModel).toHaveBeenLastCalledWith(null)
    // Even a legacy non-built-in entry cannot expose management controls in subscription mode.
    expect(await actions(1)).toEqual(['Set as quick model'])
  })

  it('hides management before the config loads and when disabled in an admin build', async () => {
    let resolve!: (value: AiGatewayInfo) => void
    const pendingConfig = new Promise<AiGatewayInfo>(done => { resolve = done })
    await render(pendingConfig)
    expect(document.body.querySelector('h1')?.textContent).toBe('Models')
    expect(document.body.querySelector('[data-testid="model-editor"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Add provider')
    await act(async () => resolve({ enabled: false }))
    expect(document.body.querySelector('h1')?.textContent).toBe('Models')
    expect(document.body.querySelector('[data-testid="model-editor"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Add provider')
    expect(await actions(1)).toEqual(['Set as quick model'])
  })

  it('keeps direct mode provider management available in a user build', async () => {
    await render({ enabled: false }, 'user')
    expect(document.body.querySelector('h1')?.textContent).toBe('AI providers')
    expect(document.body.textContent).toContain('Add provider')
    expect(document.body.querySelector('[data-testid="model-editor"]')).not.toBeNull()
    expect(await actions(1)).toEqual(['Set as quick model', 'Edit provider', 'Clone provider', 'Delete provider'])
  })

  it('keeps Gateway mode and its built-in restrictions unchanged in a user build', async () => {
    await render({ enabled: true, userModelsEnabled: true,
      enabledProviders: ['openai'], builtInModelIds: ['codex-subscription'] }, 'user')
    expect(document.body.textContent).toContain('AI Gateway mode:')
    expect(document.body.textContent).not.toContain('Quick model:')
    expect(document.body.textContent).toContain('Add provider')
    expect(await actions()).toEqual(['Set as quick model'])
  })

  it('saves the managed default independently of the quick model and lets Automatic clear that choice', async () => {
    const { setPreferredModel, setQuickModel } = await render(subscription)
    const chooseDefault = async (name: string) => {
      const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Default model"]')!
      expect(trigger).not.toBeNull()
      await act(async () => trigger.click())
      const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
        .find(element => element.textContent === name)!
      // Kumo synthesizes a PointerEvent for keyboard selection; jsdom needs this stand-in.
      const view: { PointerEvent?: typeof MouseEvent } = window
      view.PointerEvent = MouseEvent
      try {
        await act(async () => option.focus())
        await act(async () => option.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        })))
      } finally {
        delete view.PointerEvent
      }
    }
    await chooseDefault('Codex subscription')
    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith('codex-subscription')
    expect(setQuickModel).not.toHaveBeenCalled()
    expect(localStorage.getItem('lastSelectedModel')).toBe('codex-subscription')
    await chooseDefault('Automatic (first available model)')
    expect(setPreferredModel).toHaveBeenLastCalledWith(null)
    expect(setQuickModel).not.toHaveBeenCalled()
    expect(localStorage.getItem('lastSelectedModel')).toBeNull()
  })
})
