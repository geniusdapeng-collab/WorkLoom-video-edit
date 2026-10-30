-- ============================================================================
-- 0056_video_pipeline_artifacts_gates_repairs.sql
-- Immutable artifacts, gate findings/decisions, and bounded repair plans.
-- ============================================================================

CREATE TABLE video_artifacts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  project_id         TEXT NOT NULL REFERENCES video_projects(id),
  pipeline_run_id    TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  stage_run_id       TEXT NOT NULL REFERENCES production_stage_runs(id),
  logical_id         TEXT NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision > 0),
  role               TEXT NOT NULL,
  schema_version     TEXT NOT NULL,
  storage_ref        TEXT NOT NULL,
  sha256             TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes              BIGINT NOT NULL CHECK (bytes >= 0),
  media_type         TEXT NOT NULL,
  creator            JSONB NOT NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, logical_id, revision),
  UNIQUE (id, sha256)
);

CREATE INDEX idx_video_artifacts_run ON video_artifacts (pipeline_run_id, logical_id, revision DESC);
CREATE INDEX idx_video_artifacts_stage ON video_artifacts (stage_run_id);

CREATE TABLE video_artifact_edges (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  pipeline_run_id    TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  parent_artifact_id TEXT NOT NULL,
  parent_sha256      TEXT NOT NULL CHECK (parent_sha256 ~ '^[a-f0-9]{64}$'),
  child_artifact_id  TEXT NOT NULL,
  child_sha256       TEXT NOT NULL CHECK (child_sha256 ~ '^[a-f0-9]{64}$'),
  input_role         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_artifact_id, child_artifact_id, input_role),
  FOREIGN KEY (parent_artifact_id, parent_sha256) REFERENCES video_artifacts(id, sha256),
  FOREIGN KEY (child_artifact_id, child_sha256) REFERENCES video_artifacts(id, sha256)
);

CREATE INDEX idx_video_artifact_edges_child ON video_artifact_edges (child_artifact_id);

CREATE TABLE video_gate_decisions (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id),
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
  project_id              TEXT NOT NULL REFERENCES video_projects(id),
  pipeline_run_id         TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  stage_run_id            TEXT NOT NULL REFERENCES production_stage_runs(id),
  gate_id                 TEXT NOT NULL,
  artifact_manifest_hash  TEXT NOT NULL CHECK (artifact_manifest_hash ~ '^[a-f0-9]{64}$'),
  plan_hash               TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  check_set_version       TEXT NOT NULL,
  rubric_version          TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('passed','rejected','unverified','not_applicable')),
  reviewer                JSONB NOT NULL,
  evidence_refs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  supersedes_decision_id  TEXT REFERENCES video_gate_decisions(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stage_run_id, gate_id, artifact_manifest_hash, check_set_version, rubric_version),
  CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX idx_video_gate_decisions_stage ON video_gate_decisions (stage_run_id, created_at DESC);
CREATE INDEX idx_video_gate_decisions_run ON video_gate_decisions (pipeline_run_id, status);

CREATE TABLE video_gate_findings (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  decision_id       TEXT NOT NULL REFERENCES video_gate_decisions(id),
  code              TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','advisory')),
  target_type       TEXT NOT NULL CHECK (target_type IN ('run','stage','field','item','artifact')),
  target_id         TEXT,
  field_path        TEXT,
  expected_value    JSONB,
  actual_value      JSONB,
  evidence_refs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  repair_class      TEXT NOT NULL CHECK (repair_class IN ('schema','deterministic','semantic','human_input','no_repair')),
  blocking          BOOLEAN NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_video_gate_findings_blocking ON video_gate_findings (decision_id) WHERE blocking;
CREATE UNIQUE INDEX video_gate_findings_code_uq
  ON video_gate_findings (
    decision_id, code, target_type, COALESCE(target_id, ''), COALESCE(field_path, '')
  );

CREATE TABLE video_repair_plans (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  pipeline_run_id       TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  root_decision_id      TEXT NOT NULL REFERENCES video_gate_decisions(id),
  target_stage_run_id   TEXT NOT NULL REFERENCES production_stage_runs(id),
  target_revision       INTEGER NOT NULL CHECK (target_revision > 0),
  playbook_id           TEXT NOT NULL,
  playbook_version      TEXT NOT NULL,
  plan_hash             TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  allowed_changes       JSONB NOT NULL,
  forbidden_changes     JSONB NOT NULL,
  invalidation_closure  JSONB NOT NULL,
  budget_envelope       JSONB NOT NULL,
  requires_approval     BOOLEAN NOT NULL,
  status                TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','approved','running','applied','rejected','stalled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(allowed_changes) = 'array'),
  CHECK (jsonb_typeof(forbidden_changes) = 'array'),
  CHECK (jsonb_typeof(invalidation_closure) = 'array')
);

CREATE INDEX idx_video_repair_plans_run ON video_repair_plans (pipeline_run_id, created_at DESC);

