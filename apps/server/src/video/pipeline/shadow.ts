import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  artifactManifestHash,
  sha256Json,
  sha256Text,
  type ArtifactEnvelope,
  type GateDecision,
  type GateFinding,
} from "@workloom/pipeline-control";
import {
  compileVideoPipelineDocument,
  type CompiledVideoPipelinePlan,
} from "@hyperreality/video-pipeline";
import { archiveWorkDir } from "../archive-host.js";
import { VideoPipelineCommandService } from "./command-service.js";
import { VideoPipelineRepository } from "./pipeline-repository.js";

export type PipelineControlMode = "off" | "shadow" | "enforce";

export function pipelineControlMode(env: NodeJS.ProcessEnv = process.env): PipelineControlMode {
  const value = (env.PIPELINE_CONTROL_PLANE ?? "off").trim().toLowerCase();
  return value === "shadow" || value === "enforce" ? value : "off";
}

export function compileLegacyShadowPlan(): CompiledVideoPipelinePlan {
  return compileVideoPipelineDocument({
    quest: "legacy-shadow",
    name: "legacy preproduction shadow observation",
    version: "1",
    steps: [
      {
        step_key: "legacy-preproduction",
        name: "Legacy preproduction",
        owner: "video-studio",
        inputs: ["shadow_intent"],
        outputs: ["preproduction_observation"],
      },
      {
        step_key: "legacy-gates",
        name: "Legacy gate observations",
        owner: "video-studio",
        gate: "G4",
        inputs: ["preproduction_observation"],
        outputs: ["preproduction_observation"],
        depends_on: ["legacy-preproduction"],
      },
    ],
  }, { knownPipelines: ["legacy-shadow"] });
}

export interface ShadowFinalizeInput {
  success: boolean;
  pipelineKind: "marketing" | "narrative";
  intent: string;
  observedGates: Array<Record<string, unknown>>;
  expectedPlan: CompiledVideoPipelinePlan;
}

