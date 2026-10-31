-- ============================================================================
-- 0057_film_pipeline_link.sql
-- Link the existing registered film worker ledger to unified pipeline stages.
-- ============================================================================

ALTER TABLE film_jobs
  ADD COLUMN pipeline_run_id TEXT REFERENCES video_pipeline_runs(id),
  ADD COLUMN stage_run_id TEXT REFERENCES production_stage_runs(id);

ALTER TABLE film_jobs
  ADD CONSTRAINT film_jobs_pipeline_link_check CHECK (
    (pipeline_run_id IS NULL AND stage_run_id IS NULL)
    OR (pipeline_run_id IS NOT NULL AND stage_run_id IS NOT NULL)
  );

CREATE INDEX idx_film_jobs_pipeline
  ON film_jobs (pipeline_run_id, stage_run_id);

CREATE OR REPLACE FUNCTION guard_film_job_pipeline_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.pipeline_run_id, NEW.stage_run_id)
     IS DISTINCT FROM ROW(OLD.pipeline_run_id, OLD.stage_run_id) THEN
    RAISE EXCEPTION 'film job pipeline link is immutable';
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
    RAISE EXCEPTION 'film job pipeline link scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER film_jobs_pipeline_scope_guard
BEFORE INSERT OR UPDATE ON film_jobs
FOR EACH ROW EXECUTE FUNCTION guard_film_job_pipeline_scope();
