import { readFileSync } from "node:fs";
import { sha256Json, sha256Text } from "@workloom/pipeline-control";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_VIDEO_PIPELINES,
  createVideoAdapterRegistry,
  createVideoGateRegistry,
  type VideoAdapterRegistration,
  type VideoGateRegistration,
} from "./adapters.js";

type Raw = Record<string, unknown>;

export type SideEffect = "none" | "model" | "local" | "provider" | "public";
export type CostClass = "none" | "model" | "media" | "provider" | "public";

export interface ArtifactPort {
  role: string;
  schema: string;
  required: boolean;
}

export interface RepairPolicy {
  modes: Array<"local_patch" | "item_regenerate" | "stage_regenerate" | "human_input" | "no_repair">;
  ownerStage: string | null;
  maxAttempts: number;
  forbiddenChanges: string[];
}

export interface CompiledStageNode {
  key: string;
  kind: "stage";
  name: string;
  owner: string;
  adapterId: string;
  contractVersion: string;
  inputs: ArtifactPort[];
  outputs: ArtifactPort[];
  dependsOn: string[];
  invalidates: string[];
  sideEffect: SideEffect;
  costClass: CostClass;
  repair: RepairPolicy;
  budgetMs: number | null;
}

export interface CompiledGateNode {
  key: string;
  kind: "gate";
  name: string;
  owner: string;
  gateId: string;
  checkSetVersion: string;
  rubricVersion: string;
  authority: VideoGateRegistration["authority"];
  inputs: ArtifactPort[];
  outputs: ArtifactPort[];
  dependsOn: string[];
  invalidates: string[];
  sideEffect: "none";
  costClass: "none";
  repair: RepairPolicy;
  budgetMs: null;
}

export interface CompiledCallNode {
  key: string;
  kind: "call";
  name: string;
  owner: string;
  pipelineKey: string;
  inputs: ArtifactPort[];
  outputs: ArtifactPort[];
  dependsOn: string[];
  invalidates: string[];
  sideEffect: SideEffect;
  costClass: CostClass;
  repair: RepairPolicy;
  budgetMs: number | null;
}

export type CompiledNode = CompiledStageNode | CompiledGateNode | CompiledCallNode;

export interface PlanEdge {
  from: string;
  to: string;
  artifactRoles: string[];
}

export interface CompiledVideoPipelinePlan {
  schemaVersion: "workloom.video-pipeline-plan/v2";
  key: string;
  name: string;
  version: string;
  sourceSha256: string;
  planHash: string;
  nodes: CompiledNode[];
  edges: PlanEdge[];
  roots: string[];
}

export class VideoPipelinePlanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VideoPipelinePlanError";
  }
}

function fail(code: string, message: string): never {
  throw new VideoPipelinePlanError(code, message);
}

function record(value: unknown, label: string): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PIPELINE_PLAN_INVALID", `${label} 必须是对象`);
  return value as Raw;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail("PIPELINE_PLAN_INVALID", `${label} 必须是非空文本`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, label);
}

function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail("PIPELINE_PLAN_INVALID", `${label} 必须${allowEmpty ? "是" : "是非空"}字符串数组`);
  }
  const result = value.map((item) => item.trim());
  if (new Set(result).size !== result.length) fail("PIPELINE_PLAN_INVALID", `${label} 不能重复`);
  return result;
}

function schemaRole(role: string): string {
  const normalized = role.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `workloom.video.${normalized}/v1`;
}

function ports(value: unknown, label: string, allowEmpty = false): ArtifactPort[] {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail("PIPELINE_PLAN_INVALID", `${label} 必须是${allowEmpty ? "可空" : "非空"}数组`);
  }
  const result = value.map((item, index): ArtifactPort => {
    if (typeof item === "string") {
      const role = text(item, `${label}/${index}`);
      return { role, schema: schemaRole(role), required: true };
    }
    const port = record(item, `${label}/${index}`);
    const role = text(port.role, `${label}/${index}.role`);
    return {
      role,
      schema: optionalText(port.schema, `${label}/${index}.schema`) ?? schemaRole(role),
      required: port.required === undefined ? true : port.required === true,
    };
  });
  if (new Set(result.map((port) => port.role)).size !== result.length) {
    fail("PIPELINE_PLAN_INVALID", `${label} artifact role 不能重复`);
  }
  return result;
}

function positiveInt(value: unknown, label: string, fallback: number | null): number | null {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail("PIPELINE_PLAN_INVALID", `${label} 必须是正整数`);
  return n;
}

