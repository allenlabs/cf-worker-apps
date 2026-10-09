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
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    addToast.mockReset()
  })

  const render = async (enabled: boolean, mutate = async (_enabled: boolean) => {}) => {
    const setSubscriptionModelEnabled = vi.fn(mutate)
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    const admin = { setSubscriptionModelEnabled } as unknown as RpcStub<AdminApi>
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const show = async (reported: boolean) => {
      const subscriptionModel: AdminSettingsView['subscriptionModel'] = {
        id: 'codex-subscription', name: 'Codex subscription', enabled: reported,
      }
      await act(async () => root!.render(<AdminModelsPanel admin={admin}
        gatewayModels={undefined} subscriptionModel={subscriptionModel} onChanged={onChanged} />))
    }
    await show(enabled)
    return { setSubscriptionModelEnabled, onChanged, show }
  }

  const toggle = () => {
    const control = document.body.querySelector<HTMLButtonElement>('[role="switch"]')!
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
    expect(setSubscriptionModelEnabled).toHaveBeenCalledExactlyOnceWith(!enabled)
    expect(onChanged).toHaveBeenCalledOnce()
    expect(setSubscriptionModelEnabled.mock.invocationCallOrder[0]).toBeLessThan(onChanged.mock.invocationCallOrder[0])
    // The control reflects the server's read, not an optimistic local setting.
    expect(toggle().control.getAttribute('aria-checked')).toBe(String(enabled))
    await show(!enabled)
    expect(toggle().control.getAttribute('aria-checked')).toBe(String(!enabled))
  })

  it('locks the toggle during a write, then restores it and reports a rejected write', async () => {
    let reject!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, fail) => { reject = fail })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onChanged } = await render(true, () => pending)
    await act(async () => toggle().checkbox.click())
    expect(toggle().control.disabled).toBe(true)
    await act(async () => reject(new Error('Unavailable')))
    expect(toggle().control.disabled).toBe(false)
    expect(toggle().control.getAttribute('aria-checked')).toBe('true')
    expect(onChanged).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
  })
})
