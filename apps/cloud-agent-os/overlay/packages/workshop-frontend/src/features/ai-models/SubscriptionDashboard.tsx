import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  failureText, parseCreated, parseOverview, parseReading, parseSaved, subscriptionPost, SubscriptionRequestError, unavailableText,
  type HistoryPoint, type QuotaReading, type QuotaWindow, type SubscriptionConnection,
} from './SubscriptionDashboardApi'
import { SubscriptionDashboardConnect } from './SubscriptionDashboardConnect'

const SUBSCRIPTION_BUTTON = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-control disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-ring'
const SUBSCRIPTION_INPUT = 'min-h-9 min-w-0 rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default'
const THRESHOLD_KEY = 'cloud-agent-os.subscription.remaining-threshold'
const FRESH_MS = 5 * 60 * 1000
const localTime = (timestamp: string | number) => new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })
const percent = (value: number) => `${Math.round(value * 10) / 10}%`
function duration(seconds: number | null): string {
  if (seconds === null) return 'Unspecified quota window'
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] satisfies [string, number][]) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size} ${unit}${seconds === size ? '' : 's'} quota`
  }
  return `${seconds} second${seconds === 1 ? '' : 's'} quota`
}
function countdown(resetAt: number, now: number): string {
  const seconds = Math.ceil((resetAt - now) / 1000)
  if (seconds <= 0) return 'Reset time passed; refresh to confirm'
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60)
  return `Resets in ${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes}m ${seconds % 60}s`
}
const quotaWindows = (usage: Extract<QuotaReading['usage'], { status: 'available' }>) => [
  { key: 'primary', label: 'Primary', window: usage.primaryWindow },
  { key: 'secondary', label: 'Secondary', window: usage.secondaryWindow },
  ...usage.additionalWindows.flatMap(item => [
    { key: `${item.id}-primary`, label: `${item.name} (${item.id}) · primary`, window: item.primaryWindow },
    { key: `${item.id}-secondary`, label: `${item.name} (${item.id}) · secondary`, window: item.secondaryWindow },
  ]),
]

function WindowMeter({ label, window, checkedAt, now }: { label: string; window: QuotaWindow; checkedAt: string; now: number }) {
  const remaining = window.usedPercent === null ? null : Math.max(0, 100 - window.usedPercent)
  const candidate = window.resetAt === null
    ? window.resetAfterSeconds === null ? null : Date.parse(checkedAt) + window.resetAfterSeconds * 1000
    : window.resetAt * 1000
  const resetAt = candidate !== null && Number.isFinite(new Date(candidate).getTime()) ? candidate : null
  const name = `${label} · ${duration(window.windowSeconds)}`
  return <div className="space-y-1 rounded-lg border border-kumo-line p-3">
    <h4 className="text-sm font-medium text-kumo-default">{name}</h4>
    <p className="text-sm text-kumo-default">{window.usedPercent === null ? 'Used and remaining percentages not supplied'
      : `${percent(window.usedPercent)} used · ${percent(remaining ?? 0)} remaining`}</p>
    {window.usedPercent !== null && <progress aria-label={`${name} used`} max={100} value={Math.min(100, window.usedPercent)} className="h-2 w-full accent-kumo-brand" />}
    <p className="text-xs text-kumo-subtle">{resetAt === null ? 'Reset time not supplied' : <>{countdown(resetAt, now)}<br />
      <time dateTime={new Date(resetAt).toISOString()}>{localTime(resetAt)}</time></>}</p>
  </div>
}

const History = memo(function History({ points }: { points: HistoryPoint[] }) {
  return <details className="mt-3 text-sm">
    <summary className="min-h-9 cursor-pointer py-2 font-medium text-kumo-default">Quota history · {points.length} recorded samples</summary>
    <p className="mb-2 text-xs text-kumo-subtle">Actual hourly observations from the last 7 days. Earlier readings are not reconstructed.</p>
    {points.length === 0 ? <p className="text-kumo-subtle">No quota history recorded yet. Refresh a Codex connection to begin.</p>
      : <div className="max-h-64 overflow-auto rounded-lg border border-kumo-line">
        <table className="w-full text-left text-xs"><caption className="sr-only">Recorded Codex quota readings</caption>
          <thead><tr><th scope="col" className="p-2">Local observation time</th><th scope="col" className="p-2">Plan</th><th scope="col" className="p-2">Used quota</th></tr></thead>
          <tbody>{points.map(point => <tr key={point.checkedAt} className="border-t border-kumo-line">
            <td className="p-2"><time dateTime={point.checkedAt}>{localTime(point.checkedAt)}</time></td><td className="p-2">{point.planType}</td>
            <td className="p-2">{[
              { label: 'Primary', window: point.primaryWindow }, { label: 'Secondary', window: point.secondaryWindow },
              ...point.additionalWindows.flatMap(item => [{ label: `${item.name} primary`, window: item.primaryWindow }, { label: `${item.name} secondary`, window: item.secondaryWindow }]),
            ].filter(item => item.window !== null).map((item, index) => <div key={index}>{item.label} · {duration(item.window?.windowSeconds ?? null)} · {item.window?.usedPercent == null ? 'not supplied' : percent(item.window.usedPercent)}</div>)}</td>
          </tr>)}</tbody>
        </table></div>}
  </details>
})

function Reading({ connection, now, threshold, error }: { connection: SubscriptionConnection; now: number; threshold: number; error?: string }) {
  const snapshot = connection.snapshot, usage = snapshot?.usage
  const latest = connection.lastAttempt
  const stale = !!snapshot && (now - Date.parse(snapshot.checkedAt) > FRESH_MS || !!error
    || (latest?.usage.status === 'unavailable' && Date.parse(latest.checkedAt) >= Date.parse(snapshot.checkedAt)))
  const fresh = usage?.status === 'available' && !stale
  const lowWindows = fresh ? quotaWindows(usage).filter(item => item.window?.usedPercent != null && 100 - item.window.usedPercent <= threshold) : []
  const plan = usage?.status === 'available' ? usage.planType
    : latest?.account.status === 'available' ? latest.account.planType : connection.identity?.planType
  return <div className="mt-3 text-sm">
    <p className="text-kumo-default">Plan: {plan || 'Not supplied'}</p>
    {(snapshot?.account.status === 'available' ? snapshot.account.workspaceName : connection.identity?.workspaceName) &&
      <p className="text-kumo-subtle">Workspace: {snapshot?.account.status === 'available' ? snapshot.account.workspaceName : connection.identity?.workspaceName}</p>}
    {connection.provider === 'siwc' ? <p className="mt-2 text-kumo-subtle">SIWC does not supply subscription quota. Usage is unavailable.</p>
      : usage?.status === 'available' && snapshot ? <>
        <p className="mt-2 font-medium text-kumo-default">{usage.limitReached ? 'Quota limit reached' : usage.allowed === false ? 'Provider is not allowing requests' : usage.allowed === true ? 'Quota available' : 'Quota availability not supplied'}{stale ? ' · Stale cached reading' : ' · Fresh reading'}</p>
        {lowWindows.length > 0 && <p role="status" className="mt-2 rounded-lg border border-kumo-line p-2 text-kumo-default">Remaining quota is at or below your {threshold}% warning threshold in {lowWindows.map(item => item.label.toLowerCase()).join(', ')}.</p>}
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{quotaWindows(usage).filter(item => item.window !== null).map(item => item.window &&
          <WindowMeter key={item.key} label={item.label} window={item.window} checkedAt={snapshot.checkedAt} now={now} />)}</div>
        {!quotaWindows(usage).some(item => item.window) && <p className="mt-2 text-kumo-subtle">The provider did not supply quota windows.</p>}
        {usage.additionalWindows.filter(item => item.limitReached || item.allowed === false).map(item =>
          <p key={item.id} className="mt-2 text-kumo-default">{item.name}: {item.limitReached ? 'Quota limit reached' : 'Provider is not allowing requests'}</p>)}
        <p className="mt-3 text-kumo-subtle">Credits: {usage.credits === null ? 'Not supplied'
          : usage.credits.unlimited ? 'Unlimited' : usage.credits.balance !== null ? usage.credits.balance : usage.credits.hasCredits ? 'Available; balance not supplied' : 'None'}. Credits are separate from quota windows.</p>
      </> : <p className="mt-2 text-kumo-subtle">Usage unavailable. Refresh to request a Codex quota reading.</p>}
    <p className="mt-2 text-xs text-kumo-subtle">Last successful quota reading: {snapshot?.usage.status === 'available'
      ? <time dateTime={snapshot.checkedAt}>{localTime(snapshot.checkedAt)}</time> : 'Never'}</p>
    {latest && <p className="mt-1 text-xs text-kumo-subtle">Last attempt: <time dateTime={latest.checkedAt}>{localTime(latest.checkedAt)}</time>
      {latest.usage.status === 'unavailable' ? ` · ${unavailableText(latest.usage)}` : ' · Quota received'}
      {latest.account.status === 'unavailable' ? ` · Account information: ${unavailableText(latest.account)}` : ''}</p>}
    {error && <p role="alert" className="mt-2 text-kumo-default">{error}</p>}
    <History points={connection.history} />
  </div>
}

export function SubscriptionDashboard({ onChanged, availability }: {
  onChanged: () => Promise<void>
  availability: (accountId: string, label: string) => ReactNode
}) {
  const [connections, setConnections] = useState<SubscriptionConnection[]>([])
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [auth, setAuth] = useState<'ready' | 'sign-in' | 'denied'>('ready')
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(() => {
    try { const value = localStorage.getItem(THRESHOLD_KEY); const number = value === null ? 20 : Number(value)
      return Number.isInteger(number) && number >= 0 && number <= 100 ? number : 20 } catch { return 20 }
  })
  const [now, setNow] = useState(Date.now)
  const lifetime = useRef<AbortController | null>(null)
  const overviewGeneration = useRef(0)
  const activeRefresh = useRef(new Set<string>())
  const writeLocked = useRef(false)
  const authState = useRef(auth)
  const report = (error: unknown) => {
    if (error instanceof SubscriptionRequestError && (error.kind === 'sign-in' || error.kind === 'denied')) {
      authState.current = error.kind
      setAuth(error.kind)
      overviewGeneration.current++
      setConnections([])
      setRowErrors({})
      setLoaded(false)
      setSelected(null)
      if (error.kind === 'sign-in') {
        try { localStorage.removeItem('authToken') } catch { /* The sign-in link can still recover the OS session. */ }
      }
    }
    setNotice(failureText(error))
  }
  const load = async (signal: AbortSignal) => {
    const generation = ++overviewGeneration.current
    const result = await subscriptionPost('overview', {}, parseOverview, signal)
    if (signal.aborted || generation !== overviewGeneration.current || authState.current !== 'ready') return
    setConnections(result)
    setLoaded(true)
    setNotice(null)
  }
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load(controller.signal).catch(error => { if (!controller.signal.aborted) report(error) })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { controller.abort(); overviewGeneration.current++; clearInterval(timer) }
    // The overview is a cached-only read at mount. Explicit refreshes request provider usage.
  }, [])

  const refresh = async (ids: string[]) => {
    const controller = lifetime.current
    if (!controller || controller.signal.aborted || authState.current !== 'ready') return
    if (activeRefresh.current.size) return
    const queue = [...new Set(ids)]
    if (!queue.length) return
    for (const id of queue) activeRefresh.current.add(id)
    setRefreshing(new Set(activeRefresh.current))
    const errors: Record<string, string> = {}
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length && !controller.signal.aborted && authState.current === 'ready') {
        const id = queue.shift()
        if (!id) return
        try {
          const reading = await subscriptionPost('account-info', { accountId: id }, parseReading, controller.signal)
          if (controller.signal.aborted || authState.current !== 'ready') return
          setConnections(current => current.map(item => item.id === id ? { ...item, lastAttempt: reading,
            snapshot: reading.usage.status === 'available' ? reading : item.snapshot } : item))
          setRowErrors(current => { const next = { ...current }; delete next[id]; return next })
        } catch (error) {
          if (controller.signal.aborted) return
          errors[id] = failureText(error)
          setRowErrors(current => ({ ...current, [id]: failureText(error) }))
          report(error)
        } finally {
          activeRefresh.current.delete(id)
          if (!controller.signal.aborted) setRefreshing(new Set(activeRefresh.current))
        }
      }
    }))
    // Re-read the server's retained snapshots and hourly history after the bounded refresh batch.
    if (!controller.signal.aborted && authState.current === 'ready') {
      try { await load(controller.signal) } catch (error) { if (!controller.signal.aborted) report(error) }
      if (Object.keys(errors).length && authState.current === 'ready') setNotice('Some quota requests failed. Their cached readings are kept.')
    }
    for (const id of ids) activeRefresh.current.delete(id)
    if (!controller.signal.aborted) setRefreshing(new Set(activeRefresh.current))
  }
  const write = async (path: 'connections/create' | 'connections/rename', form: HTMLFormElement, accountId?: string) => {
    const controller = lifetime.current
    if (!controller || writeLocked.current || authState.current !== 'ready') return
    const label = new FormData(form).get('label')
    if (typeof label !== 'string' || !label.trim() || new TextEncoder().encode(label.trim()).length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(label)) {
      setNotice('Enter a subscription name of 1–128 UTF-8 bytes without control characters.'); return
    }
    writeLocked.current = true; setSaving(true)
    let written = false
    try {
      if (path === 'connections/create') {
        const id = await subscriptionPost(path, { label: label.trim() }, parseCreated, controller.signal)
        written = true
        if (!controller.signal.aborted) { form.reset(); setSelected(id) }
      } else {
        await subscriptionPost(path, { accountId, label: label.trim() }, parseSaved, controller.signal)
        written = true
      }
      await load(controller.signal)
      await onChanged()
    } catch (error) { if (!controller.signal.aborted) {
      report(error)
      if (written) setNotice('Subscription saved, but settings could not be reloaded. Reopen Providers to read the saved value.')
    } }
    finally { writeLocked.current = false; if (!controller.signal.aborted) setSaving(false) }
  }
  const remove = async (connection: SubscriptionConnection) => {
    const controller = lifetime.current
    if (!controller || controller.signal.aborted || writeLocked.current || activeRefresh.current.size || authState.current !== 'ready' || connection.id === 'owner') return
    if (!window.confirm(`Delete subscription "${connection.label}" and its saved login from Cloudflare OS? This cannot be undone. Your provider subscription will remain active.`)) return
    writeLocked.current = true; setSaving(true)
    overviewGeneration.current++
    setSelected(current => current === connection.id ? null : current)
    let deleted = false
    try {
      const saved = await subscriptionPost('connections/delete', { accountId: connection.id, confirmed: true }, parseSaved, controller.signal)
      if (saved.some(item => item.id === connection.id)) throw new SubscriptionRequestError('invalid')
      deleted = true
      if (!controller.signal.aborted) setConnections(current => current.filter(item => item.id !== connection.id))
      await load(controller.signal)
      await onChanged()
    } catch (error) { if (!controller.signal.aborted) {
      report(error)
      if (deleted && authState.current === 'ready') setNotice('Subscription deleted, but settings could not be reloaded. Reopen Providers to refresh the model choices.')
      else if (error instanceof SubscriptionRequestError && error.kind === 'request') setNotice('Deletion could not be confirmed. It may be blocked by an active sign-in or another service using this connection. Reopen Providers to check the saved list.')
    } }
    finally { writeLocked.current = false; if (!controller.signal.aborted) setSaving(false) }
  }
  const disabled = auth !== 'ready'
  return <div className="space-y-4">
    <p className="text-sm text-kumo-subtle">Codex supplies these subscription quotas. They are separate from Cloudflare OS token counts. Compare each connection and quota window separately; percentages are never added together.</p>
    <p className="text-xs text-kumo-subtle">Opening this panel reads saved readings only. Refresh asks the provider for usage, with a 60-second server cache. Readings older than 5 minutes are marked stale.</p>
    <div className="flex flex-wrap items-end gap-3">
      <button type="button" className={SUBSCRIPTION_BUTTON} disabled={disabled || saving || !loaded || refreshing.size > 0} onClick={() => { void refresh(connections.filter(item => item.provider === 'codex').map(item => item.id)) }}>Refresh all quotas</button>
      <label className="flex flex-wrap items-center gap-2 text-sm text-kumo-default">Warn at remaining quota
        <input type="number" min={0} max={100} step={1} value={threshold} aria-label="Remaining quota warning threshold" className={`${SUBSCRIPTION_INPUT} w-20`}
          onChange={event => { const value = Number(event.target.value); if (!Number.isInteger(value) || value < 0 || value > 100) return
            setThreshold(value); try { localStorage.setItem(THRESHOLD_KEY, String(value)) } catch { /* Display preference remains usable in memory. */ } }} />%
      </label>
    </div>
    <p className="text-xs text-kumo-subtle">Warnings appear here only for fresh quota readings. No notifications are sent.</p>
    {notice && <p role="alert" className="rounded-lg border border-kumo-line p-3 text-sm text-kumo-default">{notice}
      {auth === 'sign-in' && <> <a className="text-kumo-link underline" href="/?sign_in=oidc&return_to=%2Fadmin">Sign in to Cloudflare OS</a></>}
      {auth === 'ready' && !loaded && <button className={`${SUBSCRIPTION_BUTTON} ml-2`} type="button" onClick={() => { const signal = lifetime.current?.signal; if (signal) void load(signal).catch(report) }}>Retry saved overview</button>}
    </p>}
    {!loaded && !notice && <p role="status" className="text-sm text-kumo-subtle">Loading saved subscriptions…</p>}
    {loaded && connections.length === 0 && <p className="text-sm text-kumo-subtle">No saved subscriptions. Add a named connection below.</p>}
    <div className="grid gap-4 lg:grid-cols-2">{connections.map(connection => <article key={connection.id} aria-label={`Subscription ${connection.label}`} className="min-w-0 rounded-lg border border-kumo-line bg-kumo-base p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold text-kumo-default">{connection.label}</h3>
        <p className="mt-1 text-xs text-kumo-subtle">{connection.provider === 'codex' ? 'Codex' : connection.provider === 'siwc' ? 'SIWC' : 'Provider not selected'} · {connection.ready === null ? 'Credential readiness unavailable' : connection.ready ? 'Credentials ready' : 'Credentials need connection'}</p></div>
        {availability(connection.id, connection.label)}
      </div>
      <p className="mt-2 text-xs text-kumo-subtle">No API key is needed for users. The enable switch controls organization availability.</p>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void write('connections/rename', event.currentTarget, connection.id) }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-kumo-subtle">Connection name<input key={connection.label} aria-label={`Connection name for ${connection.label}`} name="label" required maxLength={128} defaultValue={connection.label} className={`${SUBSCRIPTION_INPUT} w-full`} disabled={disabled || saving || refreshing.size > 0} /></label>
        <button type="submit" className={SUBSCRIPTION_BUTTON} aria-label={`Rename ${connection.label}`} disabled={disabled || saving || refreshing.size > 0}>Rename</button>
      </form>
      <Reading connection={connection} now={now} threshold={threshold} error={rowErrors[connection.id] ?? (connection.error === 'account_selection_changed' ? 'The account changed while reading its saved quota. Refresh this connection.' : connection.error ? 'This connection could not be read. Other connections remain available.' : undefined)} />
      <div className="mt-3 flex flex-wrap gap-2"><button className={SUBSCRIPTION_BUTTON} type="button" aria-label={`Refresh quota for ${connection.label}`} disabled={disabled || saving || refreshing.size > 0 || connection.provider !== 'codex'} onClick={() => { void refresh([connection.id]) }}>{refreshing.has(connection.id) ? 'Refreshing…' : 'Refresh quota'}</button>
        <button className={SUBSCRIPTION_BUTTON} type="button" aria-expanded={selected === connection.id} onClick={() => setSelected(selected === connection.id ? null : connection.id)} disabled={disabled || saving || refreshing.size > 0}>Connect {connection.label}</button>
        {connection.id !== 'owner' && <button className={SUBSCRIPTION_BUTTON} type="button" aria-label={`Delete ${connection.label}`} disabled={disabled || saving || refreshing.size > 0} onClick={() => { void remove(connection) }}>Delete</button>}</div>
      {selected === connection.id && <SubscriptionDashboardConnect key={connection.id} accountId={connection.id} label={connection.label} onChanged={async () => { const signal = lifetime.current?.signal; if (signal) await load(signal); await onChanged() }} onError={report} />}
    </article>)}</div>
    <form className="flex flex-wrap items-end gap-2 border-t border-kumo-line pt-4" onSubmit={event => { event.preventDefault(); void write('connections/create', event.currentTarget) }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-kumo-default">New subscription name<input aria-label="New subscription name" name="label" required maxLength={128} autoComplete="off" className={SUBSCRIPTION_INPUT} disabled={disabled || saving || refreshing.size > 0} /></label>
      <button className={SUBSCRIPTION_BUTTON} type="submit" disabled={disabled || saving || refreshing.size > 0}>Add subscription</button>
    </form>
    <a href="/gatekeeper/subscription" className="inline-flex min-h-9 items-center text-sm text-kumo-link hover:underline">Open standalone setup as a fallback</a>
  </div>
}
