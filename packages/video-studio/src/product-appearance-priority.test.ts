import { describe, expect, it } from "vitest";
import {
  PRODUCT_APPEARANCE_PRIORITY_CLAUSE,
  isProductAppearanceRedactionPatch,
  reconcileProductAppearancePrompt,
} from "./product-appearance-priority.js";

describe("商品真实外观优先级", () => {
  it("用真实参考涂装与既有标识覆盖通用的无标识/无涂装冲突", () => {
    const result = reconcileProductAppearancePrompt([
      "车身与整流罩不出现分色赛车涂装、贴花、赞助商标识与任何可读字标。",
      "生成画面内无任何生成文字、字幕、标题卡、logo、水印与可读数字。",
      "商品外观仅作权利安全示意。",
    ].join("\n"));
    expect(result.applied).toBe(true);
    expect(result.prompt).toContain("真实可见的涂装、贴花、品牌字标、车身号码与既有赞助标识");
    expect(result.prompt).toContain("除商品参考中真实可见的车身字标、号码与赞助标识外，不新增");
    expect(result.prompt).toContain("商品外观以本次绑定真实商品参考为准");
    expect(result.prompt).toContain(PRODUCT_APPEARANCE_PRIORITY_CLAUSE);
    expect(result.replacements).toEqual(expect.arrayContaining([
      "preserve-real-livery-and-marks",
      "split-generated-overlays-from-product-marks",
      "real-product-over-conceptual-silhouette",
      "append-priority-clause",
    ]));
  });

  it("重复归一不重复追加优先级条款", () => {
    const first = reconcileProductAppearancePrompt("不复制来源涂装、贴花与赞助标识。");
    const second = reconcileProductAppearancePrompt(first.prompt);
    expect(second.prompt).toBe(first.prompt);
    expect(second.prompt.match(/【商品外观优先级】/g)).toHaveLength(1);
  });

  it("识别要求删除真实外观的审核补丁", () => {
    expect(isProductAppearanceRedactionPatch("删除商品参考中对真实涂装和品牌字标的精确还原要求")).toBe(true);
    expect(isProductAppearanceRedactionPatch("补充骑手双脚踩脚踏与膝夹油箱的接触约束")).toBe(false);
  });
});
