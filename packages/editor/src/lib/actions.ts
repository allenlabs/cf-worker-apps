// Phase 17 — the shared button/automation ACTION schema.
//
// A single action vocabulary is reused by THREE callers:
//   1. Button BLOCKS (a TipTap node in the page content).
//   2. Button PROPERTIES (a db_properties.type='button' column, per-row).
//   3. Database AUTOMATIONS (server-side, triggered by row mutations / cron).
//
// Keeping the types + the pure `describeAction` label helper here (all-MIT, no
// runtime deps) means the editor package, the web app, and the API worker all
// agree on the shape. Client-only actions (insert_blocks, open_page,
// show_confirm) run in the editor NodeView; data actions (add_page_to_db,
// edit_pages) call server fns. The server mirrors the data actions under
// slightly different names (edit_property / add_page_to) in the automations
// handler — `normalizeServerActionKind` bridges the two.

/** A templated block the `insert_blocks` action drops below the button. */
export type BlockTemplate =
  | { type: 'paragraph'; text?: string }
  | { type: 'heading'; level?: 1 | 2 | 3; text?: string }
  | { type: 'todo'; text?: string };

/** Insert one or more templated blocks below the button (client-side). */
export interface InsertBlocksAction {
  kind: 'insert_blocks';
  blocks: BlockTemplate[];
}

/** Create a page (row) in a target database with preset props (server-side). */
export interface AddPageToDbAction {
  kind: 'add_page_to_db';
  databaseId: string;
  /** Human label for the target DB (display only; the id is authoritative). */
  databaseTitle?: string;
  title?: string;
  /** Preset cell values, keyed by property id. */
  props?: Record<string, unknown>;
}

/** Set a property value on rows of a target DB matching an optional filter. */
export interface EditPagesAction {
  kind: 'edit_pages';
  /** Target DB; when omitted on a per-row button/property, the current row's DB. */
  databaseId?: string;
  /** Property id to set. */
  propertyId: string;
  /** Value to set. */
  value: unknown;
  /**
   * When true (the per-row default for button properties), edit ONLY the row
   * the button belongs to. When false/absent with a databaseId, edits all rows
   * of that DB (v1 has no rich filter — a deliberate thin slice).
   */
  currentRowOnly?: boolean;
}

/** Navigate to a page (client-side, full-page nav). */
export interface OpenPageAction {
  kind: 'open_page';
  pageId: string;
}

/** A confirm dialog gating the following actions (client-side). */
export interface ShowConfirmAction {
  kind: 'show_confirm';
  message: string;
}

/** Insert notifications for the given recipient emails (server-side). */
export interface SendNotificationAction {
  kind: 'send_notification';
  recipients: string[];
  body: string;
}

/** POST a JSON payload to an external URL (server-side, guarded). */
export interface SendWebhookAction {
  kind: 'send_webhook';
  url: string;
  payload?: Record<string, unknown>;
}

export type ButtonAction =
  | InsertBlocksAction
  | AddPageToDbAction
  | EditPagesAction
  | OpenPageAction
  | ShowConfirmAction
  | SendNotificationAction
  | SendWebhookAction;

export type ButtonActionKind = ButtonAction['kind'];

/** The full set of action kinds (button blocks, properties, automations). */
export const ACTION_KINDS: ButtonActionKind[] = [
  'insert_blocks',
  'add_page_to_db',
  'edit_pages',
  'open_page',
  'show_confirm',
  'send_notification',
  'send_webhook',
];

/** Action kinds that run client-side (in the editor NodeView). */
export const CLIENT_ACTION_KINDS = new Set<ButtonActionKind>([
  'insert_blocks',
  'open_page',
  'show_confirm',
]);

/** Action kinds executed server-side (data + side-effects). */
export const SERVER_ACTION_KINDS = new Set<ButtonActionKind>([
  'add_page_to_db',
  'edit_pages',
  'send_notification',
  'send_webhook',
]);

