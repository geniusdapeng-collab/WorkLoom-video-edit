-- ============================================================================
-- 0058_delivery_revision_jobs.sql
-- Durable delivery revision operation state.
-- ============================================================================

CREATE TABLE video_delivery_revision_jobs (
  id                         TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id),
  project_id                 TEXT NOT NULL REFERENCES video_projects(id),
  pipeline_run_id            TEXT REFERENCES video_pipeline_runs(id),
  stage_run_id               TEXT REFERENCES production_stage_runs(id),
  package_dir                TEXT NOT NULL,
  expected_version           INTEGER NOT NULL CHECK (expected_version > 0),
  expected_project_sha256    TEXT NOT NULL CHECK (expected_project_sha256 ~ '^[a-f0-9]{64}$'),
  patch_hash                 TEXT NOT NULL CHECK (patch_hash ~ '^[a-f0-9]{64}$'),
  patch                      JSONB NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued','running','done','failed','interrupted','unknown')),
  version                    INTEGER,
  out_dir                    TEXT,
  log_path                   TEXT NOT NULL,
  exit_code                  INTEGER,
  error_class                TEXT,
  error_msg                  TEXT,
  idempotency_key            TEXT NOT NULL,
  created_by                 TEXT NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                 TIMESTAMPTZ,
  finished_at                TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((pipeline_run_id IS NULL AND stage_run_id IS NULL)
      OR (pipeline_run_id IS NOT NULL AND stage_run_id IS NOT NULL)),
  CHECK (status IN ('queued','running','interrupted','unknown') OR finished_at IS NOT NULL)
);

CREATE UNIQUE INDEX video_delivery_revision_one_running_package
  ON video_delivery_revision_jobs (workspace_id, package_dir)
  WHERE status IN ('queued','running');

CREATE INDEX idx_video_delivery_revision_project
  ON video_delivery_revision_jobs (workspace_id, project_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_video_delivery_revision_scope()
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
    RAISE EXCEPTION 'video delivery revision project scope mismatch';
  END IF;
  IF NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM video_pipeline_runs r
      JOIN production_stage_runs s ON s.id = NEW.stage_run_id
     WHERE r.id = NEW.pipeline_run_id
       AND r.tenant_id = NEW.tenant_id
       AND r.workspace_id = NEW.workspace_id
       AND r.project_id = NEW.project_id
       AND s.pipeline_run_id = r.id
       AND s.workspace_id = NEW.workspace_id
       AND s.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'video delivery revision pipeline scope mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.pipeline_run_id, NEW.stage_run_id,
    NEW.package_dir, NEW.expected_version, NEW.expected_project_sha256, NEW.patch_hash,
    NEW.patch, NEW.idempotency_key, NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.pipeline_run_id, OLD.stage_run_id,
    OLD.package_dir, OLD.expected_version, OLD.expected_project_sha256, OLD.patch_hash,
    OLD.patch, OLD.idempotency_key, OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'video delivery revision identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_delivery_revision_scope_guard
BEFORE INSERT OR UPDATE ON video_delivery_revision_jobs
FOR EACH ROW EXECUTE FUNCTION guard_video_delivery_revision_scope();

ALTER TABLE video_delivery_revision_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_delivery_revision_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY video_delivery_revision_jobs_scope ON video_delivery_revision_jobs
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

GRANT SELECT, INSERT, UPDATE ON video_delivery_revision_jobs TO workloom_app, workloom_gateway;