function sideEffectForKey(key: string): SideEffect {
  if (/^g\d|^g-/.test(key)) return "none";
  if (/^(render|material-generate|videos|plates|portrait|cover|voice)$/.test(key)) return "provider";
  if (/^(publish|watch)$/.test(key)) return "public";
  if (/^(post|color|subtitle|bgm|sfx|mux|master|deliver|revise|compose|archive)$/.test(key)) return "local";
  return "model";
}

function costClassFor(key: string, sideEffect: SideEffect): CostClass {
  if (sideEffect === "none") return "none";
  if (sideEffect === "public") return "public";
  if (sideEffect === "provider") return "provider";
  if (sideEffect === "local") return "media";
  if (key.startsWith("intel-") || key === "truth-check") return "none";
  return "model";
}

function repairFor(step: Raw, key: string, kind: CompiledNode["kind"]): RepairPolicy {
  if (kind === "gate") {
    return { modes: ["local_patch", "item_regenerate", "human_input"], ownerStage: null, maxAttempts: 0, forbiddenChanges: ["gate_threshold"] };
  }
  const maxAttempts = positiveInt(step.max_repair_attempts, `${key}.max_repair_attempts`, 0) ?? 0;
  const ownerStage = optionalText(step.repair_owner, `${key}.repair_owner`);
  const modes: RepairPolicy["modes"] = maxAttempts > 0
    ? ["local_patch", "item_regenerate", "human_input"]
    : ["human_input", "no_repair"];
  return {
    modes,
    ownerStage,
    maxAttempts,
    forbiddenChanges: ["approved_upstream_artifacts", "gate_threshold", "frozen_intent"],
  };
}

function topoSort(nodes: CompiledNode[]): CompiledNode[] {
  const byId = new Map(nodes.map((node) => [node.key, node]));
  const indegree = new Map(nodes.map((node) => [node.key, node.dependsOn.length]));
  const children = new Map<string, string[]>();
  for (const node of nodes) for (const dependency of node.dependsOn) {
    children.set(dependency, [...(children.get(dependency) ?? []), node.key]);
  }
  const queue = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.key);
  const ordered: CompiledNode[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    ordered.push(byId.get(key)!);
    for (const child of children.get(key) ?? []) {
      const next = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (ordered.length !== nodes.length) fail("PIPELINE_PLAN_CYCLE", "pipeline dependency graph 存在环");
  return ordered;
}

function ancestorsOf(nodes: CompiledNode[]): Map<string, string[]> {
  const byId = new Map(nodes.map((node) => [node.key, node]));
  const result = new Map<string, string[]>();
  const visit = (key: string, trail = new Set<string>()): string[] => {
    if (result.has(key)) return result.get(key)!;
    if (trail.has(key)) fail("PIPELINE_PLAN_CYCLE", "pipeline dependency graph 存在环");
    const node = byId.get(key);
    if (!node) fail("PIPELINE_PLAN_DEPENDENCY_INVALID", `未知节点 ${key}`);
    const nextTrail = new Set(trail).add(key);
    const values = new Set<string>();
    for (const dependency of node.dependsOn) {
      values.add(dependency);
      for (const ancestor of visit(dependency, nextTrail)) values.add(ancestor);
    }
    const normalized = [...values];
    result.set(key, normalized);
    return normalized;
  };
  for (const node of nodes) visit(node.key);
  return result;
}

function validateContracts(nodes: CompiledNode[], options: {
  adapterRegistry: Record<string, VideoAdapterRegistration>;
  gateRegistry: Record<string, VideoGateRegistration>;
  knownPipelines: ReadonlySet<string>;
}): void {
  const ancestors = ancestorsOf(nodes);
  const byId = new Map(nodes.map((node) => [node.key, node]));
  const roots = new Set(nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.key));
  const externalRoles = new Set(
    nodes.filter((node) => roots.has(node.key)).flatMap((node) => node.inputs.map((port) => port.role)),
  );

  for (const node of nodes) {
    if (node.kind === "stage" && !options.adapterRegistry[node.adapterId]) {
      fail("PIPELINE_PLAN_ADAPTER_UNKNOWN", `${node.key} 使用未知 adapter ${node.adapterId}`);
    }
    if (node.kind === "gate" && !options.gateRegistry[node.gateId]) {
      fail("PIPELINE_PLAN_GATE_UNKNOWN", `${node.key} 使用未知 gate ${node.gateId}`);
    }
    if (node.kind === "call" && !options.knownPipelines.has(node.pipelineKey)) {
      fail("PIPELINE_PLAN_CALL_UNKNOWN", `${node.key} 调用未知 pipeline ${node.pipelineKey}`);
    }
    for (const invalidated of node.invalidates) {
      if (invalidated === node.key || !byId.has(invalidated)) {
        fail("PIPELINE_PLAN_INVALIDATION_INVALID", `${node.key} 失效目标未知或自身 ${invalidated}`);
      }
    }
    if (roots.has(node.key)) continue;
    const produced = new Map<string, string>();
    for (const ancestor of ancestors.get(node.key) ?? []) {
      for (const output of byId.get(ancestor)?.outputs ?? []) produced.set(output.role, output.schema);
    }
    for (const input of node.inputs) {
      if (externalRoles.has(input.role)) continue;
      const schema = produced.get(input.role);
      if (!schema) fail("PIPELINE_PLAN_PRODUCER_MISSING", `${node.key} 的输入 ${input.role} 没有上游 producer`);
      if (input.required && schema !== input.schema) {
        fail(
          "PIPELINE_PLAN_SCHEMA_MISMATCH",
          `${node.key}.${input.role} 期望 ${input.schema}，上游生产 ${schema}`,
        );
      }
    }
  }
}

