import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Checkbox, Input, Select, Textarea } from '@cloudflare/kumo'
import {
  AGENT_PERMISSIONS,
  type AgentJson, type AgentPluginInstallation, type AgentPluginSource, type AgentPermission, type AgentProviderCatalog, type AgentResource, type AgentScope,
  type AgentSettingsCommand, type AgentSettingsView, type AgentTeam,
} from '@gadgets/workshop-shared/agent-settings'

type SettingsApi = {
  getAgentSettings(): Promise<AgentSettingsView>
  updateAgentSettings(command: AgentSettingsCommand): Promise<AgentSettingsView>
  getAgentProviderCatalog(refresh?: boolean): Promise<AgentProviderCatalog>
}
const scopeKey = (scope: AgentScope): string => scope.kind === 'organization' ? 'organization'
  : scope.kind === 'team' ? `team:${scope.teamId}` : `personal:${scope.userId}`
const sameScope = (left: AgentScope, right: AgentScope) => scopeKey(left) === scopeKey(right)
const field = (data: FormData, name: string) => String(data.get(name) ?? '').trim()
const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))]
const permissionLabels: Record<AgentPermission, string> = {
  'teams:manage': 'Manage teams', 'members:manage': 'Manage members and team admins',
  'roles:manage': 'Manage roles and delegations', 'providers:manage': 'Manage providers',
  'providers:grant': 'Share providers', 'plugins:manage': 'Manage plugins', 'skills:manage': 'Manage skills',
  'mcp:manage': 'Manage MCP servers', 'settings:manage': 'Manage settings',
}
const resourcePermission: Record<AgentResource['kind'], AgentPermission> = {
  provider: 'providers:manage', skill: 'skills:manage', plugin: 'plugins:manage', mcp: 'mcp:manage',
}
const teamPath = (team: AgentTeam, teams: AgentTeam[]) => {
  const names = [team.name]
  let parentId = team.parentId
  for (let remaining = teams.length; parentId && remaining > 0; remaining--) {
    const parent = teams.find(item => item.id === parentId)
    if (!parent) break
    names.unshift(parent.name); parentId = parent.parentId
  }
  return names.join(' / ')
}
const Permissions = ({ value, available, onChange }: {
  value: AgentPermission[]; available: AgentPermission[]; onChange: (value: AgentPermission[]) => void
}) => <fieldset className="space-y-2"><legend className="mb-2 font-medium">Permissions</legend>
  <div className="grid gap-2">{AGENT_PERMISSIONS.map(permission => <Checkbox key={permission} label={permissionLabels[permission]}
    checked={value.includes(permission)} disabled={!available.includes(permission)}
    onCheckedChange={checked => onChange(checked ? [...value, permission] : value.filter(item => item !== permission))} />)}</div>
</fieldset>

const pluginSourceLabel = (source: AgentPluginSource) => source.kind === 'npm' ? `${source.name}@${source.version}` : `R2 bundle · ${source.digest}`
const samePluginSource = (left: AgentPluginSource, right: AgentPluginSource) => left.kind === 'npm'
  ? right.kind === 'npm' && left.name === right.name && left.version === right.version : right.kind === 'bundle' && left.digest === right.digest
const isAgentJson = (value: unknown): value is AgentJson => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) ? value.every(isAgentJson)
    : typeof value === 'object' && Object.values(value).every(isAgentJson))
