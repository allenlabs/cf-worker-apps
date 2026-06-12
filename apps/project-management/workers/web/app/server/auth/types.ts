// Pluggable auth seam. The PM core never assumes a specific identity provider;
// it talks to whichever `AuthAdapter` is selected for the deployment. The
// allenlabs deployment uses the `betterAuth` adapter (Better Auth SSO); a second
// deployment plugs in its own adapter + config with no core edits.

import type { Env } from '~/lib/env';
import type { TeamMembershipClaim } from '~/server/session.server';

/**
 * Backend-neutral identity the core consumes. An adapter's `verify` turns a
 * request's session into this; `findOrCreateUserBySsoImpl` maps it to a local
 * users row. No provider-specific fields leak past this boundary.
 */
export interface AuthIdentity {
  /** Stable external user id (allenlabs: the JWT `sub`). Linked to users.better_auth_user_id. */
  subject: string;
  email: string;
  displayName?: string | null;
  username?: string | null;
  preferredName?: string | null;
  locale?: string | null;
  /** Advisory only — PM admin is still the local `users.admin` column. */
  isPlatformAdmin?: boolean;
  /** Per-project roles, if the provider carries them; empty ⇒ pm.members RBAC. */
  teamMemberships?: TeamMembershipClaim[];
}

/** Result of handling the provider's sign-in callback. */
export interface CallbackResult {
  identity: AuthIdentity;
  /** Opaque session value to store in the cookie (allenlabs: the JWT). */
  sessionToken: string;
  /** Where to send the browser after success. */
  redirectTo: string;
}

/** Context for the optional team/org provisioning hook on project create. */
export interface ProjectCreatedContext {
  /** The acting user's external id (allenlabs: betterAuthUserId); null ⇒ skip. */
  actingExternalUserId: string | null;
  projectName: string;
  projectSlug: string;
}
export interface ProjectProvisionResult {
  /** Stored on projects.auth_team_id; null ⇒ no backing team (pm.members only). */
  teamId: string | null;
}

export interface AuthAdapter {
  readonly id: string;

  /** Verify the request's session cookie → identity, or null. JWT/crypto only — no DB. */
  verify(env: Env, cookieHeader: string | null): Promise<AuthIdentity | null>;

  /** Build the redirect that starts sign-in at the provider. */
  loginRedirect(env: Env, opts: { next?: string }): { href: string };

  /** Handle the provider callback (code → session token + identity). */
  handleCallback(
    env: Env,
    request: Request,
    deps?: { fetch?: typeof fetch },
  ): Promise<CallbackResult>;

  /** Set-Cookie value establishing the session. */
  sessionCookie(token: string): string;
  /** Set-Cookie value clearing the session. */
  clearSessionCookie(): string;

  /** Revoke server-side state (if any) and return the post-logout redirect. */
  logout(env: Env, cookieHeader: string | null): Promise<{ href: string; setCookie: string }>;

  /** Optional org/team provisioning when a project is created. */
  onProjectCreated?(env: Env, ctx: ProjectCreatedContext): Promise<ProjectProvisionResult>;
}
