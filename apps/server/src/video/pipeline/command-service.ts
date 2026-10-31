import {
  VideoPipelineRepository,
  type CommandEnvelopeInput,
  type CreatePipelineRunInput,
  type PipelineRunView,
} from "./pipeline-repository.js";
import type {
  ArtifactEnvelope,
  ArtifactRef,
  GateDecision,
  GateFinding,
} from "@workloom/pipeline-control";
import type { CompiledVideoPipelinePlan } from "@hyperreality/video-pipeline";

export class VideoPipelineCommandService {
  constructor(private readonly repository: VideoPipelineRepository) {}

  start(input: CreatePipelineRunInput): Promise<PipelineRunView> {
    return this.repository.createRun(input);
  }

  claimStage(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    owner: string;
    expectedStageRevision: number;
    leaseMs: number;
  }): Promise<PipelineRunView> {
    return this.repository.claimStage(input);
  }

  commitArtifact(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    artifact: ArtifactEnvelope;
    manifestArtifacts: ArtifactRef[];
    expectedStageRevision: number;
  }): Promise<{ run: PipelineRunView; artifactManifestHash: string }> {
    return this.repository.commitArtifact(input);
  }

  decideGate(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    gateStageKey: string;
    decision: GateDecision;
    findings: GateFinding[];
    manifestArtifacts: ArtifactRef[];
    expectedStageRevision: number;
  }): Promise<PipelineRunView> {
    return this.repository.recordGateDecision(input);
  }

  refreshFrontier(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
  }): Promise<PipelineRunView> {
    return this.repository.refreshFrontier(input);
  }

  markInterrupted(input: CommandEnvelopeInput & {
    runId: string;
    reason: string;
    owner: string;
  }): Promise<PipelineRunView> {
    return this.repository.markInterrupted(input);
  }
}
