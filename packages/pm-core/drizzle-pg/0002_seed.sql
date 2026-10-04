-- Seed default trackers, statuses, priorities, roles, activities (Postgres).
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0002_seed.sql
-- Idempotent: re-running is safe (ON CONFLICT DO NOTHING on primary key).

SET search_path = pm, public;

INSERT INTO pm.trackers (id, name, color, position) VALUES
  (1, 'Bug',     '#d9534f', 1),
  (2, 'Feature', '#5cb85c', 2),
  (3, 'Support', '#f0ad4e', 3),
  (4, 'Task',    '#5bc0de', 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pm.issue_statuses (id, name, is_closed, is_default, position, color) VALUES
  (1, 'New',         FALSE, TRUE,  1, '#dde9f5'),
  (2, 'In Progress', FALSE, FALSE, 2, '#fff3cd'),
  (3, 'Resolved',    FALSE, FALSE, 3, '#d4edda'),
  (4, 'Feedback',    FALSE, FALSE, 4, '#fcecd5'),
  (5, 'Closed',      TRUE,  FALSE, 5, '#e9ecef'),
  (6, 'Rejected',    TRUE,  FALSE, 6, '#f5d6d6')
ON CONFLICT (id) DO NOTHING;

INSERT INTO pm.issue_priorities (id, name, is_default, position, color) VALUES
  (1, 'Low',       FALSE, 1, '#c6e2f5'),
  (2, 'Normal',    TRUE,  2, '#e3e9ee'),
  (3, 'High',      FALSE, 3, '#fde2cf'),
  (4, 'Urgent',    FALSE, 4, '#f6c4c4'),
  (5, 'Immediate', FALSE, 5, '#e7adad')
ON CONFLICT (id) DO NOTHING;

-- Default Redmine-style roles. Permissions are a JSONB array of strings; see app/lib/permissions.ts.
INSERT INTO pm.roles (id, name, position, permissions) VALUES
  (1, 'Manager',   1, '["view_project","edit_project","manage_members","manage_versions","manage_categories","view_issues","add_issues","edit_issues","delete_issues","add_issue_notes","manage_wiki","edit_wiki_pages","view_wiki_pages","view_time_entries","log_time","edit_time_entries","manage_files","view_files","view_gantt","view_roadmap"]'::jsonb),
  (2, 'Developer', 2, '["view_project","view_issues","add_issues","edit_issues","add_issue_notes","view_wiki_pages","edit_wiki_pages","view_time_entries","log_time","view_files","manage_files","view_gantt","view_roadmap"]'::jsonb),
  (3, 'Reporter',  3, '["view_project","view_issues","add_issues","add_issue_notes","view_wiki_pages","view_files","view_gantt","view_roadmap"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pm.time_entry_activities (id, name, is_default, position) VALUES
  (1, 'Design',      FALSE, 1),
  (2, 'Development', TRUE,  2),
  (3, 'Testing',     FALSE, 3),
  (4, 'Support',     FALSE, 4)
ON CONFLICT (id) DO NOTHING;

-- Resync sequence pointers so future INSERTs (without explicit id) don't
-- collide with the seeded rows.
SELECT setval('pm.trackers_id_seq',              (SELECT COALESCE(MAX(id), 1) FROM pm.trackers));
SELECT setval('pm.issue_statuses_id_seq',        (SELECT COALESCE(MAX(id), 1) FROM pm.issue_statuses));
SELECT setval('pm.issue_priorities_id_seq',      (SELECT COALESCE(MAX(id), 1) FROM pm.issue_priorities));
SELECT setval('pm.roles_id_seq',                 (SELECT COALESCE(MAX(id), 1) FROM pm.roles));
SELECT setval('pm.time_entry_activities_id_seq', (SELECT COALESCE(MAX(id), 1) FROM pm.time_entry_activities));
