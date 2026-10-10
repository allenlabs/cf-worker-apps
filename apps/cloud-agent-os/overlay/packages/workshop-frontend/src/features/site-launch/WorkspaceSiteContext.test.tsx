// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, SiteContext } from '@gadgets/workshop-shared/api'
import { WorkspaceSiteContext } from './WorkspaceSiteContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('trusted workspace site context', () => {
  let root: Root | undefined
  const render = async (getSiteContext: () => Promise<SiteContext | null>) => {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<WorkspaceSiteContext overseer={{ getSiteContext } as RpcStub<Overseer>} />))
  }
  afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; root = undefined })

  it('displays only context fetched from the current workspace server and escapes its display name', async () => {
    await render(async () => ({ id: 'clinic', displayName: '<img src=x onerror=bad()>', environment: 'stg', timezone: 'Asia/Seoul' }))
    expect(document.body.textContent).toContain('<img src=x onerror=bad()>')
    expect(document.body.textContent).toContain('STG'); expect(document.body.textContent).toContain('Asia/Seoul')
    expect(document.querySelector('img')).toBeNull()
  })

  it('leaves ordinary workspaces unchanged when there is no site context', async () => {
    await render(async () => null)
    expect(document.querySelector('[aria-label="Site context"]')).toBeNull()
  })

  it('hides unavailable site metadata without showing raw RPC errors', async () => {
    await render(() => { throw new Error('private-error-details') })
    expect(document.querySelector('[aria-label="Site context"]')).toBeNull()
    expect(document.body.textContent).not.toContain('private-error-details')
  })

  it('ignores a previous site response when the workspace server changes', async () => {
    let resolveOld!: (value: SiteContext) => void
    const oldResponse = new Promise<SiteContext>(resolve => { resolveOld = resolve })
    await render(() => oldResponse)
    await render(async () => ({ id: 'current', displayName: 'Current clinic', environment: 'production', timezone: 'UTC' }))
    await act(async () => resolveOld({ id: 'old', displayName: 'Other clinic', environment: 'dev', timezone: 'UTC' }))
    expect(document.body.textContent).toContain('Current clinic')
    expect(document.body.textContent).not.toContain('Other clinic')
  })
})
