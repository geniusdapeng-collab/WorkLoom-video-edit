-- ============================================================================
-- 0055_production_stage_control_fields.sql
-- Extend the existing production_stage_runs ledger with the unified video
-- control-plane state while keeping the legacy status column readable.
-- ============================================================================

ALTER TABLE production_stage_runs
  ADD COLUMN pipeline_run_id TEXT REFERENCES video_pipeline_runs(id),
  ADD COLUMN stage_key TEXT,
  ADD COLUMN item_key TEXT,
  ADD COLUMN revision INTEGER,
  ADD COLUMN contract_version TEXT,
  ADD COLUMN plan_hash TEXT,
  ADD COLUMN contract_hash TEXT,
  ADD COLUMN input_manifest_hash TEXT,
  ADD COLUMN output_manifest_hash TEXT,
  ADD COLUMN output_artifact_id TEXT,
  ADD COLUMN gate_decision_id TEXT,
  ADD COLUMN execution_status TEXT,
  ADD COLUMN verification_status TEXT,
  ADD COLUMN disposition TEXT,
  ADD COLUMN repair_of_stage_run_id TEXT REFERENCES production_stage_runs(id),
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN worker_version TEXT;

ALTER TABLE production_stage_runs
  DROP CONSTRAINT IF EXISTS production_stage_runs_workspace_id_project_id_stage_id_attempt_key;

CREATE UNIQUE INDEX production_stage_runs_legacy_uq
  ON production_stage_runs (workspace_id, project_id, stage_id, attempt)
  WHERE pipeline_run_id IS NULL;

CREATE UNIQUE INDEX production_stage_runs_node_revision_uq
  ON production_stage_runs (pipeline_run_id, stage_key, COALESCE(item_key, ''), revision)
  WHERE pipeline_run_id IS NOT NULL;

CREATE INDEX idx_psr_pipeline_frontier
  ON production_stage_runs (pipeline_run_id, execution_status, verification_status);

CREATE INDEX idx_psr_pipeline_stale
  ON production_stage_runs (pipeline_run_id, verification_status)
  WHERE verification_status = 'stale';

ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_runs_control_fields_check CHECK (
    pipeline_run_id IS NULL OR (
      stage_key IS NOT NULL AND revision IS NOT NULL AND revision >= 1
      AND execution_status IN ('pending','ready','running','output_ready','completed','failed','interrupted')
      AND verification_status IN ('not_run','pending','passed','rejected','unverified','not_applicable','stale')
      AND disposition IN ('continue','repair','reconcile','wait_human','blocked','done')
      AND contract_version IS NOT NULL
      AND plan_hash ~ '^[a-f0-9]{64}$'
      AND contract_hash ~ '^[a-f0-9]{64}$'
      AND input_manifest_hash ~ '^[a-f0-9]{64}$'
      AND stage_key = stage_id
      AND (item_key IS NULL OR length(item_key) > 0)
    )
  );

ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_runs_output_manifest_check CHECK (
    pipeline_run_id IS NULL OR output_manifest_hash IS NULL OR output_manifest_hash ~ '^[a-f0-9]{64}$'
  );

CREATE OR REPLACE FUNCTION guard_production_stage_control_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM video_pipeline_runs r
      JOIN workspaces w ON w.id = r.workspace_id
     WHERE r.id = NEW.pipeline_run_id
       AND r.workspace_id = NEW.workspace_id
       AND r.project_id = NEW.project_id
       AND w.tenant_id = current_setting('app.tenant_id', true)
       AND r.plan_hash = NEW.plan_hash
  ) THEN
    RAISE EXCEPTION 'stage run pipeline scope mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pipeline_run_id IS NOT NULL AND ROW(
    NEW.workspace_id, NEW.project_id, NEW.pipeline_run_id, NEW.stage_id, NEW.stage_key,
    NEW.item_key, NEW.revision
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.project_id, OLD.pipeline_run_id, OLD.stage_id, OLD.stage_key,
    OLD.item_key, OLD.revision
  ) THEN
    RAISE EXCEPTION 'stage run identity is immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := CASE
      WHEN NEW.execution_status IN ('pending','ready','running') THEN 'running'
      WHEN NEW.execution_status = 'output_ready' THEN 'running'
      WHEN NEW.execution_status = 'completed'
           AND NEW.verification_status IN ('passed','not_applicable') THEN 'done'
      WHEN NEW.execution_status = 'interrupted' OR NEW.disposition = 'reconcile' THEN 'interrupted'
      WHEN NEW.execution_status = 'completed' THEN 'failed'
      ELSE 'failed'
    END;
  ELSIF NEW.execution_status IS DISTINCT FROM OLD.execution_status
     OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.disposition IS DISTINCT FROM OLD.disposition THEN
    NEW.status := CASE
      WHEN NEW.execution_status IN ('pending','ready','running') THEN 'running'
      WHEN NEW.execution_status = 'output_ready' THEN 'running'
      WHEN NEW.execution_status = 'completed'
           AND NEW.verification_status IN ('passed','not_applicable') THEN 'done'
      WHEN NEW.execution_status = 'interrupted' OR NEW.disposition = 'reconcile' THEN 'interrupted'
      WHEN NEW.execution_status = 'completed' THEN 'failed'
      ELSE 'failed'
    END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER production_stage_runs_control_scope
BEFORE INSERT OR UPDATE ON production_stage_runs
FOR EACH ROW EXECUTE FUNCTION guard_production_stage_control_scope();