CREATE TABLE video_repair_attempts (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  repair_plan_id    TEXT NOT NULL REFERENCES video_repair_plans(id),
  attempt           INTEGER NOT NULL CHECK (attempt > 0),
  input_manifest_hash TEXT NOT NULL CHECK (input_manifest_hash ~ '^[a-f0-9]{64}$'),
  output_artifact_id TEXT REFERENCES video_artifacts(id),
  status            TEXT NOT NULL CHECK (status IN ('running','passed','rejected','failed','unverified')),
  error_class       TEXT,
  findings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  UNIQUE (repair_plan_id, attempt)
);

CREATE OR REPLACE FUNCTION reject_video_control_append_only_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER video_artifacts_append_only
BEFORE UPDATE OR DELETE ON video_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_video_control_append_only_mutation();

CREATE TRIGGER video_artifact_edges_append_only
BEFORE UPDATE OR DELETE ON video_artifact_edges
FOR EACH ROW EXECUTE FUNCTION reject_video_control_append_only_mutation();

CREATE TRIGGER video_gate_decisions_append_only
BEFORE UPDATE OR DELETE ON video_gate_decisions
FOR EACH ROW EXECUTE FUNCTION reject_video_control_append_only_mutation();

CREATE TRIGGER video_gate_findings_append_only
BEFORE UPDATE OR DELETE ON video_gate_findings
FOR EACH ROW EXECUTE FUNCTION reject_video_control_append_only_mutation();

CREATE OR REPLACE FUNCTION guard_video_repair_attempt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'video_repair_attempts is append-only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'running' AND NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'running video repair attempt cannot have finished_at';
    END IF;
    IF NEW.status <> 'running' AND NEW.finished_at IS NULL THEN
      RAISE EXCEPTION 'terminal video repair attempt requires finished_at';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.repair_plan_id, NEW.attempt,
    NEW.input_manifest_hash, NEW.started_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.repair_plan_id, OLD.attempt,
    OLD.input_manifest_hash, OLD.started_at
  ) THEN
    RAISE EXCEPTION 'video repair attempt identity is immutable';
  END IF;
  IF OLD.status <> 'running' THEN
    IF ROW(NEW.status, NEW.output_artifact_id, NEW.error_class, NEW.findings, NEW.finished_at)
       IS DISTINCT FROM ROW(OLD.status, OLD.output_artifact_id, OLD.error_class, OLD.findings, OLD.finished_at) THEN
      RAISE EXCEPTION 'video repair attempt terminal receipt is immutable';
    END IF;
  ELSIF NEW.status = 'running' AND NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'running video repair attempt cannot have finished_at';
  ELSIF NEW.status <> 'running' AND NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'terminal video repair attempt requires finished_at';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_repair_attempts_guard
BEFORE UPDATE OR DELETE ON video_repair_attempts
FOR EACH ROW EXECUTE FUNCTION guard_video_repair_attempt();

CREATE OR REPLACE FUNCTION guard_video_repair_plan()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN;
BEGIN
  IF ROW(
    NEW.tenant_id, NEW.workspace_id, NEW.pipeline_run_id, NEW.root_decision_id,
    NEW.target_stage_run_id, NEW.target_revision, NEW.playbook_id, NEW.playbook_version,
    NEW.plan_hash, NEW.allowed_changes, NEW.forbidden_changes, NEW.invalidation_closure,
    NEW.budget_envelope, NEW.requires_approval
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.workspace_id, OLD.pipeline_run_id, OLD.root_decision_id,
    OLD.target_stage_run_id, OLD.target_revision, OLD.playbook_id, OLD.playbook_version,
    OLD.plan_hash, OLD.allowed_changes, OLD.forbidden_changes, OLD.invalidation_closure,
    OLD.budget_envelope, OLD.requires_approval
  ) THEN
    RAISE EXCEPTION 'video repair plan definition is immutable';
  END IF;
  allowed := CASE OLD.status
    WHEN 'proposed' THEN NEW.status IN ('approved','rejected','stalled')
    WHEN 'approved' THEN NEW.status IN ('running','rejected','stalled')
    WHEN 'running' THEN NEW.status IN ('applied','rejected','stalled')
    WHEN 'stalled' THEN NEW.status IN ('approved','rejected')
    ELSE FALSE
  END;
  IF NEW.status <> OLD.status AND NOT allowed THEN
    RAISE EXCEPTION 'video repair plan transition % -> % is invalid', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER video_repair_plans_guard
BEFORE UPDATE ON video_repair_plans
FOR EACH ROW EXECUTE FUNCTION guard_video_repair_plan();

CREATE OR REPLACE FUNCTION guard_video_artifact_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM video_pipeline_runs r
      JOIN production_stage_runs s ON s.id = NEW.stage_run_id
     WHERE r.id = NEW.pipeline_run_id
       AND r.tenant_id = NEW.tenant_id
       AND r.workspace_id = NEW.workspace_id
       AND r.project_id = NEW.project_id
       AND s.pipeline_run_id = NEW.pipeline_run_id
       AND s.workspace_id = NEW.workspace_id
       AND s.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'video artifact run/stage scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_artifacts_scope_guard
