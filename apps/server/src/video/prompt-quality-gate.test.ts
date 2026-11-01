import { describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_QUALITY_CHECK_IDS,
  evaluatePromptPackage,
  compilePromptPackage,
  parseSemanticQualityReview,
  promptQualityAutoChecks,
  promptContractSummary,
  verifyCurrentPromptContracts,
  writePromptQualityEvidence,
  type SemanticQualityReview,
  type SemanticQualityReviewer,
} from "./prompt-quality-gate.js";
import type { PromptCompileOptions } from "@hyperreality/video-studio";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fields: Record<string, unknown> = {
  director_instruction: "写实纪录片方向，讲清人物与水面的关系。",
  constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
  baseline: "电影级写实质感。",
  scene: "清晨临水回廊，薄雾贴着水面。",
  lighting: "侧后方晨光与水面反射补光。",
  camera_movement: "固定机位，轻微呼吸感。",
  character: "林夏穿着浅色亚麻衬衫。",
  action: "林夏停在栏杆旁触摸木纹。",
  portraits: "NONE",
  dialogue: "无台词；只保留水声与鸟鸣。",
  negative: "no text, no watermark, no duplicate person",
  consistency: "保持林夏和回廊空间一致。",
  composition: "竖版三分构图，人物位于右侧。",
  color_palette: "冷灰水面与浅木色回廊。",
  depth_of_field: "中景清晰，近处栏杆轻微虚化。",
  timeline: "T00:00至T00:05，T00:04停稳。",
  mood: "安静、克制。",
  bright_constraint: "面部与水面反光清晰。",
  character_constraint: "只出现林夏一个主体。",
  costume: "浅色亚麻衬衫与深色长裤。",
  props: "木质栏杆、薄雾、水面落叶。",
  pacing: "前段慢，后段停稳。",
  audio: "水声、鸟鸣、脚步声。",
  makeup: "自然裸妆。",
  transition: "硬切入镜。",
};

const model: PromptCompileOptions["model"] = {
  modelId: "doubao-seedance-2-5",
  provider: "seedance",
  providerModel: "doubao-seedance-2-5-260628",
  version: "test",
  modes: ["t2v"],
  durationSec: { min: 4, max: 30 },
  aspectRatios: ["9:16"],
  resolutions: ["1080p"],
  maxReferenceImages: 30,
  maxPromptChars: 4000,
};

const compile: PromptCompileOptions = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model,
  assets: [],
};

const source = {
  shotId: "S01",
  sceneType: "content",
  duration: 5,
  fields,
  portraits: fields.portraits,
};

function passReview(): SemanticQualityReview {
  return {
    shotId: "S01",
    checks: SEMANTIC_QUALITY_CHECK_IDS.map((id) => ({
      id,
      pass: true,
      field: id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "scene",
      evidence: id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement：固定机位，轻微呼吸感"
        : id === "SQ4_LIGHT_COLOR" ? "lighting：侧后方晨光与水面反射补光"
          : "scene：清晨临水回廊，薄雾贴着水面",
    })),
  };
}

function failCameraReview() {
  const review = passReview();
  review.checks[2] = {
    ...review.checks[2]!,
    pass: false,
    field: "camera_movement",
    failureCode: "CAMERA_COMPLEXITY_EXCEEDS_DURATION",
    evidence: "camera_movement：固定机位，轻微呼吸感",
    repair: "只修改 camera_movement，保留固定机位",
  };
  return review;
}

function input(reviewer: SemanticQualityReviewer, mode: "shadow" | "enforce" = "enforce") {
  return {
    mode,
    projectId: "P1",
    runId: "R1",
    stageRunId: "SR1",
    revision: 1,
    shots: [{ source, compile }],
    reviewer,
  };
}