export function compileVideoPipelineDocument(
  documentValue: unknown,
  options: {
    adapterRegistry?: Record<string, VideoAdapterRegistration>;
    gateRegistry?: Record<string, VideoGateRegistration>;
    knownPipelines?: readonly string[];
    sourceText?: string;
    expectedQuest?: string;
  } = {},
): CompiledVideoPipelinePlan {
  const document = record(documentValue, "YAML 根");
  const key = text(document.quest, "quest");
  if (options.expectedQuest && key !== options.expectedQuest) fail("PIPELINE_PLAN_QUEST_MISMATCH", `quest 必须为 ${options.expectedQuest}`);
  const name = text(document.name ?? key, "name");
  const version = text(document.version, "version");
  if (!Array.isArray(document.steps) || document.steps.length === 0) fail("PIPELINE_PLAN_INVALID", "steps 不能为空");
  const adapterRegistry = options.adapterRegistry ?? createVideoAdapterRegistry();
  const gateRegistry = options.gateRegistry ?? createVideoGateRegistry();
  const knownPipelines = new Set(options.knownPipelines ?? DEFAULT_VIDEO_PIPELINES);

  const nodes = document.steps.map((value, index): CompiledNode => {
    const step = record(value, `steps/${index}`);
    const nodeKey = text(step.step_key, `steps/${index}.step_key`);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(nodeKey)) fail("PIPELINE_PLAN_KEY_INVALID", `非法 step_key ${nodeKey}`);
    const owner = text(step.owner, `${nodeKey}.owner`);
    const inputs = ports(step.inputs, `${nodeKey}.inputs`, true);
    const outputs = ports(step.outputs, `${nodeKey}.outputs`);
    const dependsOn = stringArray(step.depends_on, `${nodeKey}.depends_on`, true);
    const invalidates = stringArray(step.invalidates, `${nodeKey}.invalidates`, true);
    const gateId = optionalText(step.gate, `${nodeKey}.gate`);
    const pipelineKey = optionalText(step.subgraph, `${nodeKey}.subgraph`);
    const kind: CompiledNode["kind"] = gateId ? "gate" : pipelineKey ? "call" : "stage";
    const repair = repairFor(step, nodeKey, kind);
    const explicitSideEffect = optionalText(step.side_effect, `${nodeKey}.side_effect`);
    const sideEffect = kind === "gate" ? "none" : explicitSideEffect ?? sideEffectForKey(nodeKey);
    if (!["none", "model", "local", "provider", "public"].includes(sideEffect)) {
      fail("PIPELINE_PLAN_SIDE_EFFECT_INVALID", `${nodeKey}.side_effect 非法`);
    }
    const cost = costClassFor(nodeKey, sideEffect as SideEffect);
    const budgetMs = positiveInt(step.budget_ms, `${nodeKey}.budget_ms`, null);
    if (kind === "gate") {
      const gate = gateRegistry[gateId!];
      if (!gate) fail("PIPELINE_PLAN_GATE_UNKNOWN", `${nodeKey} 使用未知 gate ${gateId}`);
      return {
        key: nodeKey, kind, name: text(step.name, `${nodeKey}.name`), owner, gateId: gateId!,
        checkSetVersion: gate.checkSetVersion, rubricVersion: gate.rubricVersion, authority: gate.authority,
        inputs, outputs, dependsOn, invalidates, sideEffect: "none", costClass: "none", repair, budgetMs: null,
      };
    }
    if (kind === "call") {
      return {
        key: nodeKey, kind, name: text(step.name, `${nodeKey}.name`), owner, pipelineKey: pipelineKey!,
        inputs, outputs, dependsOn, invalidates, sideEffect: sideEffect as SideEffect, costClass: cost, repair, budgetMs,
      };
    }
    const adapterId = optionalText(step.adapter, `${nodeKey}.adapter`) ?? "legacy.vendor-preproduction";
    return {
      key: nodeKey, kind, name: text(step.name, `${nodeKey}.name`), owner, adapterId,
      contractVersion: optionalText(step.contract, `${nodeKey}.contract`) ?? `workloom.video.${nodeKey}/v1`,
      inputs, outputs, dependsOn, invalidates, sideEffect: sideEffect as SideEffect, costClass: cost, repair, budgetMs,
    };
  });

  const ids = new Set(nodes.map((node) => node.key));
  if (ids.size !== nodes.length) fail("PIPELINE_PLAN_DUPLICATE", "step_key 重复");
  for (const node of nodes) {
    if (node.kind === "call" && node.pipelineKey === key) fail("PIPELINE_PLAN_RECURSION", `${node.key} 不能直接调用自身`);
    for (const dependency of node.dependsOn) {
      if (dependency === node.key || !ids.has(dependency)) fail("PIPELINE_PLAN_DEPENDENCY_INVALID", `${node.key} 依赖未知或自身 ${dependency}`);
    }
  }

  const ordered = topoSort(nodes);
  validateContracts(ordered, { adapterRegistry, gateRegistry, knownPipelines });
  const edges = nodes.flatMap((node) => node.dependsOn.map((from) => ({
    from,
    to: node.key,
    artifactRoles: node.inputs.map((port) => port.role),
  })));
  const roots = ordered.filter((node) => node.dependsOn.length === 0).map((node) => node.key);
  const planWithoutHash = {
    schemaVersion: "workloom.video-pipeline-plan/v2" as const,
    key,
    name,
    version,
    sourceSha256: options.sourceText ? sha256Text(options.sourceText) : sha256Json(documentValue),
    nodes: ordered,
    edges,
    roots,
  };
  return { ...planWithoutHash, planHash: sha256Json(planWithoutHash) };
}