const parsePluginOptions = (text: string): string => {
  const value: unknown = JSON.parse(text || '{}')
  if (!isAgentJson(value) || value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a JSON object for plugin options.')
  return JSON.stringify(value)
}
const PluginInstallationStatus = ({ execution, installation }: { execution: 'pending' | 'host' | 'dynamic'; installation?: AgentPluginInstallation }) => {
  const labels = { queued: 'Queued', building: 'Building', verifying: 'Verifying', deploying: 'Deploying', ready: execution === 'host' ? 'Waiting for deployment' : 'Ready to load', active: 'Active', failed: 'Installation failed' }
  return <div className="mt-1 text-sm text-kumo-subtle">
    <p>{execution === 'pending' ? 'Waiting for organization approval' : `${execution === 'host' ? 'Included in OpenCode DO' : 'Dynamic Worker'} · ${installation ? labels[installation.status] : 'Waiting for installer'}`}</p>
    {installation?.error && <p role="alert">{installation.error}</p>}
  </div>
}
const PluginExecutionSettings = ({ view, disabled, onSave }: {
  view: AgentSettingsView; disabled: boolean; onSave: (command: AgentSettingsCommand) => Promise<boolean>
}) => view.canManagePluginExecution ? <section aria-label="Organization plugin execution" className="space-y-3 rounded-lg border border-kumo-line p-4">
  <h3 className="text-lg font-medium">Plugin execution · organization administrator</h3>
  <p className="text-sm text-kumo-subtle">Choose execution for each pinned package, including team and personal requests. Changes to package code require approval again. Private plugin options are not included in this review.</p>
  <p className="text-sm text-kumo-subtle">Included in OpenCode DO trusts the package in the OS Worker and requires an OS deployment. Dynamic Worker loads the R2 bundle in isolation and has separate Cloudflare usage charges. Both require a compatible JavaScript bundle; Bun, subprocesses and native addons are unsupported.</p>
  {view.pluginReviews.length === 0 && <p className="text-sm text-kumo-subtle">No package plugins submitted.</p>}
  <ul className="space-y-3">{view.pluginReviews.map(plugin => <li key={plugin.id} className="space-y-2 rounded-lg border border-kumo-line p-3">
    <p className="font-medium">{plugin.name}</p><p className="break-all text-sm text-kumo-subtle">{scopeKey(plugin.scope)} · {pluginSourceLabel(plugin.source)}</p>
    <Select label={`Execution for ${plugin.name}`} aria-label={`Execution for ${plugin.name}`} value={plugin.execution} disabled={disabled}
      items={{ pending: 'Awaiting decision', host: 'Include in OpenCode DO · redeploy OS', dynamic: 'Dynamic Worker · isolated' }}
      onValueChange={execution => {
        if (execution === 'host' || execution === 'dynamic') void onSave({ type: 'setPluginExecution', expectedRevision: view.revision, resourceId: plugin.id, source: plugin.source, execution })
      }} />
    <PluginInstallationStatus execution={plugin.execution} installation={view.pluginInstallations.find(item => item.resourceId === plugin.id)} />
  </li>)}</ul>
</section> : null

const ResourceForm = ({ scope, revision, permissions, resource, disabled, onSave, onCancel }: {
  scope: AgentScope; revision: number; permissions: AgentPermission[]; resource?: AgentResource; disabled: boolean
  onSave: (command: AgentSettingsCommand) => Promise<boolean>; onCancel: () => void
}) => {
  const choices = Object.entries(resourcePermission).filter(([, permission]) => permissions.includes(permission))
  const [kind, setKind] = useState(resource?.kind ?? choices[0]?.[0] ?? 'skill')
  const [pluginId, setPluginId] = useState(resource?.kind === 'plugin' ? resource.pluginId : 'instructions')
  const [enabled, setEnabled] = useState(resource?.enabled ?? true)
  const [sourceKind, setSourceKind] = useState(resource?.kind === 'plugin' && resource.pluginId === 'package' ? resource.source.kind : 'npm')
  const [formError, setFormError] = useState<string | null>(null)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const base = { id: resource?.id ?? crypto.randomUUID(), name: field(data, 'name'), scope, enabled }
    let next: AgentResource
    if (kind === 'skill') next = { ...base, kind, description: field(data, 'description'), content: field(data, 'content') }
    else if (kind === 'mcp') next = { ...base, kind, description: field(data, 'description'), endpoint: field(data, 'endpoint') }
    else if (kind === 'provider') next = { ...base, kind, baseUrl: field(data, 'baseUrl') }
    else if (kind === 'plugin' && pluginId === 'instructions') next = { ...base, kind, pluginId, instructions: field(data, 'instructions') }
    else if (kind === 'plugin' && pluginId === 'tool-policy') next = { ...base, kind, pluginId, deniedTools: ids(field(data, 'deniedTools')) }
    else if (kind === 'plugin' && pluginId === 'package') {
      try {
        const source: AgentPluginSource = sourceKind === 'npm' ? { kind: 'npm', name: field(data, 'packageName'), version: field(data, 'packageVersion') }
          : { kind: 'bundle', digest: field(data, 'bundleDigest') }
        const execution = resource?.kind === 'plugin' && resource.pluginId === 'package' && samePluginSource(resource.source, source) ? resource.execution : 'pending'
        next = { ...base, kind, pluginId, source, execution, options: parsePluginOptions(field(data, 'pluginOptions')) }
      } catch { setFormError('Use a JSON object for plugin options.'); return }
    } else return
    setFormError(null)
    const apiToken = field(data, 'apiToken')
    // Clear the write-only credential before the RPC can settle or an error is shown.
    const tokenInput = event.currentTarget.elements.namedItem('apiToken')
    if (tokenInput instanceof HTMLInputElement) tokenInput.value = ''
    void onSave({ type: 'saveResource', expectedRevision: revision, resource: next, ...(data.get('keyless') === 'on' ? { apiToken: '' } : apiToken ? { apiToken } : {}) })
  }
  return <form aria-label={resource ? `Edit ${resource.name}` : 'Add agent resource'} onSubmit={submit} className="space-y-3 rounded-lg border border-kumo-line p-4">
    <h4 className="font-medium">{resource ? 'Edit resource' : 'Add resource'}</h4>
    {formError && <p role="alert">{formError}</p>}
    <fieldset disabled={disabled} className="space-y-3">
      <Select label="Resource type" aria-label="Resource type" value={kind} disabled={!!resource} onValueChange={value => value && setKind(value)}
        items={Object.fromEntries(choices.map(([value]) => [value, { skill: 'Skill', mcp: 'MCP server', plugin: 'Plugin', provider: 'OpenAI-compatible provider' }[value]]))} />
      <Input label="Resource name" name="name" required maxLength={100} defaultValue={resource?.name ?? ''} />
      <Checkbox label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
      {(kind === 'skill' || kind === 'mcp') && <Input label="Description" name="description" maxLength={1000} defaultValue={resource && 'description' in resource ? resource.description : ''} />}
      {kind === 'skill' && <Textarea label="Skill instructions (Markdown)" name="content" required rows={8}
        defaultValue={resource?.kind === 'skill' ? resource.content : ''} />}
      {kind === 'mcp' && <><Input label="MCP HTTPS endpoint" name="endpoint" type="url" required pattern="https://.*"
        defaultValue={resource?.kind === 'mcp' ? resource.endpoint : ''} />
        <p className="text-sm text-kumo-subtle">This shares the server configuration. Each user connects through MCP Connectors and authorizes OAuth separately; credentials are not shared.</p></>}
      {kind === 'plugin' && <><Select label="Plugin type" aria-label="Plugin type" value={pluginId} disabled={!!resource}
        onValueChange={value => value && setPluginId(value)} items={{ instructions: 'Additional instructions', 'tool-policy': 'Tool policy', package: 'npm package or R2 bundle' }} />
        {pluginId === 'instructions' && <Textarea label="Plugin instructions" name="instructions" required rows={6}
          defaultValue={resource?.kind === 'plugin' && resource.pluginId === 'instructions' ? resource.instructions : ''} />}
        {pluginId === 'tool-policy' && <Input label="Denied tool names" name="deniedTools" required description="Separate exact tool names with commas or spaces."
          defaultValue={resource?.kind === 'plugin' && resource.pluginId === 'tool-policy' ? resource.deniedTools.join(', ') : ''} />}
        {pluginId === 'package' && <>
          <Select label="Plugin source" aria-label="Plugin source" value={sourceKind} onValueChange={value => value && setSourceKind(value)}
            items={{ npm: 'npm package · exact version', bundle: 'Prebuilt R2 artifact · SHA-256' }} />
          {sourceKind === 'npm' ? <><Input label="npm package name" name="packageName" required maxLength={214} placeholder="@example/plugin"
            defaultValue={resource?.kind === 'plugin' && resource.pluginId === 'package' && resource.source.kind === 'npm' ? resource.source.name : ''} />
            <Input label="Exact npm version" name="packageVersion" required maxLength={128} placeholder="1.2.3"
              description="Pin a full version. Ranges, tags, URLs and Git sources are not accepted."
              defaultValue={resource?.kind === 'plugin' && resource.pluginId === 'package' && resource.source.kind === 'npm' ? resource.source.version : ''} /></>
            : <Input label="R2 artifact SHA-256" name="bundleDigest" required pattern="[a-f0-9]{64}" minLength={64} maxLength={64}
              description="Digest of the uploaded JavaScript bundle; enter 64 lowercase hexadecimal characters."
              defaultValue={resource?.kind === 'plugin' && resource.pluginId === 'package' && resource.source.kind === 'bundle' ? resource.source.digest : ''} />}
          <Textarea label="Plugin options (JSON object)" name="pluginOptions" rows={5}
            defaultValue={resource?.kind === 'plugin' && resource.pluginId === 'package' ? resource.options : '{}'} />
          <p className="text-sm text-kumo-subtle">Use non-secret options only. New packages and code changes wait for an organization administrator to choose execution. Saving a request does not mean installation succeeded.</p>
        </>}
      </>}
      {kind === 'provider' && <><Input label="OpenAI-compatible base URL" name="baseUrl" type="url" required pattern="https://.*"
        description="Use the HTTPS API base, including /v1 when required."
        defaultValue={resource?.kind === 'provider' ? resource.baseUrl : ''} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="keyless" />Use no API key</label>
        <Input label="API key (write only)" name="apiToken" type="password" autoComplete="new-password"
          description={resource ? 'Leave blank to keep the existing key. Saved keys are never displayed.' : 'Stored by the server; never returned in settings.'} />
        <p className="text-sm text-kumo-subtle">Model discovery reads this provider’s model list. It does not run inference.</p></>}
      <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary">Save resource</Button>
        {resource && <Button type="button" onClick={onCancel}>Cancel editing</Button>}</div>
    </fieldset>
  </form>
}

