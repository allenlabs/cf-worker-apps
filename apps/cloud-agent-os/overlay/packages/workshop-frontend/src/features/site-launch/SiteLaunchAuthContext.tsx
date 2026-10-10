import { createContext, useContext } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

type SiteLaunchAuth = {
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  onLoginSuccess: () => void
  onReauthenticate: () => void
  onLaunched: (result: SiteLaunchRedemption) => void
}

export const SiteLaunchAuthContext = createContext<SiteLaunchAuth | null>(null)

export const useSiteLaunchAuth = () => {
  const value = useContext(SiteLaunchAuthContext)
  if (!value) throw new Error('Site launch requires the application auth provider')
  return value
}
