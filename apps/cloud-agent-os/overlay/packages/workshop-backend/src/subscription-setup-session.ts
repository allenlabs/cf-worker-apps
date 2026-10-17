import { WorkerEntrypoint } from 'cloudflare:workers';
import type { VerifiedAuthIdentity } from '@gadgets/workshop-shared/gatekeeper';
import { validatePrincipal } from './site-launch.js';

/** Private service binding only; no public HTTP or browser RPC route. */
export class SubscriptionSetupSession extends WorkerEntrypoint<Cloudflare.Env> {
  async verify(token: string): Promise<VerifiedAuthIdentity | null> {
    try {
      if (typeof token !== 'string' || token.length > 299) return null;
      const match = /^([^\s@:\x00-\x1f\x7f]+@[^\s@:\x00-\x1f\x7f]+\.[^\s@:\x00-\x1f\x7f]+):([A-Za-z0-9+/]{43}=)$/.exec(token);
      if (!match) return null;
      const [, email, secret] = match;
      if (email.length > 254 || email !== email.toLowerCase() || Uint8Array.fromBase64(secret).toBase64() !== secret) return null;
      const stored = await this.ctx.exports.UserDurableObject.getByName(email).authenticate(secret);
      if (!stored) return null;
      const principal = validatePrincipal(stored);
      return principal.email === email ? principal : null;
    } catch { return null; }
  }
}
