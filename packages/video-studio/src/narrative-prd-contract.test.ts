import { describe, expect, it } from "vitest";
import { normalizeNarrativePrdContract } from "./narrative-prd-contract.js";

const metadata = {
  pipelineRoute: { kind: "narrative" },
  customerOriginalIntent: "拍一条 20 秒的苏州平江路城市人文短片，9:16，抖音",
  brief: { duration: 20, aspectRatio: "9:16", platform: "抖音" },
  builtinCharacterSelection: {
    schemaVersion: "workloom.video-character-selection/v1",
    mode: "builtin",
    characters: [{ id: "young-rider-01", name: "李英子" }],
  },
  characters: [{
    id: "young-rider-01",
    character_id: "young-rider-01",
    name: "李英子",
    role: "protagonist",
    identity: { age: "20岁成年女性（虚构设定）", occupation: "大学在读学生（虚构）" },
    appearance: { face: "自然鹅蛋脸", hair: "黑色高马尾" },
    persona: { archetype: "好奇的大学生", tone: "明快自然" },
    wardrobe: [{ id: "w1", detail: "无标识哑光黑色轻便机车夹克、白色圆领T恤与深炭灰长裤" }],
    activeWardrobeId: "w1",
    continuityRules: ["年龄、脸型、发型与服装版本保持一致"],
  }],
  _workloomRequirementContract: {
    scenes: [
      {
        id: "opening",
        source: "/sceneStructure/opening",
        duration: 3,
        purpose: "湿青石阶与水面反光建立清晨悬念",
        keyElements: ["湿青石阶", "水面反光"],
        props: [{ name: "青石阶", description: "潮湿石阶的可见纹理", source: "/opening/props/0" }],
        actions: [{ actorId: "$scene", description: "水面反光随晨风缓慢晃动", source: "/opening/actions/0" }],
        noPropsReason: null,
      },
      {
        id: "scene-1",
        source: "/sceneStructure/scenes/0",
        duration: 6,
        purpose: "英子出现并观察第一班船",
        keyElements: ["英子", "乌篷船"],
        props: [{ name: "乌篷船", description: "缓慢穿过桥洞的旧木船", source: "/scene-1/props/0" }],
        actions: [{ actorId: "young-rider-01", description: "英子抬眼望向桥洞并保持蹲姿", source: "/scene-1/actions/0" }],
        noPropsReason: null,
      },
      {
        id: "scene-2",
        source: "/sceneStructure/scenes/1",
        duration: 6,
        purpose: "船穿过桥洞形成节奏高点",
        keyElements: ["船橹", "桥洞倒影"],
        props: [{ name: "船橹", description: "入水摇动的旧木橹", source: "/scene-2/props/0" }],
        actions: [{ actorId: "$scene", description: "船橹拨开水面形成连续波纹", source: "/scene-2/actions/0" }],
        noPropsReason: null,
      },
      {
        id: "ending",
        source: "/sceneStructure/ending",
        duration: 5,
        purpose: "英子目送船离开，情绪落地",
        keyElements: ["英子", "远去的船"],
        props: [{ name: "石栏", description: "英子倚靠的旧石栏", source: "/ending/props/0" }],
        actions: [{ actorId: "young-rider-01", description: "英子倚着石栏目送船尾离开桥洞", source: "/ending/actions/0" }],
        noPropsReason: null,
      },
    ],
  },
};

