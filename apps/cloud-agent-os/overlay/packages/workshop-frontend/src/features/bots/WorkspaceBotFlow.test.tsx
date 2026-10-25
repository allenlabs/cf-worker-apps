// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotProfile, Overseer } from '@gadgets/workshop-shared/api'
import type { BotProfilesApi } from './botProfiles'

const bot: BotProfile = { id: '11111111-1111-4111-8111-111111111111', revision: 3, name: 'Synthetic main bot',
  description: '', instructions: '', icon: 'spark', starterPrompts: [], memory: 'off', archived: false,
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' }
const context = vi.hoisted(() => ({
  authenticatedApi: { listGatekeeperVendors: async () => [],
    listBotProfiles: vi.fn<BotProfilesApi['listBotProfiles']>(),
    getMainBot: vi.fn<NonNullable<BotProfilesApi['getMainBot']>>() },
  currentUser: null,
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }))
vi.mock('@cloudflare/kumo', async original => {
  const actual = await original<typeof import('@cloudflare/kumo')>()
  const parts = new Proxy(Pass, { get: (_target, key) => key === 'Root' ? () => null : Pass })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, Dialog: parts, Popover: parts, Tooltip: Pass, useKumoToastManager: () => toasts }
})
vi.mock('../chat/composer/ChatComposer', () => ({ ChatComposer: (props: {
  onModelChange: (id: null) => void; onSend: (message: string, model: null) => Promise<void>;
}) => <div><button onClick={() => props.onModelChange(null)}>Choose no agent</button>
  <button onClick={() => { void props.onSend('Synthetic task', null) }}>Submit draft</button></div> }))

import ChatInterface from '../../ChatInterface'
import { makeOverseer, makeTestRoot } from '../../action-test-harness'

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
Element.prototype.scrollTo = () => {}
const testRoot = makeTestRoot()
function Pass({ children }: { children?: React.ReactNode }) { return children ?? null }
afterEach(() => { testRoot.cleanup(); vi.clearAllMocks() })
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === text)
  if (!button) throw new Error(`Missing button ${text}`)
  await act(async () => button.click())
}
const picker = () => document.querySelector<HTMLSelectElement>('[aria-label="Choose bot"]')!

describe('workspace main bot defaults', () => {
  it('uses Standard for one draft and restores the main bot for the next draft in the same workspace', async () => {
    context.authenticatedApi.listBotProfiles.mockResolvedValue([bot])
    context.authenticatedApi.getMainBot.mockResolvedValue({ key: 'main', botId: bot.id, revision: 1 })
    const server = makeOverseer()
    const newChat = vi.fn<Overseer['newChat']>(async () => 9)
    Object.assign(server.overseer, { newChat, getChatHistory: async () => ({ messages: [] }), listChats: async () => [],
      listModels: async () => [], onRpcBroken: () => {}, subscribeToChat: () => ({ [Symbol.dispose]: () => {} }) })
    await testRoot.render(<ChatInterface workspaceId="synthetic-workspace" overseer={server.overseer} selectedChatId={null}
      onNavigateToChat={() => {}} pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}} onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />)
    expect(picker().value).toBe(bot.id)
    await act(async () => { picker().value = ''; picker().dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Choose no agent'); await click('Submit draft')
    expect(newChat).toHaveBeenLastCalledWith('Synthetic task', null, undefined, undefined, undefined, false)
    expect(picker().value).toBe(bot.id)
    await click('Choose no agent'); await click('Submit draft')
    expect(newChat).toHaveBeenLastCalledWith('Synthetic task', null, undefined, undefined, undefined, false, { id: bot.id, revision: 3 })
  })
})
