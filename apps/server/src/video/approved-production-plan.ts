/** Exact approved G4 artifact/scene plan reader shared by native and explicit source-repair paths. */
import path from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { frozenVisualPrdSegments, normalizePrdProductionProfile, type PrdMarketingAuthority } from "@hyperreality/video-studio";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Bind G6 to the same bytes the current G4 review approved, including the ordered native scene obligations. */
export function readApprovedProductionPlan(input: {
  workDir: string;
  metadata: Record<string, unknown>;
  marketing: PrdMarketingAuthority;
  proof: Record<string, unknown> | undefined;
  shots: ReadonlyArray<Record<string, unknown>>;
}) {
  const invalid = (detail: string): never => { throw new Error(`G6_APPROVED_PRODUCTION_PLAN_UNVERIFIED: ${detail}`); };
  const { workDir, marketing, proof, shots } = input;
  const profile = normalizePrdProductionProfile(input.metadata);
  const segments = frozenVisualPrdSegments({ metadata: input.metadata, marketing, profile });
  if (!segments) return invalid("缺少本次冻结无对白分段");
  const file = path.join(workDir, "gates", marketing.scope.projectId, `attempt-${marketing.scope.attempt}`, "G4_PRD.md");
  const receipt = jsonRecord(proof?.autoApproval);
  const g4ArtifactSha256 = receipt?.artifactSha256;
  const evidence = Array.isArray(proof?.evidence) ? proof.evidence.filter(item => jsonRecord(item)?.path === file) : [];
  if (proof?.gate !== "G4_PRD" || proof.approved !== true || proof.status !== "passed"
    || proof.via !== "llm" || proof.degraded !== false || receipt?.gateKey !== "G4_PRD" || receipt.outcome !== "passed"
    || typeof g4ArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(g4ArtifactSha256)
    || evidence.length !== 1 || evidence[0]?.scope !== "complete-text" || evidence[0]?.sha256 !== g4ArtifactSha256) {
    return invalid("缺少当前尝试 G4 完整原件的已通过模型和系统策略证明");
  }
  const body = (() => {
    try {
      if (realpathSync(workDir) !== workDir || realpathSync(file) !== file) return invalid("G4 原件路径越界或经过符号链接");
      const stat = statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > 2 * 1024 * 1024) return invalid("G4 原件不是完整可审文本文件");
      return readFileSync(file);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("G6_APPROVED_PRODUCTION_PLAN_UNVERIFIED:")) throw error;
      return invalid("无法读取当前尝试 G4 原件");
    }
  })();
  if (renderSha256(body) !== g4ArtifactSha256) return invalid("G4 原件字节与已通过证明不一致");
  const markdown = body.toString("utf8");
  const annex = (heading: string) => {
    const sections = markdown.split(`\n## ${heading}\n\n`);
    if (sections.length !== 2) return invalid(`G4 缺少唯一的${heading}附件`);
    const block = /^[\s\S]*?\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60(?:\n|$)/.exec(sections[1]!.split("\n## ", 1)[0]!);
    if (!block) return invalid(`G4 的${heading}缺少完整 JSON`);
    try {
      return jsonRecord(JSON.parse(block[1]!)) ?? invalid(`G4 的${heading}不是 JSON 对象`);
    } catch {
      return invalid(`G4 的${heading}不是可解析的 JSON 对象`);
    }
  };
  const authority = annex("宿主本次权威生产与交付要求");
  const plan = annex("本次 G4 执行与核验计划原文");
  const source = jsonRecord(authority.source);
  const contract = jsonRecord(authority.approvedRequirementContract);
  const requirementContractHash = source?.requirementContractHash;
  if (source?.schemaVersion !== "workloom.prd-authority/v1" || source.status !== "ready-for-g4"
    || canonicalRenderJson(source.scope ?? null) !== canonicalRenderJson(marketing.scope)
    || canonicalRenderJson(source.g1 ?? null) !== canonicalRenderJson({ path: marketing.g1Artifact.path, sha256: marketing.g1Artifact.sha256 })
    || canonicalRenderJson(source.profile ?? null) !== canonicalRenderJson(profile)
    || canonicalRenderJson(authority.profile ?? null) !== canonicalRenderJson(profile)
    || contract?.schemaVersion !== "workloom.requirement-contract/v1" || contract.status !== "ready-for-g3"
    || typeof requirementContractHash !== "string" || !/^[a-f0-9]{64}$/.test(requirementContractHash)
    || contract.hash !== requirementContractHash || plan.status !== "plan-only-not-executed") {
    return invalid("G4 作用域、当前 G1、生产规格或已审场景合同不一致");
  }
  const scenes = contract.scenes;
  const verification = plan.sceneVerificationPlans;
  if (!Array.isArray(scenes) || !Array.isArray(verification)
    || scenes.length !== segments.count || verification.length !== scenes.length || shots.length !== scenes.length) {
    return invalid("G4 场景、冻结区间与原生镜头无法按序一一对应");
  }
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text => typeof text === "string" && text.trim());
  const tolerance = (profile.durationToleranceFrames ?? 0) / (profile.frameRate ?? 1);
  const seen = new Set<string>();
  return { g4ArtifactSha256, requirementContractHash, scenes: shots.map((shot, index) => {
    const approvedScene = jsonRecord(scenes[index]);
    const verificationPlan = jsonRecord(verification[index]);
    const shotId = shot.shotId ?? shot.shot_id;
    if (!approvedScene || !verificationPlan || typeof shotId !== "string" || !shotId || seen.has(shotId)
      || (shot.shotId !== undefined && shot.shot_id !== undefined && shot.shotId !== shot.shot_id)
      || approvedScene.id !== shotId || verificationPlan.sceneId !== shotId || shot.duration !== segments.secondsPerSegment
      || approvedScene.duration !== shot.duration || typeof verificationPlan.duration !== "number"
      || !Number.isFinite(verificationPlan.duration) || Math.abs(verificationPlan.duration - shot.duration) > tolerance + 1e-9
      || typeof approvedScene.purpose !== "string" || !approvedScene.purpose.trim() || !strings(approvedScene.keyElements)
      || !Array.isArray(approvedScene.props) || !Array.isArray(approvedScene.actions) || !approvedScene.actions.length
      || !approvedScene.actions.every(value => {
        const action = jsonRecord(value);
        return typeof action?.actorId === "string" && typeof action.description === "string" && Boolean(action.description.trim());
      }) || !strings(verificationPlan.visualRequirements) || !strings(verificationPlan.audioRequirements)
      || verificationPlan.dialogue !== "") return invalid(`第 ${index + 1} 镜的已审场景身份、时长或动作核验计划不完整`);
    seen.add(shotId);
    return { shotId, sceneId: shotId, interval: segments.intervals[index]!, approvedScene, verificationPlan };
  }) };
}

