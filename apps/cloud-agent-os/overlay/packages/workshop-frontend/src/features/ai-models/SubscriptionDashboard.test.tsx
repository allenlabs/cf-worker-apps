// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionDashboard } from './SubscriptionDashboard'
import type { ConnectionStatus, QuotaReading, SubscriptionConnection } from './SubscriptionDashboardApi'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const checkedAt = '2026-10-19T00:00:00.000Z'
const window = { usedPercent: 85, windowSeconds: 18000, resetAt: Date.parse(checkedAt) / 1000 + 3600, resetAfterSeconds: 3600 }
const reading = (usedPercent = 85): QuotaReading => ({ checkedAt,
  account: { status: 'available', planType: 'pro', workspaceName: 'Example workspace', structure: 'personal' },
  usage: { status: 'available', planType: 'pro', allowed: true, limitReached: false,
    primaryWindow: { ...window, usedPercent }, secondaryWindow: { ...window, usedPercent: 12, windowSeconds: 604800 },
    credits: { unlimited: false, hasCredits: true, balance: '12.50' },
    additionalWindows: [{ id: 'example-model', name: 'Example model', allowed: false, limitReached: true, primaryWindow: { ...window, usedPercent: 100 }, secondaryWindow: null }] },
})
const id = (index: number) => index === 0 ? 'owner' : `account-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
const connection = (index = 0): SubscriptionConnection => ({ id: id(index), label: index ? `Connection ${index}` : 'Research',
  provider: 'codex', ready: true, identity: null, snapshot: reading(), lastAttempt: reading(),
  history: [{ checkedAt, planType: 'pro', primaryWindow: window, secondaryWindow: null, additionalWindows: [] }],
})
const status = (provider: 'codex' | 'siwc' = 'codex'): ConnectionStatus => ({ provider,
  inferenceReady: true, siwcInferenceReady: true, codexInferenceReady: true, loginPending: false, deviceFailed: false, identity: null, device: null, deviceLoginAvailable: true })
const response = (value: unknown, httpStatus = 200) => new Response(JSON.stringify(value), { status: httpStatus, headers: { 'content-type': 'application/json' } })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('native subscription dashboard', () => {
  let root: Root | undefined
  let saved: SubscriptionConnection[]
  let requests: { path: string; input: RequestInit; body: Record<string, unknown> }[]
  let route: (path: string, body: Record<string, unknown>) => Promise<Response>
  const onChanged = vi.fn(async () => {})
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(checkedAt)
    localStorage.clear()
    saved = [connection(), { ...connection(1), provider: 'siwc', ready: false, snapshot: null, lastAttempt: null, history: [] }]
    requests = []
    route = async (path, body) => {
      if (path === 'overview') return response({ connections: saved })
      if (path === 'account-info') { const result = reading(42); saved = saved.map(item => item.id === body.accountId ? { ...item, snapshot: result, lastAttempt: result } : item); return response(result) }
      if (path === 'connections/rename') { saved = saved.map(item => item.id === body.accountId ? { ...item, label: String(body.label) } : item); return response({ connections: saved }) }
      if (path === 'connections/delete') { saved = saved.filter(item => item.id !== body.accountId); return response({ connections: saved }) }
      if (path === 'connections/create') { const next = { ...connection(2), label: String(body.label), ready: false, snapshot: null, lastAttempt: null, history: [] }; saved.push(next); return response({ id: next.id, connections: saved }) }
      return response(status())
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (!init) throw new Error('Missing request options')
      const parsed: unknown = JSON.parse(String(init.body))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request body')
      const body = Object.fromEntries(Object.entries(parsed))
      const path = String(input).replace('/gatekeeper/subscription/', '')
      requests.push({ path, input: init, body })
      return route(path, body)
    }))
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); onChanged.mockClear()
  })
  const render = async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root?.render(<SubscriptionDashboard onChanged={onChanged} availability={(_id, label) => <span>Availability for {label}</span>} />))
  }
  const button = (label: string): HTMLButtonElement => {
    const result = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === label || item.textContent === label)
    if (!result) throw new Error(`Missing button ${label}`)
    return result
  }
  const click = async (label: string) => { await act(async () => button(label).click()) }
  const input = (label: string): HTMLInputElement => {
    const item = document.querySelector(`input[aria-label="${label}"]`)
    if (!(item instanceof HTMLInputElement)) throw new Error('Missing input')
    return item
  }
  const submit = async (field: HTMLInputElement, value: string) => {
    field.value = value
    await act(async () => field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  }

  it('compares all saved connections, actual quota durations, resets, separate credits and recorded history without fetching providers at mount', async () => {
    await render()
    expect(requests.map(item => item.path)).toEqual(['overview'])
    const text = document.body.textContent
    expect(text).toContain('Research'); expect(text).toContain('Connection 1')
    expect(text).toContain('Credentials ready'); expect(text).toContain('Credentials need connection')
    expect(text).toContain('5 hours quota'); expect(text).toContain('7 days quota')
    expect(text).toContain('85% used · 15% remaining'); expect(text).toContain('Resets in 1h 0m 0s')
    expect(text).toContain('12.50'); expect(text).toContain('Credits are separate')
    expect(text).toContain('Example model (example-model)'); expect(text).toContain('Quota limit reached')
    expect(text).toContain('SIWC does not supply subscription quota')
    expect(document.querySelector('progress')?.getAttribute('value')).toBe('85')
    expect(document.querySelector('table time')?.getAttribute('datetime')).toBe(checkedAt)
    expect(text).toContain('1 recorded samples'); expect(text).toContain('No quota history recorded yet')
    expect(text).toContain('at or below your 20% warning threshold')
    expect(localStorage.length).toBe(0)
  })

  it('keeps quota availability unknown when the provider supplies only a plan', async () => {
    const value: QuotaReading = { checkedAt, account: { status: 'unavailable', reason: 'unsupported_response', httpStatus: 200 },
      usage: { status: 'available', planType: 'pro', allowed: null, limitReached: null,
        primaryWindow: null, secondaryWindow: null, additionalWindows: [], credits: null } }
    saved = [{ ...connection(), snapshot: value, lastAttempt: value, history: [] }]
    await render()
    expect(document.body.textContent).toContain('Quota availability not supplied')
    expect(document.body.textContent).toContain('The provider did not supply quota windows')
    expect(document.body.textContent).not.toContain('Quota available')
    expect(document.querySelector('progress')).toBeNull()
  })

  it('renames and adds native connections, reloads settings, and reads the current OS bearer for each same-origin request', async () => {
    localStorage.setItem('authToken', 'synthetic-first-session')
    await render()
    localStorage.setItem('authToken', 'synthetic-second-session')
    await submit(input('Connection name for Research'), 'Work')
    expect(requests.find(item => item.path === 'connections/rename')?.body).toEqual({ accountId: 'owner', label: 'Work' })
    expect(document.body.textContent).toContain('Availability for Work')
    await submit(input('New subscription name'), 'Writing')
    expect(requests.find(item => item.path === 'connections/create')?.body).toEqual({ label: 'Writing' })
    expect(document.body.textContent).toContain('Writing')
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(new Headers(requests[0]?.input.headers).get('authorization')).toBe('Bearer synthetic-first-session')
    expect(new Headers(requests[1]?.input.headers).get('authorization')).toBe('Bearer synthetic-second-session')
    expect(requests.every(item => item.input.credentials === 'same-origin' && item.input.redirect === 'error')).toBe(true)
  })

  it('requires confirmation to delete a named connection and never offers deletion of the owner', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    await render()
    expect(Array.from(document.querySelectorAll('button')).some(item => item.getAttribute('aria-label') === 'Delete Research')).toBe(false)
    await click('Delete Connection 1')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Connection 1'))
    expect(requests.some(item => item.path === 'connections/delete')).toBe(false)
    expect(document.querySelector('article[aria-label="Subscription Connection 1"]')).not.toBeNull()
  })

  it('deletes the confirmed stable ID, stops its open setup, and reloads model choices', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    await render()
    await click('Connect Connection 1')
    const setupRequest = requests.find(item => item.path === 'status')
    expect(setupRequest?.input.signal?.aborted).toBe(false)
    await click('Delete Connection 1')
    expect(requests.find(item => item.path === 'connections/delete')?.body).toEqual({ accountId: id(1), confirmed: true })
    expect(setupRequest?.input.signal?.aborted).toBe(true)
    expect(document.querySelector('article[aria-label="Subscription Connection 1"]')).toBeNull()
    expect(document.querySelector('article[aria-label="Subscription Research"]')).not.toBeNull()
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('keeps a connection after deletion fails and prevents duplicate deletion requests', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    const pending = deferred<Response>()
    const normal = route
    route = async (path, body) => path === 'connections/delete' ? pending.promise : normal(path, body)
    await render()
    await click('Delete Connection 1')
    expect(button('Delete Connection 1').disabled).toBe(true)
    await click('Delete Connection 1')
    expect(requests.filter(item => item.path === 'connections/delete')).toHaveLength(1)
    await act(async () => pending.resolve(response({ error: 'subscription_account_in_use' }, 400)))
    expect(document.querySelector('article[aria-label="Subscription Connection 1"]')).not.toBeNull()
    expect(document.body.textContent).toContain('could not be confirmed')
    expect(document.body.textContent).not.toContain('subscription_account_in_use')
    expect(onChanged).not.toHaveBeenCalled()
    expect(button('Delete Connection 1').disabled).toBe(false)
  })

  it('does not report deletion success when the returned catalog still contains the selected ID', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    route = async () => response({ connections: saved })
    await render()
    await click('Delete Connection 1')
    expect(document.querySelector('article[aria-label="Subscription Connection 1"]')).not.toBeNull()
    expect(document.body.textContent).toContain('invalid response')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('preserves sign-in recovery if authorization expires while reloading after deletion', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    const normal = route
    let deleted = false
    route = async (path, body) => {
      if (path === 'overview' && deleted) return response({ error: 'unauthorized' }, 401)
      const result = await normal(path, body)
      if (path === 'connections/delete') deleted = true
      return result
    }
    await render()
    await click('Delete Connection 1')
    expect(document.body.textContent).toContain('Sign in to Cloudflare OS')
    expect(document.body.textContent).not.toContain('Subscription deleted, but settings could not be reloaded')
    expect(document.querySelector('article')).toBeNull()
  })

  it('refreshes a row and all Codex connections with at most three concurrent provider requests', async () => {
    saved = Array.from({ length: 5 }, (_, index) => connection(index))
    await render()
    await click('Refresh quota for Research')
    expect(document.body.textContent).toContain('42% used · 58% remaining')
    expect(requests.filter(item => item.path === 'account-info').map(item => item.body.accountId)).toEqual(['owner'])
    const pending = new Map<string, ReturnType<typeof deferred<Response>>>()
    let active = 0, maximum = 0
    route = async (path, body) => {
      if (path !== 'account-info') return response({ connections: saved })
      active++; maximum = Math.max(active, maximum)
      const next = deferred<Response>(); pending.set(String(body.accountId), next)
      const result = await next.promise; active--; return result
    }
    await click('Refresh all quotas')
    expect(pending.size).toBe(3)
    expect(button('Refresh quota for Connection 4').disabled).toBe(true)
    await act(async () => pending.get('owner')?.resolve(response(reading())))
    expect(pending.size).toBe(4)
    await act(async () => pending.get(id(1))?.resolve(response(reading())))
    expect(pending.size).toBe(5)
    await act(async () => { for (const next of pending.values()) next.resolve(response(reading())) })
    expect(maximum).toBe(3)
    expect(button('Refresh all quotas').disabled).toBe(false)
    expect(requests.filter(item => item.path === 'account-info')).toHaveLength(6)
  })

  it('keeps cached readings and exact timestamps on provider or transport failure, suppresses stale threshold warnings', async () => {
    const failed: QuotaReading = { checkedAt: '2026-10-19T00:01:00.000Z', account: { status: 'unavailable', reason: 'timeout', httpStatus: null }, usage: { status: 'unavailable', reason: 'http_error', httpStatus: 429 } }
    saved[0] = { ...connection(), lastAttempt: failed }
    await render()
    expect(document.body.textContent).toContain('Stale cached reading')
    expect(document.body.textContent).toContain('HTTP 429')
    expect(document.body.textContent).not.toContain('at or below your')
    expect(Array.from(document.querySelectorAll('time')).some(item => item.dateTime === checkedAt)).toBe(true)
    route = async path => path === 'account-info' ? response({ error: 'private_remote_error' }, 502) : response({ connections: saved })
    await click('Refresh quota for Research')
    expect(document.body.textContent).toContain('85% used · 15% remaining')
    expect(document.body.textContent).toContain('HTTP 502')
    expect(document.body.textContent).not.toContain('private_remote_error')
  })

  it('preserves the permission denial when a failed quota refresh is followed by a denied overview', async () => {
    await render()
    route = async path => response({ error: 'unavailable' }, path === 'account-info' ? 502 : 403)
    await click('Refresh quota for Research')
    expect(document.body.textContent).toContain('Your OS account cannot manage organization subscriptions')
    expect(document.body.textContent).not.toContain('Some quota requests failed')
    expect(document.body.textContent).not.toContain('Example workspace')
  })

  it.each([401, 403])('distinguishes OS sign-in recovery from a fixed permission denial (%s)', async httpStatus => {
    route = async () => response({ error: 'access_denied' }, httpStatus)
    await render()
    const signIn = document.querySelector('a[href="/?sign_in=oidc&return_to=%2Fadmin"]')
    expect(!!signIn).toBe(httpStatus === 401)
    expect(document.body.textContent).toContain(httpStatus === 401 ? 'Sign in to Cloudflare OS' : 'cannot manage organization subscriptions')
    expect(button('Add subscription').disabled).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it.each([401, 403])('clears protected readings and active connection details after authorization loss (%s)', async httpStatus => {
    localStorage.setItem('authToken', 'synthetic-os-session')
    saved[0] = { ...connection(), identity: { name: 'Example identity', email: 'reader@example.com', planType: 'pro', workspaceName: 'Example workspace', organizationNames: [], verifiedAt: checkedAt } }
    route = async path => path === 'overview' ? response({ connections: saved }) : response({ ...status(), identity: saved[0]?.identity })
    await render(); await click('Connect Research')
    expect(document.body.textContent).toContain('85% used · 15% remaining')
    expect(document.body.textContent).toContain('reader@example.com')
    route = async () => response({ error: 'access_denied' }, httpStatus)
    await click('Refresh quota for Research')
    expect(document.querySelector('article')).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('table')).toBeNull()
    expect(document.body.textContent).not.toContain('85% used')
    expect(document.body.textContent).not.toContain('Example workspace')
    expect(document.body.textContent).not.toContain('reader@example.com')
    expect(localStorage.getItem('authToken')).toBe(httpStatus === 401 ? null : 'synthetic-os-session')
    expect(button('Add subscription').disabled).toBe(true)
  })

  it('rejects C1 control characters in a connection label before making a mutation', async () => {
    await render()
    await submit(input('Connection name for Research'), 'Work\u0085name')
    expect(requests.some(item => item.path === 'connections/rename')).toBe(false)
    expect(document.body.textContent).toContain('without control characters')
  })

  it('ignores a stale account status after changing the connection and immediately clears callback codes', async () => {
    const oldStatus = deferred<Response>()
    const complete = deferred<Response>()
    route = async (path, body) => {
      if (path === 'overview') return response({ connections: saved })
      if (path === 'complete') return complete.promise
      if (path === 'status' && body.accountId === 'owner') return oldStatus.promise
      return response(status('siwc'))
    }
    await render()
    await click('Connect Research')
    await click('Connect Connection 1')
    await act(async () => oldStatus.resolve(response({ ...status(), identity: { name: 'Old account', email: 'old@example.com', planType: 'pro', workspaceName: null, organizationNames: [], verifiedAt: checkedAt } })))
    expect(document.body.textContent).not.toContain('old@example.com')
    const field = document.querySelector('textarea')
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing callback field')
    field.value = 'http://127.0.0.1:1455/auth/callback?code=synthetic-one-time-code&state=synthetic-state'
    await act(async () => field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(field.value).toBe('')
    expect(requests.find(item => item.path === 'complete')?.body.accountId).toBe(id(1))
    expect(localStorage.length).toBe(0)
    await act(async () => complete.resolve(response(status('siwc'))))
  })

  it('polls the exact official device URL at nextCheckAt, stops on account change and rejects unsafe authorization links', async () => {
    const next = Date.now() + 5000
    route = async (path, body) => {
      if (path === 'overview') return response({ connections: saved })
      if (path === 'device/start') return response({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234', expiresAt: new Date(next + 60000).toISOString(), nextCheckAt: new Date(next).toISOString() })
      if (path === 'start') return response({ authorizationUrl: 'https://untrusted.example.com/authorize' })
      return response(status(body.accountId === 'owner' ? 'codex' : 'siwc'))
    }
    await render(); await click('Connect Research')
    const start = button('Get OpenAI device code')
    const approval = start.form?.querySelector('input')
    if (!(approval instanceof HTMLInputElement)) throw new Error('Missing approval')
    approval.checked = true
    await act(async () => start.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(requests.find(item => item.path === 'device/start')?.body.planUsageConfirmed).toBe(true)
    expect(document.querySelector('a[href="https://auth.openai.com/codex/device"]')?.getAttribute('rel')).toBe('noopener noreferrer')
    await act(async () => vi.advanceTimersByTimeAsync(4999))
    expect(requests.some(item => item.path === 'device/check')).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(requests.filter(item => item.path === 'device/check')).toHaveLength(1)
    const siwcStart = button('Start OpenAI login')
    const siwcApproval = siwcStart.form?.querySelector('input')
    if (!(siwcApproval instanceof HTMLInputElement)) throw new Error('Missing SIWC approval')
    siwcApproval.checked = true
    await act(async () => siwcStart.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(document.querySelector('a[href^="https://untrusted.example.com"]')).toBeNull()
    expect(document.body.textContent).toContain('invalid response')
    await click('Connect Connection 1')
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(requests.filter(item => item.path === 'device/check')).toHaveLength(1)
  })

  it('offers SIWC login without unsupported device controls when the service does not advertise device login', async () => {
    route = async path => path === 'overview' ? response({ connections: saved }) : response({ ...status('siwc'), deviceLoginAvailable: false })
    await render(); await click('Connect Research')
    expect(document.body.textContent).toContain('Start OpenAI login')
    expect(document.body.textContent).not.toContain('Get OpenAI device code')
    expect(requests.some(item => item.path === 'device/start')).toBe(false)
  })

  it('keeps sibling connections usable when a saved account cannot be read', async () => {
    saved = [connection(), { ...connection(1), provider: null, ready: null, snapshot: null, lastAttempt: null, history: [], error: 'account_selection_changed' }]
    await render()
    expect(document.body.textContent).toContain('Credential readiness unavailable')
    expect(document.body.textContent).toContain('account changed while reading')
    expect(document.body.textContent).toContain('85% used · 15% remaining')
    expect(button('Refresh quota for Research').disabled).toBe(false)
  })
})