const ScopeSettings = ({ view, selected, disabled, onSave }: {
  view: AgentSettingsView; selected: AgentSettingsView['scopes'][number]; disabled: boolean
  onSave: (command: AgentSettingsCommand) => Promise<boolean>
}) => {
  const { scope, permissions } = selected
  const can = (permission: AgentPermission) => permissions.includes(permission)
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null)
  const [editingTeam, setEditingTeam] = useState<AgentTeam | null>(null)
  const [parentId, setParentId] = useState(scope.kind === 'team' ? scope.teamId : '')
  const [memberRole, setMemberRole] = useState('member')
  const [rolePermissions, setRolePermissions] = useState<AgentPermission[]>([])
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [delegationPermissions, setDelegationPermissions] = useState<AgentPermission[]>([])
  const [subjectKind, setSubjectKind] = useState('user')
  const [subjectRoleId, setSubjectRoleId] = useState('')
  const [grantProviderId, setGrantProviderId] = useState('')
  const [grantScopeKey, setGrantScopeKey] = useState('')
  const resources = view.resources.filter(item => sameScope(item.scope, scope))
  const roles = view.roles.filter(item => sameScope(item.scope, scope))
  const editingRole = roles.find(item => item.id === editingRoleId)
  const delegations = view.delegations.filter(item => sameScope(item.scope, scope))
  const providers = resources.filter(item => item.kind === 'provider')
  const memberships = scope.kind === 'team' ? view.memberships.filter(item => item.teamId === scope.teamId) : []
  const parentTeams = view.teams.filter(team => view.scopes.some(item => item.scope.kind === 'team' && item.scope.teamId === team.id && item.permissions.includes('teams:manage')))
  const canCreateTopLevel = view.scopes.some(item => item.scope.kind === 'organization' && item.permissions.includes('teams:manage'))
  const admins = delegations.filter(item => item.subject.kind === 'user' && AGENT_PERMISSIONS.every(permission => item.permissions.includes(permission)))
  const revision = { expectedRevision: view.revision }
  const resource = resources.find(item => item.id === editingResourceId)
  const save = async (command: AgentSettingsCommand) => {
    const applied = await onSave(command)
    if (applied) setEditingResourceId(null)
    return applied
  }
  const remove = (name: string, command: AgentSettingsCommand) => {
    if (window.confirm(`Remove ${name}? Existing access and agent behavior may change.`)) void onSave(command)
  }
  const createTeam = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const target = event.currentTarget; const data = new FormData(target)
    void onSave({ ...revision, type: 'saveTeam', team: {
      id: editingTeam?.id ?? crypto.randomUUID(), name: field(data, 'teamName'), parentId: editingTeam ? editingTeam.parentId : parentId || null,
    } }).then(applied => { if (applied) { target.reset(); setEditingTeam(null) } })
  }
  const submitRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const target = event.currentTarget; const data = new FormData(target)
    void onSave({ ...revision, type: 'saveRole', role: { id: editingRole?.id ?? crypto.randomUUID(), name: field(data, 'roleName'), scope,
      members: ids(field(data, 'roleMembers')), permissions: rolePermissions } }).then(applied => {
        if (applied) { target.reset(); setEditingRoleId(null); setRolePermissions([]) }
      })
  }
  const submitDelegation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const target = event.currentTarget; const data = new FormData(target)
    const subject = subjectKind === 'role' ? { kind: 'role', id: subjectRoleId } satisfies { kind: 'role'; id: string }
      : { kind: 'user', id: field(data, 'delegateUser') } satisfies { kind: 'user'; id: string }
    if (!subject.id) return
    void onSave({ ...revision, type: 'saveDelegation', delegation: { id: crypto.randomUUID(), scope, subject, permissions: delegationPermissions } })
      .then(applied => { if (applied) { target.reset(); setDelegationPermissions([]) } })
  }
  return <div className="space-y-6">
    <section aria-label="Scope administrators" className="space-y-3">
      <h3 className="text-lg font-medium">Administrators · {selected.label}</h3>
      {scope.kind === 'organization' && <p className="text-sm text-kumo-subtle">Deployment administrators retain organization administration. Additional scope administrators are listed below.</p>}
      {scope.kind === 'personal' && <p className="text-sm text-kumo-subtle">The owner of this personal scope is its administrator.</p>}
      {scope.kind === 'team' && <p className="text-sm text-kumo-subtle">Team administrators also administer descendant teams. Users can belong to more than one team.</p>}
      {scope.kind !== 'team' && <ul className="space-y-2">{admins.map(admin => <li key={admin.id} className="flex flex-wrap items-center gap-2">
        <span>{admin.subject.id}</span>{can('roles:manage') && <Button disabled={disabled} size="sm" variant="secondary-destructive"
          aria-label={`Remove administrator ${admin.subject.id}`} onClick={() => remove(`administrator ${admin.subject.id}`, { ...revision, type: 'removeDelegation', delegationId: admin.id })}>Remove</Button>}
      </li>)}</ul>}
      {scope.kind !== 'team' && AGENT_PERMISSIONS.every(can) && <form aria-label="Add administrator" className="flex flex-wrap items-end gap-3" onSubmit={event => {
        event.preventDefault(); const target = event.currentTarget; const data = new FormData(target)
        void onSave({ ...revision, type: 'saveDelegation', delegation: { id: crypto.randomUUID(), scope,
          subject: { kind: 'user', id: field(data, 'adminUser') }, permissions: [...AGENT_PERMISSIONS] } })
          .then(applied => { if (applied) target.reset() })
      }}><Input label="Administrator user ID" name="adminUser" required disabled={disabled} />
        <Button type="submit" disabled={disabled}>Add administrator</Button></form>}
      {scope.kind === 'team' && <>
        <ul className="space-y-2">{memberships.map(item => <li key={item.userId} className="flex flex-wrap items-center gap-2">
          <span>{item.userId} · {item.role}</span>{can('members:manage') && <Button disabled={disabled} size="sm" variant="secondary-destructive"
            aria-label={`Remove member ${item.userId}`} onClick={() => remove(`team membership for ${item.userId}`, { ...revision, type: 'removeMembership', teamId: item.teamId, userId: item.userId })}>Remove</Button>}
        </li>)}</ul>
        {can('members:manage') && <form aria-label="Team membership" className="grid gap-3 sm:grid-cols-3" onSubmit={event => {
          event.preventDefault(); const data = new FormData(event.currentTarget)
          void onSave({ ...revision, type: 'saveMembership', membership: { teamId: scope.teamId, userId: field(data, 'memberUser'), role: memberRole === 'admin' ? 'admin' : 'member' } })
        }}><Input label="Member user ID" name="memberUser" required disabled={disabled} />
          <Select label="Team membership role" aria-label="Team membership role" value={memberRole} disabled={disabled} onValueChange={value => value && setMemberRole(value)} items={{ member: 'Member', admin: 'Administrator' }} />
          <Button type="submit" disabled={disabled}>Save membership</Button></form>}
      </>}
    </section>
    {can('teams:manage') && scope.kind !== 'personal' && <section aria-label="Teams" className="space-y-3">
      <h3 className="text-lg font-medium">Teams</h3>
      <ul className="space-y-2">{view.teams.map(team => <li key={team.id} className="flex flex-wrap items-center gap-2">
        <span>{teamPath(team, view.teams)}</span>
        {view.scopes.some(item => item.scope.kind === 'team' && item.scope.teamId === team.id && item.permissions.includes('teams:manage')) &&
          <Button size="sm" disabled={disabled} onClick={() => setEditingTeam(team)}>Edit {team.name}</Button>}
      </li>)}</ul>
      <form key={editingTeam?.id ?? 'new'} aria-label="Save team" onSubmit={createTeam} className="space-y-3 rounded-lg border border-kumo-line p-4">
        <Input label="Team name" name="teamName" required maxLength={100} defaultValue={editingTeam?.name ?? ''} disabled={disabled} />
        {editingTeam ? <p className="text-sm text-kumo-subtle">The parent of an existing team is fixed to preserve inherited access.</p>
          : <Select label="Parent team" aria-label="Parent team" value={parentId} disabled={disabled} onValueChange={value => setParentId(value ?? '')}
            items={Object.fromEntries([...(canCreateTopLevel ? [['', 'Organization (top level)']] : []), ...parentTeams.map(team => [team.id, teamPath(team, view.teams)])])} />}
        <div className="flex gap-2"><Button type="submit" disabled={disabled}>{editingTeam ? 'Save team' : 'Create team'}</Button>
          {editingTeam && <Button disabled={disabled} onClick={() => setEditingTeam(null)}>Cancel team editing</Button>}</div>
      </form>
    </section>}
    <section aria-label="Scoped agent resources" className="space-y-3">
      <h3 className="text-lg font-medium">Providers, plugins, skills and MCP</h3>
      <p className="text-sm text-kumo-subtle">Resources are owned by this scope. Organization and ancestor-team configuration can also apply through your memberships.</p>
      {resources.length === 0 && <p className="text-sm text-kumo-subtle">No resources configured in this scope.</p>}
      <ul className="space-y-3">{resources.map(item => <li key={item.id} className="rounded-lg border border-kumo-line p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{item.name}</span><span className="text-sm text-kumo-subtle">{item.kind} · {item.enabled ? 'Enabled' : 'Disabled'}</span>
          {can(resourcePermission[item.kind]) && <><Button size="sm" disabled={disabled} aria-label={`Edit resource ${item.name}`} onClick={() => setEditingResourceId(item.id)}>Edit</Button>
            <Button size="sm" disabled={disabled} variant="secondary-destructive" aria-label={`Remove resource ${item.name}`}
              onClick={() => remove(`resource ${item.name}`, { ...revision, type: 'removeResource', resourceId: item.id })}>Remove</Button></>}</div>
        {item.kind === 'provider' && <p className="mt-1 break-all text-sm text-kumo-subtle">{item.baseUrl}</p>}
        {item.kind === 'mcp' && <p className="mt-1 break-all text-sm text-kumo-subtle">{item.endpoint}</p>}
        {item.kind === 'skill' && <p className="mt-1 text-sm text-kumo-subtle">{item.description}</p>}
        {item.kind === 'plugin' && (item.pluginId === 'package' ? <>
          <p className="mt-1 break-all text-sm text-kumo-subtle">{pluginSourceLabel(item.source)}</p>
          <PluginInstallationStatus execution={item.execution} installation={view.pluginInstallations.find(installation => installation.resourceId === item.id)} />
        </> : <p className="mt-1 text-sm text-kumo-subtle">Bundled plugin: {item.pluginId}</p>)}
      </li>)}</ul>
      {Object.values(resourcePermission).some(can) && <ResourceForm key={resource?.id ?? `new-${view.revision}`} scope={scope} revision={view.revision}
        permissions={permissions} resource={resource} disabled={disabled} onSave={save} onCancel={() => setEditingResourceId(null)} />}
    </section>
    {!view.easyMode && <section aria-label="Advanced access control" className="space-y-4">
      <h3 className="text-lg font-medium">Roles and delegated permissions</h3>
      <p className="text-sm text-kumo-subtle">Delegate specific permissions to a user or role in this scope. Only permissions you hold can be granted; the server validates every change.</p>
      <ul className="space-y-3">{roles.map(role => <li key={role.id} className="rounded-lg border border-kumo-line p-3">
        <p className="font-medium">{role.name}</p><p className="text-sm text-kumo-subtle">Members: {role.members.join(', ') || 'None'}</p>
        <p className="text-sm text-kumo-subtle">{role.permissions.map(item => permissionLabels[item]).join(', ') || 'No permissions'}</p>
        {can('roles:manage') && <div className="mt-2 flex gap-2"><Button size="sm" disabled={disabled} aria-label={`Edit role ${role.name}`}
          onClick={() => { setEditingRoleId(role.id); setRolePermissions(role.permissions) }}>Edit role</Button>
          <Button size="sm" disabled={disabled} variant="secondary-destructive" aria-label={`Remove role ${role.name}`}
            onClick={() => remove(`role ${role.name}`, { ...revision, type: 'removeRole', roleId: role.id })}>Remove role</Button></div>}
      </li>)}</ul>
      {can('roles:manage') && <form key={editingRole?.id ?? 'new-role'} aria-label="Save role" onSubmit={submitRole} className="space-y-3 rounded-lg border border-kumo-line p-4">
        <fieldset disabled={disabled} className="space-y-3"><Input label="Role name" name="roleName" required maxLength={100} defaultValue={editingRole?.name ?? ''} />
          <Textarea label="Role member user IDs" name="roleMembers" description="Separate user IDs with commas or new lines." rows={2} defaultValue={editingRole?.members.join('\n') ?? ''} />
          <Permissions value={rolePermissions} available={permissions} onChange={setRolePermissions} />
          <div className="flex gap-2"><Button type="submit" disabled={rolePermissions.length === 0}>{editingRole ? 'Save role' : 'Create role'}</Button>
            {editingRole && <Button onClick={() => { setEditingRoleId(null); setRolePermissions([]) }}>Cancel role editing</Button>}</div></fieldset>
      </form>}
      <ul className="space-y-3">{delegations.map(item => <li key={item.id} className="rounded-lg border border-kumo-line p-3">
        <p>{item.subject.kind}: {item.subject.kind === 'role' ? roles.find(role => role.id === item.subject.id)?.name ?? item.subject.id : item.subject.id}</p>
        <p className="text-sm text-kumo-subtle">{item.permissions.map(permission => permissionLabels[permission]).join(', ')}</p>
        {can('roles:manage') && <Button size="sm" disabled={disabled} variant="secondary-destructive" aria-label={`Remove delegation ${item.id}`}
          onClick={() => remove(`delegation for ${item.subject.id}`, { ...revision, type: 'removeDelegation', delegationId: item.id })}>Remove delegation</Button>}
      </li>)}</ul>
      {can('roles:manage') && <form aria-label="Delegate permissions" onSubmit={submitDelegation} className="space-y-3 rounded-lg border border-kumo-line p-4">
        <fieldset disabled={disabled} className="space-y-3"><Select label="Delegate to" aria-label="Delegate to" value={subjectKind} onValueChange={value => value && setSubjectKind(value)} items={{ user: 'User', role: 'Role' }} />
          {subjectKind === 'user' ? <Input label="Delegate user ID" name="delegateUser" required />
            : <Select label="Delegate role" aria-label="Delegate role" value={subjectRoleId} onValueChange={value => value && setSubjectRoleId(value)} placeholder="Choose a role"
              items={Object.fromEntries(roles.map(role => [role.id, role.name]))} />}
          <Permissions value={delegationPermissions} available={permissions} onChange={setDelegationPermissions} />
          <Button type="submit" disabled={delegationPermissions.length === 0 || (subjectKind === 'role' && !subjectRoleId)}>Delegate permissions</Button></fieldset>
      </form>}
      <h3 className="text-lg font-medium">Provider sharing audiences</h3>
      <p className="text-sm text-kumo-subtle">A provider remains managed by its owning scope. Sharing makes its models available to the chosen audience.</p>
      <ul className="space-y-2">{view.providerGrants.filter(grant => providers.some(provider => provider.id === grant.providerId)).map(grant => <li key={grant.id} className="flex flex-wrap items-center gap-2">
        <span>{providers.find(provider => provider.id === grant.providerId)?.name} → {view.scopes.find(item => sameScope(item.scope, grant.scope))?.label ?? scopeKey(grant.scope)} · {grant.enabled ? 'Enabled' : 'Disabled'}</span>
        {can('providers:grant') && <Button size="sm" disabled={disabled} variant="secondary-destructive" aria-label={`Remove provider sharing ${grant.id}`}
          onClick={() => remove('provider sharing', { ...revision, type: 'removeProviderGrant', grantId: grant.id })}>Remove sharing</Button>}
      </li>)}</ul>
      {can('providers:grant') && providers.length > 0 && <form aria-label="Share provider" className="space-y-3 rounded-lg border border-kumo-line p-4" onSubmit={event => {
        event.preventDefault(); const audience = view.scopes.find(item => scopeKey(item.scope) === grantScopeKey)
        if (!audience || !providers.some(item => item.id === grantProviderId)) return
        void onSave({ ...revision, type: 'saveProviderGrant', grant: { id: crypto.randomUUID(), providerId: grantProviderId, scope: audience.scope, enabled: true } })
          .then(applied => { if (applied) { setGrantProviderId(''); setGrantScopeKey('') } })
      }}><Select label="Provider to share" aria-label="Provider to share" value={grantProviderId} placeholder="Choose a provider" disabled={disabled}
        onValueChange={value => value && setGrantProviderId(value)} items={Object.fromEntries(providers.map(item => [item.id, item.name]))} />
        <Select label="Sharing audience" aria-label="Sharing audience" value={grantScopeKey} placeholder="Choose an audience" disabled={disabled}
          onValueChange={value => value && setGrantScopeKey(value)} items={Object.fromEntries(view.scopes.map(item => [scopeKey(item.scope), item.label]))} />
        <Button type="submit" disabled={disabled || !grantProviderId || !grantScopeKey}>Share provider</Button>
      </form>}
    </section>}
  </div>
}

