import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, SiteContext } from '@gadgets/workshop-shared/api'

export const WorkspaceSiteContext = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const [loaded, setLoaded] = useState<{ source: RpcStub<Overseer>; context: SiteContext | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const context = await overseer.getSiteContext()
        if (!cancelled) setLoaded({ source: overseer, context })
      } catch { /* Context is optional; unavailable metadata must not break the workspace. */ }
    })()
    return () => { cancelled = true }
  }, [overseer])

  const context = loaded?.source === overseer ? loaded.context : null
  if (!context) return null
  return (
    <section aria-label="Site context" className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-line bg-kumo-base px-4 py-2 text-xs text-kumo-subtle sm:px-6">
      <span className="font-medium text-kumo-default">{context.displayName}</span>
      <span>{context.environment.toUpperCase()}</span>
      <span>{context.timezone}</span>
    </section>
  )
}
