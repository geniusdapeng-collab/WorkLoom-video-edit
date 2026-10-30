import { PipelineControlError } from "@workloom/pipeline-control";
import type { VideoPipelineRepository } from "./pipeline-repository.js";
import { projectPipelineStatus, type PipelineStatus } from "./status.js";

export class VideoPipelineQueryService {
  constructor(private readonly repository: VideoPipelineRepository) {}

  async status(runId: string): Promise<PipelineStatus> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在或不属于当前作用域");
    return projectPipelineStatus(run);
  }
}
