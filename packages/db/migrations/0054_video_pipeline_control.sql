-- ============================================================================
-- 0054_video_pipeline_control.sql
-- Unified video pipeline run, command, and outbox state.
--
-- Additive migration. Legacy production_stage_runs rows remain the compatibility
-- source for old readers until 0055 links new StageRun rows to this parent.
-- ============================================================================

CREATE TABLE video_pipeline_runs (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  project_id          TEXT NOT NULL REFERENCES video_projects(id),
  pipeline_kind       TEXT NOT NULL CHECK (pipeline_kind IN ('marketing','narrative','explainer','edit','whiteboard')),
  intent_contract_id  TEXT NOT NULL,
  intent_hash         TEXT NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  plan_key            TEXT NOT NULL,
  plan_version        TEXT NOT NULL,
  plan_hash           TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','waiting','reconciling','completed','failed','cancelled')),
  next_action         TEXT NOT NULL DEFAULT 'run_node'
                      CHECK (next_action IN ('run_node','wait_approval','repair','reconcile','wait_resource','manual_fix','done')),
  current_frontier    JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision            BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(current_frontier) = 'array'),
  CHECK (lease_owner IS NULL OR lease_expires_at IS NOT NULL)
);

CREATE UNIQUE INDEX video_pipeline_runs_one_active_project
  ON video_pipeline_runs (workspace_id, project_id)
  WHERE status IN ('queued','running','waiting','reconciling');

CREATE INDEX idx_video_pipeline_runs_project
  ON video_pipeline_runs (workspace_id, project_id, created_at DESC);

CREATE INDEX idx_video_pipeline_runs_lease
  ON video_pipeline_runs (lease_expires_at)
  WHERE status IN ('running','waiting','reconciling');

CREATE TABLE video_pipeline_commands (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL REFERENCES tenants(id),
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id),
  run_id                    TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  command_kind              TEXT NOT NULL,
  idempotency_key           TEXT NOT NULL,
  request_hash              TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id                  TEXT NOT NULL,
  actor_type                TEXT NOT NULL CHECK (actor_type IN ('human','system','worker')),
  expected_run_revision     BIGINT NOT NULL CHECK (expected_run_revision > 0),
  expected_stage_revision   BIGINT CHECK (expected_stage_revision IS NULL OR expected_stage_revision > 0),
  status                    TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','applied','failed')),
  response_json             JSONB,
  error_json                JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at               TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key),
  CHECK (status <> 'applied' OR response_json IS NOT NULL),
  CHECK (status <> 'failed' OR error_json IS NOT NULL)
);

CREATE INDEX idx_video_pipeline_commands_run
  ON video_pipeline_commands (run_id, created_at);

CREATE TABLE video_pipeline_outbox (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  run_id         TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  event_kind     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  published_at   TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_video_pipeline_outbox_pending
  ON video_pipeline_outbox (created_at)
  WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION guard_video_pipeline_command_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM video_pipeline_runs r
     WHERE r.id = NEW.run_id
       AND r.tenant_id = NEW.tenant_id
       AND r.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video pipeline command run scope mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.run_id, NEW.command_kind, NEW.idempotency_key,
    NEW.request_hash, NEW.actor_id, NEW.actor_type, NEW.expected_run_revision,
    NEW.expected_stage_revision
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.run_id, OLD.command_kind, OLD.idempotency_key,
    OLD.request_hash, OLD.actor_id, OLD.actor_type, OLD.expected_run_revision,
    OLD.expected_stage_revision
  ) THEN
    RAISE EXCEPTION 'video pipeline command identity is immutable';
  END IF;
  IF OLD.status IN ('applied','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal video pipeline command cannot be reopened';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_pipeline_commands_scope_guard
BEFORE INSERT OR UPDATE ON video_pipeline_commands
FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_command_scope();

CREATE OR REPLACE FUNCTION guard_video_pipeline_outbox_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM video_pipeline_runs r
     WHERE r.id = NEW.run_id
       AND r.tenant_id = NEW.tenant_id
       AND r.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video pipeline outbox run scope mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.run_id, NEW.event_kind, NEW.payload
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.run_id, OLD.event_kind, OLD.payload
  ) THEN
    RAISE EXCEPTION 'video pipeline outbox identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_pipeline_outbox_scope_guard
BEFORE INSERT OR UPDATE ON video_pipeline_outbox
FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_outbox_scope();

CREATE OR REPLACE FUNCTION guard_video_pipeline_run_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM workspaces w
      JOIN video_projects p ON p.workspace_id = w.id
     WHERE w.id = NEW.workspace_id
       AND w.tenant_id = NEW.tenant_id
       AND p.id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'video pipeline run scope mismatch';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.pipeline_kind,
    NEW.intent_contract_id, NEW.intent_hash, NEW.plan_key, NEW.plan_version, NEW.plan_hash
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.pipeline_kind,
    OLD.intent_contract_id, OLD.intent_hash, OLD.plan_key, OLD.plan_version, OLD.plan_hash
  ) THEN
    RAISE EXCEPTION 'video pipeline run identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_pipeline_runs_scope_guard
BEFORE INSERT OR UPDATE ON video_pipeline_runs
FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_run_scope();

ALTER TABLE video_pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_pipeline_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY video_pipeline_runs_scope ON video_pipeline_runs
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE video_pipeline_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_pipeline_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY video_pipeline_commands_scope ON video_pipeline_commands
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE video_pipeline_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_pipeline_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY video_pipeline_outbox_scope ON video_pipeline_outbox
  USING (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
     AND workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE ON video_pipeline_runs TO workloom_app, workloom_gateway;
GRANT SELECT, INSERT, UPDATE ON video_pipeline_commands TO workloom_app, workloom_gateway;
GRANT SELECT, INSERT, UPDATE ON video_pipeline_outbox TO workloom_app, workloom_gateway;
