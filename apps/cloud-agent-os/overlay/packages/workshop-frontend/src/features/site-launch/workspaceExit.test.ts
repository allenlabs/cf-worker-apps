import { describe, expect, it, vi } from 'vitest'
import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'
import { exitWorkspace } from './workspaceExit'

const selection: SiteLaunchRedemption = { workspaceId: 'deleted-site-workspace', siteContext: {
  id: 'a', environment: 'production', displayName: 'Site A', timezone: 'Asia/Seoul',
} }

describe('workspace recovery exits', () => {
  it.each(['/', '/workspaces'] as const)('requests a fresh host launch for scoped exit %s rather than looping to deleted selection', target => {
    const actions = { reloadLaunch: vi.fn(), navigate: vi.fn() }
    exitWorkspace(selection, target, actions)
    expect(actions.reloadLaunch).toHaveBeenCalledOnce()
    expect(actions.navigate).not.toHaveBeenCalled()
  })
  it.each(['/', '/workspaces'] as const)('keeps standalone workspace exit %s', target => {
    const actions = { reloadLaunch: vi.fn(), navigate: vi.fn() }
    exitWorkspace(null, target, actions)
    expect(actions.navigate).toHaveBeenCalledWith(target)
    expect(actions.reloadLaunch).not.toHaveBeenCalled()
  })
})
