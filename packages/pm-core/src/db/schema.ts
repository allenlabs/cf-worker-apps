import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
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

export const pm = pgSchema('pm');

// ---------- Users / Sessions ----------

export const users = pm.table(
  'users',
  {
    id: serial('id').primaryKey(),
    login: text('login').notNull(),
    email: text('email').notNull(),
    firstname: text('firstname').notNull().default(''),
    lastname: text('lastname').notNull().default(''),
    passwordHash: text('password_hash'),
    passwordSalt: text('password_salt'),
    githubId: integer('github_id'),
    // Link to the allenlabs-auth Better Auth user id. Populated on the
    // first SSO sign-in via /auth/callback; thereafter we look up the
    // local user row by this column. Nullable so existing rows survive
    // the migration unchanged.
    betterAuthUserId: text('better_auth_user_id'),
    // Suite-wide public handle + preferred display name, synced from the auth
    // user (JWT `username` / `preferredName`) on sign-in. Nullable; display
    // falls back to firstname/lastname/login when absent.
    username: text('username'),
    preferredName: text('preferred_name'),
    avatarUrl: text('avatar_url'),
    admin: boolean('admin').notNull().default(false),
    status: text('status', { enum: ['active', 'locked'] }).notNull().default('active'),
    language: text('language').notNull().default('en'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    loginIdx: uniqueIndex('users_login_idx').on(t.login),
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    githubIdx: uniqueIndex('users_github_idx').on(t.githubId),
    betterAuthIdx: uniqueIndex('users_better_auth_user_id_idx').on(t.betterAuthUserId),
  }),
);

// ---------- Roles / Members ----------

export const roles = pm.table('roles', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  permissions: jsonb('permissions')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  position: integer('position').notNull().default(1),
});

export const projects = pm.table(
  'projects',
  {
    id: serial('id').primaryKey(),
    identifier: text('identifier').notNull(),
    // Short uppercase project code (e.g. RED) used to compose Jira-style issue
    // keys (`${key}-${number}`). Distinct from the URL `identifier`.
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    homepage: text('homepage').notNull().default(''),
    isPublic: boolean('is_public').notNull().default(false),
    // Per-project monotonic counter; the next issue's `number` is allocated by
    // incrementing this in a single UPDATE ... RETURNING.
    issueSeq: integer('issue_seq').notNull().default(0),
    // Better Auth team id (inside org_allenlabs) backing this project's
    // per-project collaborators. Set on create; nullable for legacy rows.
    authTeamId: text('auth_team_id'),
    // Optional owning site (0013) — the top partition. NULL ⇒ siteless/legacy.
    // Lazy ref: `sites` is declared later in this module.
    siteId: integer('site_id').references(() => sites.id),
    // Optional group-tree association (0012). NULL ⇒ project-only RBAC.
    // Lazy ref: `groups` is declared later in this module.
    groupId: integer('group_id').references(() => groups.id),
    parentId: integer('parent_id'),
    status: text('status', { enum: ['active', 'closed', 'archived'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    identifierIdx: uniqueIndex('projects_identifier_idx').on(t.identifier),
    keyIdx: uniqueIndex('projects_key_idx').on(t.key),
    parentIdx: index('projects_parent_idx').on(t.parentId),
    authTeamIdx: index('projects_auth_team_id_idx').on(t.authTeamId),
    siteIdx: index('projects_site_idx').on(t.siteId),
  }),
);

export const members = pm.table(
  'members',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uniqMember: uniqueIndex('members_unique_idx').on(t.userId, t.projectId, t.roleId),
    projectIdx: index('members_project_idx').on(t.projectId),
    userIdx: index('members_user_idx').on(t.userId),
  }),
);

// ---------- Trackers / Statuses / Priorities ----------

export const trackers = pm.table('trackers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('#3a7fa5'),
  position: integer('position').notNull().default(1),
});

export const issueStatuses = pm.table('issue_statuses', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  isClosed: boolean('is_closed').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  position: integer('position').notNull().default(1),
  color: text('color').notNull().default('#dde9f5'),
});

