export type QuotaWindow = {
  usedPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  resetAfterSeconds: number | null
}
type Unavailable = { status: 'unavailable'; reason: string; httpStatus: number | null }
type AdditionalWindow = {
  id: string; name: string; allowed: boolean | null; limitReached: boolean | null
  primaryWindow: QuotaWindow | null; secondaryWindow: QuotaWindow | null
}
export type QuotaReading = {
  checkedAt: string
  account: Unavailable | { status: 'available'; planType: string | null; workspaceName: string | null; structure: string | null }
  usage: Unavailable | {
    status: 'available'; planType: string; allowed: boolean | null; limitReached: boolean | null
    primaryWindow: QuotaWindow | null; secondaryWindow: QuotaWindow | null
    additionalWindows: AdditionalWindow[]
    credits: { unlimited: boolean; hasCredits: boolean; balance: string | null } | null
  }
}
type Identity = {
  name: string | null; email: string; planType: string | null; workspaceName: string | null
  organizationNames: string[] | null; verifiedAt: string | null
}
export type HistoryPoint = {
  checkedAt: string; planType: string; primaryWindow: QuotaWindow | null; secondaryWindow: QuotaWindow | null
  additionalWindows: AdditionalWindow[]
}
export type SubscriptionConnection = {
  id: string; label: string; provider: 'codex' | 'siwc' | null; ready: boolean | null; identity: Identity | null
  snapshot: QuotaReading | null; lastAttempt: QuotaReading | null; history: HistoryPoint[]
  error?: 'account_selection_changed' | 'unavailable'
}
export type DeviceAttempt = { verificationUrl: string; userCode: string; expiresAt: string; nextCheckAt: string }
export type ConnectionStatus = {
  provider: 'codex' | 'siwc' | null; inferenceReady: boolean; siwcInferenceReady: boolean; codexInferenceReady: boolean
  loginPending: boolean; deviceFailed: boolean; identity: Identity | null; device: DeviceAttempt | null
  deviceLoginAvailable: boolean
}

export class SubscriptionRequestError extends Error {
  constructor(readonly kind: 'sign-in' | 'denied' | 'request' | 'invalid', readonly httpStatus?: number) {
    super(kind === 'sign-in' ? 'Sign in to Cloudflare OS to continue.'
      : kind === 'denied' ? 'Your OS account cannot manage organization subscriptions.'
        : kind === 'invalid' ? 'The subscription service returned an invalid response.'
          : `The subscription request failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}. Cached readings are kept.`)
  }
}

