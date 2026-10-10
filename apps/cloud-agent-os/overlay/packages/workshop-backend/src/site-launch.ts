import { WorkerEntrypoint } from 'cloudflare:workers';
import type { VerifiedAuthIdentity } from '@gadgets/workshop-shared/gatekeeper';
import { createSiteLaunchError, type SiteContext, type SiteLaunchInput, type SiteLaunchTicket } from '@gadgets/workshop-shared/api';

export const SITE_LAUNCH_LIFETIME_MS = 5 * 60 * 1000;
export type SiteLaunchEnvironment = {
  SITE_LAUNCH_ISSUER?: string;
  SITE_LAUNCH_IDENTITIES?: string;
  SITE_LAUNCH_PARENT_ORIGINS?: string;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw createSiteLaunchError('site_launch_invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw createSiteLaunchError('site_launch_invalid');
  return value;
}
function issuerUrl(value: unknown): string {
  const raw = text(value, 2048), url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href.replace(/\/$/, '') !== raw) throw createSiteLaunchError('site_launch_invalid');
  return raw;
}
function origin(value: unknown): string {
  const raw = text(value, 2048), url = new URL(raw);
  if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password || url.port ||
      /(^|\.)workers\.dev$/i.test(url.hostname)) throw createSiteLaunchError('site_launch_invalid');
  return raw;
}
export function validatePrincipal(value: unknown): VerifiedAuthIdentity {
  const v = record(value), email = text(v.email, 320);
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email !== email.trim().toLowerCase()) throw createSiteLaunchError('site_launch_invalid');
  return { issuer: issuerUrl(v.issuer), subject: text(v.subject, 255), email };
}
export function samePrincipal(a: VerifiedAuthIdentity, b: VerifiedAuthIdentity): boolean {
  return a.email === b.email && a.subject === b.subject && a.issuer === b.issuer;
}
export function validateSiteContext(value: unknown): SiteContext {
  const v = record(value), id = text(v.id, 128), environment = text(v.environment, 32), timezone = text(v.timezone, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || !['production', 'stg', 'dev', 'preview'].includes(environment)) throw createSiteLaunchError('site_launch_invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw createSiteLaunchError('site_launch_invalid'); }
  return { id, environment: environment as SiteContext['environment'], displayName: text(v.displayName, 160), timezone };
}
export function siteLaunchPolicy(env: Cloudflare.Env & SiteLaunchEnvironment) {
  try {
    const issuer = issuerUrl(env.SITE_LAUNCH_ISSUER);
    const identities: unknown = JSON.parse(env.SITE_LAUNCH_IDENTITIES!);
    const origins: unknown = JSON.parse(env.SITE_LAUNCH_PARENT_ORIGINS!);
    if (!Array.isArray(identities) || !identities.length || identities.length > 100 || !Array.isArray(origins) || !origins.length || origins.length > 10) throw Error();
    // Deployment identity pins contain email+subject; issuer is shared by the entire deployment.
    const principals = identities.map(v => validatePrincipal({ ...record(v), issuer }));
    if (new Set(principals.map(p => p.email)).size !== principals.length || new Set(principals.map(p => p.subject)).size !== principals.length) throw Error();
    const parentOrigins = origins.map(origin);
    if (new Set(parentOrigins).size !== parentOrigins.length) throw Error();
    return { issuer, principals, parentOrigins };
  } catch { throw createSiteLaunchError('site_launch_disabled'); }
}
export function checkSiteLaunchPrincipal(env: Cloudflare.Env & SiteLaunchEnvironment, principal: VerifiedAuthIdentity): void {
  const policy = siteLaunchPolicy(env);
  const candidate = validatePrincipal(principal);
  if (!policy.principals.some(p => samePrincipal(p, candidate))) throw createSiteLaunchError('site_launch_invalid');
}
export function validateSiteLaunch(env: Cloudflare.Env & SiteLaunchEnvironment, input: SiteLaunchInput): SiteLaunchInput {
  try {
    const policy = siteLaunchPolicy(env), v = record(input), principal = validatePrincipal(v.principal);
    if (!policy.principals.some(p => samePrincipal(p, principal)) || !policy.parentOrigins.includes(origin(v.parentOrigin))) throw createSiteLaunchError('site_launch_invalid');
    return { principal, site: validateSiteContext(v.site), parentOrigin: origin(v.parentOrigin) };
  } catch (error) {
    if (error instanceof Error && error.message === 'site_launch_disabled') throw error;
    throw createSiteLaunchError('site_launch_invalid');
  }
}
export function siteWorkspaceKey(principal: VerifiedAuthIdentity, site: SiteContext): string {
  return JSON.stringify([principal.issuer, principal.subject, site.environment, site.id]);
}
export function sameSiteContext(a: SiteContext, b: SiteContext): boolean {
  return a.id === b.id && a.environment === b.environment && a.displayName === b.displayName && a.timezone === b.timezone;
}
/** Callable only by an explicitly bound trusted server; the default HTTP handler never routes here. */
export class SiteLaunchGateway extends WorkerEntrypoint<Cloudflare.Env & SiteLaunchEnvironment> {
  async issueSiteLaunch(input: SiteLaunchInput): Promise<SiteLaunchTicket> {
    const verified = validateSiteLaunch(this.env, input);
    return this.ctx.exports.UserDurableObject.getByName(verified.principal.email).issueSiteLaunch(verified);
  }
}
