import { describe, expect, it } from "vitest";
import {
  buildCopyBrief, evaluateCopy, normalizePersona, resolveCopyProfile, resolveCopyStyle, rewriteCue,
  type CopyCue,
} from "./copy-style.js";

describe("edit/copy-style：字幕文案风格 × 人设", () => {
  it("风格解析：显式 id 优先，缺省按题材关键词兜底", () => {
    expect(resolveCopyStyle("promo").name).toBe("带货推荐");
    expect(resolveCopyStyle(null, "知识分享 测评").id).toBe("knowledge");
    expect(resolveCopyStyle(null, "美食探店").id).toBe("food");
    expect(resolveCopyStyle(null, "随手拍的日常").id).toBe("vlog");
  });

  it("人设档案归一化，禁用词合并（人设叠加风格）", () => {
    const persona = normalizePersona({ name: "山东姑娘", selfAddress: "我", verbalTics: ["俺跟你说"], bannedWords: ["绝绝子"] });
    expect(persona.verbalTics).toEqual(["俺跟你说"]);
    const profile = resolveCopyProfile({ styleId: "vlog", persona });
    expect(profile.bannedWords).toContain("绝绝子");
    expect(profile.bannedWords).toContain("让我们一起");
  });

  it("机检：AI 腔/书面语/标点/字数带都会报，人味越足分越高", () => {
    const profile = resolveCopyProfile({ styleId: "vlog", persona: { verbalTics: ["真"] } });
    const aiCues: CopyCue[] = [
      { index: 1, start: 0, end: 3, text: "让我们一起感受美好的氛围。" },
      { index: 2, start: 3, end: 6, text: "这里非常值得一试，品尝当地美食。" },
    ];
    const humanCues: CopyCue[] = [
      { index: 1, start: 0, end: 3, text: "风一停 整条街都安静了" },
      { index: 2, start: 3, end: 6, text: "羊汤就得趁热喝 真香" },
    ];
    const ai = evaluateCopy({ cues: aiCues, profile });
    const human = evaluateCopy({ cues: humanCues, profile });
    expect(ai.score).toBeLessThan(human.score);
    expect(ai.issues.some((issue) => issue.code === "ai-phrase")).toBe(true);
    expect(ai.issues.some((issue) => issue.code === "punctuation")).toBe(true);
    expect(human.issues.some((issue) => issue.code === "ai-phrase")).toBe(false);
    expect(human.metrics.oralMarkerRate).toBeGreaterThan(0.5);
  });

  it("机检：无事实支撑的数字标 fabrication-risk 且硬失败", () => {
    const profile = resolveCopyProfile({ styleId: "promo" });
    const result = evaluateCopy({
      cues: [{ index: 1, start: 0, end: 4, text: "今天直降99 还送两箱" }],
      profile,
      facts: { allowedTerms: ["羊汤", "果园"] },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "fabrication-risk")).toBe(true);
  });

  it("rewriteCue 只做安全口语替换并清掉行内标点", () => {
    const profile = resolveCopyProfile({ styleId: "vlog" });
    expect(rewriteCue("让我们一起品尝非常美味的羊汤。", profile)).toBe("咱们尝特别美味的羊汤");
  });

  it("写作简报把风格/目标/人设/禁用/镜头事实/原字幕一次交底", () => {
    const profile = resolveCopyProfile({ styleId: "food", persona: { identity: "山东姑娘", audience: "同龄朋友", verbalTics: ["真"] } });
    const brief = buildCopyBrief({
      profile,
      cues: [{ index: 1, start: 0, end: 3, text: "品尝羊汤" }],
      facts: { allowedTerms: ["羊汤"], shots: [{ segmentId: "seg-001", summary: "羊汤特写 热气" }] },
      goal: "种草",
      platform: "视频号",
    });
    expect(brief).toContain("美食探店");
    expect(brief).toContain("山东姑娘");
    expect(brief).toContain("禁用");
    expect(brief).toContain("seg-001：羊汤特写 热气");
    expect(brief).toContain("1. 品尝羊汤");
  });
});
