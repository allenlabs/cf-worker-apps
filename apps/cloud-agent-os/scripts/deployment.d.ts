export type DeploymentConfig = {
  accountId: string;
  origin: string;
  workers: { router: string; workshop: string; context: string; mcp?: string };
  resources: {
    blueprintsKvNamespaceId: string;
    avatarsKvNamespaceId: string;
    contextKvNamespaceId: string;
    blueprintContentBucket: string;
  };
  admins: string[];
  modelBridge: {
    service: string;
    model: string;
    allowedUserIds: string[];
    /** Admin offers the configured subscription to users; user preserves per-user setup. */
    management?: 'user' | 'admin';
  };
  mcp: boolean;
  mcpScopes?: Record<string, string[]>;
} & ({
  auth: {
    /** Omitted mode preserves existing OIDC deployment configuration. */
    mode?: 'oidc';
    issuer: string;
    clientId: string;
    displayName: string;
    allowedIdentities: { email: string; subject: string }[];
    loginUrl?: string;
    loginSite?: string;
  };
  workers: { oidc: string };
  modelBridge: { setup?: never };
  /** Trusted host origins; identity policy derives from the OIDC allowlist. */
  siteLaunch?: { parentOrigins: string[] };
} | {
  auth: {
    mode: 'access';
    issuer: string;
    audience: string;
    /** Deployment validation only. Cloudflare Access policies authorize sign-in. */
    allowedEmails: string[];
  };
  workers: { oidc?: never };
  /** Routes SIWC subscription setup through the Access-protected router. */
  modelBridge: { setup?: 'siwc' };
  siteLaunch?: never;
});
