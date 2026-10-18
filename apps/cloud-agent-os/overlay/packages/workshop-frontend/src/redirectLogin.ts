import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

export const REDIRECT_LOGIN_KEY = 'gadgets.redirect-login'
export const REDIRECT_LOGIN_RECEIVED_KEY = 'gadgets.redirect-login-received'
export const MANUAL_SIGN_IN_KEY = 'gadgets.manual-sign-in'
const LIFETIME_MS = 30 * 60 * 1000
const HEX_SECRET = /^[0-9a-f]{64}$/
const NATIVE_PATH = /^\/(?:$|(?:admin|blueprints|context|explore|gatekeepers|outputs|profile|providers|workspaces)$|(?:workspace|gadget|gatekeepers)\/[^/]+$|launch$)/

type RedirectLogin = {
  nonce: string
  resumeSecret: string
  returnTo: string
  expiresAt: number
}

/** Allow only normalized native pages and the protected subscription document on this origin. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return null
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return null }
  if (/[\\\u0000-\u0020\u007f-\u009f]/.test(value) || /[\\\u0000-\u001f\u007f-\u009f]/.test(decoded)) return null
  const url = new URL(value, window.location.origin)
  if (url.origin !== window.location.origin || `${url.pathname}${url.search}${url.hash}` !== value) return null
  if (url.searchParams.has('sign_in') || url.searchParams.has('return_to')) return null
  if (url.pathname === '/gatekeeper/subscription') {
    if (url.search || (url.hash && url.hash !== '#add' && !/^#connection=(?:owner|account-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(url.hash))) return null
  } else if (!NATIVE_PATH.test(url.pathname) || /%2f|%5c/i.test(url.pathname)) return null
  return value
}

export function requestedSignInReturn(search: string): string | null {
  const query = new URLSearchParams(search)
  if (query.getAll('sign_in').length !== 1 || query.get('sign_in') !== 'oidc') return null
  if (query.getAll('return_to').length !== 1) return '/'
  return safeReturnPath(query.get('return_to')) ?? '/'
}

export function markRedirectLoginReceived(returnTo: string): void {
  sessionStorage.setItem(REDIRECT_LOGIN_RECEIVED_KEY, JSON.stringify({ returnTo, expiresAt: Date.now() + LIFETIME_MS }))
}

export function clearRedirectLoginReceived(): void {
  try { sessionStorage.removeItem(REDIRECT_LOGIN_RECEIVED_KEY) } catch { /* storage may be unavailable */ }
}

export function readRedirectLoginReceived(): { returnTo: string; expiresAt: number } | null {
  try {
    const raw = sessionStorage.getItem(REDIRECT_LOGIN_RECEIVED_KEY)
    if (raw === null) return null
    const parsed: unknown = raw.length <= 4096 ? JSON.parse(raw) : null
    if (typeof parsed === 'object' && parsed !== null && 'returnTo' in parsed && 'expiresAt' in parsed
      && typeof parsed.returnTo === 'string' && safeReturnPath(parsed.returnTo) !== null
      && typeof parsed.expiresAt === 'number' && Number.isSafeInteger(parsed.expiresAt)
      && parsed.expiresAt > Date.now() && parsed.expiresAt <= Date.now() + LIFETIME_MS) {
      return { returnTo: parsed.returnTo, expiresAt: parsed.expiresAt }
    }
  } catch { /* malformed or unavailable storage */ }
  clearRedirectLoginReceived()
  return null
}

export function markManualSignIn(): void {
  try { sessionStorage.setItem(MANUAL_SIGN_IN_KEY, 'logout') } catch { /* logout must still finish */ }
}

export function clearManualSignIn(): void {
  try { sessionStorage.removeItem(MANUAL_SIGN_IN_KEY) } catch { /* storage may be unavailable */ }
}

/** A native identity check does not prove a subscription administrator session is accepted. */
export function clearVerifiedNativeLoginMarkers(): void {
  if (!readRedirectLoginReceived()?.returnTo.startsWith('/gatekeeper/subscription')) clearRedirectLoginReceived()
  clearManualSignIn()
}

export function clearRedirectLogin(): void {
  try { sessionStorage.removeItem(REDIRECT_LOGIN_KEY) } catch { /* storage may be unavailable */ }
}

/** Read once; an untrusted URL never supplies receive authority. */
export function takeRedirectLogin(): RedirectLogin | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(REDIRECT_LOGIN_KEY)
    sessionStorage.removeItem(REDIRECT_LOGIN_KEY)
  } catch { return null }
  if (raw === null || raw.length > 4096) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || !('nonce' in parsed) || !('resumeSecret' in parsed)
    || !('returnTo' in parsed) || !('expiresAt' in parsed)) return null
  const { nonce, resumeSecret, returnTo, expiresAt } = parsed
  if (typeof nonce !== 'string' || !HEX_SECRET.test(nonce) || typeof resumeSecret !== 'string'
    || !HEX_SECRET.test(resumeSecret) || typeof returnTo !== 'string' || safeReturnPath(returnTo) === null
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()
    || expiresAt > Date.now() + LIFETIME_MS) return null
  return { nonce, resumeSecret, returnTo, expiresAt }
}

export async function startRedirectLogin(rpcStub: RpcStub<PublicApi>, returnTo: string,
  isActive: () => boolean = () => true): Promise<void> {
  if (!isActive()) return
  if (safeReturnPath(returnTo) === null) throw new Error('This sign-in destination is invalid.')
  // Fail before creating a flow when storage is blocked. Neither secret goes into a URL.
  sessionStorage.setItem(REDIRECT_LOGIN_KEY, '')
  sessionStorage.removeItem(REDIRECT_LOGIN_KEY)
  try {
    const flow = await rpcStub.startGatekeeperLogin('oidc', 'redirect')
    if (!isActive()) return
    if (flow.mode !== 'redirect') throw new Error('Could not start same-tab sign-in.')
    const url = new URL(flow.url, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/gatekeeper/oidc/')) {
      throw new Error('This sign-in destination is invalid.')
    }
    sessionStorage.setItem(REDIRECT_LOGIN_KEY, JSON.stringify({
      nonce: flow.nonce, resumeSecret: flow.resumeSecret, returnTo, expiresAt: Date.now() + LIFETIME_MS,
    } satisfies RedirectLogin))
    window.opener = null
    loginNavigation.replace(url.href)
  } catch (error) {
    if (!isActive()) return
    clearRedirectLogin()
    throw error
  }
}

export const loginNavigation = { replace: (url: string) => window.location.replace(url) }