function prd() {
  return {
    productPositioning: { targetDuration: 20, aspectRatio: "9:16", targetPlatform: "抖音" },
    creativeCore: {
      keyMessages: ["P0：字幕单行不超过14字，字高占画面宽度4%", "P1：声音先于画面到场"],
    },
    visualSpecification: {
      cameraLanguage: "固定长镜为主，横移单方向；20秒内不超过4镜，不推拉",
    },
    characterSystem: {
      characters: [
        { characterId: "young-rider-01", name: "英子", role: "主角", ageRange: "青少年", appearance: "十七八岁", costume: "浅色连帽衫" },
        { characterId: "boatman", name: "船工", role: "配角", ageRange: "中年", appearance: "四五十岁", costume: "靛蓝旧布衫" },
      ],
    },
    scenePlan: {
      scenes: [
        { sceneId: "SC01", duration: 3, purpose: "开场", setting: "桥洞", visualRequirements: ["船工背影"], keyProps: ["字幕板"] },
        { sceneId: "SC02", duration: 5.5, purpose: "人物", setting: "石阶", visualRequirements: ["字幕≤10字"], keyProps: ["手机"] },
        { sceneId: "SC03", duration: 7.5, purpose: "过船", setting: "桥洞", visualRequirements: ["船工仅手部出镜"], keyProps: ["乌篷船"] },
        { sceneId: "SC04", duration: 4, purpose: "结尾", setting: "石阶", visualRequirements: ["字幕板"], keyProps: ["石阶"] },
        { sceneId: "SC05", duration: 2, purpose: "模型擅自新增场景", setting: "不存在", visualRequirements: [], keyProps: [] },
      ],
      shotMapping: Array.from({ length: 5 }, (_, index) => ({ sceneId: `SC0${index + 1}`, estimatedShots: 2 })),
    },
    productionConstraints: {
      technicalConstraints: ["字幕持续显示"],
      businessConstraints: ["图内不出现竞品"],
      forbiddenElements: ["低质量"],
      qualityThresholds: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 },
    },
    deliveryStandard: {
      acceptanceCriteria: { visual: 0.75, audio: 0.7, narrative: 0.75, consistency: 0.7 },
      outputFormat: { videoCodec: "H.264", audioCodec: "AAC", container: "MP4" },
      fallbackPlan: { trigger: "质量低于阈值", action: "降低复杂度", expectedOutput: "保证叙事完整" },
    },
  };
}

describe("narrative PRD contract", () => {
  it("uses the approved cast and scene contract as the only production authority", () => {
    const result = normalizeNarrativePrdContract(prd(), metadata);
    const value = result.prd as any;
    expect(result.applied).toBe(true);
    expect(value.characterSystem.characters).toHaveLength(1);
    expect(value.characterSystem.characters[0]).toMatchObject({
      characterId: "young-rider-01",
      name: "李英子",
      ageRange: "20岁成年女性（虚构设定）",
    });
    expect(value.characterSystem.characters[0].costume).toContain("黑色轻便机车夹克");
    expect(JSON.stringify(value.characterSystem)).not.toContain("船工");

    expect(value.scenePlan.scenes.map((scene: { sceneId: string }) => scene.sceneId))
      .toEqual(["opening", "scene-1", "scene-2", "ending"]);
    expect(value.scenePlan.scenes.map((scene: { duration: number }) => scene.duration))
      .toEqual([3, 6, 6, 5]);
    expect(value.scenePlan.shotMapping).toHaveLength(4);
    expect(JSON.stringify(value.scenePlan)).not.toContain("船工");

    expect(value.visualSpecification.cameraLanguage).not.toMatch(/不超过\s*4\s*镜/);
    expect(value.creativeCore.keyMessages.join(" ")).not.toContain("字幕");
    expect(value.productionConstraints.technicalConstraints.join(" ")).not.toContain("字幕");
    expect(value.productionConstraints.qualityThresholds).toEqual({
      visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75,
    });
    expect(value.deliveryStandard.acceptanceCriteria).toEqual(
      value.productionConstraints.qualityThresholds,
    );
    expect(value.deliveryStandard.fallbackPlan.trigger).toContain("视觉 0.8");
    expect(value.deliveryStandard.deliverables).toEqual(expect.arrayContaining([
      expect.objectContaining({ item: "subtitle_policy", priority: "required" }),
    ]));
    expect(value._workloomNarrativeContractNormalization.applied).toBe(true);
  });

  it("is a no-op outside the narrative route", () => {
    const input = prd();
    const result = normalizeNarrativePrdContract(input, { ...metadata, pipelineRoute: { kind: "marketing" } });
    expect(result.applied).toBe(false);
    expect(result.prd).toEqual(input);
  });
});