export function loadVideoPipelinePlan(
  file: string,
  expectedQuest?: string,
  adapterRegistry?: Record<string, VideoAdapterRegistration>,
): CompiledVideoPipelinePlan {
  const source = readFileSync(file, "utf8");
  return compileVideoPipelineDocument(parseYaml(source), { expectedQuest, adapterRegistry, sourceText: source });
}

export function assertVideoPipelinePlan(plan: CompiledVideoPipelinePlan): CompiledVideoPipelinePlan {
  if (plan.schemaVersion !== "workloom.video-pipeline-plan/v2") fail("PIPELINE_PLAN_SCHEMA_INVALID", "plan schemaVersion 非法");
  if (!/^[a-f0-9]{64}$/.test(plan.planHash) || !/^[a-f0-9]{64}$/.test(plan.sourceSha256)) fail("PIPELINE_PLAN_HASH_INVALID", "plan hash 非法");
  if (plan.nodes.length === 0) fail("PIPELINE_PLAN_INVALID", "plan 没有节点");
  if (new Set(plan.nodes.map((node) => node.key)).size !== plan.nodes.length) {
    fail("PIPELINE_PLAN_DUPLICATE", "step_key 重复");
  }
  const expectedEdges = plan.nodes.flatMap((node) => node.dependsOn.map((from) => ({
    from,
    to: node.key,
    artifactRoles: node.inputs.map((port) => port.role),
  })));
  if (sha256Json(expectedEdges) !== sha256Json(plan.edges)) fail("PIPELINE_PLAN_EDGE_MISMATCH", "plan edges 与节点依赖不一致");
  const roots = plan.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.key);
  if (sha256Json(roots) !== sha256Json(plan.roots)) fail("PIPELINE_PLAN_ROOT_MISMATCH", "plan roots 与节点依赖不一致");
  validateContracts(plan.nodes, {
    adapterRegistry: createVideoAdapterRegistry(),
    gateRegistry: createVideoGateRegistry(),
    knownPipelines: new Set(DEFAULT_VIDEO_PIPELINES),
  });
  const expectedHash = sha256Json({
    schemaVersion: plan.schemaVersion,
    key: plan.key,
    name: plan.name,
    version: plan.version,
    sourceSha256: plan.sourceSha256,
    nodes: plan.nodes,
    edges: plan.edges,
    roots: plan.roots,
  });
  if (expectedHash !== plan.planHash) fail("PIPELINE_PLAN_HASH_MISMATCH", "plan 内容与 planHash 不一致");
  return structuredClone(plan);
}
