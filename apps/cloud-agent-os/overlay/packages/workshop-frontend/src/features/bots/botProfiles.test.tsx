// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotProfile, BotProfileInput, MainBotSelection } from '@gadgets/workshop-shared/api'
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
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function apiFor(id: string, main: MainBotSelection): BotProfilesApi {
  return { listBotProfiles: async () => [profile(id)], getMainBot: async () => main,
    setMainBot: async botId => selection(botId, main.revision + 1),
    saveBotProfile: async () => { throw new Error('Not used') } }
}

describe('account bot catalog', () => {
  let root: Root
  const stubs: Disposable[] = []
  const rpcFor = (api: BotProfilesApi) => {
    const stub = new RpcStub(new class extends RpcTarget implements BotProfilesApi {
      listBotProfiles() { return api.listBotProfiles() }
      saveBotProfile(input: BotProfileInput, revision: number) { return api.saveBotProfile(input, revision) }
      getMainBot() { return api.getMainBot!() }
      setMainBot(botId: string | null, revision: number) { return api.setMainBot!(botId, revision) }
    }())
    stubs.push(stub)
    return stub
  }
  let catalog: ReturnType<typeof useBotProfiles>
  function Probe({ api }: { api: BotProfilesApi }) { catalog = useBotProfiles(api); return null }
  const render = async (api: BotProfilesApi) => { await act(async () => root.render(createElement(Probe, { api }))) }
  beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement('div'))) })
  afterEach(async () => {
    await act(async () => root.unmount()); document.body.innerHTML = ''
    for (const stub of stubs.splice(0)) stub[Symbol.dispose]()
  })

  it('loads a callable RPC catalog and keeps the saved profile visible after upsert', async () => {
    await render(rpcFor(apiFor(A, selection(A, 1))))
    expect(catalog.status).toBe('ready')
    expect(catalog.profiles.map(bot => bot.id)).toEqual([A])
    await act(async () => catalog.upsert({ ...profile(A), name: 'Updated role', revision: 2 }))
    expect(catalog.status).toBe('ready')
    expect(catalog.profiles[0].name).toBe('Updated role')
  })

  it('hides the previous callable RPC account while its replacement is loading', async () => {
    await render(rpcFor(apiFor(A, selection(A, 1))))
    const pending = deferred<BotProfile[]>()
    const next = apiFor(B, selection(B, 5))
    next.listBotProfiles = () => pending.promise
    await render(rpcFor(next))
    expect(catalog.status).toBe('loading')
    expect(catalog.profiles).toEqual([])
    expect(catalog.mainBot).toBeNull()
    await act(async () => pending.resolve([profile(B)]))
    expect(catalog.status).toBe('ready')
    expect(catalog.profiles.map(bot => bot.id)).toEqual([B])
    expect(catalog.mainBot).toEqual(selection(B, 5))
  })

  it.each(['success', 'failure'] as const)('ignores a stale callable RPC %s after changing accounts', async outcome => {
    const pending = deferred<BotProfile[]>()
    const first = apiFor(A, selection(A, 1))
    first.listBotProfiles = () => pending.promise
    await render(rpcFor(first))
    await render(rpcFor(apiFor(B, selection(B, 5))))
    await act(async () => {
      if (outcome === 'success') pending.resolve([profile(A)])
      else pending.reject(new Error('Old account unavailable'))
    })
    expect(catalog.status).toBe('ready')
    expect(catalog.profiles.map(bot => bot.id)).toEqual([B])
    expect(catalog.mainBot).toEqual(selection(B, 5))
  })

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
