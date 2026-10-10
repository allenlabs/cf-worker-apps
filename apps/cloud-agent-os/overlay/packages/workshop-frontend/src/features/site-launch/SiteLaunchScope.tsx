import { useState, createContext, useContext, type ReactNode } from 'react'
import { Navigate } from '@tanstack/react-router'
import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

// Presentation scope only: all workspace access and site identity remain server-verified.
export const SiteLaunchScopeContext = createContext<SiteLaunchRedemption | null>(null)
export const useSiteLaunchScope = () => useContext(SiteLaunchScopeContext)

export const useSiteLaunchSelection = (pathname: string) => {
  const [state, setState] = useState<{ pathname: string; selection: SiteLaunchRedemption | null }>({ pathname, selection: null })
  if (state.pathname !== pathname) {
    setState({ pathname, selection: pathname === '/launch' ? null : state.selection })
  }
  return {
    selection: pathname === '/launch' && state.pathname !== pathname ? null : state.selection,
    onLaunched: (selection: SiteLaunchRedemption) => setState({ pathname, selection }),
    clearSelection: () => setState({ pathname, selection: null }),
  }
}

export const SiteLaunchRouteGuard = ({ pathname, selection, embedded, children }: {
  pathname: string; selection: SiteLaunchRedemption | null; embedded: boolean; children: ReactNode
}) => {
  if (!embedded || pathname === '/launch') return <>{children}</>
  if (!selection) return <Navigate to="/launch" replace search={{}} hash="" />
  const currentWorkspace = pathname === `/workspace/${encodeURIComponent(selection.workspaceId)}`
  const accountManagement = ['/profile', '/providers', '/admin', '/gatekeepers', '/context'].includes(pathname)
    || pathname.startsWith('/gatekeepers/')
  if (!currentWorkspace && !accountManagement) return (
    <Navigate to="/workspace/$id" params={{ id: selection.workspaceId }} replace search={{}} hash="" />
  )
  return <>{children}</>
}
