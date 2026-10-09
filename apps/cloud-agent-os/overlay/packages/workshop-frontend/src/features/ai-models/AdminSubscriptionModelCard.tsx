import { useEffect, useId, useRef, useState } from 'react'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import type { AdminApi, AdminSettingsView } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { rpcFailureDescription } from '../../rpcErrors'

/** The deployment's fixed subscription bridge, with no personal credential configuration. */
export const AdminSubscriptionModelCard = ({ admin, model, onChanged }: {
  admin: RpcStub<AdminApi>
  model: NonNullable<AdminSettingsView['subscriptionModel']>
  onChanged: () => Promise<void>
}) => {
  const toasts = useKumoToastManager()
  const helpId = useId()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const focusBeforeWrite = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (busy) return
    if (document.activeElement === document.body) focusBeforeWrite.current?.focus()
    focusBeforeWrite.current = null
  }, [busy])

  const changeEnabled = async (enabled: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    focusBeforeWrite.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(true)
    let saved = false
    try {
      await admin.setSubscriptionModelEnabled(enabled)
      saved = true
      await onChanged()
    } catch (err) {
      const title = saved ? 'Saved, but couldn’t reload the provider' : 'Couldn’t update Codex subscription'
      console.error(`${title}:`, err)
      toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Providers</h2>
      <p className="mb-4 text-sm text-kumo-subtle">
        Manage the shared subscription here. Users choose which available model to use.
      </p>
      <div className="flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
        <div className="min-w-0 flex-1 text-sm">
          <h3 className="font-medium text-kumo-default">{model.name}</h3>
          <p className="mt-0.5 break-all font-mono text-xs text-kumo-subtle">{model.id}</p>
          <p id={helpId} className="mt-2 text-kumo-subtle">
            No API key or account registration is needed. Turning this off makes the model
            unavailable to users and agents until you enable it again.
          </p>
        </div>
        <Switch aria-label="Enable Codex subscription" aria-describedby={helpId}
          checked={model.enabled} disabled={busy} onCheckedChange={enabled => { void changeEnabled(enabled) }} />
      </div>
    </section>
  )
}
