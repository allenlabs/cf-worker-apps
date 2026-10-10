// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to, params }: { to: string; params?: { id: string } }) => <div data-redirect={to} data-workspace={params?.id} />,
  Link: ({ to, params, children }: { to: string; params?: { id: string }; children: ReactNode }) =>
    <a href={to.replace('$id', params?.id ?? '')}>{children}</a>,
}))
vi.mock('../../components/UserMenu', () => ({ default: () => <button>Account menu</button> }))

import { SiteLaunchRouteGuard, SiteLaunchScopeContext, useSiteLaunchSelection } from './SiteLaunchScope'
import { WorkspaceHomeLink } from './WorkspaceHomeLink'
import { EmbeddedSiteShell } from './EmbeddedSiteShell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const selected: SiteLaunchRedemption = { workspaceId: 'site-a',
  siteContext: { id: 'a', environment: 'production', displayName: 'Site A', timezone: 'Asia/Seoul' } }

describe('embedded site presentation', () => {
  let root: Root | undefined
  const render = async (node: ReactNode) => {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(node))
  }
  afterEach(async () => {
    await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks()
  })
  const content = vi.fn(() => <div>Protected route content</div>)
  const tree = (pathname: string, selection: SiteLaunchRedemption | null = selected, embedded = true) => (
    <SiteLaunchRouteGuard pathname={pathname} selection={selection} embedded={embedded}>
      {<Content />}
    </SiteLaunchRouteGuard>
  )
  const Content = () => content()

  it.each(['/', '/workspaces', '/workspace/site-b', '/gadget/site-b', '/outputs', '/blueprints', '/explore'])
  ('redirects %s before mounting any unrelated content', async pathname => {
    await render(tree(pathname))
    expect(content).not.toHaveBeenCalled()
    expect(document.querySelector('[data-redirect]')?.getAttribute('data-workspace')).toBe('site-a')
  })

  it.each(['/workspace/site-a', '/profile', '/providers', '/admin', '/gatekeepers', '/gatekeepers/example', '/context'])
  ('allows current site and account management route %s', async pathname => {
    await render(tree(pathname))
    expect(document.body.textContent).toContain('Protected route content')
    expect(document.querySelector('[data-redirect]')).toBeNull()
  })

  it('fails closed when reloaded in an embedded workspace with no verified selection', async () => {
    await render(tree('/workspace/site-a', null))
    expect(content).not.toHaveBeenCalled()
    expect(document.querySelector('[data-redirect]')?.getAttribute('data-redirect')).toBe('/launch')
  })

  it('preserves standalone Home and other workspace navigation', async () => {
    await render(tree('/', null, false)); expect(content).toHaveBeenCalledOnce()
    await render(tree('/workspace/site-b', selected, false)); expect(content).toHaveBeenCalledTimes(2)
  })

  it('retains trusted selection across management navigation and clears it on new launch or logout', async () => {
    let actions: ReturnType<typeof useSiteLaunchSelection>
    const Probe = ({ pathname }: { pathname: string }) => {
      actions = useSiteLaunchSelection(pathname)
      return <div>{actions.selection?.workspaceId ?? 'no selection'}</div>
    }
    await render(<Probe pathname="/launch" />)
    await act(async () => actions.onLaunched(selected))
    await render(<Probe pathname="/workspace/site-a" />)
    await render(<Probe pathname="/providers" />)
    expect(document.body.textContent).toBe('site-a')
    await render(<Probe pathname="/launch" />)
    expect(document.body.textContent).toBe('no selection')
    await act(async () => actions.onLaunched(selected))
    await act(async () => actions.clearSelection())
    expect(document.body.textContent).toBe('no selection')
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })

  it('removes workspace Home navigation only for a trusted embedded selection', async () => {
    await render(<SiteLaunchScopeContext.Provider value={selected}><WorkspaceHomeLink>Logo</WorkspaceHomeLink></SiteLaunchScopeContext.Provider>)
    expect(document.querySelector('a')).toBeNull()
    await render(<WorkspaceHomeLink>Logo</WorkspaceHomeLink>)
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/')
  })

  it('keeps account management visibly tied to the site without global workspace navigation', async () => {
    await render(<EmbeddedSiteShell selection={selected}><div>Models settings</div></EmbeddedSiteShell>)
    expect(document.body.textContent).toContain('Site A')
    expect(document.body.textContent).toContain('PRODUCTION')
    expect(document.body.textContent).toContain('Account-wide settings')
    const back = Array.from(document.querySelectorAll('a')).find(node => node.textContent === 'Back to site workspace')
    expect(back?.getAttribute('href')).toBe('/workspace/site-a')
    expect(document.querySelector('a[href="/"]')).toBeNull()
    expect(document.querySelector('a[href="/workspaces"]')).toBeNull()
    expect(document.body.textContent).toContain('Models settings')
  })
})
