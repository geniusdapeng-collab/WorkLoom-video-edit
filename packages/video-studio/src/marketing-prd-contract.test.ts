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
      businessConstraints: ["Apache-2.0 首次出现须有设备轮廓示意", "无字幕依赖：任何关键信息不得落在可读文字上"],
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
      deliverables: [{
        item: "video_master",
        spec: "MP4/H.265, 4K；字幕默认烧录已审画面文字；github.com/example/project",
        priority: "required",
      }],
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
    expect(value.audioSpecification.soundDesign).toContain("客户未明确要求字幕");
    expect(value.audioSpecification.soundDesign).not.toContain("字幕仅烧录已审画面文字");
    expect(value.productionConstraints.technicalConstraints.join(" ")).toContain("2160x3840");
    expect(value.productionConstraints.technicalConstraints.join(" ")).toContain("30fps");
    expect(value.productionConstraints.businessConstraints.join(" ")).not.toContain("无字幕依赖");
    expect(value.productionConstraints.technicalConstraints.join(" ")).not.toContain("license_risk=h");
    expect(value.deliveryStandard.deliverables[0].spec).toContain("-14 LUFS");
    expect(value.deliveryStandard.deliverables[0].spec).toContain("30fps");
    expect(value.deliveryStandard.deliverables[0].spec).toContain("https://github.com/example/project");
    expect(value.deliveryStandard.deliverables[0].spec).not.toContain("字幕默认烧录已审画面文字");
    expect(result.applied).toBe(true);
  });

  it("normalizes unsupported screen labels and absolute whole-film claims", () => {
    const source = prd() as any;
    source.scenePlan.scenes[0].visualRequirements = [
      "标注 integration；全片仅此一个视觉落点；数百个冷白点阵；全片文字层仅来自G1原文；与G1原文逐字一致；结构可无限接驳",
    ];
    source.scenePlan.scenes[1].visualRequirements = ["单行字幕与 Apache-2.0 极小脚注"];
    source.audioSpecification.soundDesign = "字幕执行计划（客户未显式指定字幕，沿用已有任务，不加持续警示字幕、不加封面）：所有屏幕文字为画面内烧录的等宽字体英文原文与来源标注，不另做 sidecar；烧录字幕核对：字幕内容与 G1 原文逐字符一致";
    source.audienceProfile.emotionTriggers = ["第12秒已审场景节点：方块连接设备"];
    const result = normalizeMarketingPrdContract(source, {
      builtinCharacterSelection: { mode: "none" },
      customerOriginalIntent: "全片无人，不显示未入 G1 的标签",
    }, {}, { scenes: [{ id: "opening" }, { id: "ending" }] });
    const requirements = (result.prd as any).scenePlan.scenes[0].visualRequirements.join(" ");
    expect(requirements).not.toContain("integration");
    expect(requirements).not.toContain("全片仅此一个");
    expect(requirements).not.toContain("数百个");
    expect(requirements).not.toContain("全片文字层仅来自G1原文");
    expect(requirements).not.toContain("逐字一致");
    expect(requirements).toContain("屏上可见文字只允许从本次 G1 已审名称");
    const ending = (result.prd as any).scenePlan.scenes[1].visualRequirements.join(" ");
    expect(ending).not.toMatch(/极小脚注|单行字幕/);
    expect(ending).toContain("辅助脚注");
    const audio = (result.prd as any).audioSpecification.soundDesign;
    expect(audio).not.toMatch(/沿用已有任务|画面内烧录|烧录字幕核对/);
    expect(audio).toContain("不生成字幕轨或 sidecar");
    expect(audio).toContain("连续子串逐字符一致并保留原标点");
    expect(audio).toContain("辅助文字与脚注不豁免");
    expect((result.prd as any).audienceProfile.emotionTriggers.join(" ")).not.toContain("已审场景节点");
  });

  it("harmonizes license substrings, URL-only source rows and complete-line authority", () => {
    const source = prd() as any;
    source.productPositioning = { productType: "剧情短片", genre: "商业广告｜开发者种草", resolution: "1080p", frameRate: 24 };
    source.creativeCore.keyMessages = [
      "一行 license：Apache-2.0 可核对",
      "没有中心的系统最难被关掉；Local control. Privacy first. Apache-2.0. 是三行原文",
      "这些不是宣传语，是摘自 Home Assistant 官方 GitHub 仓库项目说明的逐字原文",
      "全片唯一一次说完整的句子落地之后收束",
    ];
    source.audioSpecification.soundDesign = "屏上出现 license: Apache-2.0 与 https://github.com/home-assistant/core · README";
    source.deliveryStandard.deliverables.push({ item: "character_portraits", spec: "定妆照全套", priority: "required" });
    source.scenePlan.scenes[0] = {
      sceneId: "opening",
      duration: 4,
      purpose: "README 首句逐字符浮现，但只显示半句；因为插槽还空着两格，必须看到它们被填满",
      visualRequirements: ["整屏仅 license：Apache-2.0 一处被点亮", "标签文字须与 G1 claim CL-a1b2 原文 Apache-2.0 一致", "底部中文说明字幕自下而上淡入后保持不动，位于安全区"],
    };
    source.scenePlan.scenes[1] = {
      sceneId: "ending",
      duration: 4,
      purpose: "屏幕上给出收束的一句：来源 github.com/home-assistant/core",
      visualRequirements: ["来源归属行固定为 https://github.com/home-assistant/core · README", "本场景为全片唯一完整呈现文字的一段"],
    };
    const result = normalizeMarketingPrdContract(source, {
      builtinCharacterSelection: { mode: "none" },
      customerOriginalIntent: "全片无人，仅使用抽象界面和示意图",
    }, { targetDuration: 30, aspectRatio: "9:16", resolution: "4K" },
    { scenes: [{ id: "opening" }, { id: "ending" }] }).prd as any;
    expect(result.creativeCore.keyMessages.join(" ")).not.toMatch(/\blicense:\s*Apache/u);
    expect(result.audioSpecification.soundDesign).not.toMatch(/\blicense:\s*Apache|·\s*README/u);
    expect(result.creativeCore.keyMessages.join(" ")).toContain("License: Apache-2.0");
    expect(result.scenePlan.scenes[0].visualRequirements.join(" ")).toContain("标签文字须与 G1 原文连续子串 License: Apache-2.0 一致");
    expect(result.productPositioning).toMatchObject({ productType: "商业广告", genre: "商业广告", resolution: "4K", frameRate: 30 });
    expect(result.deliveryStandard.deliverables.map((item: any) => item.item)).not.toContain("character_portraits");
    expect(result.deliveryStandard.deliverables[0].spec).not.toMatch(/1080p|24fps/u);
    expect(result.creativeCore.keyMessages.join(" ")).not.toMatch(/没有中心的系统|Local control\. Privacy|三行原文|摘自 Home Assistant/u);
    expect(result.creativeCore.keyMessages.join(" ")).toContain("G1 已审连续原句");
    expect(result.scenePlan.scenes[0].purpose).toContain("保留两格空位作为悬念");
    expect(result.scenePlan.scenes[0].visualRequirements.join(" ")).toContain("不显示中文说明字幕");
    expect(result.scenePlan.scenes[0].purpose).toContain("明确连续半句");
    expect(result.scenePlan.scenes[1].purpose).toContain("屏幕上只连续显示 https://github.com/home-assistant/core");
    expect(result.scenePlan.scenes[1].visualRequirements.join(" ")).toContain("全片唯一完整呈现两行官方自述原句");
  });

  it("fails closed instead of silently changing the approved scene count", () => {
    expect(() => normalizeMarketingPrdContract(prd(), {
      builtinCharacterSelection: { mode: "none" },
    }, {}, { scenes: [{ id: "opening" }] })).toThrow(/SCENE_AUTHORITY_CHANGED/);
  });
});
