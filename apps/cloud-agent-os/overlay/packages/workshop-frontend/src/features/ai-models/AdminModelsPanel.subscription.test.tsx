// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminSettingsView } from '@gadgets/workshop-shared/api'

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn<(toast: unknown) => void>() }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminModelsPanel } from './AdminModelsPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Admin-managed Codex subscription', () => {

  it('keeps legacy bridge readiness unknown when setup is not configured', async () => {
    const subscriptionModel: NonNullable<AdminSettingsView['subscriptionModel']> = {
      id: 'codex-subscription', name: 'Codex subscription', enabled: true, userModelsEnabled: true,
      connections: [{ id: 'codex-subscription', accountId: 'owner', name: 'Codex subscription',
        provider: null, ready: null, enabled: true }],
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<AdminModelsPanel admin={{} as unknown as RpcStub<AdminApi>}
      gatewayModels={undefined} subscriptionModel={subscriptionModel} onChanged={async () => {}} />))
    expect(document.body.textContent).toContain('Managed by inference bridge')
    expect(document.body.textContent).not.toContain('Not connected')
    expect(document.body.querySelector('a')).toBeNull()
  })


  it('renders each named connection and sends independent toggle selectors', async () => {
    const setSubscriptionModelEnabled = vi.fn<AdminApi['setSubscriptionModelEnabled']>(async () => {})
    const admin = { setSubscriptionModelEnabled } as unknown as RpcStub<AdminApi>
    const accountA = 'account-11111111-1111-4111-8111-111111111111'
    const accountB = 'account-22222222-2222-4222-8222-222222222222'
    const subscriptionModel: NonNullable<AdminSettingsView['subscriptionModel']> = {
      id: 'codex-subscription', name: 'Owner', enabled: true, userModelsEnabled: true,
      setupUrl: '/gatekeeper/subscription', connections: [
        { id: `subscription-${accountA}`, accountId: accountA, name: 'Research', provider: 'codex', ready: true, enabled: true },
        { id: `subscription-${accountB}`, accountId: accountB, name: 'Writing', provider: 'siwc', ready: false, enabled: false },
      ],
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<AdminModelsPanel admin={admin} gatewayModels={undefined}
      subscriptionModel={subscriptionModel} onChanged={async () => {}} />))
    expect(document.body.textContent).toContain('Research')
    expect(document.body.textContent).toContain('Writing')
    expect(document.body.textContent).toContain('Connected')
    expect(document.body.textContent).toContain('Not connected')
    expect(document.body.querySelector(`a[href="/gatekeeper/subscription#connection=${accountB}"]`)?.textContent).toBe('Manage Writing')
    await act(async () => toggle('Enable Writing').checkbox.click())
    expect(setSubscriptionModelEnabled).toHaveBeenLastCalledWith(true, accountB)
    expect(toggle('Enable Research').control.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle('Enable Research').checkbox.click())
    expect(setSubscriptionModelEnabled).toHaveBeenLastCalledWith(false, accountA)
    expect(document.body.querySelectorAll('[aria-label="Allow personal providers"]')).toHaveLength(1)
  })

  let root: Root | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    addToast.mockReset()
  })

  const render = async (enabled: boolean, mutate = async (_enabled: boolean, _accountId?: string) => {},
    policy: Pick<NonNullable<AdminSettingsView['subscriptionModel']>, 'userModelsEnabled' | 'setupUrl'> = { userModelsEnabled: true }) => {
    const setSubscriptionModelEnabled = vi.fn(mutate)
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    const setUserModelsEnabled = vi.fn(mutate)
    const admin = { setSubscriptionModelEnabled, setUserModelsEnabled } as unknown as RpcStub<AdminApi>
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const show = async (reported: boolean) => {
      const subscriptionModel: AdminSettingsView['subscriptionModel'] = {
        id: 'codex-subscription', name: 'Codex subscription', enabled: reported, ...policy,
        connections: [{ id: 'codex-subscription', accountId: 'owner', name: 'Codex subscription', provider: 'siwc', ready: true, enabled: reported }],
      }
      await act(async () => root!.render(<AdminModelsPanel admin={admin}
        gatewayModels={undefined} subscriptionModel={subscriptionModel} onChanged={onChanged} />))
    }
    await show(enabled)
    return { setSubscriptionModelEnabled, setUserModelsEnabled, onChanged, show }
  }

  const toggle = (label = "Enable Codex subscription") => {
    const control = document.body.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!
    const checkbox = control?.nextElementSibling
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing subscription toggle')
    return { control, checkbox }
  }

  it.each([true, false])('shows the fixed credential-free subscription and toggles %s through Admin', async enabled => {
    const { setSubscriptionModelEnabled, onChanged, show } = await render(enabled)
    expect(document.body.textContent).toContain('Codex subscription')
    expect(document.body.textContent).toContain('codex-subscription')
    expect(document.body.textContent).toContain('No API key')
    expect(document.body.querySelectorAll('input:not([type="checkbox"]), select, textarea, form')).toHaveLength(0)
    expect(toggle().control.getAttribute('aria-checked')).toBe(String(enabled))
    await act(async () => toggle().checkbox.click())
    expect(setSubscriptionModelEnabled).toHaveBeenCalledExactlyOnceWith(!enabled, 'owner')
    expect(onChanged).toHaveBeenCalledOnce()
    expect(setSubscriptionModelEnabled.mock.invocationCallOrder[0]).toBeLessThan(onChanged.mock.invocationCallOrder[0])
    // The control reflects the server's read, not an optimistic local setting.
    expect(toggle().control.getAttribute('aria-checked')).toBe(String(enabled))
    await show(!enabled)
    expect(toggle().control.getAttribute('aria-checked')).toBe(String(!enabled))
  })

  it.each(['Enable Codex subscription', 'Allow personal providers'])('locks both toggles during a write, then restores them and reports rejection (%s)', async label => {
    let reject!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, fail) => { reject = fail })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onChanged } = await render(true, () => pending)
    await act(async () => toggle(label).checkbox.click())
    expect(toggle().control.disabled).toBe(true)
    expect(toggle('Allow personal providers').control.disabled).toBe(true)
    await act(async () => reject(new Error('Unavailable')))
    expect(toggle().control.disabled).toBe(false)
    expect(toggle().control.getAttribute('aria-checked')).toBe('true')
    expect(onChanged).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
  })
  it.each([undefined, '/gatekeeper/subscription'])('offers SIWC setup only when advertised (%s)', async setupUrl => {
    await render(true, undefined, { userModelsEnabled: true, setupUrl })
    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/gatekeeper/subscription#connection=owner"]')
    if (setupUrl) {
      expect(link?.textContent).toBe('Manage Codex subscription')
      expect(link?.getAttribute('href')).toBe('/gatekeeper/subscription#connection=owner')
      expect(document.body.querySelector('a[href="/gatekeeper/subscription#add"]')?.textContent).toBe('Add subscription')
    } else expect(link).toBeNull()
    expect(document.body.textContent).toContain('Organization subscription')
    expect(document.body.textContent).toContain('Personal providers')
  })

  it.each([true, false])('saves the personal-provider policy through Admin (%s)', async userModelsEnabled => {
    const { setUserModelsEnabled, setSubscriptionModelEnabled, onChanged, show } =
      await render(true, undefined, { userModelsEnabled, setupUrl: undefined })
    const label = 'Allow personal providers'
    expect(toggle(label).control.getAttribute('aria-checked')).toBe(String(userModelsEnabled))
    await act(async () => toggle(label).checkbox.click())
    expect(setUserModelsEnabled).toHaveBeenCalledExactlyOnceWith(!userModelsEnabled)
    expect(setSubscriptionModelEnabled).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalledOnce()
    expect(toggle(label).control.getAttribute('aria-checked')).toBe(String(userModelsEnabled))
    await show(false)
    expect(toggle().control.getAttribute('aria-checked')).toBe('false')
  })

})
