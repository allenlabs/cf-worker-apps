// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, BotProfile, Overseer } from '@gadgets/workshop-shared/api'
import { useComposerDraft } from '../chat/composer/draft/useComposerDraft'
import { composerDraftStorageKey, readComposerDraft, writeComposerDraft } from '../chat/composer/draft/composerDraft'

type TestOverseer = Pick<Overseer, 'newChat'> & { getMetadata(): Promise<{ id: string }>; [Symbol.dispose](): void }
const state = vi.hoisted(() => ({
  listBotProfiles: vi.fn<() => Promise<BotProfile[]>>(), listModels: vi.fn<() => Promise<AiChatAuthorInfo[]>>(),
  newChat: vi.fn<Overseer['newChat']>(), getMetadata: vi.fn<TestOverseer['getMetadata']>(),
  dispose: vi.fn<() => void>(), newGadget: vi.fn<() => TestOverseer>(),
  navigate: vi.fn<(options: unknown) => Promise<void>>(), addToast: vi.fn<(options: unknown) => void>(),
  currentUser: { id: 'test-user' } as { id: string } | null,
}))
const api = { listBotProfiles: state.listBotProfiles, listModels: state.listModels, newGadget: state.newGadget }
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api, currentUser: state.currentUser }) }))
vi.mock('@tanstack/react-router', async original => ({ ...await original<typeof import('@tanstack/react-router')>(), useNavigate: () => state.navigate }))
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: state.addToast }) }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../../components/MeshBackground', () => ({ default: () => null }))
vi.mock('../../components/AppShell/HomeTaskSuggestions', () => ({ default: () => null }))
vi.mock('../chat/composer/ChatComposer', () => ({ ChatComposer: (props: {
  seedText?: string; seedNonce?: number; draftStorageKey?: string; onModelChange: (id: string) => void;
  onSend: (message: string, model: string) => Promise<void>; blockedReason?: string;
}) => {
  // Keep the real storage and restore behavior: account identity can arrive after Home renders.
  const draft = useComposerDraft({ storageKey: props.draftStorageKey, logoSlot: '' })
  const text = draft.document.text
  const setText = (value: string) => {
    draft.recordEdit()
    draft.replaceDocument({ text: value, capsules: [], formats: [], command: null })
  }
  const setTextRef = useRef(setText)
  setTextRef.current = setText
  const [error, setError] = useState('')
  useEffect(() => { if (props.seedNonce !== undefined) setTextRef.current(props.seedText ?? '') }, [props.seedNonce, props.seedText])
  return <div><textarea aria-label="Prompt" value={text} onChange={event => setText(event.target.value)} />
    <button onClick={() => props.onModelChange('model-one')}>Choose test model</button>
    <button onClick={() => { void props.onSend(text || 'First task', 'model-one').catch(cause => setError(cause.message)) }}>Send test message</button>
    {props.blockedReason && <p>{props.blockedReason}</p>}{error && <p role="alert">{error}</p>}</div>
} }))
import { HomePageContent } from '../../routes/index'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const profile: BotProfile = { id: '11111111-1111-4111-8111-111111111111', revision: 3, name: 'Research partner',
  description: 'Use primary sources.', instructions: 'Cite.', icon: 'search', starterPrompts: ['Find the primary evidence.'], memory: 'off', archived: false,
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' }
const click = async (label: string) => {
  const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  if (!button) throw new Error(`Missing button ${label}`)
  await act(async () => button.click())
}

describe('Home bot entry', () => {
  let root: Root
  beforeEach(() => {
    state.currentUser = { id: 'test-user' }
    state.listBotProfiles.mockResolvedValue([profile])
    state.listModels.mockResolvedValue([{ type: 'agent', id: 'model-one', name: 'Model one' }])
    state.newChat.mockResolvedValue(12); state.getMetadata.mockResolvedValue({ id: 'workspace-test' })
    state.newGadget.mockReturnValue({ newChat: state.newChat, getMetadata: state.getMetadata, [Symbol.dispose]: state.dispose })
    root = createRoot(document.body.appendChild(document.createElement('div')))
  })
  afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear() })
  const render = async (props: { bot?: string; prompt?: string } = { bot: profile.id }) => { await act(async () => root.render(<HomePageContent {...props} />)) }

  it('requires an explicit model and sends the selected bot revision as the seventh argument', async () => {
    await render(); await click('Send test message')
    expect(state.newGadget).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Choose a provider and model')
    await click('Choose test model'); await click('Send test message')
    expect(state.newChat).toHaveBeenCalledWith('First task', 'model-one', undefined, undefined, undefined, undefined, { id: profile.id, revision: 3 })
  })

  it('keeps a selected bot load failure visible and prevents a standard-agent fallback', async () => {
    state.listBotProfiles.mockRejectedValueOnce(new Error('Connection failed'))
    await render(); await click('Choose test model'); await click('Send test message')
    expect(state.newGadget).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Could not load bots')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Choose bot"]')?.value).toBe(profile.id)
    await click('Retry bots'); await click('Send test message')
    expect(state.newChat).toHaveBeenCalledWith('First task', 'model-one', undefined, undefined, undefined, undefined, { id: profile.id, revision: 3 })
  })

  it('keeps an archived bot deep link explicit and requires choosing another assistant before sending', async () => {
    state.listBotProfiles.mockResolvedValueOnce([{ ...profile, archived: true }])
    await render(); await click('Choose test model'); await click('Send test message')
    expect(state.newGadget).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('This bot is unavailable or archived')
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Choose bot"]')!
    expect(select.value).toBe(profile.id)
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Send test message')
    expect(state.newChat).toHaveBeenCalledWith('First task', 'model-one', undefined, undefined, undefined, undefined, undefined)
  })

  it('inserts a starter into an empty composer while retaining a dirty draft on the next click', async () => {
    await render(); await click('Use starter prompt 1')
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!
    expect(textarea.value).toBe('Find the primary evidence.')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'My unfinished original draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Use starter prompt 1')
    expect(textarea.value).toBe('My unfinished original draft')
    expect(document.body.textContent).toContain('Your draft is unchanged')
  })

  it('retains the selected bot in the route when consuming a prompt deep link', async () => {
    await render({ bot: profile.id, prompt: 'Investigate the incident.' })
    expect(state.navigate).toHaveBeenCalledWith({ to: '/', search: { bot: profile.id }, replace: true })
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe('Investigate the incident.')
    expect(state.newGadget).not.toHaveBeenCalled()
  })

  it.each(['deep link', 'starter'] as const)('retains a stored draft when a %s arrives before account identity', async source => {
    const key = composerDraftStorageKey('test-user', 'home')
    const original = 'My complete saved draft from before reloading.'
    writeComposerDraft(key, { version: 1, text: original, formats: [] })
    state.currentUser = null
    await render({ bot: profile.id, ...(source === 'deep link' ? { prompt: profile.starterPrompts[0] } : {}) })
    if (source === 'starter') await click('Use starter prompt 1')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe('')
    state.currentUser = { id: 'test-user' }
    // A router update can still be pending when whoami resolves; keep the deep-link prop present.
    await render({ bot: profile.id, ...(source === 'deep link' ? { prompt: profile.starterPrompts[0] } : {}) })
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(original)
    expect(readComposerDraft(key)?.text).toBe(original)
    expect(document.body.textContent).toContain('Your draft is unchanged')
    expect(document.body.textContent).toContain(profile.starterPrompts[0])
    await click('Use starter prompt 1')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(original)
    expect(readComposerDraft(key)?.text).toBe(original)
  })

  it('keeps a blocked starter available when the browser has no clipboard API', async () => {
    await render(); await click('Use starter prompt 1'); await click('Use starter prompt 1')
    await click('Copy prompt')
    expect(document.body.textContent).toContain('Copy is unavailable')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe('Find the primary evidence.')
  })
})
