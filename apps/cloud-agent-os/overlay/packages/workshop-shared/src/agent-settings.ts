export const AGENT_PERMISSIONS = ['teams:manage', 'members:manage', 'roles:manage', 'providers:manage', 'providers:grant', 'plugins:manage', 'skills:manage', 'mcp:manage', 'settings:manage'] as const;
export type AgentPermission = typeof AGENT_PERMISSIONS[number];
export type AgentScope = { kind: 'organization' } | { kind: 'team'; teamId: string } | { kind: 'personal'; userId: string };
export type AgentTeam = { id: string; name: string; parentId: string | null };
export type AgentMembership = { teamId: string; userId: string; role: 'admin' | 'member' };
export type AgentRole = { id: string; name: string; scope: AgentScope; members: string[]; permissions: AgentPermission[] };
export type AgentDelegation = { id: string; scope: AgentScope; subject: { kind: 'user'; id: string } | { kind: 'role'; id: string }; permissions: AgentPermission[] };
export type AgentJson = null | boolean | number | string | AgentJson[] | { [key: string]: AgentJson };
export type AgentPluginSource = { kind: 'npm'; name: string; version: string } | { kind: 'bundle'; digest: string };
export type AgentPluginArtifact = { apiVersion: 1; source: AgentPluginSource; module: string; packageIntegrity: string | null; lockDigest: string | null };
export type AgentPluginInstallation = {
  resourceId: string; id: string; execution: 'host' | 'dynamic';
  status: 'queued' | 'building' | 'verifying' | 'deploying' | 'ready' | 'active' | 'failed';
  artifactDigest: string | null; error: string | null; updatedAt: string | null;
};
type ResourceBase = { id: string; name: string; scope: AgentScope; enabled: boolean };
export type AgentResource = ResourceBase & (
  | { kind: 'skill'; description: string; content: string }
  | { kind: 'mcp'; endpoint: string; description: string }
  | { kind: 'plugin'; pluginId: 'instructions'; instructions: string }
  | { kind: 'plugin'; pluginId: 'tool-policy'; deniedTools: string[] }
  | { kind: 'plugin'; pluginId: 'package'; source: AgentPluginSource; execution: 'pending' | 'host' | 'dynamic'; options: string }
  | { kind: 'provider'; baseUrl: string }
);
export type AgentPluginReview = Pick<Extract<AgentResource, { kind: 'plugin'; pluginId: 'package' }>, 'id' | 'name' | 'scope' | 'source' | 'execution'>;
export type AgentProviderGrant = { id: string; providerId: string; scope: AgentScope; enabled: boolean };
export type AgentScopeView = { scope: AgentScope; label: string; permissions: AgentPermission[] };
export type AgentSettingsView = {
  revision: number;
  easyMode: boolean;
  viewerId: string;
  scopes: AgentScopeView[];
  teams: AgentTeam[];
  memberships: AgentMembership[];
  roles: AgentRole[];
  delegations: AgentDelegation[];
  resources: AgentResource[];
  effectiveResources: AgentResource[];
  providerGrants: AgentProviderGrant[];
  canManagePluginExecution: boolean;
  pluginReviews: AgentPluginReview[];
  pluginInstallations: AgentPluginInstallation[];
  pluginInstallerError: string | null;
};
type AgentSettingsChange =
  | { type: 'setMode'; easyMode: boolean }
  | { type: 'saveTeam'; team: AgentTeam }
  | { type: 'saveMembership'; membership: AgentMembership }
  | { type: 'removeMembership'; teamId: string; userId: string }
  | { type: 'saveRole'; role: AgentRole }
  | { type: 'removeRole'; roleId: string }
  | { type: 'saveDelegation'; delegation: AgentDelegation }
  | { type: 'removeDelegation'; delegationId: string }
  | { type: 'saveResource'; resource: AgentResource; apiToken?: string }
  | { type: 'removeResource'; resourceId: string }
  | { type: 'setPluginExecution'; resourceId: string; source: AgentPluginSource; execution: 'host' | 'dynamic' }
  | { type: 'saveProviderGrant'; grant: AgentProviderGrant }
  | { type: 'removeProviderGrant'; grantId: string };
export type AgentSettingsCommand = AgentSettingsChange & { expectedRevision: number };
export type AgentProviderModel = {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  providerName: string;
  scope: AgentScope;
  source: 'subscription' | 'openai-compatible';
};
export type AgentProviderCatalog = {
  providers: { id: string; name: string; scope: AgentScope; models: AgentProviderModel[]; refreshedAt: string | null; error: string | null }[];
};
