// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PERMISSIONS, type AgentProviderCatalog, type AgentSettingsCommand, type AgentSettingsView } from '@gadgets/workshop-shared/agent-settings'
import { AgentSettingsPanel } from './AgentSettingsPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const initial = (): AgentSettingsView => ({
  revision: 7, easyMode: true, viewerId: 'viewer', canManagePluginExecution: true, pluginReviews: [], pluginInstallations: [], pluginInstallerError: null,
  scopes: [
    { scope: { kind: 'organization' }, label: 'Organization', permissions: [...AGENT_PERMISSIONS] },
    { scope: { kind: 'team', teamId: 'research' }, label: 'Research', permissions: [...AGENT_PERMISSIONS] },
    { scope: { kind: 'team', teamId: 'agents' }, label: 'Agents', permissions: [...AGENT_PERMISSIONS] },
    { scope: { kind: 'team', teamId: 'writing' }, label: 'Writing', permissions: [...AGENT_PERMISSIONS] },
    { scope: { kind: 'personal', userId: 'viewer' }, label: 'Personal', permissions: [...AGENT_PERMISSIONS] },
  ],
  teams: [{ id: 'research', name: 'Research', parentId: null }, { id: 'agents', name: 'Agents', parentId: 'research' }, { id: 'writing', name: 'Writing', parentId: null }],
  memberships: [{ teamId: 'agents', userId: 'viewer', role: 'admin' }, { teamId: 'writing', userId: 'viewer', role: 'member' }],
  roles: [{ id: 'maintainer', name: 'Model maintainers', scope: { kind: 'personal', userId: 'viewer' }, members: ['colleague'], permissions: ['providers:manage'] }],
  delegations: [], resources: [], effectiveResources: [], providerGrants: [],
})
const catalog = (): AgentProviderCatalog => ({ providers: [{ id: 'subscription', name: 'Writing subscription', scope: { kind: 'personal', userId: 'viewer' },
  refreshedAt: '2026-10-20T01:00:00Z', error: null, models: [{ id: 'sub-model', providerId: 'subscription', modelId: 'model-a', name: 'Model A', providerName: 'Writing subscription',
    scope: { kind: 'personal', userId: 'viewer' }, source: 'subscription' }] },
{ id: 'compatible', name: 'Research backend', scope: { kind: 'team', teamId: 'research' }, refreshedAt: null, error: 'Model list unavailable', models: [] }] })
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => { throw new Error('Deferred not initialized') }
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('scoped agent settings', () => {
  it('requires an explicit keyless choice rather than reusing a saved key', async () => {
    await render()
    await select('Resource type', 'OpenAI-compatible provider')
    fill('name', 'Keyless backend'); fill('baseUrl', 'https://models.example.org/v1')
    const keyless = document.querySelector('input[name="keyless"]')
    expect(keyless).toBeInstanceOf(HTMLInputElement)
    if (!(keyless instanceof HTMLInputElement)) throw new Error('Missing keyless choice')
    await act(async () => keyless.click())
    await submit('Add agent resource')
    expect(updateAgentSettings.mock.lastCall?.[0]).toMatchObject({ type: 'saveResource', apiToken: '' })
  })

  let root: Root | null = null
  let saved: AgentSettingsView
  const getAgentSettings = vi.fn<() => Promise<AgentSettingsView>>()
  const updateAgentSettings = vi.fn<(command: AgentSettingsCommand) => Promise<AgentSettingsView>>()
  const getAgentProviderCatalog = vi.fn<(refresh?: boolean) => Promise<AgentProviderCatalog>>()
  const api = { getAgentSettings, updateAgentSettings, getAgentProviderCatalog }
  beforeEach(() => {
    saved = initial()
    getAgentSettings.mockImplementation(async () => saved)
    updateAgentSettings.mockImplementation(async command => {
      saved = { ...saved, revision: saved.revision + 1 }
      if (command.type === 'setMode') saved.easyMode = command.easyMode
      if (command.type === 'saveResource') saved.resources = [...saved.resources.filter(item => item.id !== command.resource.id), command.resource]
      if (command.type === 'setPluginExecution') saved.pluginReviews = saved.pluginReviews.map(item => item.id === command.resourceId ? { ...item, execution: command.execution } : item)
      if (command.type === 'saveRole') saved.roles = [...saved.roles.filter(item => item.id !== command.role.id), command.role]
      if (command.type === 'saveDelegation') saved.delegations = [...saved.delegations.filter(item => item.id !== command.delegation.id), command.delegation]
      if (command.type === 'saveMembership') saved.memberships = [...saved.memberships.filter(item => item.userId !== command.membership.userId || item.teamId !== command.membership.teamId), command.membership]
      if (command.type === 'removeMembership') saved.memberships = saved.memberships.filter(item => item.userId !== command.userId || item.teamId !== command.teamId)
      return saved
    })
    getAgentProviderCatalog.mockImplementation(async () => catalog())
    localStorage.clear()
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''; vi.restoreAllMocks(); vi.clearAllMocks()
  })
  const render = async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root?.render(<AgentSettingsPanel api={api} />))
  }
  const button = (label: string, within: ParentNode = document): HTMLButtonElement => {
    const buttons = Array.from(within.querySelectorAll('button'))
    const found = buttons.find(item => item.getAttribute('aria-label') === label) ?? buttons.find(item => item.textContent === label)
    if (!found) throw new Error(`Missing button: ${label}`)
    return found
  }
  const form = (label: string): HTMLFormElement => {
    const found = document.querySelector(`form[aria-label="${label}"]`)
    if (!(found instanceof HTMLFormElement)) throw new Error(`Missing form: ${label}`)
    return found
  }
  const fill = (name: string, value: string, within: ParentNode = document) => {
    const found = within.querySelector(`[name="${name}"]`)
    if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)) throw new Error(`Missing field: ${name}`)
    found.value = value
  }
  const submit = async (label: string) => { await act(async () => form(label).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
  const click = async (label: string, within: ParentNode = document) => { await act(async () => button(label, within).click()) }
  const select = async (label: string, text: string) => {
    await click(label)
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent === text)
    if (!option) throw new Error(`Missing ${label} option: ${text}`)
    const browser: { PointerEvent?: typeof MouseEvent } = window
    browser.PointerEvent = MouseEvent
    try {
      await act(async () => option.focus())
      await act(async () => option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    } finally { delete browser.PointerEvent }
  }
  const checkbox = (text: string, within: ParentNode = document): HTMLElement => {
    const label = Array.from(within.querySelectorAll('label')).find(item => item.textContent === text)
    const found = label?.control ?? label?.querySelector('[role="checkbox"]')
    if (!(found instanceof HTMLElement)) throw new Error(`Missing checkbox: ${text}`)
    return found
  }
  const check = async (text: string, within: ParentNode = document) => { await act(async () => checkbox(text, within).click()) }

  it('loads personal settings with provenance and bounded plugin/MCP guidance, without inference or eager refresh', async () => {
    await render()
    expect(document.body.textContent).toContain('The owner of this personal scope is its administrator')
    expect(document.body.textContent).toContain('Easy mode shows administrators')
    expect(document.body.textContent).toContain('Writing subscription')
    expect(document.body.textContent).toContain('model-a · Subscription')
    expect(document.body.textContent).toContain('Model list unavailable')
    expect(getAgentProviderCatalog.mock.calls).toEqual([[]])
    expect(updateAgentSettings).not.toHaveBeenCalled()
    await select('Resource type', 'MCP server')
    expect(document.body.textContent).toContain('authorizes OAuth separately')
    await select('Resource type', 'Plugin')
    expect(document.body.textContent).toContain('Plugin execution · organization administrator')
    expect(document.querySelector('textarea[name="instructions"]')).not.toBeNull()
    await select('Plugin type', 'Tool policy')
    fill('name', 'Policy'); fill('deniedTools', 'write_file, execute_command')
    await submit('Add agent resource')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 7, resource: expect.objectContaining({ kind: 'plugin', pluginId: 'tool-policy', deniedTools: ['write_file', 'execute_command'] }) }))
  })

  it('submits pinned npm requests as pending and rejects non-object options before writing', async () => {
    saved.canManagePluginExecution = false
    await render()
    await select('Resource type', 'Plugin'); await select('Plugin type', 'npm package or R2 bundle')
    fill('name', 'Authored plugin'); fill('packageName', '@example/authored-plugin'); fill('packageVersion', '1.2.3')
    fill('pluginOptions', '[]'); await submit('Add agent resource')
    expect(updateAgentSettings).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Use a JSON object for plugin options')
    fill('pluginOptions', '{"language":"한글","nested":{"enabled":true}}'); await submit('Add agent resource')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'saveResource', expectedRevision: 7, resource: {
      id: expect.any(String), name: 'Authored plugin', kind: 'plugin', pluginId: 'package', enabled: true, scope: { kind: 'personal', userId: 'viewer' },
      source: { kind: 'npm', name: '@example/authored-plugin', version: '1.2.3' }, execution: 'pending', options: JSON.stringify({ language: '한글', nested: { enabled: true } }),
    } })
    expect(document.body.textContent).toContain('Waiting for organization approval')
    expect(document.querySelector('[aria-label="Execution for Authored plugin"]')).toBeNull()
  })

  it('submits prebuilt R2 digests and resets execution when changing approved source code', async () => {
    saved.canManagePluginExecution = false
    saved.resources = [{ id: 'package', name: 'Existing plugin', kind: 'plugin', pluginId: 'package', enabled: true, scope: { kind: 'personal', userId: 'viewer' },
      source: { kind: 'npm', name: 'authored-plugin', version: '1.2.3' }, execution: 'host', options: JSON.stringify({ language: 'en' }) }]
    await render(); await click('Edit resource Existing plugin')
    fill('pluginOptions', '{"language":"ko"}'); await submit('Edit Existing plugin')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ resource: expect.objectContaining({ execution: 'host', options: JSON.stringify({ language: 'ko' }) }) }))
    await click('Edit resource Existing plugin'); await select('Plugin source', 'Prebuilt R2 artifact · SHA-256')
    fill('bundleDigest', 'a'.repeat(64)); await submit('Edit Existing plugin')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 8,
      resource: expect.objectContaining({ source: { kind: 'bundle', digest: 'a'.repeat(64) }, execution: 'pending' }) }))
  })

  it('lets only organization administrators choose pinned execution from the narrow review list', async () => {
    saved.resources = []
    saved.pluginReviews = [{ id: 'private-package', name: 'Private request', scope: { kind: 'personal', userId: 'colleague' },
      source: { kind: 'npm', name: 'authored-plugin', version: '1.2.3' }, execution: 'pending' }]
    await render()
    expect(document.body.textContent).toContain('Private plugin options are not included')
    await select('Execution for Private request', 'Include in OpenCode DO · redeploy OS')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'setPluginExecution', expectedRevision: 7, resourceId: 'private-package',
      source: { kind: 'npm', name: 'authored-plugin', version: '1.2.3' }, execution: 'host' })
    expect(document.body.textContent).toContain('Waiting for installer')
    expect(document.querySelector('form[aria-label="Edit Private request"]')).toBeNull()
    saved = { ...saved, canManagePluginExecution: false, pluginReviews: [] }
    await click('Reload settings')
    expect(document.querySelector('[aria-label="Organization plugin execution"]')).toBeNull()
  })

  it('shows real installation progress and queue errors without treating host readiness as active deployment', async () => {
    saved.resources = [{ id: 'package', name: 'Queued plugin', kind: 'plugin', pluginId: 'package', enabled: true, scope: { kind: 'personal', userId: 'viewer' },
      source: { kind: 'npm', name: 'authored-plugin', version: '1.2.3' }, execution: 'host', options: '{}' }]
    saved.pluginInstallations = [{ id: 'installation', resourceId: 'package', execution: 'host', status: 'ready', artifactDigest: 'a'.repeat(64), error: null, updatedAt: null }]
    saved.pluginInstallerError = 'Settings saved; installer queue unavailable. Reload settings to retry.'
    await render()
    expect(document.body.textContent).toContain('Waiting for deployment')
    expect(document.body.textContent).not.toContain(' · Active')
    expect(document.body.textContent).toContain('installer queue unavailable')
    expect(button('Add administrator').disabled).toBe(false)
    saved = { ...saved, pluginInstallerError: null, pluginInstallations: saved.pluginInstallations.map(item => ({ ...item, status: 'active' })) }
    await click('Reload settings'); expect(document.body.textContent).toContain(' · Active')
  })

  it('saves an OpenAI-compatible backend in its selected scope with a write-only key and exact revision', async () => {
    await render()
    await select('Resource type', 'OpenAI-compatible provider')
    fill('name', 'Personal router'); fill('baseUrl', 'https://models.example.org/v1'); fill('apiToken', 'synthetic-write-only')
    expect(document.querySelector('input[name="apiToken"]')?.getAttribute('type')).toBe('password')
    await submit('Add agent resource')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'saveResource', expectedRevision: 7, apiToken: 'synthetic-write-only', resource: {
      id: expect.any(String), name: 'Personal router', kind: 'provider', baseUrl: 'https://models.example.org/v1', scope: { kind: 'personal', userId: 'viewer' }, enabled: true,
    } })
    expect(document.body.textContent).toContain('Saved.')
    expect(document.body.textContent).toContain('Personal router')
    expect(document.body.innerHTML).not.toContain('synthetic-write-only')
    expect(localStorage.length).toBe(0)
    await click('Edit resource Personal router')
    const key = document.querySelector('input[name="apiToken"]')
    expect(key instanceof HTMLInputElement && key.value).toBe('')
    expect(document.body.textContent).toContain('Leave blank to keep the existing key')
    await submit('Edit Personal router')
    expect(updateAgentSettings.mock.lastCall?.[0]).not.toHaveProperty('apiToken')
  })

  it('shows read-only organization resources without granting actions from the scope name', async () => {
    saved.canManagePluginExecution = false
    saved.scopes = [{ scope: { kind: 'organization' }, label: 'Organization', permissions: [] }]
    saved.resources = [{ id: 'shared', kind: 'provider', name: 'Organization models', scope: { kind: 'organization' }, enabled: true, baseUrl: 'https://models.example.org/v1' }]
    await render()
    expect(document.body.textContent).toContain('Read-only scope')
    expect(document.body.textContent).toContain('Organization models')
    expect(document.body.textContent).toContain('managed by an organization settings administrator')
    expect(document.querySelector('form')).toBeNull()
    expect(Array.from(document.querySelectorAll('button')).some(item => item.textContent === 'Edit')).toBe(false)
    expect(Array.from(document.querySelectorAll('button')).some(item => item.textContent === 'Remove')).toBe(false)
    expect(document.querySelector('[role="checkbox"]')).toBeNull()
  })

  it('limits delegated role choices to permissions actually held by the selected scope', async () => {
    saved.easyMode = false
    saved.scopes = [{ scope: { kind: 'personal', userId: 'viewer' }, label: 'Personal', permissions: ['roles:manage', 'providers:manage'] }]
    await render()
    expect(Array.from(document.querySelectorAll('button')).some(item => item.textContent === 'Add administrator')).toBe(false)
    expect(checkbox('Share providers', form('Delegate permissions')).matches(':disabled')).toBe(true)
    await check('Share providers', form('Delegate permissions'))
    expect(button('Delegate permissions').disabled).toBe(true)
    await check('Manage providers', form('Delegate permissions'))
    fill('delegateUser', 'provider-editor')
    await submit('Delegate permissions')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ delegation: expect.objectContaining({ permissions: ['providers:manage'] }) }))
  })

  it('supports nested scopes, multiple team memberships, team admins and confirmed membership removal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render()
    await select('Configuration scope', 'Team · Research / Agents')
    expect(document.body.textContent).toContain('viewer · admin')
    expect(document.body.textContent).toContain('Users can belong to more than one team')
    fill('memberUser', 'second-user')
    await select('Team membership role', 'Administrator')
    await submit('Team membership')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'saveMembership', expectedRevision: 7, membership: { teamId: 'agents', userId: 'second-user', role: 'admin' } })
    await click('Remove member viewer')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('viewer'))
    expect(updateAgentSettings).toHaveBeenCalledTimes(1)
    confirm.mockReturnValue(true)
    await click('Remove member viewer')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'removeMembership', expectedRevision: 8, teamId: 'agents', userId: 'viewer' })
    await click('Edit Agents')
    expect(document.body.textContent).toContain('parent of an existing team is fixed')
    expect(document.querySelector('[aria-label="Parent team"]')).toBeNull()
    await select('Configuration scope', 'Team · Writing')
    expect(document.body.textContent).toContain('viewer · member')
  })

  it('lets easy-mode administrators delegate full scope administration and uses the organization mode permission', async () => {
    await render()
    fill('adminUser', 'other-admin')
    await submit('Add administrator')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'saveDelegation', expectedRevision: 7,
      delegation: expect.objectContaining({ scope: { kind: 'personal', userId: 'viewer' }, subject: { kind: 'user', id: 'other-admin' }, permissions: [...AGENT_PERMISSIONS] }) }))
    await check('Easy mode')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'setMode', expectedRevision: 8, easyMode: false })
    expect(document.body.textContent).toContain('Roles and delegated permissions')
  })

  it('edits roles and delegates permissions to a role, then shares a provider with a named audience', async () => {
    saved.easyMode = false
    saved.resources = [{ id: 'personal-provider', name: 'Personal backend', kind: 'provider', scope: { kind: 'personal', userId: 'viewer' }, enabled: true, baseUrl: 'https://models.example.org/v1' }]
    await render()
    await click('Edit role Model maintainers')
    fill('roleName', 'Provider maintainers'); fill('roleMembers', 'colleague, reviewer')
    await check('Share providers', form('Save role'))
    await submit('Save role')
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'saveRole', expectedRevision: 7, role: { id: 'maintainer', name: 'Provider maintainers', scope: { kind: 'personal', userId: 'viewer' }, members: ['colleague', 'reviewer'], permissions: ['providers:manage', 'providers:grant'] } })
    await select('Delegate to', 'Role')
    await select('Delegate role', 'Provider maintainers')
    await check('Manage providers', form('Delegate permissions'))
    await submit('Delegate permissions')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'saveDelegation', expectedRevision: 8,
      delegation: expect.objectContaining({ subject: { kind: 'role', id: 'maintainer' }, permissions: ['providers:manage'] }) }))
    await select('Provider to share', 'Personal backend'); await select('Sharing audience', 'Research')
    await submit('Share provider')
    expect(updateAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'saveProviderGrant', expectedRevision: 9,
      grant: expect.objectContaining({ providerId: 'personal-provider', scope: { kind: 'team', teamId: 'research' }, enabled: true }) }))
  })

  it('reloads conflicting changes before retrying and uses the new revision without claiming success', async () => {
    updateAgentSettings.mockRejectedValueOnce(new Error('revision conflict'))
    await render()
    saved = { ...saved, revision: 11 }
    fill('adminUser', 'delegate')
    await submit('Add administrator')
    expect(document.body.textContent).toContain('Settings changed elsewhere')
    expect(document.body.textContent).not.toContain('Saved.')
    expect(getAgentSettings).toHaveBeenCalledTimes(2)
    await submit('Add administrator')
    expect(updateAgentSettings.mock.lastCall?.[0].expectedRevision).toBe(11)
  })

  it('disables mutation after an uncertain save and failed readback until an explicit reload succeeds', async () => {
    await render()
    updateAgentSettings.mockRejectedValueOnce(new Error('transport failed after write'))
    getAgentSettings.mockRejectedValueOnce(new Error('readback unavailable'))
    fill('adminUser', 'delegate')
    await submit('Add administrator')
    expect(document.body.textContent).toContain('change could not be confirmed and reloading failed')
    expect(document.body.textContent).not.toContain('Saved.')
    expect(button('Add administrator').disabled).toBe(true)
    await click('Reload settings')
    expect(button('Add administrator').disabled).toBe(false)
    expect(document.body.textContent).toContain('Current settings loaded.')
  })

  it('prevents duplicate writes, confirms resource removal and refreshes model discovery independently', async () => {
    const pending = deferred<AgentSettingsView>()
    saved.resources = [{ id: 'skill', name: 'Research skill', kind: 'skill', description: 'Read sources', content: 'Read primary sources.', enabled: true, scope: { kind: 'personal', userId: 'viewer' } }]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render()
    await click('Remove resource Research skill')
    expect(updateAgentSettings).not.toHaveBeenCalled()
    confirm.mockReturnValue(true); updateAgentSettings.mockReturnValueOnce(pending.promise)
    await click('Remove resource Research skill')
    await click('Remove resource Research skill')
    expect(updateAgentSettings).toHaveBeenCalledTimes(1)
    expect(updateAgentSettings).toHaveBeenLastCalledWith({ type: 'removeResource', expectedRevision: 7, resourceId: 'skill' })
    await click('Refresh model lists')
    expect(getAgentProviderCatalog).toHaveBeenLastCalledWith(true)
    await act(async () => pending.resolve({ ...saved, revision: 8, resources: [] }))
    expect(document.body.textContent).toContain('No resources configured in this scope')
  })

  it('keeps older model discovery marked stale when settings change while its request is pending', async () => {
    await render()
    const pending = deferred<AgentProviderCatalog>()
    getAgentProviderCatalog.mockReturnValueOnce(pending.promise)
    await click('Refresh model lists')
    fill('adminUser', 'delegate')
    await submit('Add administrator')
    await act(async () => pending.resolve(catalog()))
    expect(document.body.textContent).toContain('Settings changed. Refresh model lists')
    await click('Refresh model lists')
    expect(document.body.textContent).not.toContain('Settings changed. Refresh model lists')
  })

  it('ignores an old account’s in-flight write after the authenticated API changes', async () => {
    await render()
    const pending = deferred<AgentSettingsView>()
    updateAgentSettings.mockReturnValueOnce(pending.promise)
    fill('adminUser', 'delegate'); await submit('Add administrator')
    const nextView: AgentSettingsView = { ...initial(), canManagePluginExecution: false, viewerId: 'another-viewer', scopes: [{ scope: { kind: 'personal', userId: 'another-viewer' }, label: 'Another personal scope', permissions: [] }] }
    const nextApi = { getAgentSettings: vi.fn<() => Promise<AgentSettingsView>>(async () => nextView), updateAgentSettings,
      getAgentProviderCatalog: vi.fn<(refresh?: boolean) => Promise<AgentProviderCatalog>>(async () => ({ providers: [] })) }
    await act(async () => root?.render(<AgentSettingsPanel api={nextApi} />))
    expect(document.body.textContent).toContain('Another personal scope')
    expect(button('Reload settings').disabled).toBe(false)
    await act(async () => pending.resolve({ ...saved, revision: 8 }))
    expect(document.body.textContent).toContain('Another personal scope')
    expect(document.body.textContent).not.toContain('Saved.')
    expect(document.querySelector('form')).toBeNull()
  })
})
