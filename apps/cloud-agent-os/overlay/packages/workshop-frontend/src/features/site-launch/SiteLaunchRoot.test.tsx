// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRouter, createMemoryHistory, createRoute, RouterProvider, useNavigate, useParams } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSiteLaunchAuth } from './SiteLaunchAuthContext'
import type { SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

const state = vi.hoisted(() => ({ appShell: vi.fn(), mounted: vi.fn(), logout: vi.fn(),
  onLogout: undefined as (() => void) | undefined,
  navigation: undefined as Promise<void> | undefined,
  api: { isOnboardingCompleted: async () => true },
}))
const LaunchProbe = () => {
  const { onLaunched } = useSiteLaunchAuth()
  const navigate = useNavigate()
  return <button onClick={() => {
    state.navigation = (async () => {
      await Promise.resolve() // Redemption resumes asynchronously after the sign-in/message event.
      onLaunched(selected)
      await navigate({ to: '/workspace/$id', params: { id: selected.workspaceId }, replace: true, search: {}, hash: '' })
    })()
  }}>Verified launch</button>
}
const selected: SiteLaunchRedemption = { workspaceId: 'site-a', siteContext: {
  id: 'a', environment: 'production', displayName: 'Site A', timezone: 'Asia/Seoul',
} }
vi.mock('@cloudflare/kumo', () => ({ TooltipProvider: ({ children }: { children: ReactNode }) => children, Toasty: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../RpcContext', () => ({ useRpcStub: () => ({}), useConnectionLost: () => false }))
vi.mock('../../useAuth', () => ({ CF_ACCESS_MODE: false, useAuth: () => ({
  isAuthenticated: true, authenticatedApi: state.api, isLoading: false, error: null, logout: state.logout, login: vi.fn(),
}) }))
vi.mock('../../AuthContext', () => ({ AuthProvider: ({ children, onLogout }: { children: ReactNode; onLogout: () => void }) => {
  state.onLogout = onLogout; return children
} }))
vi.mock('../../FeatureFlagsContext', () => ({ FeatureFlagsProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../components/AppShell/AppShell', () => ({ default: ({ children }: { children: ReactNode }) => {
  state.appShell(); return <div>Global workspace navigation{children}</div>
} }))
vi.mock('../../components/Header', () => ({ default: () => null }))
vi.mock('../../LoginPage', () => ({ default: () => null }))
vi.mock('../../OnboardingWizard', () => ({ default: () => null }))
vi.mock('../../components/billing/AccountSelectionModal', () => ({ default: () => null }))
vi.mock('../../components/UserMenu', () => ({ default: () => null }))
import { Route } from '../../routes/__root'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('root embedded route integration', () => {
  let root: Root | undefined
  const Content = ({ page }: { page: string }) => {
    state.mounted(page)
    return <div>Route {page}</div>
  }
  const Workspace = () => {
    const { id } = useParams({ strict: false })
    return <Content page={`/workspace/${id}`} />
  }
  const routeTree = Route.addChildren([
    createRoute({ getParentRoute: () => Route, path: '/launch', component: LaunchProbe }),
    createRoute({ getParentRoute: () => Route, path: '/workspace/$id', component: Workspace }),
    createRoute({ getParentRoute: () => Route, path: '/providers', component: () => <Content page="/providers" /> }),
    createRoute({ getParentRoute: () => Route, path: '/', component: () => <Content page="/" /> }),
  ])
  let router: ReturnType<typeof createRouter> | undefined
  const render = async (pathname: string, embedded = true) => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    vi.stubEnv('VITE_SITE_LAUNCH_PARENT_ORIGINS', '["https://portal.example.com"]')
    vi.spyOn(window, 'parent', 'get').mockReturnValue(embedded ? {} as Window : window)
    if (!root) {
      router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [pathname] }) })
      root = createRoot(document.body.appendChild(document.createElement('div')))
      await act(async () => { root!.render(<RouterProvider router={router!} />); await router!.load() })
    } else {
      await act(async () => { await router!.navigate({ to: pathname as '/' }) })
    }
  }
  const launch = async () => {
    await render('/launch')
    await act(async () => {
      document.querySelector('button')!.click()
      await state.navigation
    })
  }
  afterEach(async () => {
    await act(async () => root?.unmount()); root = undefined; router = undefined; document.body.innerHTML = ''
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); state.onLogout = undefined
  })

  it('launches the trusted workspace, retains site on management, and prevents Home/other-workspace mounting', async () => {
    await launch()
    expect(document.body.textContent).toContain('Route /workspace/site-a')
    await render('/providers')
    expect(document.body.textContent).toContain('Site A')
    expect(document.body.textContent).toContain('Account-wide settings')
    expect(document.body.textContent).toContain('Back to site workspace')
    expect(state.appShell).not.toHaveBeenCalled()
    state.mounted.mockClear()
    await render('/')
    expect(state.mounted).not.toHaveBeenCalledWith('/')
    expect(router!.state.location.pathname).toBe('/workspace/site-a')
    await render('/workspace/site-b')
    expect(document.body.textContent).toContain('Route /workspace/site-a')
    expect(state.mounted).not.toHaveBeenCalledWith('/workspace/site-b')
  })

  it('blocks direct embedded workspace reload without verified memory selection', async () => {
    await render('/workspace/site-a')
    expect(state.mounted).not.toHaveBeenCalled()
    expect(router!.state.location.pathname).toBe('/launch')
  })

  it('clears trusted selection on logout and never falls back to ordinary workspace chrome', async () => {
    await launch()
    vi.spyOn(console, 'error').mockImplementation(() => {}) // jsdom does not implement document navigation.
    await act(async () => state.onLogout!())
    expect(state.logout).toHaveBeenCalledOnce()
    expect(router!.state.location.pathname).toBe('/launch')
    expect(state.appShell).not.toHaveBeenCalled()
  })

  it('retains ordinary standalone global navigation', async () => {
    await render('/', false)
    expect(state.appShell).toHaveBeenCalled()
    expect(document.body.textContent).toContain('Global workspace navigation')
  })
})
