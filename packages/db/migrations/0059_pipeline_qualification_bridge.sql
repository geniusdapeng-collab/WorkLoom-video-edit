-- ============================================================================
-- 0059_pipeline_qualification_bridge.sql
-- Allow production qualifications to bind either the legacy monolithic
-- preproduction row or a completed/passed control-plane stage revision.
-- ============================================================================

CREATE OR REPLACE FUNCTION guard_production_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'production qualification is append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM workspaces w
      JOIN video_projects p ON p.workspace_id = w.id
      JOIN production_stage_runs r
        ON r.workspace_id = w.id
       AND r.project_id = p.id
     WHERE w.id = NEW.workspace_id
       AND w.tenant_id = NEW.tenant_id
       AND p.id = NEW.project_id
       AND r.id = NEW.source_stage_run_id
       AND r.attempt = NEW.source_attempt
       AND r.output_sha256 = NEW.source_output_sha256
       AND (
         (
           r.pipeline_run_id IS NULL
           AND r.stage_id = 'preproduction'
           AND r.status = 'done'
         )
         OR
         (
           r.pipeline_run_id IS NOT NULL
           AND r.execution_status = 'completed'
           AND r.verification_status IN ('passed','not_applicable')
           AND r.output_manifest_hash IS NOT NULL
           AND (
             r.verification_status = 'not_applicable'
             OR EXISTS (
               SELECT 1
                 FROM video_gate_decisions d
                WHERE d.id = r.gate_decision_id
                  AND d.stage_run_id = r.id
                  AND d.pipeline_run_id = r.pipeline_run_id
                  AND d.plan_hash = r.plan_hash
                  AND d.artifact_manifest_hash = r.output_manifest_hash
                  AND d.status = 'passed'
             )
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM production_stage_runs newer
          WHERE newer.workspace_id = r.workspace_id
            AND newer.project_id = r.project_id
            AND newer.pipeline_run_id IS NOT DISTINCT FROM r.pipeline_run_id
            AND newer.stage_key IS NOT DISTINCT FROM r.stage_key
            AND COALESCE(newer.item_key, '') = COALESCE(r.item_key, '')
            AND COALESCE(newer.revision, newer.attempt) > COALESCE(r.revision, r.attempt)
       )
  ) THEN
    RAISE EXCEPTION 'production qualification source is not current';
  END IF;

  IF NEW.status = 'passed' AND NOT EXISTS (
    SELECT 1
      FROM render_scripts s
     WHERE s.id = NEW.script_id
       AND s.workspace_id = NEW.workspace_id
       AND s.project_id = NEW.project_id
       AND s.shot_id = NEW.shot_id
       AND s.version = NEW.script_version
  ) THEN
    RAISE EXCEPTION 'production qualification script scope mismatch';
  END IF;
  RETURN NEW;
END $$;