describe("prompt semantic quality gate", () => {
  it("accepts only five complete, evidence-bearing binary checks", () => {
    const parsed = parseSemanticQualityReview(passReview(), {
      shotId: "S01",
      fieldSchema: "workloom.video-shot-card/v2",
      fieldCount: 25,
      bindings: Object.keys(fields).map((field) => ({ field, valueSha256: "a".repeat(64), channels: ["prompt" as const] })),
    } as never, source);
    expect(parsed.valid).toBe(true);
    const missing = passReview();
    missing.checks.pop();
    expect(parseSemanticQualityReview(missing, {
      shotId: "S01",
      fieldSchema: "workloom.video-shot-card/v2",
      fieldCount: 25,
      bindings: Object.keys(fields).map((field) => ({ field, valueSha256: "a".repeat(64), channels: ["prompt" as const] })),
    } as never, source).valid).toBe(false);
  });

  it("does not call semantic review when deterministic contract checks fail", async () => {
    const review = vi.fn(async () => passReview());
    const bad = { ...source, fields: { ...fields, scene: "" } };
    const result = await evaluatePromptPackage({
      ...input({ review }),
      shots: [{ source: bad, compile }],
    });
    expect(review).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
    expect(result.findings.some((finding) => finding.code === "HARD_FIELD_VALUE_MISSING")).toBe(true);
  });

  it("shadow records the same rejection without becoming a blocking decision", async () => {
    const result = await evaluatePromptPackage({
      ...input({ review: vi.fn(async () => passReview()) }, "shadow"),
      shots: [{ source: { ...source, fields: { ...fields, scene: "" } }, compile }],
    });
    expect(result.status).toBe("shadow");
    expect(result.renderEligible).toBe(false);
    expect(result.decision.status).toBe("rejected");
  });

  it("retries an invalid semantic response once and then stalls without changing fields", async () => {
    const review = vi.fn(async () => ({ shotId: "S01", checks: [] }));
    const result = await evaluatePromptPackage(input({ review }));
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("stalled");
    expect(result.semanticReports[0]?.technicalRetry).toBe(1);
    expect(result.findings[0]?.code).toBe("SEMANTIC_REVIEW_INVALID");
    expect(promptQualityAutoChecks(result).some((check) =>
      check.id === "prompt-quality-stalled" && check.category === "policy" && check.status === "failed")).toBe(true);
  });

  it("allows one exact field repair, then re-runs all five checks and full contract compilation", async () => {
    let repaired = false;
    const reviewer: SemanticQualityReviewer = {
      model: "test-reviewer",
      review: async () => repaired ? passReview() : failCameraReview(),
      repair: async () => {
        repaired = true;
        return { changes: [{ field: "camera_movement", value: "固定机位，缓慢推近一个动作", reason: "在时长内可完成" }] };
      },
    };
    const result = await evaluatePromptPackage(input(reviewer));
    expect(result.status).toBe("passed");
    expect(result.repairAttempt).toMatchObject({ status: "applied", allowedFields: ["camera_movement"] });
    expect(result.shotContracts[0]?.contract.request.parameters.camera_fixed).toBe(true);
    expect(result.g6Eligible).toBe(true);
    expect(result.renderEligible).toBe(false);
    expect(promptQualityAutoChecks(result)).toHaveLength(6);
  });

  it("stalls forbidden changes and unchanged repair output", async () => {
    const forbidden: SemanticQualityReviewer = {
      review: async () => failCameraReview(),
      repair: async () => ({ changes: [{ field: "scene", value: "另一个场景", reason: "扩写" }] }),
    };
    expect((await evaluatePromptPackage(input(forbidden))).status).toBe("stalled");

    const unchanged: SemanticQualityReviewer = {
      review: async () => failCameraReview(),
      repair: async () => ({ changes: [{ field: "camera_movement", value: fields.camera_movement, reason: "没有变化" }] }),
    };
    expect((await evaluatePromptPackage(input(unchanged))).status).toBe("stalled");
  });

  it("records contract, semantic and decision evidence with stable file hashes", async () => {
    const result = await evaluatePromptPackage(input({ review: async () => passReview() }));
    const dir = mkdtempSync(path.join(tmpdir(), "prompt-quality-"));
    try {
      const evidence = writePromptQualityEvidence(dir, result);
      for (const file of [
        ...evidence.contracts.map((item) => item.path),
        evidence.semanticReportPath,
        evidence.decisionPath,
      ]) {
        expect(readFileSync(file, "utf8").length).toBeGreaterThan(20);
      }
      expect(evidence.sha256.contracts).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(readFileSync(evidence.decisionPath, "utf8")).gateId).toBe("G6_PROMPT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G7 detects field, prompt and request drift from the current G6 contracts", () => {
    const compiled = compilePromptPackage({ shots: [{ source, compile }] });
    const summary = promptContractSummary(compiled.map((item) => item.contract));
    expect(verifyCurrentPromptContracts({ shots: [{ source, compile }] }, summary).valid).toBe(true);
    const changed = {
      ...source,
      fields: { ...fields, timeline: "T00:00至T00:09，T00:09停稳。" },
    };
    const drift = verifyCurrentPromptContracts({ shots: [{ source: changed, compile }] }, summary);
    expect(drift.valid).toBe(false);
    expect(drift.reasons).toContain("PROMPT_CONTRACT_DRIFT:S01");
  });
});