// This deployment has no runtime schema dependency. These parsers validate its protected HTTP boundary.
const invalid = (): never => { throw new SubscriptionRequestError('invalid') }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : invalid()
const text = (value: unknown): string => typeof value === 'string' && value.length <= 16384 ? value : invalid()
const nullableText = (value: unknown) => value == null ? null : text(value)
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid()
const nullableBoolean = (value: unknown) => value == null ? null : boolean(value)
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid()
const nullableNumber = (value: unknown) => value == null ? null : number(value)
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid()
const timestamp = (value: unknown): string => {
  const result = text(value)
  return Number.isFinite(Date.parse(result)) ? result : invalid()
}
const provider = (value: unknown): SubscriptionConnection['provider'] => value == null ? null : value === 'siwc' || value === 'codex' ? value : invalid()
const accountId = (value: unknown) => {
  const result = text(value)
  return /^(?:owner|account-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(result) ? result : invalid()
}
function window(value: unknown): QuotaWindow | null {
  if (value == null) return null
  const item = record(value)
  return { usedPercent: nullableNumber(item.usedPercent), windowSeconds: nullableNumber(item.windowSeconds),
    resetAt: nullableNumber(item.resetAt), resetAfterSeconds: nullableNumber(item.resetAfterSeconds) }
}
function additional(value: unknown): AdditionalWindow[] {
  if (value == null) return []
  const values = array(value)
  if (values.length > 8) return invalid()
  return values.map(value => {
    const item = record(value)
    return { id: text(item.id), name: text(item.name), allowed: nullableBoolean(item.allowed),
      limitReached: nullableBoolean(item.limitReached), primaryWindow: window(item.primaryWindow), secondaryWindow: window(item.secondaryWindow) }
  })
}
function unavailable(item: Record<string, unknown>): Unavailable {
  if (item.status !== 'unavailable') return invalid()
  return { status: 'unavailable', reason: text(item.reason), httpStatus: nullableNumber(item.httpStatus) }
}
function identity(value: unknown): Identity | null {
  if (value == null) return null
  const item = record(value)
  return { name: nullableText(item.name), email: text(item.email), planType: nullableText(item.planType),
    workspaceName: nullableText(item.workspaceName), organizationNames: item.organizationNames == null ? null : array(item.organizationNames).map(text),
    verifiedAt: item.verifiedAt == null ? null : timestamp(item.verifiedAt) }
}
export function parseReading(value: unknown): QuotaReading {
  const item = record(value), account = record(item.account), usage = record(item.usage)
  const credits = usage.credits == null ? null : record(usage.credits)
  return { checkedAt: timestamp(item.checkedAt), account: account.status === 'available'
    ? { status: 'available', planType: nullableText(account.planType), workspaceName: nullableText(account.workspaceName), structure: nullableText(account.structure) }
    : unavailable(account), usage: usage.status === 'available'
      ? { status: 'available', planType: text(usage.planType), allowed: nullableBoolean(usage.allowed), limitReached: nullableBoolean(usage.limitReached),
        primaryWindow: window(usage.primaryWindow), secondaryWindow: window(usage.secondaryWindow), additionalWindows: additional(usage.additionalWindows),
        credits: credits ? { unlimited: boolean(credits.unlimited), hasCredits: boolean(credits.hasCredits), balance: nullableText(credits.balance) } : null }
      : unavailable(usage) }
}
export function parseOverview(value: unknown): SubscriptionConnection[] {
  const values = array(record(value).connections)
  if (values.length > 20) return invalid()
  const connections = values.map(value => {
    const item = record(value)
    const error: Pick<SubscriptionConnection, 'error'> = item.error === undefined ? {} : item.error === 'account_selection_changed' || item.error === 'unavailable' ? { error: item.error } : invalid()
    return { id: accountId(item.id), label: text(item.label), provider: provider(item.provider), ready: nullableBoolean(item.ready), identity: identity(item.identity), ...error,
      snapshot: item.snapshot == null ? null : parseReading(item.snapshot), lastAttempt: item.lastAttempt == null ? null : parseReading(item.lastAttempt),
      history: array(item.history).map(value => {
        const point = record(value)
        return { checkedAt: timestamp(point.checkedAt), planType: text(point.planType), primaryWindow: window(point.primaryWindow),
          secondaryWindow: window(point.secondaryWindow), additionalWindows: additional(point.additionalWindows) }
      }) }
  })
  if (new Set(connections.map(item => item.id)).size !== connections.length || connections.some(item => item.history.length > 168)) return invalid()
  return connections
}
export function parseDevice(value: unknown): DeviceAttempt {
  const item = record(value)
  if (item.verificationUrl !== 'https://auth.openai.com/codex/device') return invalid()
  const userCode = text(item.userCode)
  if (!userCode || userCode.length > 128) return invalid()
  return { verificationUrl: item.verificationUrl, userCode, expiresAt: timestamp(item.expiresAt), nextCheckAt: timestamp(item.nextCheckAt) }
}
export function parseStatus(value: unknown): ConnectionStatus {
  const item = record(value)
  return { provider: provider(item.provider), inferenceReady: boolean(item.inferenceReady), siwcInferenceReady: boolean(item.siwcInferenceReady),
    codexInferenceReady: boolean(item.codexInferenceReady), loginPending: boolean(item.loginPending), deviceFailed: boolean(item.deviceFailed),
    deviceLoginAvailable: item.deviceLoginAvailable === undefined ? false : boolean(item.deviceLoginAvailable),
    identity: identity(item.identity), device: item.device == null ? null : parseDevice(item.device) }
}
export function parseAuthorization(value: unknown): string {
  const item = record(value)
  let url: URL
  try { url = new URL(text(item.authorizationUrl)) } catch { return invalid() }
  return url.origin === 'https://auth.openai.com' && url.pathname === '/api/accounts/authorize' && !url.username && !url.password
    ? url.href : invalid()
}
export function parseCreated(value: unknown): string {
  const id = accountId(record(value).id)
  return parseSaved(value).some(item => item.id === id) ? id : invalid()
}
export function parseSaved(value: unknown): { id: string; label: string }[] {
  const saved = array(record(value).connections).map(value => { const item = record(value); return { id: accountId(item.id), label: text(item.label) } })
  if (saved.length > 20 || new Set(saved.map(item => item.id)).size !== saved.length) return invalid()
  return saved
}

export async function subscriptionPost<T>(path: string, body: object, parse: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  const headers = new Headers({ 'content-type': 'application/json' })
  try {
    const token = localStorage.getItem('authToken')
    if (token) headers.set('Authorization', `Bearer ${token}`)
  } catch { /* The service can also authenticate a same-origin Access request. */ }
  let response: Response
  try {
    response = await fetch(`/gatekeeper/subscription/${path}`, { method: 'POST', credentials: 'same-origin',
      headers, body: JSON.stringify(body), cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error', signal })
  } catch { throw new SubscriptionRequestError('request') }
  if (!response.ok) throw new SubscriptionRequestError(response.status === 401 ? 'sign-in' : response.status === 403 ? 'denied' : 'request', response.status)
  let result: unknown
  try { result = await response.json() } catch { throw new SubscriptionRequestError('invalid') }
  return parse(result)
}

export const failureText = (error: unknown): string => error instanceof SubscriptionRequestError ? error.message : 'The subscription request failed. Cached readings are kept.'
export function unavailableText(value: Unavailable): string {
  const reasons: Record<string, string> = {
    provider_not_supplied: 'This provider does not supply subscription quota.', network_error: 'The quota provider could not be reached.',
    timeout: 'The quota provider timed out.', http_error: 'The quota provider rejected the request.',
    invalid_content_type: 'The provider returned an unsupported response.', invalid_encoding: 'The provider returned an unreadable response.',
    invalid_json: 'The provider returned unreadable usage data.', unsupported_response: 'The provider returned unsupported usage data.',
    account_mismatch: 'The provider returned a different account.', account_not_found: 'The provider did not return the selected account.',
    response_too_large: 'The provider response exceeded its size limit.', invalid_profile: 'Reconnect this subscription to read quota.',
    duplicate_account: 'The provider returned an ambiguous account.',
  }
  return `${reasons[value.reason] ?? 'Usage is unavailable.'}${value.httpStatus === null ? '' : ` HTTP ${value.httpStatus}.`}`
}
