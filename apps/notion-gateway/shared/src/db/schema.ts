import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { NotionMapping } from '../types';

export const notionGateway = pgSchema('notion_gateway');

// ---------- Workspaces ----------

export const workspaces = notionGateway.table(
  'workspaces',
  {
    id: serial('id').primaryKey(),
    notionId: text('notion_id').notNull().unique(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    ownerEmail: text('owner_email'),
    accessToken: text('access_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({ notionIdx: uniqueIndex('workspaces_notion_id_idx').on(t.notionId) }),
);

// ---------- App clients ----------

export const appClients = notionGateway.table(
  'app_clients',
  {
    id: serial('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    name: text('name').notNull(),
    hmacSecret: text('hmac_secret').notNull(),
    allowedReturnOrigins: jsonb('allowed_return_origins')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    webhookUrl: text('webhook_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({ clientIdIdx: uniqueIndex('app_clients_client_id_idx').on(t.clientId) }),
);

// ---------- Connections ----------

export const connections = notionGateway.table(
  'connections',
  {
    id: serial('id').primaryKey(),
    appClientId: integer('app_client_id')
      .notNull()
      .references(() => appClients.id, { onDelete: 'cascade' }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    appResource: text('app_resource').notNull(),
    databaseId: text('database_id').notNull(),
    databaseTitle: text('database_title').notNull(),
    mapping: jsonb('mapping').$type<NotionMapping>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    appResourceIdx: uniqueIndex('connections_app_resource_idx').on(
      t.appClientId,
      t.appResource,
    ),
    workspaceIdx: index('connections_workspace_idx').on(t.workspaceId),
  }),
);

// ---------- Page links ----------

export const pageLinks = notionGateway.table(
  'page_links',
  {
    connectionId: integer('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    appRecord: text('app_record').notNull(),
    pageId: text('page_id').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.connectionId, t.appRecord] }) }),
);

// ---------- Webhook subscriptions ----------

export const webhookSubscriptions = notionGateway.table('webhook_subscriptions', {
  id: serial('id').primaryKey(),
  verificationToken: text('verification_token').notNull(),
  status: text('status').notNull().default('pending'),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// ---------- OAuth state ----------

export const oauthState = notionGateway.table(
  'oauth_state',
  {
    state: text('state').primaryKey(),
    appClientId: integer('app_client_id')
      .notNull()
      .references(() => appClients.id, { onDelete: 'cascade' }),
    appResource: text('app_resource').notNull(),
    returnTo: text('return_to').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => ({ expiresIdx: index('oauth_state_expires_at_idx').on(t.expiresAt) }),
);

// ---------- Types ----------

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type AppClient = typeof appClients.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type PageLink = typeof pageLinks.$inferSelect;
export type OAuthState = typeof oauthState.$inferSelect;
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
