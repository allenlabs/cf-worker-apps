// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotProfile, BotProfileInput } from '@gadgets/workshop-shared/api'
import { BotLibrary } from './BotLibrary'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const profile = (overrides: Partial<BotProfile> = {}): BotProfile => ({
  id: '11111111-1111-4111-8111-111111111111', revision: 3, name: 'Research partner',
  description: 'Find primary sources and explain what they establish.', instructions: 'Cite sources. Preserve uncertainty.',
  icon: 'search', starterPrompts: ['Compare the evidence for these options.'], memory: 'off', archived: false,
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', ...overrides,
})
const button = (label: string): HTMLButtonElement => {
  const found = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === label || item.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
const field = (name: string) => {
  const found = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)
  if (!found) throw new Error(`Missing field ${name}`)
  return found
}
async function fill(name: string, value: string) {
  const element = field(name)
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(label: string) { await act(async () => button(label).click()) }
async function save() {
  const form = document.querySelector('form[aria-label="Bot profile"]')!
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

describe('personal bot library', () => {
  let root: Root
  let profiles: BotProfile[]
  const listBotProfiles = vi.fn<() => Promise<BotProfile[]>>()
  const saveBotProfile = vi.fn<(input: BotProfileInput, expectedRevision: number) => Promise<BotProfile>>()
  const onUseBot = vi.fn<(id: string) => void>()
  const api = { listBotProfiles, saveBotProfile }
  beforeEach(() => {
    profiles = [profile()]
    listBotProfiles.mockImplementation(async () => profiles)
    saveBotProfile.mockImplementation(async (input, expectedRevision) => {
      const saved = { ...input, revision: expectedRevision + 1, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T01:00:00Z' }
      profiles = [...profiles.filter(item => item.id !== input.id), saved]
      return saved
    })
    root = createRoot(document.body.appendChild(document.createElement('div')))
  })
  afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.clearAllMocks() })
  const render = async () => { await act(async () => root.render(<BotLibrary api={api} onUseBot={onUseBot} />)) }

  const rpcApi = (getMainBot = async () => ({ key: 'main' as const, botId: null, revision: 0 })) => new RpcStub(new class extends RpcTarget {
    listBotProfiles() { return listBotProfiles() }
    saveBotProfile(input: BotProfileInput, revision: number) { return saveBotProfile(input, revision) }
    getMainBot() { return getMainBot() }
  }())

  it('enables creation when the callable RPC catalog has loaded', async () => {
    using rpc = rpcApi()
    profiles = []
    await act(async () => root.render(<BotLibrary api={rpc} onUseBot={onUseBot} />))
    expect(button('New bot').disabled).toBe(false)
    await click('New bot')
    expect(document.querySelector('form[aria-label="Bot profile"]')).not.toBeNull()
  })

  it.each(['profiles', 'main'] as const)('shows a retryable error when callable RPC %s lookup fails', async lookup => {
    let failMain = lookup === 'main'
    if (lookup === 'profiles') listBotProfiles.mockRejectedValueOnce(new Error('Catalog unavailable'))
    using rpc = rpcApi(async () => {
      if (failMain) throw new Error('Main bot unavailable')
      return { key: 'main', botId: null, revision: 0 }
    })
    await act(async () => root.render(<BotLibrary api={rpc} onUseBot={onUseBot} />))
    expect(document.body.textContent).toContain('Could not load your bots')
    expect(document.body.textContent).not.toContain('Loading your bots')
    expect(button('New bot').disabled).toBe(true)
    failMain = false
    await click('Retry loading bots')
    expect(button('New bot').disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Could not load your bots')
  })

  it('distinguishes loading, failure, retry and an empty library', async () => {
    let reject!: (error: Error) => void
    listBotProfiles.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
    await render()
    expect(document.body.textContent).toContain('Loading your bots')
    expect(document.body.textContent).not.toContain('Create your first bot')
    await act(async () => reject(new Error('Network unavailable')))
    expect(document.body.textContent).toContain('Could not load your bots')
    expect(document.body.textContent).not.toContain('Create your first bot')
    profiles = []
    await click('Retry loading bots')
    expect(document.body.textContent).toContain('Create your first bot')
  })

  it('creates an explicit personal profile and exposes its saved chat entry point', async () => {
    profiles = []; await render(); await click('New bot')
    await fill('name', 'Writing partner')
    await fill('description', 'Edit with care.')
    await fill('instructions', '  Keep every source quotation intact.\nAsk before publishing.  ')
    await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="Use connected memory"]')!.click())
    await click('Add starter prompt'); await fill('starter-0', 'Review this draft.')
    expect(document.body.textContent).toContain('not a separate memory store')
    expect(document.body.textContent).toContain('Instructions saved with a chat are visible to that workspace’s collaborators.')
    expect(document.querySelector('a[href="/gatekeepers"]')).not.toBeNull()
    await save()
    expect(saveBotProfile).toHaveBeenLastCalledWith({ id: expect.stringMatching(/^[\da-f-]{36}$/i), name: 'Writing partner',
      description: 'Edit with care.', instructions: '  Keep every source quotation intact.\nAsk before publishing.  ',
      icon: 'spark', starterPrompts: ['Review this draft.'], memory: 'connected', archived: false }, 0)
    expect(document.querySelector('form[aria-label="Bot profile"]')).toBeNull()
    await click('Use Writing partner')
    expect(onUseBot).toHaveBeenCalledWith(profiles[0].id)
  })

  it('retains the complete overlimit draft and reports validation without clipping or saving', async () => {
    await render(); await click('Edit Research partner')
    const instructions = '한'.repeat(16001)
    await fill('instructions', instructions); await save()
    expect(field('instructions').value).toBe(instructions)
    expect(field('instructions').hasAttribute('maxlength')).toBe(false)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('16,000')
    expect(saveBotProfile).not.toHaveBeenCalled()
  })

  it('explains the memory preference without implying that it disconnects authorized tools', async () => {
    await render()
    expect(document.body.textContent).toContain('Automatic recall off')
    await click('Edit Research partner')
    expect(document.body.textContent).toContain('The bot can use it when you explicitly ask; this setting does not disconnect tools.')
    expect(document.querySelector<HTMLInputElement>('input[name="memory"][value="off"]')?.checked).toBe(true)
  })

  it('keeps dirty text through a conflict and requires an explicit revision review before overwriting', async () => {
    await render(); await click('Edit Research partner'); await fill('instructions', 'My unsaved instructions, kept in full.')
    saveBotProfile.mockRejectedValueOnce(new Error('Bot revision conflict. Reload before saving.'))
    await save()
    expect(field('instructions').value).toBe('My unsaved instructions, kept in full.')
    expect(document.body.textContent).toContain('Your draft is unchanged')
    profiles = [profile({ revision: 4, instructions: 'A different saved version.', starterPrompts: ['A newer starter.'], memory: 'connected', archived: true })]
    await click('Review latest version')
    expect(document.body.textContent).toContain('A different saved version.')
    expect(document.querySelector('[aria-label="Latest saved profile"]')?.textContent).toContain('A newer starter.')
    expect(field('instructions').value).toBe('My unsaved instructions, kept in full.')
    await click('Keep my draft with this revision'); await save()
    expect(saveBotProfile).toHaveBeenLastCalledWith(expect.objectContaining({ instructions: 'My unsaved instructions, kept in full.' }), 4)
    expect(document.body.textContent).toContain('Research partner')
  })

  it('duplicates only editable configuration under a fresh ID and does not save until requested', async () => {
    await render(); await click('Duplicate Research partner')
    expect(saveBotProfile).not.toHaveBeenCalled()
    expect(field('instructions').value).toBe('Cite sources. Preserve uncertainty.')
    await fill('name', 'Another research partner'); await save()
    const [input, revision] = saveBotProfile.mock.lastCall!
    expect(input.id).not.toBe('11111111-1111-4111-8111-111111111111')
    expect(revision).toBe(0)
    expect(input).not.toHaveProperty('createdAt')
    expect(input).not.toHaveProperty('revision')
    expect(profiles).toHaveLength(2)
  })

  it('archives and restores without deleting the profile or changing its instructions', async () => {
    await render(); await click('Archive Research partner')
    expect(saveBotProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: profiles[0].id, archived: true,
      instructions: 'Cite sources. Preserve uncertainty.' }), 3)
    expect(document.body.textContent).not.toContain('Use Research partner')
    await click('Archived')
    await click('Restore Research partner')
    expect(saveBotProfile).toHaveBeenLastCalledWith(expect.objectContaining({ archived: false }), 4)
    await click('Active')
    expect(button('Use Research partner').disabled).toBe(false)
  })

  it('filters by the complete description and distinguishes no matches from no bots', async () => {
    await render(); await fill('search', 'primary sources')
    expect(button('Use Research partner')).toBeDefined()
    await fill('search', 'missing job')
    expect(document.body.textContent).toContain('No matching bots')
    expect(document.body.textContent).not.toContain('Create your first bot')
  })

  it('cancel restores the library without writing an edited draft', async () => {
    await render(); await click('Edit Research partner'); await fill('name', 'Uncommitted name'); await click('Cancel')
    expect(saveBotProfile).not.toHaveBeenCalled()
    expect(button('Use Research partner')).toBeDefined()
    expect(document.body.textContent).not.toContain('Uncommitted name')
  })

  it('finishes a save after React replays mounting effects in StrictMode', async () => {
    await act(async () => root.render(<StrictMode><BotLibrary api={api} onUseBot={onUseBot} /></StrictMode>))
    await click('Edit Research partner'); await fill('name', 'Saved under StrictMode'); await save()
    expect(document.querySelector('form[aria-label="Bot profile"]')).toBeNull()
    expect(button('Use Saved under StrictMode')).toBeDefined()
  })
})
