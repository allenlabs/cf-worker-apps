import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotProfile, BotProfileInput, MainBotSelection } from '@gadgets/workshop-shared/api'

export type BotProfilesApi = {
  listBotProfiles(): Promise<BotProfile[]>
  saveBotProfile(input: BotProfileInput, expectedRevision: number): Promise<BotProfile>
  getMainBot?(): Promise<MainBotSelection>
  setMainBot?(botId: string | null, expectedRevision: number): Promise<MainBotSelection>
}
export type BotCatalogStatus = 'loading' | 'ready' | 'error'

export function botProfileInput(profile: BotProfile): BotProfileInput {
  return { id: profile.id, name: profile.name, description: profile.description, instructions: profile.instructions,
    icon: profile.icon, starterPrompts: [...profile.starterPrompts], memory: profile.memory, archived: profile.archived }
}

export function useBotProfiles(api: Pick<BotProfilesApi, 'listBotProfiles'>) {
  const [profiles, setProfiles] = useState<BotProfile[]>([])
  const [status, setStatus] = useState<BotCatalogStatus>('loading')
  const [mainBot, setMainBotState] = useState<MainBotSelection | null>(null)
  const [loadedFor, setLoadedFor] = useState<typeof api | null>(null)
  const epoch = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++epoch.current
    setStatus('loading')
    try {
      const [next, main] = await Promise.all([
        api.listBotProfiles(),
        api.getMainBot?.() ?? Promise.resolve({ key: 'main' as const, botId: null, revision: 0 }),
      ])
      if (request !== epoch.current) return
      setProfiles(next); setMainBotState(main); setLoadedFor(api); setStatus('ready')
      return next
    } catch {
      if (request === epoch.current) { setLoadedFor(api); setStatus('error') }
    }
  }, [api])
  useEffect(() => {
    setProfiles([]); setMainBotState(null); setLoadedFor(null)
    void refresh()
    return () => { epoch.current++ }
  }, [refresh])
  const upsert = useCallback((profile: BotProfile) => {
    epoch.current++
    setProfiles(current => [...current.filter(item => item.id !== profile.id), profile])
    if (profile.archived) setMainBotState(current => current?.botId === profile.id
      ? { key: 'main', botId: null, revision: current.revision + 1 } : current)
    setLoadedFor(api); setStatus('ready')
  }, [api])
  const selectMain = useCallback(async (botId: string | null) => {
    if (!api.setMainBot || !mainBot || loadedFor !== api || status !== 'ready') {
      throw new Error('Main bot settings are unavailable. Refresh and try again.')
    }
    const result = await api.setMainBot(botId, mainBot.revision)
    setMainBotState(result)
    return result
  }, [api, mainBot, loadedFor, status])
  return { profiles: loadedFor === api ? profiles : [],
    mainBot: loadedFor === api ? mainBot : null,
    status: loadedFor === api ? status : 'loading' as BotCatalogStatus, refresh, upsert, selectMain }
}
