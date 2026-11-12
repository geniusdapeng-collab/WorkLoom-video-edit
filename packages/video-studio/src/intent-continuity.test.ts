import { describe, expect, it } from "vitest";
import {
  PRODUCTION_INTENT_CONTRACT_VERSION,
  auditProductionIntentPrompt,
  deriveProductionIntentContract,
  motionIntentForShot,
  productionIntentPrompt,
} from "./intent-continuity.js";

const rawIntent = "制作一条 30 秒摩托车高燃赛道短片。李英子穿同一套哑光赛车服，不得换装。保留原生引擎声。";
const brief = {
  tone: "冷酷精密，全程高燃",
  pacing: "fast but narratively legible",
  style: { primary: "极速竞技、低机位追车、弯道并排、外线连续超越" },
  requirements: "赛车速度必须随动作明显提升，不能像恒速巡航。",
  product: "820RR-RC 赛道版",
  wardrobe: "w01 哑光黑色全覆护具赛车服",
  productionRequirements: { subtitleMode: "burned", nativeAudio: true },
};

describe("production intent continuity", () => {
  it("freezes customer clauses with source hashes and carries all relevant directives", () => {
    const contract = deriveProductionIntentContract({ rawIntent, brief });
    expect(contract.schemaVersion).toBe(PRODUCTION_INTENT_CONTRACT_VERSION);
    expect(contract.sources.length).toBeGreaterThan(0);
    expect(contract.directives.some((row) => row.category === "identity")).toBe(true);
    expect(contract.directives.some((row) => row.category === "wardrobe")).toBe(true);
    expect(contract.directives.some((row) => row.category === "audio")).toBe(true);
    expect(contract.motion.profile).toBe("high-energy-action");
    expect(contract.motion.requiresAcceleration).toBe(true);
    const prompt = productionIntentPrompt(contract, { stage: "prompt", maxChars: 1600 });
    expect(prompt).toContain(contract.contractSha256);
    for (const directive of contract.directives) expect(prompt).toContain(directive.id);
    expect(auditProductionIntentPrompt(contract, prompt, { action: "低机位追车并完成外线超越" })).toMatchObject({ ok: true });
  });

  it("is deterministic and ignores negative-only motion language", () => {
    expect(deriveProductionIntentContract({ rawIntent, brief }))
      .toEqual(deriveProductionIntentContract({ rawIntent, brief }));
    const quiet = deriveProductionIntentContract({
      rawIntent: "人物安静坐在室内，不要高速，不要追车。",
      brief: { tone: "克制平稳", requirements: "不要加速，保持固定机位。" },
    });
    expect(quiet.motion.profile).not.toBe("high-energy-action");
    expect(quiet.motion.requiresAcceleration).toBe(false);
  });

  it("fails closed when a later prompt drops an intent or rewrites speed as cruise", () => {
    const contract = deriveProductionIntentContract({ rawIntent, brief });
    const incomplete = `【需求意图延续合同】${contract.contractSha256}`;
    expect(auditProductionIntentPrompt(contract, incomplete).issues.some((issue) => issue.includes("遗漏客户意图"))).toBe(true);
    const prompt = productionIntentPrompt(contract, { stage: "prompt", maxChars: 1600 });
    const audit = auditProductionIntentPrompt(contract, prompt, {
      shotId: "S1",
      action: "低机位恒速后追随摩托车，不加速",
      camera_movement: "平稳跟拍，无超车",
    });
    expect(audit.ok).toBe(false);
    expect(audit.issues.join("；")).toContain("恒速");
  });

  it("derives a fast action profile without hard-coding a specific project", () => {
    const contract = deriveProductionIntentContract({
      rawIntent: "拍一条高燃滑雪冲刺片，运动员从后方追近并在弯道完成超越。",
      brief: { pacing: "高速、紧迫、动作片节奏" },
    });
    expect(contract.motion).toMatchObject({ profile: "high-energy-action", requiresAcceleration: true });
    expect(motionIntentForShot({ action: "运动员持续冲刺并完成外道超越" }, contract.motion)).toMatchObject({
      intent: "speed-ramp",
      requiresSpeedRamp: true,
      source: "project-action",
    });
  });
});
