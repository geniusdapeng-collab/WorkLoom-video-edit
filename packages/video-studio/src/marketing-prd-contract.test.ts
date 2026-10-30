import { describe, expect, it } from "vitest";
import { normalizeMarketingPrdContract } from "./marketing-prd-contract.js";

function prd() {
  return {
    creativeCore: {
      creativeHook: "观众手指停住，感到结构和秩序。",
      keyMessages: ["P0 卖点 1｜落点 scene-3/结尾", "合法消息"],
      twistPoint: "第22秒 scene-3 收束",
    },
    visualSpecification: {
      cameraLanguage: "手部插入模块的近景",
      visualReferences: ["《2001太空漫游》、大卫·芬奇、Apple"],
    },
    audioSpecification: {
      musicStyle: "无旋律配乐",
      soundDesign: "低频节奏",
      voicePolicy: "字幕+音乐",
    },
    scenePlan: {
      scenes: [
        { sceneId: "opening", duration: 4, purpose: "开场", visualRequirements: ["九个空心方块示意模块", "来源角标常驻，任何一帧截图都能自证出处"] },
        { sceneId: "ending", duration: 4, purpose: "结尾", visualRequirements: ["手部对齐"] },
      ],
      shotMapping: [{ sceneId: "opening" }, { sceneId: "ending" }],
    },
    productionConstraints: {
      technicalConstraints: ["在道具清单中标注 HOME-HERO-001 / HOME-REF-002 调用（license_risk=h", "同时在场景结构里逐一标注「"],
      businessConstraints: ["Apache-2.0 首次出现须有设备轮廓示意"],
      forbiddenElements: ["人物"],
      qualityThresholds: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 },
    },
    audienceProfile: {
      emotionTriggers: ["第12秒手指能感到的插合力度"],
    },
    referenceCases: {
      filmReferences: ["《2001太空漫游》"],
      adReferences: ["Apple"],
      styleReferences: ["大卫·芬奇"],
    },
    deliveryStandard: {
      deliverables: [{ item: "video_master", spec: "MP4/H.265, 4K", priority: "required" }],
      acceptanceCriteria: { visualScore: 0.75, audioScore: 0.7, narrativeScore: 0.75, consistencyScore: 0.7 },
    },
  };
}

describe("marketing PRD host contract", () => {
  it("binds references, no-person language, scene counts and technical delivery to host authority", () => {
    const result = normalizeMarketingPrdContract(prd(), {
      customerOriginalIntent: "全片无人，仅使用抽象界面和示意图",
      builtinCharacterSelection: { mode: "none" },
    }, {
      resolution: "4K",
      aspectRatio: "9:16",
      targetDuration: 30,
      durationToleranceFrames: 1,
    }, {
      scenes: [{ id: "opening" }, { id: "ending" }],
    });
    const value = result.prd as any;
    expect(value.visualSpecification.visualReferences.join(" ")).not.toContain("库布里克");
    expect(value.referenceCases.filmReferences.join(" ")).not.toMatch(/《|导演|Apple/);
    expect(value.creativeCore.creativeHook).not.toContain("手指");
    expect(value.creativeCore.keyMessages.join(" ")).not.toContain("scene-3");
    expect(value.scenePlan.scenes[0].visualRequirements[0]).toContain("若干");
    expect(value.scenePlan.scenes[0].visualRequirements.join(" ")).not.toContain("任何一帧");
    expect(value.audioSpecification.voicePolicy).toBe("无对白");
    expect(value.audioSpecification.soundDesign).toContain("-14 LUFS");
    expect(value.productionConstraints.technicalConstraints.join(" ")).toContain("2160x3840");
    expect(value.productionConstraints.technicalConstraints.join(" ")).not.toContain("license_risk=h");
    expect(value.deliveryStandard.deliverables[0].spec).toContain("-14 LUFS");
    expect(result.applied).toBe(true);
  });

  it("fails closed instead of silently changing the approved scene count", () => {
    expect(() => normalizeMarketingPrdContract(prd(), {
      builtinCharacterSelection: { mode: "none" },
    }, {}, { scenes: [{ id: "opening" }] })).toThrow(/SCENE_AUTHORITY_CHANGED/);
  });
});