export const issuePriorities = pm.table('issue_priorities', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  isDefault: boolean('is_default').notNull().default(false),
  position: integer('position').notNull().default(1),
  color: text('color').notNull().default('#e3e9ee'),
});

// ---------- Versions / Categories ----------

export const versions = pm.table(
  'versions',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    dueDate: text('due_date'),
    status: text('status', { enum: ['open', 'locked', 'closed'] })
      .notNull()
      .default('open'),
    sharing: text('sharing', {
      enum: ['none', 'descendants', 'hierarchy', 'tree', 'system'],
    })
      .notNull()
      .default('none'),
    wikiPage: text('wiki_page'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    projectIdx: index('versions_project_idx').on(t.projectId),
  }),
);

export const issueCategories = pm.table(
  'issue_categories',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    assignedToId: integer('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    projectIdx: index('issue_categories_project_idx').on(t.projectId),
  }),
);

// ---------- Issues ----------

export const issues = pm.table(
  'issues',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Per-project sequential number; the human key is `${project.key}-${number}`
    // (e.g. RED-1). The global `id` remains the stable PK/permalink.
    number: integer('number').notNull(),
    trackerId: integer('tracker_id')
      .notNull()
      .references(() => trackers.id, { onDelete: 'restrict' }),
    subject: text('subject').notNull(),
    description: text('description').notNull().default(''),
    statusId: integer('status_id')
      .notNull()
      .references(() => issueStatuses.id, { onDelete: 'restrict' }),
    priorityId: integer('priority_id')
      .notNull()
      .references(() => issuePriorities.id, { onDelete: 'restrict' }),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedToId: integer('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    categoryId: integer('category_id').references(() => issueCategories.id, {
      onDelete: 'set null',
    }),
    fixedVersionId: integer('fixed_version_id').references(() => versions.id, {
      onDelete: 'set null',
    }),
    parentId: integer('parent_id'),
    startDate: text('start_date'),
    dueDate: text('due_date'),
    estimatedHours: doublePrecision('estimated_hours'),
    doneRatio: integer('done_ratio').notNull().default(0),
    isPrivate: boolean('is_private').notNull().default(false),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    projectIdx: index('issues_project_idx').on(t.projectId),
    projectNumberIdx: uniqueIndex('issues_project_number_idx').on(t.projectId, t.number),
    statusIdx: index('issues_status_idx').on(t.statusId),
    assigneeIdx: index('issues_assignee_idx').on(t.assignedToId),
    parentIdx: index('issues_parent_idx').on(t.parentId),
    versionIdx: index('issues_version_idx').on(t.fixedVersionId),
  }),
);

// ---------- Journals (comments + audit log entries on issues) ----------

export const journals = pm.table(
  'journals',
  {
    id: serial('id').primaryKey(),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    notes: text('notes').notNull().default(''),
    privateNotes: boolean('private_notes').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    issueIdx: index('journals_issue_idx').on(t.issueId),
  }),
);

export const journalDetails = pm.table(
  'journal_details',
  {
    id: serial('id').primaryKey(),
    journalId: integer('journal_id')
      .notNull()
      .references(() => journals.id, { onDelete: 'cascade' }),
    property: text('property').notNull(), // attr | cf | attachment
    prop_key: text('prop_key').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
  },
  (t) => ({
    journalIdx: index('journal_details_journal_idx').on(t.journalId),
  }),
);

// ---------- Time tracking ----------

export const timeEntryActivities = pm.table('time_entry_activities', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  isDefault: boolean('is_default').notNull().default(false),
  position: integer('position').notNull().default(1),
});

export const timeEntries = pm.table(
  'time_entries',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    issueId: integer('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    activityId: integer('activity_id')
      .notNull()
      .references(() => timeEntryActivities.id, { onDelete: 'restrict' }),
    hours: doublePrecision('hours').notNull(),
    comments: text('comments').notNull().default(''),
    spentOn: text('spent_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    projectIdx: index('time_entries_project_idx').on(t.projectId),
    userIdx: index('time_entries_user_idx').on(t.userId),
    issueIdx: index('time_entries_issue_idx').on(t.issueId),
    spentOnIdx: index('time_entries_spent_on_idx').on(t.spentOn),
  }),
);

