// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotProfile, MainBotSelection } from '@gadgets/workshop-shared/api'
import { useBotProfiles, type BotProfilesApi } from './botProfiles'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const selection = (botId: string | null, revision: number): MainBotSelection => ({ key: 'main', botId, revision })
const profile = (id: string): BotProfile => ({ id, name: 'Synthetic bot', description: '', instructions: '',
  icon: 'spark', starterPrompts: [], memory: 'off', archived: false, revision: 1,
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function apiFor(id: string, main: MainBotSelection): BotProfilesApi {
  return { listBotProfiles: async () => [profile(id)], getMainBot: async () => main,
    setMainBot: async botId => selection(botId, main.revision + 1),
    saveBotProfile: async () => { throw new Error('Not used') } }
}

describe('account bot catalog', () => {
  let root: Root
  let catalog: ReturnType<typeof useBotProfiles>
  function Probe({ api }: { api: BotProfilesApi }) { catalog = useBotProfiles(api); return null }
  const render = async (api: BotProfilesApi) => { await act(async () => root.render(createElement(Probe, { api }))) }
  beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement('div'))) })
  afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = '' })

  it('ignores a main-bot save completed after the authenticated account changes', async () => {
    const pending = deferred<MainBotSelection>()
    const first = apiFor(A, selection(null, 0))
    first.setMainBot = () => pending.promise
    await render(first)
    let save!: Promise<MainBotSelection>
    await act(async () => { save = catalog.selectMain(A) })
    await render(apiFor(B, selection(B, 5)))
    await act(async () => { pending.resolve(selection(A, 1)); await save })
    expect(catalog.profiles.map(bot => bot.id)).toEqual([B])
    expect(catalog.mainBot).toEqual(selection(B, 5))
  })

  it('keeps a saved main bot when an older refresh finishes afterward', async () => {
    const pendingSave = deferred<MainBotSelection>()
    const pendingRead = deferred<MainBotSelection>()
    const api = apiFor(A, selection(null, 0))
    api.setMainBot = () => pendingSave.promise
    await render(api)
    let save!: Promise<MainBotSelection>
    let refresh!: ReturnType<typeof catalog.refresh>
    await act(async () => { save = catalog.selectMain(A) })
    api.getMainBot = () => pendingRead.promise
    await act(async () => { refresh = catalog.refresh() })
    await act(async () => { pendingSave.resolve(selection(A, 1)); await save })
    await act(async () => { pendingRead.resolve(selection(null, 0)); await refresh })
    expect(catalog.status).toBe('ready')
    expect(catalog.mainBot).toEqual(selection(A, 1))
  })

  it.each(['loading', 'ready'] as const)('ignores an old account profile save while the new catalog is %s', async phase => {
    await render(apiFor(A, selection(A, 1)))
    const oldUpsert = catalog.upsert
    const pending = deferred<BotProfile[]>()
    const next = apiFor(B, selection(B, 5))
    next.listBotProfiles = () => pending.promise
    await render(next)
    if (phase === 'ready') await act(async () => pending.resolve([profile(B)]))
    await act(async () => oldUpsert(profile(A)))
    if (phase === 'loading') await act(async () => pending.resolve([profile(B)]))
    expect(catalog.status).toBe('ready')
    expect(catalog.profiles.map(bot => bot.id)).toEqual([B])
    expect(catalog.mainBot).toEqual(selection(B, 5))
  })

  it('ignores a refresh callback retained by a previous account', async () => {
    await render(apiFor(A, selection(A, 1)))
    const oldRefresh = catalog.refresh
    await render(apiFor(B, selection(B, 5)))
    await act(async () => { await oldRefresh() })
    expect(catalog.status).toBe('ready')
    expect(catalog.profiles.map(bot => bot.id)).toEqual([B])
    expect(catalog.mainBot).toEqual(selection(B, 5))
  })

  it('rejects a main-bot save callback retained by a previous account', async () => {
    await render(apiFor(A, selection(A, 1)))
    const oldSelect = catalog.selectMain
    await render(apiFor(B, selection(null, 0)))
    await act(async () => { await expect(oldSelect(A)).rejects.toThrow(/unavailable/i) })
    expect(catalog.profiles.map(bot => bot.id)).toEqual([B])
    expect(catalog.mainBot).toEqual(selection(null, 0))
  })
})
