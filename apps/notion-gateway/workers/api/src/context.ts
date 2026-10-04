// Shared Hono context shape.  Both the HMAC middleware and the route
// handlers reach into `c.var.*`, so we centralize the variable types
// here for type-safe access across files.

import type { DB } from '@shared/db/client';
import type { Env } from './env';

export interface AppClientContext {
  id: number;
  clientId: string;
  name: string;
  hmacSecret: string;
  allowedReturnOrigins: string[];
}

export interface AppBindings {
  Bindings: Env;
  Variables: {
    appClient: AppClientContext;
    db: DB;
    rawBody: string;
  };
}
