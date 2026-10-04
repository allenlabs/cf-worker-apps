-- Initial schema for Project Management (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Mirrors drizzle/0001_initial.sql + drizzle/0002_better_auth_user_id.sql.
-- All DDL targets the `pm` schema. We use TIMESTAMPTZ + DEFAULT NOW() for
-- "created_at"-style epoch columns (the old SQLite schema stored them as
-- INTEGER seconds; the drizzle PG schema will mirror this with timestamp
-- mode 'date'/'string', so call sites stay shape-compatible).

CREATE SCHEMA IF NOT EXISTS pm;
SET search_path = pm, public;

-- ---------- Users ----------
CREATE TABLE pm.users (
  id SERIAL PRIMARY KEY,
  login TEXT NOT NULL,
  email TEXT NOT NULL,
  firstname TEXT NOT NULL DEFAULT '',
  lastname TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  password_salt TEXT,
  github_id INTEGER,
  better_auth_user_id TEXT,
  avatar_url TEXT,
  admin BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  language TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_login_idx ON pm.users (login);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON pm.users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_github_idx ON pm.users (github_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_better_auth_user_id_idx ON pm.users (better_auth_user_id);

-- ---------- Roles ----------
CREATE TABLE pm.roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  position INTEGER NOT NULL DEFAULT 1
);

-- ---------- Projects ----------
CREATE TABLE pm.projects (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '',
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_identifier_idx ON pm.projects (identifier);
CREATE INDEX IF NOT EXISTS projects_parent_idx ON pm.projects (parent_id);

-- ---------- Members ----------
CREATE TABLE pm.members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES pm.roles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS members_unique_idx ON pm.members (user_id, project_id, role_id);
CREATE INDEX IF NOT EXISTS members_project_idx ON pm.members (project_id);
CREATE INDEX IF NOT EXISTS members_user_idx ON pm.members (user_id);

-- ---------- Trackers ----------
CREATE TABLE pm.trackers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3a7fa5',
  position INTEGER NOT NULL DEFAULT 1
);

-- ---------- Issue statuses ----------
CREATE TABLE pm.issue_statuses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#dde9f5'
);

-- ---------- Issue priorities ----------
CREATE TABLE pm.issue_priorities (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#e3e9ee'
);

-- ---------- Versions ----------
CREATE TABLE pm.versions (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  sharing TEXT NOT NULL DEFAULT 'none',
  wiki_page TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS versions_project_idx ON pm.versions (project_id);

-- ---------- Issue categories ----------
CREATE TABLE pm.issue_categories (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assigned_to_id INTEGER REFERENCES pm.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS issue_categories_project_idx ON pm.issue_categories (project_id);

-- ---------- Issues ----------
CREATE TABLE pm.issues (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  tracker_id INTEGER NOT NULL REFERENCES pm.trackers(id) ON DELETE RESTRICT,
  subject TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status_id INTEGER NOT NULL REFERENCES pm.issue_statuses(id) ON DELETE RESTRICT,
  priority_id INTEGER NOT NULL REFERENCES pm.issue_priorities(id) ON DELETE RESTRICT,
  author_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE RESTRICT,
  assigned_to_id INTEGER REFERENCES pm.users(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES pm.issue_categories(id) ON DELETE SET NULL,
  fixed_version_id INTEGER REFERENCES pm.versions(id) ON DELETE SET NULL,
  parent_id INTEGER,
  start_date TEXT,
  due_date TEXT,
  estimated_hours REAL,
  done_ratio INTEGER NOT NULL DEFAULT 0,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS issues_project_idx ON pm.issues (project_id);
CREATE INDEX IF NOT EXISTS issues_status_idx ON pm.issues (status_id);
CREATE INDEX IF NOT EXISTS issues_assignee_idx ON pm.issues (assigned_to_id);
CREATE INDEX IF NOT EXISTS issues_parent_idx ON pm.issues (parent_id);
CREATE INDEX IF NOT EXISTS issues_version_idx ON pm.issues (fixed_version_id);

-- ---------- Journals ----------
CREATE TABLE pm.journals (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE RESTRICT,
  notes TEXT NOT NULL DEFAULT '',
  private_notes BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS journals_issue_idx ON pm.journals (issue_id);

-- ---------- Journal details ----------
CREATE TABLE pm.journal_details (
  id SERIAL PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES pm.journals(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  prop_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS journal_details_journal_idx ON pm.journal_details (journal_id);

-- ---------- Time entry activities ----------
CREATE TABLE pm.time_entry_activities (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 1
);

-- ---------- Time entries ----------
CREATE TABLE pm.time_entries (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE RESTRICT,
  issue_id INTEGER REFERENCES pm.issues(id) ON DELETE SET NULL,
  activity_id INTEGER NOT NULL REFERENCES pm.time_entry_activities(id) ON DELETE RESTRICT,
  hours REAL NOT NULL,
  comments TEXT NOT NULL DEFAULT '',
  spent_on TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS time_entries_project_idx ON pm.time_entries (project_id);
CREATE INDEX IF NOT EXISTS time_entries_user_idx ON pm.time_entries (user_id);
CREATE INDEX IF NOT EXISTS time_entries_issue_idx ON pm.time_entries (issue_id);
CREATE INDEX IF NOT EXISTS time_entries_spent_on_idx ON pm.time_entries (spent_on);

-- ---------- Wikis ----------
CREATE TABLE pm.wikis (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  start_page TEXT NOT NULL DEFAULT 'Wiki',
  status TEXT NOT NULL DEFAULT 'enabled'
);
CREATE UNIQUE INDEX IF NOT EXISTS wikis_project_idx ON pm.wikis (project_id);

-- ---------- Wiki pages ----------
CREATE TABLE pm.wiki_pages (
  id SERIAL PRIMARY KEY,
  wiki_id INTEGER NOT NULL REFERENCES pm.wikis(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id INTEGER,
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  current_revision_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_slug_idx ON pm.wiki_pages (wiki_id, slug);

-- ---------- Wiki revisions ----------
CREATE TABLE pm.wiki_revisions (
  id SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pm.wiki_pages(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE RESTRICT,
  text TEXT NOT NULL,
  comments TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wiki_revisions_page_idx ON pm.wiki_revisions (page_id);

-- ---------- Attachments ----------
CREATE TABLE pm.attachments (
  id SERIAL PRIMARY KEY,
  container_type TEXT NOT NULL,
  container_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filesize INTEGER NOT NULL,
  digest TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attachments_container_idx ON pm.attachments (container_type, container_id);

-- ---------- Activities ----------
CREATE TABLE pm.activities (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pm.projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activities_created_idx ON pm.activities (created_at);
CREATE INDEX IF NOT EXISTS activities_project_idx ON pm.activities (project_id);
CREATE INDEX IF NOT EXISTS activities_user_idx ON pm.activities (user_id);

-- ---------- Watchers ----------
CREATE TABLE pm.watchers (
  issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, user_id)
);

-- ---------- Project trackers ----------
CREATE TABLE pm.project_trackers (
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  tracker_id INTEGER NOT NULL REFERENCES pm.trackers(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tracker_id)
);

-- ---------- Enabled modules ----------
CREATE TABLE pm.enabled_modules (
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