/** True when an action is a client-only action (no server round-trip). */
export function isClientAction(a: ButtonAction): boolean {
  return CLIENT_ACTION_KINDS.has(a.kind);
}

/**
 * A short, human-readable label for an action — used in the config UI list and
 * automations builder. Pure (no i18n dependency); the host can translate the
 * leading verb via the optional `t` map keyed by `'action.<kind>'`. Falls back
 * to English.
 */
export function describeAction(a: ButtonAction, t?: (key: string) => string): string {
  const label = (key: string, fallback: string) => {
    const v = t?.(key);
    return v && v !== key ? v : fallback;
  };
  switch (a.kind) {
    case 'insert_blocks': {
      const n = a.blocks?.length ?? 0;
      return `${label('action.insert_blocks', 'Insert blocks')} (${n})`;
    }
    case 'add_page_to_db':
      return `${label('action.add_page_to_db', 'Add page to')} ${a.databaseTitle ?? a.databaseId ?? '…'}`;
    case 'edit_pages':
      return `${label('action.edit_pages', 'Edit pages')}`;
    case 'open_page':
      return `${label('action.open_page', 'Open page')}`;
    case 'show_confirm':
      return `${label('action.show_confirm', 'Show confirm')}: ${a.message ?? ''}`.trim();
    case 'send_notification':
      return `${label('action.send_notification', 'Send notification')} (${a.recipients?.length ?? 0})`;
    case 'send_webhook':
      return `${label('action.send_webhook', 'Send webhook')}`;
    default: {
      // Exhaustiveness guard — unreachable for valid ButtonAction values.
      const never: never = a;
      return String((never as { kind?: string }).kind ?? 'unknown');
    }
  }
}

/**
 * Validate that an unknown value is a well-formed ButtonAction. Pure + defensive
 * — used both client-side (config popover) and server-side (before executing).
 * Returns the narrowed action, or null when invalid.
 */
export function parseAction(value: unknown): ButtonAction | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  switch (a.kind) {
    case 'insert_blocks':
      if (!Array.isArray(a.blocks)) return null;
      return { kind: 'insert_blocks', blocks: a.blocks as BlockTemplate[] };
    case 'add_page_to_db':
      if (typeof a.databaseId !== 'string') return null;
      return {
        kind: 'add_page_to_db',
        databaseId: a.databaseId,
        databaseTitle: typeof a.databaseTitle === 'string' ? a.databaseTitle : undefined,
        title: typeof a.title === 'string' ? a.title : undefined,
        props: a.props && typeof a.props === 'object' ? (a.props as Record<string, unknown>) : undefined,
      };
    case 'edit_pages':
      if (typeof a.propertyId !== 'string') return null;
      return {
        kind: 'edit_pages',
        databaseId: typeof a.databaseId === 'string' ? a.databaseId : undefined,
        propertyId: a.propertyId,
        value: a.value,
        currentRowOnly: a.currentRowOnly === undefined ? undefined : Boolean(a.currentRowOnly),
      };
    case 'open_page':
      if (typeof a.pageId !== 'string') return null;
      return { kind: 'open_page', pageId: a.pageId };
    case 'show_confirm':
      return { kind: 'show_confirm', message: typeof a.message === 'string' ? a.message : '' };
    case 'send_notification':
      if (!Array.isArray(a.recipients)) return null;
      return {
        kind: 'send_notification',
        recipients: (a.recipients as unknown[]).filter((r): r is string => typeof r === 'string'),
        body: typeof a.body === 'string' ? a.body : '',
      };
    case 'send_webhook':
      if (typeof a.url !== 'string') return null;
      return {
        kind: 'send_webhook',
        url: a.url,
        payload:
          a.payload && typeof a.payload === 'object'
            ? (a.payload as Record<string, unknown>)
            : undefined,
      };
    default:
      return null;
  }
}

/** Parse + filter an unknown array into a clean ButtonAction[]. Pure. */
export function parseActions(value: unknown): ButtonAction[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseAction).filter((a): a is ButtonAction => a !== null);
}
