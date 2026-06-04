import type { Env } from './lib/env';
import type { DB } from '../../web/app/db/client';

export interface AppClientContext {
  id: number;
  clientId: string;
  name: string;
  userId: number;
}

export interface AppBindings {
  Bindings: Env;
  Variables: {
    apiClient: AppClientContext;
    db: DB;
    rawBody: string;
  };
}
