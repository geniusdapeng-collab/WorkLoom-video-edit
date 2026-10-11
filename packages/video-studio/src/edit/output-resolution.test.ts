import { describe, expect, it } from "vitest";
import { decideOutputResolution } from "./output-resolution.js";

/** 4K 竖拍素材（本仓事故现场：IMG_2594 的 SDR 母版就是 2160×3840） */
const vertical4k = { sourceId: "src-4k", width: 2160, height: 3840 };

describe("edit/output-resolution：默认跟随素材原生分辨率", () => {
  it("不传显式分辨率 → 取与 9:16 一致的素材档位，清晰度档自动 uhd", () => {
    const decision = decideOutputResolution({
      targetAspectRatio: "9:16",
      sources: [vertical4k],
    });
    expect(decision.hardFailures).toEqual([]);
    expect(decision.width).toBe(2160);
    expect(decision.height).toBe(3840);
    expect(decision.quality).toBe("uhd");
    expect(decision.policy).toContain("source-max");
    expect(decision.downscale).toBe(false);
  });

  it("横向 4K 与竖向 4K 同在时，按目标画幅 9:16 挑竖向档位（不按面积瞎挑）", () => {
    const decision = decideOutputResolution({
      targetAspectRatio: "9:16",
      sources: [{ sourceId: "src-h", width: 3840, height: 2160 }, vertical4k],
    });
    expect([decision.width, decision.height]).toEqual([2160, 3840]);
  });
});

describe("edit/output-resolution：显式降分辨率必须声明（fail closed）", () => {
  it("4K 素材 + 显式 1080×1920 且未声明 → 硬失败，且指名 --allow-downscale 与产品口径", () => {
    const decision = decideOutputResolution({
      targetAspectRatio: "9:16",
      sources: [vertical4k],
      explicit: { width: 1080, height: 1920 },
    });
    expect(decision.hardFailures).toHaveLength(1);
    expect(decision.hardFailures[0]).toContain("--allow-downscale");
    expect(decision.hardFailures[0]).toContain("2160×3840");
    expect(decision.downscale).toBe(true);
    expect(decision.downscaleApproved).toBe(false);
    /** 判定信息仍完整返回，供调用方/回执记录 */
    expect([decision.width, decision.height]).toEqual([1080, 1920]);
    expect(decision.scaleVersusSource).toBeCloseTo(0.5, 3);
  });

  it("显式声明 --allow-downscale → 放行，但回执必须带降分辨率与缩放比", () => {
    const decision = decideOutputResolution({
      targetAspectRatio: "9:16",
      sources: [vertical4k],
      explicit: { width: 1080, height: 1920 },
      allowDownscale: true,
    });
    expect(decision.hardFailures).toEqual([]);
    expect(decision.downscale).toBe(true);
    expect(decision.downscaleApproved).toBe(true);
    expect(decision.policy).toContain("素材原生 2160×3840");
  });

  it("显式等于原生分辨率 → 不算降分辨率，也不报警", () => {
    const decision = decideOutputResolution({
      sources: [vertical4k],
      explicit: { width: 2160, height: 3840 },
    });
    expect(decision.hardFailures).toEqual([]);
    expect(decision.downscale).toBe(false);
    expect(decision.scaleVersusSource).toBeCloseTo(1, 3);
  });

  it("显式高于原生分辨率 → 只给咨询项（上采样不增加清晰度）", () => {
    const decision = decideOutputResolution({
      sources: [{ sourceId: "src-hd", width: 1080, height: 1920 }],
      explicit: { width: 2160, height: 3840 },
    });
    expect(decision.hardFailures).toEqual([]);
    expect(decision.advisories.some((note) => note.includes("上采样"))).toBe(true);
  });

  it("素材不可探测 → 回退 1080p 并在咨询项里如实标注", () => {
    const decision = decideOutputResolution({ sources: [{ sourceId: "src-x", width: null, height: null }] });
    expect([decision.width, decision.height]).toEqual([1920, 1080]);
    expect(decision.policy).toContain("fallback");
    expect(decision.advisories.some((note) => note.includes("不可探测"))).toBe(true);
  });

  it("只给一半显式参数 / 非法值 / 非法清晰度档都按口径处理", () => {
    const partial = decideOutputResolution({ sources: [vertical4k], explicit: { width: 1080 } });
    expect(partial.hardFailures).toEqual([]);
    expect([partial.width, partial.height]).toEqual([2160, 3840]);
    expect(partial.advisories.some((note) => note.includes("两个都给"))).toBe(true);

    const invalid = decideOutputResolution({ sources: [vertical4k], explicit: { width: "abc", height: 1080 } });
    expect(invalid.hardFailures[0]).toContain("必须为正数");

    const quality = decideOutputResolution({ sources: [vertical4k], quality: "8k" });
    expect(quality.hardFailures[0]).toContain("hd / uhd");
  });
});
