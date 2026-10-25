import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotProfile, BotProfileInput } from '@gadgets/workshop-shared/api'

export type BotProfilesApi = {
  listBotProfiles(): Promise<BotProfile[]>
  saveBotProfile(input: BotProfileInput, expectedRevision: number): Promise<BotProfile>
}
export type BotCatalogStatus = 'loading' | 'ready' | 'error'

export function botProfileInput(profile: BotProfile): BotProfileInput {
  return { id: profile.id, name: profile.name, description: profile.description, instructions: profile.instructions,
    icon: profile.icon, starterPrompts: [...profile.starterPrompts], memory: profile.memory, archived: profile.archived }
}

export function useBotProfiles(api: Pick<BotProfilesApi, 'listBotProfiles'>) {
  const [profiles, setProfiles] = useState<BotProfile[]>([])
  const [status, setStatus] = useState<BotCatalogStatus>('loading')
  const [loadedFor, setLoadedFor] = useState<typeof api | null>(null)
  const epoch = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++epoch.current
    setStatus('loading')
    try {
      const next = await api.listBotProfiles()
      if (request !== epoch.current) return
      setProfiles(next); setLoadedFor(api); setStatus('ready')
      return next
    } catch {
      if (request === epoch.current) { setLoadedFor(api); setStatus('error') }
    }
  }, [api])
  useEffect(() => {
    setProfiles([]); setLoadedFor(null)
    void refresh()
    return () => { epoch.current++ }
  }, [refresh])
  const upsert = useCallback((profile: BotProfile) => {
    epoch.current++
    setProfiles(current => [...current.filter(item => item.id !== profile.id), profile])
    setLoadedFor(api); setStatus('ready')
  }, [api])
  return { profiles: loadedFor === api ? profiles : [], status: loadedFor === api ? status : 'loading' as BotCatalogStatus, refresh, upsert }
}
