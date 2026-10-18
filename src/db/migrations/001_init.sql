-- POC schema. Starts from design 8.4 with the plan's changes:
-- no stored scores (computed on read), item keys and roles on sources, server-owned run windows,
-- content-free outcome and event rows. gen_random_uuid() is built in (PG13+), so no pgcrypto.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  display_name  text,
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Read and written as a whole document.
CREATE TABLE user_settings (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  people            jsonb NOT NULL DEFAULT '[]',  -- [{name, emails[], slack_handles[], slack_ids[], aliases[], tier, relationship}]
  known_open_items  jsonb NOT NULL DEFAULT '[]',  -- coverage check: items the user named as open during setup
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_state (
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source               text NOT NULL CHECK (source IN ('gmail','slack','gcal','granola')),
  refresh_cursor       timestamptz,          -- refresh windows start 1 h before this
  backfill_anchor      timestamptz,          -- "now" at the first backfill run; slices step back from here
  backfill_next_to     timestamptz,          -- upper bound of the next backfill slice
  slices_done          integer NOT NULL DEFAULT 0,
  current_slice_hours  integer,              -- halves when a backfill slice is capped
  refresh_window_hours integer,              -- set when a refresh is capped: catch up oldest-first in chunks
  backfill_complete    boolean NOT NULL DEFAULT false,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_status          text CHECK (last_status IN ('ok','partial','failed')),
  last_error           text CHECK (char_length(last_error) <= 300),
  PRIMARY KEY (user_id, source)
);

CREATE TABLE ingest_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('gmail','slack','gcal','granola')),
  mode           text NOT NULL CHECK (mode IN ('backfill','refresh')),
  window_from    timestamptz NOT NULL,
  window_to      timestamptz NOT NULL,
  is_last_slice  boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  counts         jsonb,                      -- {fetched, evaluated, not_a_task, capped}
  error          text CHECK (char_length(error) <= 300),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX ingest_runs_user_source_idx ON ingest_runs (user_id, source, started_at DESC);

CREATE TABLE tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                text NOT NULL CHECK (char_length(title) <= 120),
  title_norm           text NOT NULL,
  summary              text CHECK (char_length(summary) <= 500),
  kind                 text NOT NULL CHECK (kind IN ('ask','commitment','decision','risk','follow_up','prep')),
  workstream           text CHECK (char_length(workstream) <= 40),

  -- signals (from Claude; requester_tier may be forced from saved people)
  due_at               timestamptz,
  due_confidence       text NOT NULL DEFAULT 'none' CHECK (due_confidence IN ('explicit','inferred','none')),
  waiting_on_user      boolean NOT NULL DEFAULT false,
  ask_received_at      timestamptz,
  requester_tier       text CHECK (requester_tier IN ('lp','principal','portfolio_ceo','portfolio_exec','internal_team','external_counterparty','vendor','unknown')),
  requester_name       text CHECK (char_length(requester_name) <= 120),
  requester_label      text CHECK (char_length(requester_label) <= 60),  -- the user's own term: client, co-founder, prospect
  risk_flags           text[] NOT NULL DEFAULT '{}',
  urgency_language     boolean NOT NULL DEFAULT false,
  delegable            boolean NOT NULL DEFAULT false,
  suggested_delegate   text CHECK (char_length(suggested_delegate) <= 120),
  claude_importance    smallint CHECK (claude_importance BETWEEN 0 AND 2),
  urgency_reason       text CHECK (char_length(urgency_reason) <= 300),
  importance_reason    text CHECK (char_length(importance_reason) <= 300),

  quadrant_override    text CHECK (quadrant_override IN ('do','schedule','delegate','defer')),
  override_reason      text CHECK (char_length(override_reason) <= 300),
  rules_version        text NOT NULL,

  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','delegated','waiting_on_others','done')),
  status_note          text CHECK (char_length(status_note) <= 300),
  snooze_until         timestamptz,
  delegated_to         text CHECK (char_length(delegated_to) <= 120),
  follow_up_at         timestamptz,
  status_changed_at    timestamptz NOT NULL DEFAULT now(),

  created_run_id       uuid REFERENCES ingest_runs(id) ON DELETE SET NULL,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at     timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  CHECK ((status = 'done') = (closed_at IS NOT NULL))
);
CREATE INDEX tasks_user_status_idx ON tasks (user_id, status);
CREATE INDEX tasks_title_norm_trgm_idx ON tasks USING gin (title_norm gin_trgm_ops);

CREATE TABLE task_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('gmail','slack','gcal','granola')),
  external_id   text NOT NULL CHECK (char_length(external_id) <= 256),
  ask_index     smallint CHECK (ask_index BETWEEN 1 AND 50),
  item_key      text NOT NULL,              -- external_id, or external_id#ask_index
  thread_key    text NOT NULL CHECK (char_length(thread_key) <= 256),
  role          text NOT NULL CHECK (role IN ('origin','update','evidence','resolution')),
  via_conversion boolean NOT NULL DEFAULT false,  -- attached by a Step 2 or drift conversion, so separate_task may move it
  title         text CHECK (char_length(title) <= 120),
  url           text,                       -- only https on an allowed host
  url_text      text CHECK (char_length(url_text) <= 300),  -- any other URL, kept as plain text
  occurred_at   timestamptz NOT NULL,
  author        text CHECK (char_length(author) <= 120),
  excerpt       text CHECK (char_length(excerpt) <= 280),
  run_id        uuid REFERENCES ingest_runs(id) ON DELETE SET NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, source, item_key)
);
CREATE INDEX task_sources_item_idx ON task_sources (source, item_key);
CREATE INDEX task_sources_external_idx ON task_sources (source, external_id);
CREATE INDEX task_sources_thread_idx ON task_sources (source, thread_key);
CREATE INDEX task_sources_run_idx ON task_sources (run_id);

CREATE TABLE entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('person','company','deal','portfolio_company')),
  canonical_name  text NOT NULL CHECK (char_length(canonical_name) <= 120),
  aliases         text[] NOT NULL DEFAULT '{}',
  emails          text[] NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX entities_user_type_name_uq ON entities (user_id, type, lower(canonical_name));
CREATE INDEX entities_emails_idx ON entities USING gin (emails);

CREATE TABLE task_entities (
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role       text CHECK (role IN ('requester','subject','attendee','owner')),
  PRIMARY KEY (task_id, entity_id)
);
CREATE INDEX task_entities_entity_idx ON task_entities (entity_id);

CREATE TABLE task_links (
  from_task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type     text NOT NULL CHECK (link_type IN ('related','follows_up','blocks','duplicate_of')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_task_id, to_task_id, link_type),
  CHECK (from_task_id <> to_task_id)
);

-- Type, actor and time only: no before/after snapshots.
CREATE TABLE task_events (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor       text NOT NULL CHECK (actor IN ('claude','board','server')),
  event_type  text NOT NULL CHECK (char_length(event_type) <= 40),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events (task_id, created_at);

-- One content-free row per upsert attempt: answers "why isn't my item on the board?".
CREATE TABLE ingest_outcomes (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id       uuid REFERENCES ingest_runs(id) ON DELETE SET NULL,
  source       text NOT NULL CHECK (source IN ('gmail','slack','gcal','granola')),
  external_id  text NOT NULL,
  item_key     text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('created','updated','converted','skipped-done','evidence','reopened','moved')),
  task_id      uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_outcomes_external_idx ON ingest_outcomes (user_id, source, external_id, id);
CREATE INDEX ingest_outcomes_run_idx ON ingest_outcomes (run_id);
