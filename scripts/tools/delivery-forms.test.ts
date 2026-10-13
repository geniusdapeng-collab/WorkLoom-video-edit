import { describe, expect, it } from "vitest";
import { DANMAKU_PUBLISH_NOTE, PUBLISH_NOTE, danmakuFormFile, recommendedDanmakuFile, recommendedPublishFile, resolveBurnSubtitles } from "./lib/delivery-forms.mts";

/**
 * 交付形态默认口径（T-2026-1012-0001）：字幕默认烧录。
 *
 * 事故背景：交付包里的「软字幕轨」形态在 macOS 上默认不显示字幕
 * （AVFoundation 自动选择实测为「无」；Quick Look / QuickTime 预览都不自动打开字幕轨），
 * 用户把文件发给别人时，对方看到的成片"没有字幕"——与文件名不符。
 */
describe("交付形态默认口径：提供字幕时默认烧字", () => {
  it("提供字幕 → 默认烧字（成片自带字幕，任何播放器/预览器直接可见）", () => {
    expect(resolveBurnSubtitles({ subtitleProvided: true })).toBe(true);
  });

  it("--no-burn-subtitles → 退回纯软字幕轨（剪辑/平台字幕轨场景）", () => {
    expect(resolveBurnSubtitles({ subtitleProvided: true, noBurnFlag: true })).toBe(false);
  });

  it("保留 --burn-subtitles 兼容开关：显式传入与默认行为一致", () => {
    expect(resolveBurnSubtitles({ subtitleProvided: true, burnFlag: true })).toBe(true);
    expect(resolveBurnSubtitles({ subtitleProvided: true, burnFlag: true, noBurnFlag: true })).toBe(false);
  });

  it("没有字幕文件时不产出烧字形态", () => {
    expect(resolveBurnSubtitles({ subtitleProvided: false })).toBe(false);
    expect(resolveBurnSubtitles({ subtitleProvided: false, burnFlag: true })).toBe(false);
  });
});

describe("推荐发布件：烧字 + 封面烧封", () => {
  it("默认（有封面烧封）指向 variants/<id>/<id>.burned.cover.mp4", () => {
    expect(recommendedPublishFile("warm-story")).toBe("variants/warm-story/warm-story.burned.cover.mp4");
    expect(recommendedPublishFile("segmented-story", true)).toBe("variants/segmented-story/segmented-story.burned.cover.mp4");
  });

  it("未烧封封面时退化为 variants/<id>/<id>.burned.mp4", () => {
    expect(recommendedPublishFile("clean-tech", false)).toBe("variants/clean-tech/clean-tech.burned.mp4");
  });

  it("发布口径说明必须同时写明「已烧录」与「软字幕轨限制」", () => {
    expect(PUBLISH_NOTE).toContain("烧录");
    expect(PUBLISH_NOTE).toContain("软字幕轨");
    expect(PUBLISH_NOTE).toContain("默认不显示字幕轨");
  });
});

/**
 * 弹幕形态（T-2026-1013-0002 / 审计 F5）：弹幕此前只在独立工位存在，交付包里没有弹幕形态。
 * 现在形态命名与推荐件由同一处口径产出，`edit:post --danmaku` 出「烧字+弹幕」、`edit:cover` 再叠封面。
 */
describe("弹幕形态：与字幕/封面同构的后缀叠加", () => {
  it("烧字 + 弹幕 → variants/<id>/<id>.burned.danmaku.mp4", () => {
    expect(danmakuFormFile("warm-story", { burnedSubtitles: true })).toBe("variants/warm-story/warm-story.burned.danmaku.mp4");
  });

  it("无烧字（无字幕或 --no-burn-subtitles）→ variants/<id>/<id>.danmaku.mp4", () => {
    expect(danmakuFormFile("clean-tech", { burnedSubtitles: false })).toBe("variants/clean-tech/clean-tech.danmaku.mp4");
  });

  it("推荐弹幕发布件 = 烧字 + 弹幕 + 封面烧封", () => {
    expect(recommendedDanmakuFile("bold-promo")).toBe("variants/bold-promo/bold-promo.burned.danmaku.cover.mp4");
    expect(recommendedDanmakuFile("bold-promo", false)).toBe("variants/bold-promo/bold-promo.burned.danmaku.mp4");
  });

  it("弹幕口径说明写明「再烧一层」与「原形态保留」", () => {
    expect(DANMAKU_PUBLISH_NOTE).toContain("再烧一层弹幕");
    expect(DANMAKU_PUBLISH_NOTE).toContain("保留");
  });
});
