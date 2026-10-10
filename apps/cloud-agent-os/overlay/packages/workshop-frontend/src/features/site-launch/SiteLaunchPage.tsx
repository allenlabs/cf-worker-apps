import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button, Loader } from '@cloudflare/kumo'
import LoginPage from '../../LoginPage'
import { useRpcStub } from '../../RpcContext'
import { useSiteLaunchAuth } from './SiteLaunchAuthContext'
import { parseSiteLaunchParentOrigins, SiteLaunchSession, type SiteLaunchState,
  type SiteLaunchResultCode } from './siteLaunch'

const ERROR_MESSAGES: Record<SiteLaunchResultCode, string> = {
  site_launch_sign_in_required: 'Sign in to your OS account to open this site.',
  site_launch_expired: 'This site launch has expired. Retry from the host application to request a fresh launch.',
  site_launch_invalid: 'This site launch is invalid. Retry from the host application to request a fresh launch.',
  site_launch_disabled: 'Site launch is disabled for this deployment.',
  site_launch_failed: 'Could not open this site. Retry from the host application to try again.',
  site_launch_unavailable: 'Site launch is unavailable for this deployment.',
}

export const SiteLaunchPage = () => {
  const config = import.meta.env.VITE_SITE_LAUNCH_PARENT_ORIGINS
  const parent = window.parent === window ? null : window.parent
  const allowedOrigins = parseSiteLaunchParentOrigins(config)
  const enabled = parent !== null && allowedOrigins.length > 0
  const { authenticatedApi, isLoading, onLoginSuccess, onReauthenticate, onLaunched } = useSiteLaunchAuth()
  const publicApi = useRpcStub()
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const onLaunchedRef = useRef(onLaunched)
  onLaunchedRef.current = onLaunched
  const sessionRef = useRef<SiteLaunchSession | null>(null)
  const [state, setState] = useState<SiteLaunchState>({ status: enabled ? 'waiting' : 'unavailable' })

  useEffect(() => {
    const session = new SiteLaunchSession({
      allowedOrigins: parseSiteLaunchParentOrigins(config), parent,
      post: (message, origin) => parent?.postMessage(message, origin),
      onState: setState,
      onWorkspace: result => {
        onLaunchedRef.current(result)
        void navigateRef.current({ to: '/workspace/$id', params: { id: result.workspaceId },
          search: {}, hash: '', replace: true })
      },
    })
    sessionRef.current = session
    const receive = (event: MessageEvent) => session.receive(event)
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      session.dispose()
      sessionRef.current = null
    }
  }, [config, parent])

  useEffect(() => {
    sessionRef.current?.setAuthentication(authenticatedApi, !isLoading)
  }, [authenticatedApi, isLoading, config, parent])

  if (!enabled) return (
    <div role="status" className="flex h-full items-center justify-center bg-kumo-base p-6 text-kumo-subtle">
      Site launch is unavailable for this deployment.
    </div>
  )

  if (!isLoading && !authenticatedApi) return (
    <div className="flex h-full flex-col bg-kumo-base">
      <p className="px-6 pt-6 text-center text-sm text-kumo-subtle">Sign in to your OS account to open this site.</p>
      <div className="min-h-0 flex-1"><LoginPage rpcStub={publicApi} onLoginSuccess={onLoginSuccess} /></div>
    </div>
  )

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-kumo-base p-6 text-center">
      {state.status === 'sign-in-required' ? (
        <>
          <p role="status" className="text-sm text-kumo-subtle">Sign in again to open this site with your current account.</p>
          <Button variant="primary" onClick={onReauthenticate}>Sign in again</Button>
        </>
      ) : state.status === 'error' ? (
        <p role="alert" className="text-sm text-kumo-danger">{ERROR_MESSAGES[state.code]}</p>
      ) : (
        <>
          <Loader size="lg" />
          <p role="status" className="text-sm text-kumo-subtle">
            {isLoading ? 'Checking your OS sign-in…' : state.status === 'busy' || state.status === 'ready'
              ? 'Opening this site workspace…' : 'Waiting for the site launch…'}
          </p>
        </>
      )}
    </div>
  )
}
