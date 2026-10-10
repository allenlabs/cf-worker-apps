import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useSiteLaunchScope } from './SiteLaunchScope'

export const WorkspaceHomeLink = ({ children }: { children: ReactNode }) => {
  const scope = useSiteLaunchScope()
  if (scope) return <span aria-label="Site workspace" className="flex-shrink-0">{children}</span>
  return <Link to="/" aria-label="Home" className="flex-shrink-0 hover:opacity-80 transition-opacity">{children}</Link>
}
