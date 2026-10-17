import { describe, expect, it } from "vitest";
import {
  buildArtifactName, buildDeliveryIndexMarkdown, resolutionBadge, sanitizeNamePart, variantDisplayName,
} from "./naming.js";

describe("edit/naming：交付文件命名规范", () => {
  it("分辨率徽标按短边实测换算（4K/2K/1080P/720P）", () => {
    expect(resolutionBadge({ width: 3840, height: 2160 })).toBe("4K");
    expect(resolutionBadge({ width: 2160, height: 3840 })).toBe("4K");
    expect(resolutionBadge({ width: 2560, height: 1440 })).toBe("2K");
    expect(resolutionBadge({ width: 1920, height: 1080 })).toBe("1080P");
    expect(resolutionBadge({ width: 1280, height: 720 })).toBe("720P");
    expect(resolutionBadge({ width: 0, height: 0 })).toBe("未知分辨率");
  });

  it("中文名 = 片名·版本名·核心特点·分辨率·版本号", () => {
    expect(buildArtifactName({
      title: "别人挤景区，我回村摘苹果",
      variantName: "暖心版",
      feature: "带字幕",
      resolution: { width: 3840, height: 2160 },
      version: "V10",
      ext: ".mp4",
    })).toBe("别人挤景区我回村摘苹果·暖心版·带字幕·4K·V10.mp4");
  });

  it("预览件标注真实分辨率与「预览」，不用交付分辨率冒充", () => {
    expect(buildArtifactName({
      title: "别人挤景区，我回村摘苹果",
      variantName: "暖心版",
      feature: "带字幕",
      resolution: { width: 1920, height: 1080 },
      version: "V10",
      preview: true,
      ext: "mp4",
    })).toBe("别人挤景区我回村摘苹果·暖心版·带字幕·1080P·预览·V10.mp4");
  });

  it("没有像素尺寸的产物（字幕文件）可省略分辨率段，而不是写「未知分辨率」", () => {
    expect(buildArtifactName({
      title: "别人挤景区，我回村摘苹果",
      feature: "字幕文件",
      resolution: null,
      omitUnknownResolution: true,
      version: "V10",
      ext: "srt",
    })).toBe("别人挤景区我回村摘苹果·字幕文件·V10.srt");
  });

  it("母版/封面/字幕文件都有稳定词表", () => {
    expect(buildArtifactName({
      title: "别人挤景区，我回村摘苹果", feature: "干净母版", resolution: { width: 3840, height: 2160 }, version: "V10", ext: "mp4",
    })).toContain("干净母版·4K·V10");
    expect(buildArtifactName({
      title: "别人挤景区，我回村摘苹果", variantName: "分段调色版", feature: "双色分段封面", resolution: { width: 3840, height: 2160 }, version: "V10", ext: "png",
    })).toBe("别人挤景区我回村摘苹果·分段调色版·双色分段封面·4K·V10.png");
  });

  it("清洗路径分隔符/空白，片名过长按上限裁剪且不会产生空文件名", () => {
    expect(sanitizeNamePart("a/b:c d\\e")).toBe("abcde");
    const name = buildArtifactName({ title: "x".repeat(40), feature: "带字幕", resolution: { width: 1920, height: 1080 }, ext: "mp4" });
    expect(name.startsWith("x".repeat(24))).toBe(true);
    expect(name.endsWith("·带字幕·1080P.mp4")).toBe(true);
    expect(buildArtifactName({ title: "  ", feature: "带字幕", resolution: null, ext: "mp4" })).toBe("未命名·带字幕·未知分辨率.mp4");
  });

  it("变体名走统一词表；交付说明把推荐发布的带字幕版列在前面", () => {
    expect(variantDisplayName("segmented-story")).toBe("分段调色版");
    const markdown = buildDeliveryIndexMarkdown({
      title: "别人挤景区我回村摘苹果",
      version: "V10",
      platform: "视频号",
      resolution: { width: 3840, height: 2160 },
      generatedAt: "2026-10-11T00:00:00.000Z",
      artifacts: [
        { source: "/tmp/a.mp4", displayName: "别人挤景区我回村摘苹果·干净母版·无字幕·4K·V10.mp4", role: "master" },
        { source: "/tmp/b.mp4", displayName: "别人挤景区我回村摘苹果·暖心版·带字幕·4K·V10.mp4", role: "burned", variantId: "warm-story" },
      ],
    });
    expect(markdown).toContain("推荐直接发布：带字幕成片");
    expect(markdown.indexOf("推荐直接发布：带字幕成片")).toBeLessThan(markdown.indexOf("干净母版（不含烧录字幕）"));
    expect(markdown).toContain("分辨率：3840×2160（4K）");
  });
});
