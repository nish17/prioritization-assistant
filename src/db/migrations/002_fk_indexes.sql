-- Indexes for foreign keys hit by task deletion (cascades, SET NULL) and reset_backfill.
CREATE INDEX IF NOT EXISTS ingest_outcomes_task_idx ON ingest_outcomes (task_id);
CREATE INDEX IF NOT EXISTS tasks_created_run_idx ON tasks (created_run_id);
CREATE INDEX IF NOT EXISTS task_links_to_idx ON task_links (to_task_id);
