-- ============================================================================
-- 0060_video_system_auto_approval.sql
-- Versioned system policy receipts for video gates. Review-capable video
-- actions never create or consume a human approval row; a policy block is a
-- durable terminal gate decision.
-- ============================================================================

ALTER TABLE production_stage_runs
  DROP CONSTRAINT IF EXISTS production_stage_runs_control_fields_check;
ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_runs_control_fields_check CHECK (
    pipeline_run_id IS NULL OR (
      stage_key IS NOT NULL AND revision IS NOT NULL AND revision >= 1
      AND execution_status IN ('pending','ready','running','output_ready','completed','failed','interrupted')
      AND verification_status IN ('not_run','pending','passed','rejected','unverified','not_applicable','stale','blocked')
      AND disposition IN ('continue','repair','reconcile','wait_human','blocked','done')
      AND contract_version IS NOT NULL
      AND plan_hash ~ '^[a-f0-9]{64}$'
      AND contract_hash ~ '^[a-f0-9]{64}$'
      AND input_manifest_hash ~ '^[a-f0-9]{64}$'
      AND stage_key = stage_id
      AND (item_key IS NULL OR length(item_key) > 0)
    )
  );

ALTER TABLE video_gate_decisions
  DROP CONSTRAINT IF EXISTS video_gate_decisions_status_check;
ALTER TABLE video_gate_decisions
  ADD CONSTRAINT video_gate_decisions_status_check CHECK (
    status IN ('passed','rejected','unverified','not_applicable','blocked')
  );

ALTER TABLE video_gate_decisions
  DROP CONSTRAINT IF EXISTS video_gate_decisions_system_auto_receipt_check;
ALTER TABLE video_gate_decisions
  ADD CONSTRAINT video_gate_decisions_system_auto_receipt_check CHECK (
    reviewer->>'kind' <> 'system_auto_approval'
    OR (
      status IN ('passed','rejected','blocked')
      AND reviewer->>'approvalId' IS NULL
      AND jsonb_typeof(reviewer->'autoApproval') = 'object'
      AND reviewer->'autoApproval'->>'schemaVersion' = 'workloom.system-auto-approval/v1'
      AND reviewer->'autoApproval'->>'authority' = 'system_auto_approval'
      AND reviewer->'autoApproval'->>'gateKey' = gate_id
      AND btrim(reviewer->'autoApproval'->>'policyId') <> ''
      AND btrim(reviewer->'autoApproval'->>'policyVersion') <> ''
      AND reviewer->'autoApproval'->>'outcome' =
        CASE status WHEN 'passed' THEN 'passed' WHEN 'rejected' THEN 'repair' ELSE 'blocked' END
      AND reviewer->'autoApproval'->>'artifactSha256' ~ '^[a-f0-9]{64}$'
      AND reviewer->'autoApproval'->>'factHash' ~ '^[a-f0-9]{64}$'
      AND reviewer->'autoApproval'->>'expectedFactHash' ~ '^[a-f0-9]{64}$'
      AND reviewer->'autoApproval'->>'evidenceDigest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(reviewer->'autoApproval'->'checks') = 'array'
      AND jsonb_array_length(reviewer->'autoApproval'->'checks') > 0
    )
  );