BEFORE INSERT ON video_artifacts
FOR EACH ROW EXECUTE FUNCTION guard_video_artifact_scope();

CREATE OR REPLACE FUNCTION guard_video_artifact_edge_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM video_artifacts parent
      JOIN video_artifacts child ON child.id = NEW.child_artifact_id
     WHERE parent.id = NEW.parent_artifact_id
       AND parent.sha256 = NEW.parent_sha256
       AND child.sha256 = NEW.child_sha256
       AND parent.pipeline_run_id = NEW.pipeline_run_id
       AND child.pipeline_run_id = NEW.pipeline_run_id
       AND parent.tenant_id = NEW.tenant_id
       AND child.tenant_id = NEW.tenant_id
       AND parent.workspace_id = NEW.workspace_id
       AND child.workspace_id = NEW.workspace_id
       AND parent.project_id = child.project_id
  ) THEN
    RAISE EXCEPTION 'video artifact edge scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_artifact_edges_scope_guard
BEFORE INSERT ON video_artifact_edges
FOR EACH ROW EXECUTE FUNCTION guard_video_artifact_edge_scope();

CREATE OR REPLACE FUNCTION guard_video_gate_decision_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM video_pipeline_runs r
      JOIN production_stage_runs s ON s.id = NEW.stage_run_id
     WHERE r.id = NEW.pipeline_run_id
       AND r.tenant_id = NEW.tenant_id
       AND r.workspace_id = NEW.workspace_id
       AND r.project_id = NEW.project_id
       AND r.plan_hash = NEW.plan_hash
       AND s.pipeline_run_id = NEW.pipeline_run_id
       AND s.workspace_id = NEW.workspace_id
       AND s.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'video gate decision scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_gate_decisions_scope_guard
BEFORE INSERT ON video_gate_decisions
FOR EACH ROW EXECUTE FUNCTION guard_video_gate_decision_scope();

CREATE OR REPLACE FUNCTION guard_video_gate_finding_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM video_gate_decisions d
     WHERE d.id = NEW.decision_id
       AND d.tenant_id = NEW.tenant_id
       AND d.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video gate finding decision scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_gate_findings_scope_guard
BEFORE INSERT ON video_gate_findings
FOR EACH ROW EXECUTE FUNCTION guard_video_gate_finding_scope();

CREATE OR REPLACE FUNCTION guard_video_repair_plan_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM video_gate_decisions d
      JOIN production_stage_runs target ON target.id = NEW.target_stage_run_id
     WHERE d.id = NEW.root_decision_id
       AND d.pipeline_run_id = NEW.pipeline_run_id
       AND d.tenant_id = NEW.tenant_id
       AND d.workspace_id = NEW.workspace_id
       AND target.pipeline_run_id = NEW.pipeline_run_id
       AND target.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video repair plan scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_repair_plans_scope_guard
BEFORE INSERT ON video_repair_plans
FOR EACH ROW EXECUTE FUNCTION guard_video_repair_plan_scope();

CREATE OR REPLACE FUNCTION guard_video_repair_attempt_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM video_repair_plans p
     WHERE p.id = NEW.repair_plan_id
       AND p.tenant_id = NEW.tenant_id
       AND p.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video repair attempt scope mismatch';
  END IF;
  IF NEW.output_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM video_artifacts a
      JOIN video_repair_plans p ON p.id = NEW.repair_plan_id
     WHERE a.id = NEW.output_artifact_id
       AND a.tenant_id = NEW.tenant_id
       AND a.workspace_id = NEW.workspace_id
       AND a.pipeline_run_id = p.pipeline_run_id
  ) THEN
    RAISE EXCEPTION 'video repair output artifact scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_repair_attempts_scope_guard
BEFORE INSERT OR UPDATE ON video_repair_attempts
FOR EACH ROW EXECUTE FUNCTION guard_video_repair_attempt_scope();

ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_output_artifact_fk
  FOREIGN KEY (output_artifact_id) REFERENCES video_artifacts(id);

ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_gate_decision_fk
  FOREIGN KEY (gate_decision_id) REFERENCES video_gate_decisions(id);

ALTER TABLE video_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY video_artifacts_scope ON video_artifacts
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

ALTER TABLE video_artifact_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_artifact_edges FORCE ROW LEVEL SECURITY;
CREATE POLICY video_artifact_edges_scope ON video_artifact_edges
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

ALTER TABLE video_gate_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_gate_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY video_gate_decisions_scope ON video_gate_decisions
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

ALTER TABLE video_gate_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_gate_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY video_gate_findings_scope ON video_gate_findings
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

ALTER TABLE video_repair_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_repair_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY video_repair_plans_scope ON video_repair_plans
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

ALTER TABLE video_repair_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_repair_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY video_repair_attempts_scope ON video_repair_attempts
  USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));

GRANT SELECT, INSERT ON video_artifacts, video_artifact_edges, video_gate_decisions, video_gate_findings, video_repair_attempts TO workloom_app, workloom_gateway;
GRANT SELECT, INSERT, UPDATE ON video_repair_plans TO workloom_app, workloom_gateway;
