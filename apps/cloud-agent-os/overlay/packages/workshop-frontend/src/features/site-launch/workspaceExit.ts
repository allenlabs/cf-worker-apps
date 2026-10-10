import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

export const exitWorkspace = (selection: SiteLaunchRedemption | null, target: '/' | '/workspaces',
  actions: { reloadLaunch: () => void; navigate: (target: '/' | '/workspaces') => void }) => {
  // A deleted or unavailable scoped workspace requires a fresh host ticket, not another owner workspace.
  if (selection) actions.reloadLaunch()
  else actions.navigate(target)
}
