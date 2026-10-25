// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  currentUser: null as { id: string } | null,
  api: { listBotProfiles: vi.fn(), saveBotProfile: vi.fn() },
  navigate: vi.fn(),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.api, currentUser: state.currentUser }) }))
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
    vi.clearAllMocks()
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
