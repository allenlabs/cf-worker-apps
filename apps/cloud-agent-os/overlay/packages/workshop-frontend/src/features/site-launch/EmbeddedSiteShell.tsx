import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'
import UserMenu from '../../components/UserMenu'

export const EmbeddedSiteShell = ({ selection, children }: { selection: SiteLaunchRedemption; children: ReactNode }) => (
  <div className="flex h-full min-h-0 flex-col bg-kumo-base">
    <header className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link to="/workspace/$id" params={{ id: selection.workspaceId }} search={{}} hash=""
          className="font-medium text-kumo-link">Back to site workspace</Link>
        <span className="text-kumo-subtle">Account-wide settings</span>
      </div>
      <UserMenu />
    </header>
    <section aria-label="Selected site" className="flex flex-shrink-0 flex-wrap gap-3 border-b border-kumo-line px-4 py-2 text-xs text-kumo-subtle">
      <span className="font-medium text-kumo-default">{selection.siteContext.displayName}</span>
      <span>{selection.siteContext.environment.toUpperCase()}</span>
      <span>{selection.siteContext.timezone}</span>
    </section>
    <nav aria-label="Account settings" className="flex flex-shrink-0 flex-wrap gap-4 border-b border-kumo-line px-4 py-2 text-sm text-kumo-link">
      <Link to="/profile">Profile</Link>
      <Link to="/providers">Models</Link>
      <Link to="/gatekeepers">Connectors</Link>
      <Link to="/context">Context</Link>
    </nav>
    <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
  </div>
)
