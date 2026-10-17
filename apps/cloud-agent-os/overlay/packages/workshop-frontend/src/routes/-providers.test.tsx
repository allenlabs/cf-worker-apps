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
vi.mock('../AddModelModal', () => ({
  default: ({ visible, mode }: { visible: boolean, mode?: { type: string } }) =>
    <div data-testid="model-editor" data-open={String(visible)} data-mode={mode?.type ?? 'add'} />,
}))
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
    const modelList = [
      { type: 'agent' as const, id: 'codex-subscription', name: 'Codex subscription' },
      { type: 'agent' as const, id: 'old-personal', name: 'Old personal model' },
    ]
    const getModelConfig = vi.fn<AuthenticatedApi['getModelConfig']>(async id => ({
      profile: modelList.find(model => model.id === id)!,
      config: { provider: 'openai', model: id, apiToken: null },
    }))
    const deleteModel = vi.fn<AuthenticatedApi['deleteModel']>(async id => {
      modelList.splice(modelList.findIndex(model => model.id === id), 1)
    })
    state.authenticatedApi = {
      listModels: async () => modelList,
      getModelConfig, deleteModel,
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
    return { setQuickModel, setPreferredModel, getModelConfig, deleteModel }
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

  it.each([true, false])('saves the managed default independently of the quick model and lets Automatic clear it (personal providers %s)', async userModelsEnabled => {
    const { setPreferredModel, setQuickModel } = await render({ ...subscription, userModelsEnabled })
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
    const defaultId = userModelsEnabled ? 'old-personal' : 'codex-subscription'
    await chooseDefault(userModelsEnabled ? 'Old personal model' : 'Codex subscription')
    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith(defaultId)
    expect(setQuickModel).not.toHaveBeenCalled()
    expect(localStorage.getItem('lastSelectedModel')).toBe(defaultId)
    await chooseDefault('Automatic (first available model)')
    expect(setPreferredModel).toHaveBeenLastCalledWith(null)
    expect(setQuickModel).not.toHaveBeenCalled()
    expect(localStorage.getItem('lastSelectedModel')).toBeNull()
  })
  it.each(['admin', 'user'])('offers personal provider management beside protected shared models when policy permits (%s build)', async management => {
    const { getModelConfig, deleteModel } = await render({ ...subscription, userModelsEnabled: true }, management)
    expect(document.body.querySelector('h1')?.textContent).toBe('AI providers')
    expect(document.body.textContent).toContain('organization')
    expect(document.body.textContent).toContain('personal')
    expect(document.body.querySelector('[aria-label="Default model"]')).not.toBeNull()
    const add = Array.from(document.body.querySelectorAll('button')).find(element => element.textContent?.includes('Add provider'))!
    await act(async () => add.click())
    expect(document.body.querySelector('[data-mode="add"]')?.getAttribute('data-open')).toBe('true')
    expect(await actions(0)).toEqual(['Set as quick model'])
    const sharedMenu = document.body.querySelector<HTMLElement>('[role="menu"]')!
    await act(async () => sharedMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(await actions(1)).toEqual(['Set as quick model', 'Edit provider', 'Clone provider', 'Delete provider'])
    const edit = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(element => element.textContent === 'Edit provider')!
    await act(async () => edit.click())
    expect(getModelConfig).toHaveBeenCalledExactlyOnceWith('old-personal')
    expect(document.body.querySelector('[data-mode="edit"]')?.getAttribute('data-open')).toBe('true')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await actions(1)
    const remove = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(element => element.textContent === 'Delete provider')!
    await act(async () => remove.click())
    expect(deleteModel).toHaveBeenCalledExactlyOnceWith('old-personal')
    expect(document.body.textContent).not.toContain('Old personal model')
    expect(document.body.textContent).toContain('Codex subscription')
  })

})
