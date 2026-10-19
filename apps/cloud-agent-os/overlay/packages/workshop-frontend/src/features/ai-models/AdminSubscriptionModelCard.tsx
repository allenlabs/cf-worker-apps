import { useEffect, useId, useRef, useState } from 'react'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import type { AdminApi, AdminSettingsView } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { rpcFailureDescription } from '../../rpcErrors'
import { SubscriptionDashboard } from './SubscriptionDashboard'
import { DisplayNameEditor } from './DisplayNameEditor'

/** Named subscription objects use independent availability and the same personal-provider policy. */
export const AdminSubscriptionModelCard = ({ admin, model, onChanged }: {
  admin: RpcStub<AdminApi>
  model: NonNullable<AdminSettingsView['subscriptionModel']>
  onChanged: () => Promise<void>
}) => {
  const toasts = useKumoToastManager()
  const helpId = useId()
  const personalHelpId = useId()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const focusBeforeWrite = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (busy) return
    if (document.activeElement === document.body) focusBeforeWrite.current?.focus()
    focusBeforeWrite.current = null
  }, [busy])

  const changeEnabled = async (scope: 'subscription' | 'personal', enabled: boolean, accountId?: string) => {
    if (inFlight.current) return
    inFlight.current = true
    focusBeforeWrite.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(true)
    let saved = false
    try {
      if (scope === 'subscription') await admin.setSubscriptionModelEnabled(enabled, accountId)
      else await admin.setUserModelsEnabled(enabled)
      saved = true
      await onChanged()
    } catch (err) {
      const title = saved ? 'Saved, but couldn’t reload the provider'
        : scope === 'subscription' ? 'Couldn’t update Codex subscription' : 'Couldn’t update personal provider policy'
      toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const changeModelName = async (modelId: string, name: string | null) => {
    if (inFlight.current) return
    inFlight.current = true
    focusBeforeWrite.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(true)
    try {
      await admin.setModelDisplayName(modelId, name)
      await onChanged()
    } catch (err) {
      toasts.add({ title: 'Couldn’t save the organization model name', description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Organization subscription</h2>
      <p className="mb-4 text-sm text-kumo-subtle">
        Manage named subscriptions shared by your organization. Users choose which available model to use.
      </p>
      {model.setupUrl === '/gatekeeper/subscription' ? (
        <SubscriptionDashboard onChanged={onChanged} availability={(accountId, label) => {
          const connection = model.connections.find(item => item.accountId === accountId)
          return connection ? <div className="min-w-0 space-y-2">
            <Switch aria-label={`Enable ${label}`} checked={connection.enabled} disabled={busy}
              onCheckedChange={enabled => { void changeEnabled('subscription', enabled, accountId) }} />
            <p className="text-xs text-kumo-subtle">Model display name: {connection.name}</p>
            <DisplayNameEditor label={`Model display name for ${label}`} name={connection.name} busy={busy}
              onSave={name => { void changeModelName(connection.id, name) }} />
          </div> : null
        }} />
      ) : <div className="space-y-3">
        {model.connections.map(connection => (
          <div key={connection.id} className="flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <h3 className="font-medium text-kumo-default">{connection.name}</h3>
              <p className="mt-0.5 break-all font-mono text-xs text-kumo-subtle">{connection.id}</p>
              <p className="mt-1 text-kumo-subtle">{connection.ready === null ? 'Managed by inference bridge'
                : `${connection.ready ? 'Connected' : 'Not connected'} · ${connection.provider === 'siwc' ? 'SIWC' : 'Codex'}`}</p>
              <p id={`${helpId}-${connection.id}`} className="mt-2 text-kumo-subtle">
                No API key is needed for users. Turning this off makes the model
                unavailable to users and agents until you enable it again.
              </p>
              <DisplayNameEditor label={`Model display name for ${connection.providerDisplayName ?? connection.name}`} name={connection.name} busy={busy}
                onSave={name => { void changeModelName(connection.id, name) }} />
              {model.setupUrl && (
                <a href={`${model.setupUrl}#connection=${encodeURIComponent(connection.accountId)}`}
                  className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-kumo-link hover:underline">
                  Manage {connection.name}
                </a>
              )}
            </div>
            <Switch aria-label={`Enable ${connection.name}`} aria-describedby={`${helpId}-${connection.id}`}
              checked={connection.enabled} disabled={busy}
              onCheckedChange={enabled => { void changeEnabled('subscription', enabled, connection.accountId) }} />
          </div>
        ))}
      </div>}
      <div className="mt-6 flex items-center gap-4 border-t border-kumo-line pt-4">
        <div className="min-w-0 flex-1 text-sm">
          <h3 className="font-medium text-kumo-default">Personal providers</h3>
          <p id={personalHelpId} className="mt-2 text-kumo-subtle">
            Allow users to add providers with their own API credentials and custom endpoints.
            Turning this off stops personal models from being used. Saved providers are kept.
          </p>
        </div>
        <Switch aria-label="Allow personal providers" aria-describedby={personalHelpId}
          checked={model.userModelsEnabled} disabled={busy}
          onCheckedChange={enabled => { void changeEnabled('personal', enabled) }} />
      </div>
    </section>
  )
}
