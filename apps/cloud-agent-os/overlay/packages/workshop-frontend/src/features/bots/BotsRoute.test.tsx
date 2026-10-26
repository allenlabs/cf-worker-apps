// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotProfilesApi } from './botProfiles'

const state = vi.hoisted(() => ({
  currentUser: null as { id: string } | null,
  api: { listBotProfiles: vi.fn<BotProfilesApi['listBotProfiles']>(), saveBotProfile: vi.fn<BotProfilesApi['saveBotProfile']>() },
  authenticatedApi: null as BotProfilesApi | null,
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi ?? state.api, currentUser: state.currentUser }) }))
vi.mock('@tanstack/react-router', async original => ({ ...await original<typeof import('@tanstack/react-router')>(), useNavigate: () => state.navigate }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
import { BotsPage } from './BotsPage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('bot library route identity', () => {
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    state.currentUser = null
    state.authenticatedApi = null
    vi.clearAllMocks()
  })

  it('waits for a null identity and enables creation after the callable RPC account connects', async () => {
    using rpc = new RpcStub(new class extends RpcTarget {
      async listBotProfiles() { return [] }
      async getMainBot() { return { key: 'main' as const, botId: null, revision: 0 } }
      async saveBotProfile(): Promise<never> { throw new Error('Unused') }
    }())
    state.authenticatedApi = rpc
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<BotsPage />))
    expect(document.body.textContent).toContain('Loading your account')
    expect(document.querySelector('form')).toBeNull()
    state.currentUser = { id: 'synthetic-user' }
    await act(async () => root!.render(<BotsPage />))
    const create = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'New bot')!
    expect(create.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Loading your bots')
  })

  it('waits for account identity before an editor can open and be reset by the account response', async () => {
    state.api.listBotProfiles.mockResolvedValue([])
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<BotsPage />))
    expect(document.body.textContent).toContain('Loading your account')
    expect(state.api.listBotProfiles).not.toHaveBeenCalled()
    expect(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'New bot')).toBe(false)
    state.currentUser = { id: 'test-user' }
    await act(async () => root!.render(<BotsPage />))
    const create = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'New bot')!
    expect(create.disabled).toBe(false)
    await act(async () => create.click())
    const instructions = document.querySelector<HTMLTextAreaElement>('[name="instructions"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(instructions, 'An unsaved role, kept intact.')
      instructions.dispatchEvent(new Event('input', { bubbles: true }))
    })
    state.currentUser = { id: 'test-user' }
    await act(async () => root!.render(<BotsPage />))
    expect(document.querySelector<HTMLTextAreaElement>('[name="instructions"]')?.value).toBe('An unsaved role, kept intact.')
    expect(state.api.saveBotProfile).not.toHaveBeenCalled()
  })
})
