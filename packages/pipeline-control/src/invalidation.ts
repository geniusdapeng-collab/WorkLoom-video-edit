import { PipelineControlError } from "./artifact.js";
import { transitionStage } from "./state-machine.js";
import type { PipelineRunState } from "./types.js";

export interface PipelineEdge {
  from: string;
  to: string;
}

export function descendantsOf(edges: PipelineEdge[], nodeKey: string): string[] {
  if (!edges.some((edge) => edge.from === nodeKey || edge.to === nodeKey)) {
    throw new PipelineControlError("PIPELINE_NODE_UNKNOWN", `未知节点 ${nodeKey}`);
  }
  const children = new Map<string, string[]>();
  for (const edge of edges) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  const seen = new Set<string>();
  const queue = [...(children.get(nodeKey) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(children.get(current) ?? []));
  }
  return [...seen].sort();
}

export function invalidateDescendants(
  run: PipelineRunState,
  edges: PipelineEdge[],
  fromNode: string,
  reason: string,
): string[] {
  const invalidated: string[] = [];
  for (const id of descendantsOf(edges, fromNode)) {
    const stage = run.stages[id];
    if (!stage || !stage.artifact) continue;
    run.stages[id] = transitionStage(stage, { type: "stale", reason });
    invalidated.push(id);
  }
  return invalidated;
}