// ---------- Wiki ----------

export const wikis = pm.table(
  'wikis',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    startPage: text('start_page').notNull().default('Wiki'),
    status: text('status', { enum: ['enabled', 'disabled'] }).notNull().default('enabled'),
  },
  (t) => ({
    projectIdx: uniqueIndex('wikis_project_idx').on(t.projectId),
  }),
);

export const wikiPages = pm.table(
  'wiki_pages',
  {
    id: serial('id').primaryKey(),
    wikiId: integer('wiki_id')
      .notNull()
      .references(() => wikis.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    parentId: integer('parent_id'),
    protected: boolean('protected').notNull().default(false),
    currentRevisionId: integer('current_revision_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uniqSlug: uniqueIndex('wiki_pages_slug_idx').on(t.wikiId, t.slug),
  }),
);

export const wikiRevisions = pm.table(
  'wiki_revisions',
  {
    id: serial('id').primaryKey(),
    pageId: integer('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    text: text('text').notNull(),
    comments: text('comments').notNull().default(''),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pageIdx: index('wiki_revisions_page_idx').on(t.pageId),
  }),
);

// ---------- Attachments ----------

export const attachments = pm.table(
  'attachments',
  {
    id: serial('id').primaryKey(),
    containerType: text('container_type', {
      enum: ['issue', 'wiki_page', 'project', 'journal'],
    }).notNull(),
    containerId: integer('container_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    filesize: integer('filesize').notNull(),
    digest: text('digest').notNull(),
    r2Key: text('r2_key').notNull(),
    description: text('description').notNull().default(''),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    containerIdx: index('attachments_container_idx').on(t.containerType, t.containerId),
  }),
);

// ---------- Activities (global feed) ----------

export const activities = pm.table(
  'activities',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'issue_created',
        'issue_updated',
        'issue_closed',
        'comment_added',
        'wiki_edited',
        'time_logged',
        'project_created',
      ],
    }).notNull(),
    refId: integer('ref_id'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    createdIdx: index('activities_created_idx').on(t.createdAt),
    projectIdx: index('activities_project_idx').on(t.projectId),
    userIdx: index('activities_user_idx').on(t.userId),
  }),
);

// ---------- Issue watchers ----------

export const watchers = pm.table(
  'watchers',
  {
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.userId] }),
  }),
);

// ---------- Enabled trackers per project ----------

export const projectTrackers = pm.table(
  'project_trackers',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    trackerId: integer('tracker_id')
      .notNull()
      .references(() => trackers.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.trackerId] }),
  }),
);

// ---------- Labels (free-form tags) ----------

export const labels = pm.table(
  'labels',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6b7280'),
  },
  (t) => ({
    projectNameIdx: uniqueIndex('labels_project_name_idx').on(t.projectId, t.name),
    projectIdx: index('labels_project_idx').on(t.projectId),
  }),
);

export const issueLabels = pm.table(
  'issue_labels',
  {
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.labelId] }),
    labelIdx: index('issue_labels_label_idx').on(t.labelId),
  }),
);

// ---------- Notifications ----------

export const notifications = pm.table(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: ['assigned', 'mentioned', 'commented', 'updated'],
    }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index('notifications_user_idx').on(t.userId, t.readAt),
    issueIdx: index('notifications_issue_idx').on(t.issueId),
  }),
);

// ---------- Issue relations ----------

export const issueRelations = pm.table(
  'issue_relations',
  {
    id: serial('id').primaryKey(),
    sourceIssueId: integer('source_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    targetIssueId: integer('target_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    // Stored (canonical) type: relates | duplicates | blocks | precedes | copied_to.
    // The inverse (duplicated/blocked/follows/copied_from) is derived for display.
    relationType: text('relation_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uniq: uniqueIndex('issue_relations_unique_idx').on(
      t.sourceIssueId,
      t.targetIssueId,
      t.relationType,
    ),
    sourceIdx: index('issue_relations_source_idx').on(t.sourceIssueId),
    targetIdx: index('issue_relations_target_idx').on(t.targetIssueId),
  }),
);

