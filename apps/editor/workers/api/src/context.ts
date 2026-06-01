import type { Env } from './lib/env';
import type { Sql } from './lib/db';

/**
 * The authed caller. After HMAC verifies, we trust the user fields the web
 * worker put in the signed body — it sourced them from the verified JWT.
 */
export interface AuthedUser {
  userId: string;
  userName: string;
  username: string | null;
}

export interface AppBindings {
  Bindings: Env;
  Variables: {
    user: AuthedUser;
    db: Sql;
    body: Record<string, unknown>;
  };
}
