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
  /** Trusted host origins; identity policy derives from the existing OIDC allowlist. */
  siteLaunch?: { parentOrigins: string[] };
  modelBridge: {
    service: string;
    model: string;
    allowedUserIds: string[];
    /** Admin offers the configured subscription to users; user preserves per-user setup. */
    management?: 'user' | 'admin';
  };
  mcp: boolean;
  mcpScopes?: Record<string, string[]>;
}
