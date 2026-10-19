import { useEffect, useRef, useState } from 'react'
import { failureText, parseAuthorization, parseDevice, parseStatus, subscriptionPost,
  type ConnectionStatus, type DeviceAttempt } from './SubscriptionDashboardApi'

const SUBSCRIPTION_BUTTON = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-control disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-ring'
const SUBSCRIPTION_INPUT = 'min-h-9 min-w-0 rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm text-kumo-default'

export function SubscriptionDashboardConnect({ accountId, label, onChanged, onError }: {
  accountId: string; label: string; onChanged: () => Promise<void>; onError: (error: unknown) => void
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [device, setDevice] = useState<DeviceAttempt | null>(null)
  const [authorization, setAuthorization] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Checking saved connection status…')
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const locked = useRef(false)
  const pollCount = useRef(0)
  const callbacks = useRef({ onChanged, onError })
  callbacks.current = { onChanged, onError }

  useEffect(() => {
    const lifetime = new AbortController()
    controller.current = lifetime
    const attempt = ++generation.current
    void subscriptionPost('status', { accountId }, parseStatus, lifetime.signal).then(value => {
      if (lifetime.signal.aborted || attempt !== generation.current) return
      setStatus(value); setDevice(value.device); setMessage(value.loginPending ? 'A login is pending for this connection.' : 'Choose a connection method below.')
    }).catch(error => { if (!lifetime.signal.aborted && attempt === generation.current) { setMessage(failureText(error)); callbacks.current.onError(error) } })
    return () => { lifetime.abort(); generation.current++ }
  }, [accountId])

  useEffect(() => {
    if (!device) return
    const lifetime = controller.current
    if (!lifetime) return
    const expires = Date.parse(device.expiresAt)
    if (expires <= Date.now() || pollCount.current >= 120) {
      setDevice(null); setMessage('Device approval expired or reached its check limit. Start a new login.'); return
    }
    const attempt = generation.current
    const delay = Math.min(Math.max(1000, Date.parse(device.nextCheckAt) - Date.now()), expires - Date.now())
    const timer = setTimeout(async () => {
      if (lifetime.signal.aborted || attempt !== generation.current) return
      if (Date.now() >= expires) { setDevice(null); setMessage('Device approval expired. Start a new login.'); return }
      pollCount.current++
      try {
        const value = await subscriptionPost('device/check', { accountId }, parseStatus, lifetime.signal)
        if (lifetime.signal.aborted || attempt !== generation.current) return
        setStatus(value); setDevice(value.device)
        setMessage(value.device ? 'Waiting for OpenAI approval.' : value.inferenceReady ? 'Connection is ready.' : 'Device login ended. Start a new login if needed.')
        if (!value.device) await callbacks.current.onChanged()
      } catch (error) {
        if (lifetime.signal.aborted || attempt !== generation.current) return
        setDevice(null); setMessage(failureText(error)); callbacks.current.onError(error)
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [device, accountId])

  const run = async (path: 'start' | 'complete' | 'device/start' | 'select' | 'refresh', body: object) => {
    const lifetime = controller.current
    if (!lifetime || lifetime.signal.aborted || locked.current) return
    locked.current = true; setBusy(true)
    const attempt = ++generation.current
    setDevice(null)
    try {
      if (path === 'start') {
        setAuthorization(null)
        const url = await subscriptionPost(path, { ...body, accountId }, parseAuthorization, lifetime.signal)
        if (lifetime.signal.aborted || attempt !== generation.current) return
        setAuthorization(url); setMessage('Open OpenAI, choose the account and workspace, then paste its local callback below. This attempt expires after 10 minutes.')
      } else if (path === 'device/start') {
        const value = await subscriptionPost(path, { ...body, accountId }, parseDevice, lifetime.signal)
        if (lifetime.signal.aborted || attempt !== generation.current) return
        pollCount.current = 0; setDevice(value); setMessage('Enter this one-time code at OpenAI and approve this connection. Keep this panel open.')
      } else {
        const value = await subscriptionPost(path, { ...body, accountId }, parseStatus, lifetime.signal)
        if (lifetime.signal.aborted || attempt !== generation.current) return
        setStatus(value); setDevice(value.device)
        if (path === 'complete') setAuthorization(null)
        setMessage(value.inferenceReady ? 'Connection is ready.' : 'This connection needs a completed login.')
        await callbacks.current.onChanged()
      }
    } catch (error) {
      if (!lifetime.signal.aborted && attempt === generation.current) { setMessage(failureText(error)); callbacks.current.onError(error) }
    } finally {
      locked.current = false
      if (!lifetime.signal.aborted && attempt === generation.current) setBusy(false)
    }
  }

  return <section aria-label={`Connect ${label} details`} className="mt-4 space-y-3 border-t border-kumo-line pt-4 text-sm text-kumo-default">
    <p role="status">{message}</p>
    {status && <div className="text-xs text-kumo-subtle"><p>Active provider: {status.provider === 'codex' ? 'Codex' : status.provider === 'siwc' ? 'SIWC' : 'Not selected'} · {status.inferenceReady ? 'Credentials ready' : 'Credentials need connection'}</p>
      {status.identity && <><p>Verified account: {status.identity.name ? `${status.identity.name} · ` : ''}{status.identity.email}</p>
        {status.identity.verifiedAt && <p>Last identity verification: <time dateTime={status.identity.verifiedAt}>{new Date(status.identity.verifiedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })}</time></p>}</>}
      {status.deviceFailed && <p>Previous device login ended. Start a new login.</p>}</div>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={SUBSCRIPTION_BUTTON} disabled={busy} onClick={() => { void run('refresh', {}) }}>Refresh credentials</button>
      {status?.siwcInferenceReady && status.provider !== 'siwc' && <button type="button" className={SUBSCRIPTION_BUTTON} disabled={busy} onClick={() => { void run('select', { provider: 'siwc' }) }}>Use connected SIWC</button>}
      {status?.codexInferenceReady && status.provider !== 'codex' && <button type="button" className={SUBSCRIPTION_BUTTON} disabled={busy} onClick={() => { void run('select', { provider: 'codex' }) }}>Use connected Codex</button>}
    </div>
    {status?.deviceLoginAvailable && <form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void run('device/start', { planUsageConfirmed: form.get('approval') === 'on' }) }}>
      <fieldset disabled={busy} className="space-y-2 rounded-lg border border-kumo-line p-3"><legend className="px-1 font-medium">Codex device login</legend>
        <label className="flex items-start gap-2"><input type="checkbox" name="approval" required className="mt-1" />I agree to use my ChatGPT subscription for model requests through this connection.</label>
        <button type="submit" className={SUBSCRIPTION_BUTTON}>Get OpenAI device code</button>
      </fieldset>
    </form>}
    {device && <div className="rounded-lg border border-kumo-line p-3"><p>One-time device code: <strong className="font-mono">{device.userCode}</strong></p>
      <a href={device.verificationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-9 items-center text-kumo-link underline">Approve code at OpenAI</a>
      <p className="text-xs text-kumo-subtle">Expires <time dateTime={device.expiresAt}>{new Date(device.expiresAt).toLocaleString()}</time>. Checks stop at expiry or after 120 attempts.</p></div>}
    <form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void run('start', { planUsageConfirmed: form.get('approval') === 'on' }) }}>
      <fieldset disabled={busy} className="space-y-2 rounded-lg border border-kumo-line p-3"><legend className="px-1 font-medium">SIWC login</legend>
        <label className="flex items-start gap-2"><input type="checkbox" name="approval" required className="mt-1" />I agree to use my ChatGPT subscription for model requests through this connection.</label>
        <button type="submit" className={SUBSCRIPTION_BUTTON}>Start OpenAI login</button>
      </fieldset>
    </form>
    {authorization && <a href={authorization} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-9 items-center text-kumo-link underline">Open official OpenAI login</a>}
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault()
      const field = event.currentTarget.elements.namedItem('callback')
      if (!(field instanceof HTMLTextAreaElement)) return
      const callbackUrl = field.value
      field.value = ''
      void run('complete', { callbackUrl })
    }}>
      <fieldset disabled={busy} className="space-y-2 rounded-lg border border-kumo-line p-3"><legend className="px-1 font-medium">Complete SIWC login</legend>
        <p className="text-xs text-kumo-subtle">After OpenAI redirects to <code>http://127.0.0.1:1455/auth/callback</code>, copy the full address here even if the local page cannot open. It contains a one-time code. The field clears immediately on submission.</p>
        <label className="flex flex-col gap-1">Local callback address<textarea name="callback" required maxLength={16384} autoComplete="off" autoCapitalize="none" spellCheck={false} rows={3} className={`${SUBSCRIPTION_INPUT} w-full font-mono`} /></label>
        <button type="submit" className={SUBSCRIPTION_BUTTON}>Complete connection</button>
      </fieldset>
    </form>
    <p className="text-xs text-kumo-subtle">SIWC does not provide total subscription usage. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-kumo-link underline">View usage at ChatGPT</a></p>
  </section>
}