/** Scoped agent configuration and server-authoritative access management. */
export const AgentSettingsPanel = ({ api }: { api: SettingsApi }) => {
  const [view, setView] = useState<AgentSettingsView | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<AgentProviderCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogStale, setCatalogStale] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const lifetime = useRef(0)
  const catalogEpoch = useRef(0)
  const writeLocked = useRef<number | null>(null)
  const catalogLocked = useRef<number | null>(null)
  useEffect(() => {
    const generation = ++lifetime.current
    const readEpoch = catalogEpoch.current
    setReady(false); setBusy(false); setView(null); setCatalog(null); setCatalogStale(false); setNotice(null)
    catalogLocked.current = generation; setCatalogBusy(true)
    void api.getAgentSettings().then(next => {
      if (generation !== lifetime.current) return
      setView(next); setReady(true)
    }).catch(() => { if (generation === lifetime.current) setNotice('Cannot load agent settings. Check access and reload settings.') })
    void api.getAgentProviderCatalog().then(next => {
      if (generation === lifetime.current) { setCatalog(next); setCatalogError(false); setCatalogStale(readEpoch !== catalogEpoch.current) }
    }).catch(() => { if (generation === lifetime.current) setCatalogError(true) })
      .finally(() => { if (catalogLocked.current === generation) catalogLocked.current = null; if (generation === lifetime.current) setCatalogBusy(false) })
    return () => { lifetime.current++ }
  }, [api])
  const reload = async () => {
    const generation = lifetime.current
    if (writeLocked.current === generation) return
    writeLocked.current = generation; setBusy(true)
    try {
      const next = await api.getAgentSettings()
      if (generation !== lifetime.current) return
      setView(next); setReady(true); setNotice('Current settings loaded.')
    } catch { if (generation === lifetime.current) { setReady(false); setNotice('Cannot reload settings. Changes are disabled until current access and settings can be confirmed.') } }
    finally { if (writeLocked.current === generation) writeLocked.current = null; if (generation === lifetime.current) setBusy(false) }
  }
  const save = async (command: AgentSettingsCommand) => {
    const generation = lifetime.current
    if (writeLocked.current === generation || !ready) return false
    writeLocked.current = generation; setBusy(true); setNotice(null)
    try {
      const next = await api.updateAgentSettings(command)
      if (generation !== lifetime.current) return false
      setView(next); setReady(true); catalogEpoch.current++; setCatalogStale(true); setNotice('Saved.')
      return true
    } catch (error) {
      if (generation !== lifetime.current) return false
      setReady(false); catalogEpoch.current++; setCatalogStale(true)
      const conflict = error instanceof Error && /conflict|revision/i.test(error.message)
      try {
        const next = await api.getAgentSettings()
        if (generation !== lifetime.current) return false
        setView(next); setReady(true)
        setNotice(conflict ? 'Settings changed elsewhere. Current settings reloaded; review before saving again.'
          : 'The change could not be confirmed. Current settings reloaded; review before retrying.')
      } catch { if (generation === lifetime.current) setNotice('The change could not be confirmed and reloading failed. Reload settings before retrying.') }
      return false
    } finally { if (writeLocked.current === generation) writeLocked.current = null; if (generation === lifetime.current) setBusy(false) }
  }
  const refreshCatalog = async () => {
    const generation = lifetime.current
    if (catalogLocked.current === generation) return
    catalogLocked.current = generation; setCatalogBusy(true)
    const readEpoch = catalogEpoch.current
    try { const next = await api.getAgentProviderCatalog(true); if (generation === lifetime.current) { setCatalog(next); setCatalogError(false); setCatalogStale(readEpoch !== catalogEpoch.current) } }
    catch { if (generation === lifetime.current) setCatalogError(true) }
    finally { if (catalogLocked.current === generation) catalogLocked.current = null; if (generation === lifetime.current) setCatalogBusy(false) }
  }
  const selected = view?.scopes.find(item => scopeKey(item.scope) === selectedKey)
    ?? view?.scopes.find(item => item.scope.kind === 'personal' && item.scope.userId === view.viewerId) ?? view?.scopes[0]
  const orgSettings = view?.scopes.some(item => item.scope.kind === 'organization' && item.permissions.includes('settings:manage'))
  const disabled = busy || !ready
  return <section aria-label="Agent configuration" className="space-y-5 text-kumo-default">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Agent configuration</h2>
      <p className="mt-1 text-sm text-kumo-subtle">Organization, nested teams and personal settings. Access is checked by the server.</p></div>
      <Button disabled={busy} onClick={() => void reload()}>Reload settings</Button></div>
    {notice && <p role={ready ? 'status' : 'alert'} className="rounded-lg border border-kumo-line p-3 text-sm">{notice}</p>}
    {!view && !notice && <p role="status">Loading agent settings…</p>}
    {view && selected && <>
      <div className="flex flex-wrap items-end gap-4"><Select label="Configuration scope" aria-label="Configuration scope" value={scopeKey(selected.scope)} disabled={busy}
        onValueChange={value => value && setSelectedKey(value)} items={Object.fromEntries(view.scopes.map(item => {
          const itemScope = item.scope
          return [scopeKey(itemScope), itemScope.kind === 'team'
            ? `Team · ${teamPath(view.teams.find(team => team.id === itemScope.teamId) ?? { id: itemScope.teamId, name: item.label, parentId: null }, view.teams)}` : item.label]
        }))} />
        {orgSettings ? <Checkbox label="Easy mode" checked={view.easyMode} disabled={disabled}
          onCheckedChange={easyMode => void save({ type: 'setMode', easyMode, expectedRevision: view.revision })} />
          : <p className="text-sm text-kumo-subtle">{view.easyMode ? 'Easy mode' : 'Advanced mode'} · managed by an organization settings administrator</p>}
      </div>
      {view.easyMode && <p className="text-sm text-kumo-subtle">Easy mode shows administrators, team membership and resources. An organization administrator can turn it off to configure roles, delegated permissions and sharing audiences.</p>}
      {selected.permissions.length === 0 && <p className="text-sm text-kumo-subtle">Read-only scope. Ask a scope administrator for delegated management permissions.</p>}
      {view.pluginInstallerError && <p role="alert" className="rounded-lg border border-kumo-line p-3 text-sm">{view.pluginInstallerError}</p>}
      <PluginExecutionSettings view={view} disabled={disabled} onSave={save} />
      <ScopeSettings key={scopeKey(selected.scope)} view={view} selected={selected} disabled={disabled} onSave={save} />
      <details className="rounded-lg border border-kumo-line p-3"><summary className="cursor-pointer font-medium">Resources effective for your account · {view.effectiveResources.length}</summary>
        <ul className="mt-2 space-y-1 text-sm">{view.effectiveResources.map(item => <li key={item.id}>{item.name} · {item.kind} · {view.scopes.find(candidate => sameScope(candidate.scope, item.scope))?.label ?? scopeKey(item.scope)}</li>)}</ul>
      </details>
    </>}
    <section aria-label="Discovered provider models" className="space-y-3 border-t border-kumo-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-medium">Available provider models</h3>
        <Button disabled={catalogBusy} onClick={() => void refreshCatalog()}>{catalogBusy ? 'Refreshing models…' : 'Refresh model lists'}</Button></div>
      <p className="text-sm text-kumo-subtle">Models from accessible subscriptions and OpenAI-compatible backends. Subscription lists are SDK-supported models; account entitlement is unverified. Discovery does not run inference.</p>
      {catalogStale && <p role="status" className="text-sm text-kumo-subtle">Settings changed. Refresh model lists to update provider access and available models.</p>}
      {catalogError && <p role="alert" className="text-sm">Model discovery failed. Previously loaded results may be stale. Refresh to retry.</p>}
      {catalog?.providers.length === 0 && <p className="text-sm text-kumo-subtle">No accessible providers discovered.</p>}
      {catalog?.providers.map(provider => <article key={provider.id} aria-label={`Models from ${provider.name}`} className="rounded-lg border border-kumo-line p-3">
        <h4 className="font-medium">{provider.name}</h4><p className="text-xs text-kumo-subtle">{view?.scopes.find(item => sameScope(item.scope, provider.scope))?.label ?? scopeKey(provider.scope)} · {provider.refreshedAt ? `Last discovery: ${new Date(provider.refreshedAt).toLocaleString()}` : 'Not refreshed'}</p>
        {provider.error && <p role="alert" className="mt-2 text-sm">{provider.error}</p>}
        <ul className="mt-2 space-y-1 text-sm">{provider.models.map(model => <li key={model.id}>{model.name} · {model.modelId} · {model.source === 'subscription' ? 'Subscription' : 'OpenAI-compatible'}</li>)}</ul>
        {provider.models.length === 0 && <p className="mt-2 text-sm text-kumo-subtle">No models returned.</p>}
      </article>)}
    </section>
  </section>
}
