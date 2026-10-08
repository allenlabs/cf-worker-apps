export interface DeploymentConfig {
  accountId: string;
  origin: string;
  workers: { router: string; workshop: string; context: string; oidc: string; mcp?: string };
  resources: {
    blueprintsKvNamespaceId: string;
    avatarsKvNamespaceId: string;
    contextKvNamespaceId: string;
    blueprintContentBucket: string;
  };
  auth: {
    issuer: string;
    clientId: string;
    displayName: string;
    allowedIdentities: { email: string; subject: string }[];
    loginUrl?: string;
    loginSite?: string;
  };
  admins: string[];
  modelBridge: { service: string; model: string; allowedUserIds: string[] };
  mcp: boolean;
  mcpScopes?: Record<string, string[]>;
}
