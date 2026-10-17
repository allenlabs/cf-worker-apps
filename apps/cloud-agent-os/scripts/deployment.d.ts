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
    /** Routes SIWC setup through the router with separately pinned administrator authentication. */
    setup?: 'siwc';
  };
  mcp: boolean;
  mcpScopes?: Record<string, string[]>;
} & ({
  auth: {
    issuer: string;
    clientId: string;
    displayName: string;
    allowedIdentities: { email: string; subject: string }[];
    loginUrl?: string;
    loginSite?: string;
  } & ({
    /** Omitted mode preserves existing OIDC deployment configuration. */
    mode?: 'oidc';
  } | {
    mode: 'oauth-jwt';
    /** Exact HTTPS resource origin, used for both resource indicators and JWT audience. */
    resource: string;
    scopes: string[];
    tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  });
  workers: { oidc: string };
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
  siteLaunch?: never;
});