function digestId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256Json(value).slice(0, 24)}`;
}

export class PipelineShadowObserver {
  private readonly gateOrder: string[] = [];
  private finalized = false;

  constructor(
    private readonly scope: { tenantId: string; workspaceId: string },
    private readonly projectId: string,
    private readonly runId: string,
  ) {}

  observeGate(gate: string | null | undefined): void {
    if (gate) this.gateOrder.push(gate);
  }

  private async initialize(input: ShadowFinalizeInput): Promise<{
    plan: CompiledVideoPipelinePlan;
    commands: VideoPipelineCommandService;
    run: Awaited<ReturnType<VideoPipelineCommandService["start"]>>;
  }> {
    const plan = compileLegacyShadowPlan();
    const repository = new VideoPipelineRepository(this.scope);
    const commands = new VideoPipelineCommandService(repository);
    const intentHash = sha256Json({ intent: input.intent, projectId: this.projectId, observedPlan: input.expectedPlan.planHash });
    const run = await commands.start({
      projectId: this.projectId,
      pipelineKind: input.pipelineKind,
      intentContractId: `legacy:${this.runId}`,
      intentHash,
      createdBy: "video-studio-shadow",
      plan,
      commandId: digestId("start", { runId: this.runId, intentHash }),
      idempotencyKey: `shadow-start:${this.runId}`,
      actor: { id: "video-studio-shadow", type: "system" },
    });
    return { plan, commands, run };
  }

  async finalize(input: ShadowFinalizeInput): Promise<string | null> {
    if (this.finalized) return null;
    this.finalized = true;
    const { plan, commands, run } = await this.initialize(input);
    const sourceStage = run.stages.find((stage) => stage.key === "legacy-preproduction");
    const gateStage = run.stages.find((stage) => stage.key === "legacy-gates");
    if (!sourceStage || !gateStage) throw new Error("SHADOW_PLAN_NODE_MISSING");

    const claimed = await commands.claimStage({
      plan,
      runId: run.runId,
      stageKey: "legacy-preproduction",
      owner: "video-studio-shadow",
      commandId: digestId("claim", { runId: run.runId, revision: run.revision }),
      idempotencyKey: `shadow-claim:${run.runId}`,
      expectedRunRevision: run.revision,
      expectedStageRevision: sourceStage.revision,
      leaseMs: 60_000,
      actor: { id: "video-studio-shadow", type: "system" },
    });

    const artifactDir = path.join(archiveWorkDir(), "archive", this.scope.workspaceId, this.projectId, "artifacts", "shadow");
    mkdirSync(artifactDir, { recursive: true });
    const snapshot = {
      schemaVersion: "workloom.legacy-preproduction-shadow/v1",
      sourceRunId: this.runId,
      projectId: this.projectId,
      pipelineKind: input.pipelineKind,
      success: input.success,
      expectedPlanHash: input.expectedPlan.planHash,
      expectedNodeOrder: input.expectedPlan.nodes.map((node) => node.key),
      observedGateOrder: this.gateOrder,
      observedGates: input.observedGates,
      recordedAt: new Date().toISOString(),
    };
    const sourceText = `${JSON.stringify(snapshot, null, 2)}\n`;
    const storageRef = path.posix.join("artifacts", "shadow", `${run.runId}.json`);
    writeFileSync(path.join(artifactDir, `${run.runId}.json`), sourceText, "utf8");
    const artifact: ArtifactEnvelope = {
      schemaVersion: "workloom.video-artifact/v1",
      id: digestId("A", { runId: run.runId, sha256: sha256Text(sourceText) }),
      logicalId: "preproduction-observation",
      role: "preproduction_observation",
      revision: 1,
      schema: "workloom.legacy-preproduction-shadow/v1",
      storageRef,
      sha256: sha256Text(sourceText),
      bytes: Buffer.byteLength(sourceText),
      mediaType: "application/json",
      creator: { kind: "deterministic", id: "video-studio-shadow", version: "1" },
      parents: [],
      metadata: { sourceRunId: this.runId, expectedPlanHash: input.expectedPlan.planHash },
    };
    const committed = await commands.commitArtifact({
      plan,
      runId: run.runId,
      stageKey: "legacy-preproduction",
      artifact,
      manifestArtifacts: [artifact],
      commandId: digestId("commit", { runId: run.runId, sha256: artifact.sha256 }),
      idempotencyKey: `shadow-commit:${run.runId}`,
      expectedRunRevision: claimed.revision,
      expectedStageRevision: sourceStage.revision,
      actor: { id: "video-studio-shadow", type: "system" },
    });
    const gateReady = await commands.refreshFrontier({
      plan,
      runId: run.runId,
      commandId: digestId("refresh", { runId: run.runId, revision: committed.run.revision }),
      idempotencyKey: `shadow-refresh:${run.runId}`,
      expectedRunRevision: committed.run.revision,
      actor: { id: "video-studio-shadow", type: "system" },
    });

    const rejectedGates = input.observedGates.filter((gate) => gate.approved === false);
    const findings: GateFinding[] = rejectedGates.map((gate, index) => ({
      code: `LEGACY_GATE_REJECTED_${index + 1}`,
      severity: "P1",
      targetType: "stage",
      targetId: typeof gate.gate === "string" ? gate.gate : null,
      fieldPath: null,
      expected: true,
      actual: gate.reason ?? false,
      evidenceRefs: [`shadow:${run.runId}`],
      repairClass: "semantic",
      blocking: true,
    }));
    const status = findings.length > 0 ? "rejected" : "passed";
    const decision: GateDecision = {
      id: digestId("GD", { runId: run.runId, artifact: artifact.sha256, status }),
      runId: run.runId,
      stageRunId: sourceStage.stageRunId,
      gateId: "G4",
      artifactManifestHash: artifactManifestHash([artifact]),
      planHash: plan.planHash,
      checkSetVersion: "g4/v1",
      rubricVersion: "g4/v1",
      status,
      reviewer: { kind: "host_rule", id: "legacy-shadow-observer" },
      findings,
      evidenceRefs: [`shadow:${run.runId}`],
      supersedesDecisionId: null,
      createdAt: new Date().toISOString(),
    };
    const decided = await commands.decideGate({
      plan,
      runId: run.runId,
      gateStageKey: "legacy-gates",
      decision,
      findings,
      manifestArtifacts: [artifact],
      commandId: digestId("gate", { decision: decision.id }),
      idempotencyKey: `shadow-gate:${run.runId}`,
      expectedRunRevision: gateReady.revision,
      expectedStageRevision: gateStage.revision,
      actor: { id: "legacy-shadow-observer", type: "system" },
    });
    if (status === "passed") {
      await commands.refreshFrontier({
        plan,
        runId: run.runId,
        commandId: digestId("complete", { runId: run.runId, revision: decided.revision }),
        idempotencyKey: `shadow-complete:${run.runId}`,
        expectedRunRevision: decided.revision,
        actor: { id: "video-studio-shadow", type: "system" },
      });
    }
    return run.runId;
  }
}
