// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { AUTH_ERROR_CODES, createAuthError, type AuthenticatedApi, type PublicApi } from '@gadgets/workshop-shared/api'
import LoginPage from './LoginPage'
import { AutomaticOidcLogin, SignInReturn } from './AutomaticOidcLogin'
import ConnectHandoffPage from './ConnectHandoffPage'
import { RpcContext } from './RpcContext'
import { useAuth } from './useAuth'
import { loginNavigation, MANUAL_SIGN_IN_KEY, REDIRECT_LOGIN_KEY, REDIRECT_LOGIN_RECEIVED_KEY, readRedirectLoginReceived, requestedSignInReturn, safeReturnPath, startRedirectLogin, takeRedirectLogin, markRedirectLoginReceived } from './redirectLogin'
const loginConfig = vi.hoisted(() => ({ passwordAuthEnabled: false, authVendors: [{ vendorId: 'oidc', displayName: 'Example identity' }] }))
vi.mock('./ServerConfigContext', () => ({ useServerConfig: () => loginConfig, useServerConfigError: () => false, useSiteName: () => 'Example' }))
vi.mock('./errorReporting', () => ({ setReportedUserId: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NONCE = 'a'.repeat(64), SECRET = 'b'.repeat(64), TICKET = 'c'.repeat(64)
const RETURN = '/gatekeeper/subscription#connection=owner'
const URL = 'http://localhost:3000/gatekeeper/oidc/fixture/start'
let root: Root | undefined
let container: HTMLDivElement
const navigate = vi.fn<(url: string) => void>()
const startGatekeeperLogin = vi.fn().mockResolvedValue({ mode: 'redirect', url: URL, nonce: NONCE, resumeSecret: SECRET })
const api = { startGatekeeperLogin } as unknown as RpcStub<PublicApi>
const proof = (overrides = {}) => ({ nonce: NONCE, resumeSecret: SECRET, returnTo: RETURN, expiresAt: Date.now() + 30 * 60 * 1000, ...overrides })
async function mount(page: ReactNode) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(page))
}
beforeEach(() => {
  vi.spyOn(loginNavigation, 'replace').mockImplementation(navigate)
  vi.spyOn(window, 'open').mockReturnValue(null)
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  act(() => root?.unmount()); root = undefined; container?.remove()
  loginConfig.authVendors = [{ vendorId: 'oidc', displayName: 'Example identity' }]
  sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); navigate.mockReset(); startGatekeeperLogin.mockClear()
})
describe('safe same-tab login return', () => {
  it('automatically enters the sole configured OIDC provider from the real native login page', async () => {
    window.history.replaceState(null, '', '/providers')
    await mount(<RpcContext.Provider value={{ stub: api, connectionLost: false }}><LoginPage rpcStub={api} automaticOidc /></RpcContext.Provider>)
    expect(startGatekeeperLogin).toHaveBeenCalledExactlyOnceWith('oidc', 'redirect')
    expect(takeRedirectLogin()?.returnTo).toBe('/providers')
    expect(window.open).not.toHaveBeenCalled()
  })
  it('keeps inline sign-in as a manual popup flow', async () => {
    await mount(<RpcContext.Provider value={{ stub: api, connectionLost: false }}><LoginPage rpcStub={api} /></RpcContext.Provider>)
    expect(startGatekeeperLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Continue with Example identity')
  })
  it('keeps multiple configured providers as manual popup buttons', async () => {
    loginConfig.authVendors.push({ vendorId: 'github', displayName: 'Example alternate' })
    await mount(<RpcContext.Provider value={{ stub: api, connectionLost: false }}><LoginPage rpcStub={api} automaticOidc /></RpcContext.Provider>)
    expect(startGatekeeperLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Continue with Example identity')
    expect(container.textContent).toContain('Continue with Example alternate')
  })
  it('allows normalized native routes and bounded subscription fragments only', () => {
    for (const value of ['/', '/providers', '/workspace/42?chat=3#message', RETURN, '/gatekeeper/subscription#add']) expect(safeReturnPath(value)).toBe(value)
    for (const value of ['https://external.invalid/', '//external.invalid/', '/\\external.invalid/', '/workspace/../connect/handoff', '/connect/handoff',
      '/gatekeeper/oidc/oauth', '/api', '/auth/callback', '/signup', '/cdn-cgi/access/logout', '/%2fexternal.invalid', '/workspace/%2fexternal',
      '/workspace/%5cexternal', '/providers\n', '/providers#%00', '/providers#%7f', '/?sign_in=oidc', '/?return_to=%2f',
      '/gatekeeper/subscription?token=x', '/gatekeeper/subscription#connection=unknown', '/providers#' + 'a'.repeat(2048)]) expect(safeReturnPath(value), value).toBeNull()
    expect(requestedSignInReturn(`?sign_in=oidc&return_to=${encodeURIComponent(RETURN)}`)).toBe(RETURN)
    expect(requestedSignInReturn('?sign_in=oidc&return_to=https%3A%2F%2Fexternal.invalid')).toBe('/')
    expect(requestedSignInReturn('?sign_in=other&return_to=%2f')).toBeNull()
    expect(requestedSignInReturn('?sign_in=oidc&sign_in=oidc&return_to=%2f')).toBeNull()
  })
  it('stores the independent proof before navigation without putting either secret in a URL', async () => {
    window.opener = window
    await startRedirectLogin(api, RETURN)
    expect(window.opener).toBeNull()
    expect(startGatekeeperLogin).toHaveBeenCalledExactlyOnceWith('oidc', 'redirect')
    expect(navigate).toHaveBeenCalledExactlyOnceWith(URL)
    expect(navigate.mock.calls[0][0]).not.toContain(SECRET)
    expect(navigate.mock.calls[0][0]).not.toContain(NONCE)
    expect(takeRedirectLogin()).toMatchObject({ nonce: NONCE, resumeSecret: SECRET, returnTo: RETURN })
    expect(takeRedirectLogin()).toBeNull(); expect(window.open).not.toHaveBeenCalled()
  })
  it('spends malformed, expired or external return records without using them', () => {
    for (const record of [proof({ resumeSecret: SECRET.toUpperCase() }), proof({ returnTo: '//external.invalid' }), proof({ expiresAt: Date.now() - 1 }),
      proof({ expiresAt: Date.now() + 31 * 60 * 1000 }), { nonce: NONCE }]) {
      sessionStorage.setItem(REDIRECT_LOGIN_KEY, JSON.stringify(record))
      expect(takeRedirectLogin()).toBeNull(); expect(sessionStorage.getItem(REDIRECT_LOGIN_KEY)).toBeNull()
    }
  })
  it('automatically starts once under StrictMode and preserves the requested protected destination', async () => {
    window.history.replaceState(null, '', `/?sign_in=oidc&return_to=${encodeURIComponent(RETURN)}`)
    await mount(<StrictMode><AutomaticOidcLogin rpcStub={api} /></StrictMode>)
    expect(startGatekeeperLogin).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledExactlyOnceWith(URL)
    expect(takeRedirectLogin()?.returnTo).toBe(RETURN); expect(window.open).not.toHaveBeenCalled()
  })
  it('requires a manual retry when a newly delivered native session is rejected again', async () => {
    markRedirectLoginReceived('/providers')
    await mount(<AutomaticOidcLogin rpcStub={api} />)
    expect(startGatekeeperLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Continue when you are ready')
    expect(sessionStorage.getItem(REDIRECT_LOGIN_KEY)).toBeNull()
  })
  it.each([RETURN, '/gatekeeper/subscription#add'])('keeps a subscription rejection marker even when the native session is valid (%s)', async (returnTo) => {
    markRedirectLoginReceived(RETURN)
    const whoami = vi.fn().mockResolvedValue({ type: 'user', id: 'owner@example.invalid', name: 'Owner' })
    window.history.replaceState(null, '', `/?sign_in=oidc&return_to=${encodeURIComponent(returnTo)}`)
    await mount(<SignInReturn authenticatedApi={{ whoami } as unknown as RpcStub<AuthenticatedApi>} returnTo={returnTo} rpcStub={api} />)
    expect(navigate).not.toHaveBeenCalled()
    expect(startGatekeeperLogin).not.toHaveBeenCalled()
    expect(whoami).not.toHaveBeenCalled()
    expect(readRedirectLoginReceived()?.returnTo).toBe(RETURN)
    await act(async () => container.querySelector('button')!.click())
    expect(startGatekeeperLogin).toHaveBeenCalledExactlyOnceWith('oidc', 'redirect')
    expect(readRedirectLoginReceived()).toBeNull()
  })
  it('does not store secrets or navigate when the start RPC resolves after unmount', async () => {
    let resolve!: (flow: unknown) => void
    const pending = new Promise(done => { resolve = done })
    const start = vi.fn().mockReturnValue(pending)
    await mount(<StrictMode><AutomaticOidcLogin rpcStub={{ startGatekeeperLogin: start } as unknown as RpcStub<PublicApi>} /></StrictMode>)
    expect(start).toHaveBeenCalledOnce()
    act(() => root!.unmount()); root = undefined
    await act(async () => resolve({ mode: 'redirect', url: URL, nonce: NONCE, resumeSecret: SECRET }))
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(REDIRECT_LOGIN_KEY)).toBeNull()
    expect(localStorage.getItem('authToken')).toBeNull()
  })
  it('requires a manual retry after cancellation instead of automatically looping', async () => {
    sessionStorage.setItem(REDIRECT_LOGIN_KEY, JSON.stringify(proof()))
    await mount(<AutomaticOidcLogin rpcStub={api} />)
    expect(startGatekeeperLogin).not.toHaveBeenCalled(); expect(container.textContent).toContain('Continue when you are ready')
    expect(sessionStorage.getItem(REDIRECT_LOGIN_KEY)).toBeNull()
    await act(async () => container.querySelector('button')!.click())
    expect(startGatekeeperLogin).toHaveBeenCalledOnce()
  })
  it('lets the native authority validate and return a native destination after receipt', async () => {
    markRedirectLoginReceived('/providers')
    const whoami = vi.fn().mockResolvedValue({ type: 'user', id: 'owner@example.invalid', name: 'Owner' })
    await mount(<SignInReturn authenticatedApi={{ whoami } as unknown as RpcStub<AuthenticatedApi>} returnTo="/providers" rpcStub={api} />)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/providers')
    expect(startGatekeeperLogin).not.toHaveBeenCalled()
  })
  it('waits for a valid existing session before returning without starting another sign-in', async () => {
    let resolve!: () => void
    const whoami = vi.fn(() => new Promise<void>(done => { resolve = done }))
    await mount(<SignInReturn authenticatedApi={{ whoami } as unknown as RpcStub<AuthenticatedApi>} returnTo={RETURN} rpcStub={api} />)
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => resolve())
    expect(navigate).toHaveBeenCalledExactlyOnceWith(RETURN); expect(startGatekeeperLogin).not.toHaveBeenCalled()
  })
  it('confirms, resumes with the independent proof, receives once and returns in the same tab', async () => {
    sessionStorage.setItem(REDIRECT_LOGIN_KEY, JSON.stringify(proof()))
    window.history.replaceState(null, '', `/connect/handoff#${TICKET}`)
    const confirmLogin = vi.fn().mockResolvedValue(undefined), receive = vi.fn().mockResolvedValue('owner@example.invalid:fixture-session')
    const dispose = vi.fn(), resumeGatekeeperLogin = vi.fn().mockResolvedValue({ receive, [Symbol.dispose]: dispose })
    const stub = { confirmLogin, resumeGatekeeperLogin } as unknown as RpcStub<PublicApi>
    await mount(<StrictMode><RpcContext.Provider value={{ stub, connectionLost: false }}><ConnectHandoffPage /></RpcContext.Provider></StrictMode>)
    expect(confirmLogin).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    expect(resumeGatekeeperLogin).toHaveBeenCalledExactlyOnceWith(NONCE, SECRET)
    expect(confirmLogin.mock.invocationCallOrder[0]).toBeLessThan(resumeGatekeeperLogin.mock.invocationCallOrder[0])
    expect(receive).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce()
    expect(localStorage.getItem('authToken')).toBe('owner@example.invalid:fixture-session')
    expect(navigate).toHaveBeenCalledExactlyOnceWith(RETURN); expect(window.location.hash).toBe('')
    expect(sessionStorage.getItem(REDIRECT_LOGIN_KEY)).toBeNull(); expect(window.open).not.toHaveBeenCalled()
    expect(readRedirectLoginReceived()?.returnTo).toBe(RETURN)
    expect(sessionStorage.getItem(REDIRECT_LOGIN_RECEIVED_KEY)).not.toContain(SECRET)
    expect(sessionStorage.getItem(REDIRECT_LOGIN_RECEIVED_KEY)).not.toContain(NONCE)
  })
  it('does not resume a rejected ticket, clears proof, and provides a manual retry', async () => {
    sessionStorage.setItem(REDIRECT_LOGIN_KEY, JSON.stringify(proof()))
    window.history.replaceState(null, '', `/connect/handoff#${TICKET}`)
    const confirmLogin = vi.fn().mockRejectedValue(new Error('Sign-in was denied.')), resumeGatekeeperLogin = vi.fn()
    const stub = { confirmLogin, resumeGatekeeperLogin } as unknown as RpcStub<PublicApi>
    await mount(<RpcContext.Provider value={{ stub, connectionLost: false }}><ConnectHandoffPage /></RpcContext.Provider>)
    expect(container.textContent).toContain('Sign-in was denied.')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(`/?sign_in=oidc&return_to=${encodeURIComponent(RETURN)}`)
    expect(resumeGatekeeperLogin).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
    expect(localStorage.getItem('authToken')).toBeNull(); expect(sessionStorage.getItem(REDIRECT_LOGIN_KEY)).toBeNull()
  })
})
describe('explicit logout and received-marker scope', () => {
  it('keeps an explicit logout signed out until a deliberate sign-in click', async () => {
    localStorage.setItem('authToken', 'owner@example.invalid:fixture-session')
    const stub = { startGatekeeperLogin, authenticate: () => ({
      whoami: async () => ({ type: 'user', id: 'owner@example.invalid', name: 'Owner' }), [Symbol.dispose]() {},
    }) } as unknown as RpcStub<PublicApi>
    function Session() {
      const auth = useAuth(stub)
      if (auth.isLoading) return null
      return auth.isAuthenticated ? <button onClick={auth.logout}>Sign out</button> : <AutomaticOidcLogin rpcStub={stub} />
    }
    await mount(<Session />)
    await act(async () => container.querySelector('button')!.click())
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(sessionStorage.getItem(MANUAL_SIGN_IN_KEY)).toBe('logout')
    expect(startGatekeeperLogin).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => container.querySelector('button')!.click())
    expect(startGatekeeperLogin).toHaveBeenCalledExactlyOnceWith('oidc', 'redirect')
    expect(sessionStorage.getItem(MANUAL_SIGN_IN_KEY)).toBeNull()
  })
  it.each([RETURN, '/providers'])('native verification clears only native destination markers (%s)', async (returnTo) => {
    const token = 'owner@example.invalid:fixture-session'
    localStorage.setItem('authToken', token)
    markRedirectLoginReceived(returnTo)
    const stub = { authenticate: () => ({ whoami: async () => ({ type: 'user', id: 'owner@example.invalid', name: 'Owner' }), [Symbol.dispose]() {} }) } as unknown as RpcStub<PublicApi>
    function Session() { useAuth(stub); return null }
    await mount(<Session />)
    expect(readRedirectLoginReceived()?.returnTo ?? null).toBe(returnTo === RETURN ? RETURN : null)
  })
  it('removes an expired received marker without treating it as receipt authority', () => {
    sessionStorage.setItem(REDIRECT_LOGIN_RECEIVED_KEY, JSON.stringify({ returnTo: RETURN, expiresAt: Date.now() - 1 }))
    expect(readRedirectLoginReceived()).toBeNull()
    expect(sessionStorage.getItem(REDIRECT_LOGIN_RECEIVED_KEY)).toBeNull()
  })
})
describe('native expired-session recovery', () => {
  it.each([true, false])('clears only invalid sessions and preserves denial failures (invalid=%s)', async (invalid) => {
    const error = invalid ? createAuthError(AUTH_ERROR_CODES.invalidSessionToken) : new Error('Permission denied')
    const stub = { authenticate: () => ({ whoami: async () => { throw error }, [Symbol.dispose]() {} }) } as unknown as RpcStub<PublicApi>
    localStorage.setItem('authToken', 'owner@example.invalid:old-session')
    function Status() { return <p>{useAuth(stub).isAuthenticated ? 'authenticated' : 'signed out'}</p> }
    await mount(<Status />)
    expect(container.textContent).toBe(invalid ? 'signed out' : 'authenticated')
    expect(localStorage.getItem('authToken')).toBe(invalid ? null : 'owner@example.invalid:old-session')
  })
})