// ---------- Project enabled modules ----------

export const enabledModules = pm.table(
  'enabled_modules',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name', {
      enum: ['issue_tracking', 'time_tracking', 'wiki', 'files', 'gantt', 'roadmap'],
    }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.name] }),
  }),
);

// ---------- API clients (HMAC) ----------

export const apiClients = pm.table(
  'api_clients',
  {
    id: serial('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    name: text('name').notNull(),
    hmacSecret: text('hmac_secret').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index('api_clients_user_idx').on(t.userId),
  }),
);

export type ApiClient = typeof apiClients.$inferSelect;

// ---------- Sites (0013) ----------
//
// A site is the TOP partition of a single-DB, multi-site deployment — a
// first-class, separately-managed entity that sits ABOVE the org/group tree.
// Projects and groups optionally belong to a site (NULLABLE for siteless/legacy
// single-site deployments). A site is NOT "the root group": groups (orgs/teams)
// nest UNDER a site, and a site can be administered on its own (site_members).
// `external_id` matches an IdP-provided site key during the optional claims sync.

export const sites = pm.table(
  'sites',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    slugIdx: uniqueIndex('sites_slug_idx').on(t.slug),
    externalIdx: uniqueIndex('sites_external_id_idx').on(t.externalId),
  }),
);

export const siteMembers = pm.table(
  'site_members',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'), // owner | admin | member
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uniq: uniqueIndex('site_members_unique_idx').on(t.siteId, t.userId),
    userIdx: index('site_members_user_idx').on(t.userId),
  }),
);

export type Site = typeof sites.$inferSelect;
export type SiteMember = typeof siteMembers.$inferSelect;

// ---------- Group tree (0012) ----------
//
// A single self-referential tree of arbitrary depth. A group is an
// 'organization' or 'team' (the `kind` label); any group may contain child
// groups. Groups nest under a site (groups.site_id, 0013). Projects optionally
// attach to a group (projects.group_id), and membership on any node inherits
// down to all descendants. All optional — a project with NULL group_id resolves
// exactly as before (project-only RBAC). `external_id` matches IdP-provided ids
// during the optional claims sync.

export const groups = pm.table(
  'groups',
  {
    id: serial('id').primaryKey(),
    // Owning site (0013); NULL ⇒ siteless/legacy. Lazy ref: `sites` above.
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    parentId: integer('parent_id'), // self-ref (lazy); NULL ⇒ root. FK in SQL.
    kind: text('kind', { enum: ['organization', 'team'] })
      .notNull()
      .default('organization'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    parentSlugIdx: uniqueIndex('groups_parent_slug_idx').on(t.parentId, t.slug),
    parentIdx: index('groups_parent_idx').on(t.parentId),
    siteIdx: index('groups_site_idx').on(t.siteId),
    externalIdx: uniqueIndex('groups_external_id_idx').on(t.externalId),
  }),
);

export const groupMembers = pm.table(
  'group_members',
  {
    id: serial('id').primaryKey(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'), // owner | admin | lead | member
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uniq: uniqueIndex('group_members_unique_idx').on(t.groupId, t.userId),
    userIdx: index('group_members_user_idx').on(t.userId),
  }),
);

export type Group = typeof groups.$inferSelect;
export type GroupMember = typeof groupMembers.$inferSelect;

// ---------- Notion integration ----------
//
// The interim PM-side `notion_connections` / `notion_issue_links` tables
// were dropped in `drizzle-pg/0004_drop_notion.sql` once the central
// notion-gateway took over connection + page-link storage.  PM now calls
// the gateway over HMAC-signed HTTP; nothing in this schema persists
// Notion state anymore.

// ---------- Types ----------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Member = typeof members.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Version = typeof versions.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Label = typeof labels.$inferSelect;
