import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'
import { clearManualSignIn, clearRedirectLogin, clearRedirectLoginReceived, loginNavigation, MANUAL_SIGN_IN_KEY, REDIRECT_LOGIN_KEY, readRedirectLoginReceived, requestedSignInReturn, safeReturnPath, startRedirectLogin, takeRedirectLogin } from './redirectLogin'

export function AutomaticOidcLogin({ rpcStub }: { rpcStub: RpcStub<PublicApi> }) {
  const started = useRef(false)
  const mounted = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const returnTo = requestedSignInReturn(window.location.search)
    ?? safeReturnPath(`${window.location.pathname}${window.location.search}${window.location.hash}`) ?? '/'
  const start = () => {
    if (!mounted.current) return
    clearRedirectLoginReceived()
    clearManualSignIn()
    setError(null)
    setPending(true)
    void startRedirectLogin(rpcStub, returnTo, () => mounted.current).catch((err: unknown) => {
      if (!mounted.current) return
      setError(err instanceof Error ? err.message : 'Could not sign in.')
      setPending(false)
    })
  }
  useEffect(() => {
    mounted.current = true
    if (!started.current) {
      started.current = true
      try {
        const previous = sessionStorage.getItem(REDIRECT_LOGIN_KEY)
        takeRedirectLogin()
        if (previous !== null || readRedirectLoginReceived() !== null || sessionStorage.getItem(MANUAL_SIGN_IN_KEY) !== null) {
          setError('Continue when you are ready to sign in.')
        } else start()
      } catch {
        setError('Allow site data in this browser to sign in.')
      }
    }
    return () => { mounted.current = false }
  }, [])
  return <div className="space-y-3 text-center">
    {error && <p role="alert">{error}</p>}
    {pending ? <p>Redirecting to sign in…</p>
      : <button className="underline" onClick={start}>Continue to sign in</button>}
  </div>
}

/** Validate a stored session before returning an explicit protected-page sign-in request. */
export function SignInReturn({ authenticatedApi, returnTo, rpcStub }: {
  authenticatedApi: RpcStub<AuthenticatedApi>; returnTo: string; rpcStub: RpcStub<PublicApi>
}) {
  const [error, setError] = useState(false)
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    let cancelled = false
    const received = readRedirectLoginReceived()
    if (received?.returnTo.startsWith('/gatekeeper/subscription') && returnTo.startsWith('/gatekeeper/subscription')) {
      setBlocked(true)
      return
    }
    authenticatedApi.whoami().then(() => {
      if (cancelled) return
      clearRedirectLogin()
      loginNavigation.replace(returnTo)
    }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [authenticatedApi, returnTo])
  if (blocked) return <AutomaticOidcLogin rpcStub={rpcStub} />
  return <div className="p-6 text-center">
    {error ? <><p role="alert">Could not verify your session.</p><button onClick={() => window.location.reload()}>Retry</button></>
      : <p>Returning to your page…</p>}
  </div>
}
