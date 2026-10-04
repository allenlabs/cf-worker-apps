// Shared type definitions for the Notion Gateway.  These are the wire
// shapes consumer apps see; the gateway's internal DB rows mirror them
// closely.  Keep this file dependency-free so it imports cleanly from
// both worker bundles + tests.

/**
 * Per-field mapping snapshot stored on every `connections` row.  The keys
 * are consumer-app field names (e.g. PM's `subject`, `dueDate`); the
 * values either point at a specific Notion property (frozen id + name +
 * type at connect-time) or are null when the user explicitly skipped
 * that field.
 */
export interface NotionMapping {
  fields: Record<
    string,
    {
      propertyId: string;
      propertyName: string;
      propertyType: string;
    } | null
  >;
}

export interface NotionProperty {
  id: string;
  name: string;
  type: string;
}

export interface AppClient {
  id: number;
  clientId: string;
  name: string;
}

export interface WorkspaceSummary {
  id: number;
  notionId: string;
  name: string;
  icon: string | null;
  ownerEmail: string | null;
}

export interface ConnectionSummary {
  id: number;
  workspaceId: number;
  workspaceName: string;
  databaseId: string;
  databaseTitle: string;
  mapping: NotionMapping;
  createdAt: string;
}

// ---------- PM-style field catalogue ----------
//
// The gateway owns the canonical PM field catalogue.  Consumer apps that
// want to mirror their own resources can either reuse this list (PM) or
// pass a custom list at connect time (future apps).
export const PM_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  compatibleTypes: ReadonlyArray<string>;
}> = [
  { key: 'subject', label: 'Subject', compatibleTypes: ['title'] },
  { key: 'description', label: 'Description', compatibleTypes: ['rich_text'] },
  { key: 'status', label: 'Status', compatibleTypes: ['status', 'select'] },
  { key: 'tracker', label: 'Tracker', compatibleTypes: ['select', 'multi_select'] },
  { key: 'priority', label: 'Priority', compatibleTypes: ['select', 'status'] },
  {
    key: 'assignedTo',
    label: 'Assignee',
    compatibleTypes: ['people', 'rich_text', 'email'],
  },
  { key: 'dueDate', label: 'Due date', compatibleTypes: ['date'] },
  { key: 'startDate', label: 'Start date', compatibleTypes: ['date'] },
  { key: 'estimatedHours', label: 'Estimated hours', compatibleTypes: ['number'] },
  { key: 'doneRatio', label: 'Done %', compatibleTypes: ['number'] },
  { key: 'category', label: 'Category', compatibleTypes: ['select'] },
  { key: 'fixedVersion', label: 'Fixed version', compatibleTypes: ['select'] },
  { key: 'createdAt', label: 'Created at', compatibleTypes: ['date', 'created_time'] },
  { key: 'pmId', label: 'PM id', compatibleTypes: ['rich_text', 'url'] },
];

export type FieldCatalogue = typeof PM_FIELDS;

// ---------- Wire-level response shapes ----------
//
// Consumer apps import these directly to type their gateway-client helpers
// so PM and friends don't have to re-derive them.

/**
 * Inspect a Notion Database and get back the property schema plus the
 * gateway's recommended PM-field mapping.  `suggested` is the legacy key
 * (kept for back-compat); new callers should read `suggested_mapping`.
 */
export interface DatabaseInspectResponse {
  database: { title: string; properties: Record<string, NotionProperty> };
  suggested: NotionMapping;
  suggested_mapping: NotionMapping;
}

/**
 * The connection row as the gateway exposes it on the wire.  Matches
 * `ConnectionView` in `workers/api/src/handlers/connections.ts`.
 */
export interface GatewayConnection {
  id: number;
  workspace_id: number;
  workspace_name: string;
  database_id: string;
  database_title: string;
  mapping: NotionMapping;
  created_at: string;
  updated_at: string;
}

export interface PageUpsertResponse {
  page_id: string;
  created: boolean;
}

export interface PageDeleteResponse {
  ok: true;
  archived: boolean;
}

export interface OAuthStartTokenResponse {
  start_url: string;
}

export interface ListDatabasesResponse {
  databases: Array<{ id: string; title: string }>;
}

export interface ListWorkspacesResponse {
  workspaces: Array<{
    id: number;
    notion_id: string;
    name: string;
    icon: string | null;
    owner_email: string | null;
  }>;
}

// Re-exported under a friendlier alias for consumer-side code that just
// wants the "is a Notion property" shape without the full module path.
export type NotionPropertyShape = NotionProperty;
