import { describe, expect, it } from "vitest";
import { compilePromptShot, type PromptCompileOptions, type PromptCompileShot } from "./prompt-compiler.js";

const fields = {
  director_instruction: "写实赛车广告，真实物理光照。",
  constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
  baseline: "电影级写实基础，细节清晰。",
  scene: "同一封闭赛道，整车静止在冷沥青上。",
  lighting: "阴天午后散射光与固定冷白补光，方向稳定。",
  camera_movement: "固定机位，全程不移动。",
  character: "无角色出场，仅拍整车。",
  action: "车辆完全静止，轮胎与地面接触稳定。",
  portraits: "无角色出场，无定妆照",
  dialogue: "无台词；只保留环境声。",
  negative: "no text, no watermark",
  consistency: "保持同一天、同一赛道与同一光位。",
  composition: "低机位中心对称全景，整车完整入画。",
  color_palette: "冷沥青灰与冷白轮廓光。",
  depth_of_field: "f/5.6 深景深，车身与背景轮廓清晰。",
  timeline: "T00:00至T00:04，整车保持静止。",
  mood: "冷酷、克制、冠军感。",
  bright_constraint: "车身轮廓明亮清晰，暗部保留细节。",
  character_constraint: "画面无人物。",
  costume: "无角色出场，不适用。",
  props: "整车、冷沥青地面。",
  pacing: "稳定静止，末段收束。",
  audio: "只有空旷赛道环境声，无音乐。",
  makeup: "无角色出场，不适用。",
  transition: "硬切进入，末帧稳定。",
};
const options: PromptCompileOptions = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model: {
    modelId: "doubao-seedance-2-5", provider: "seedance", providerModel: "doubao-seedance-2-5-260628",
    version: "fixture", modes: ["t2v"], durationSec: { min: 4, max: 30 }, aspectRatios: ["9:16"],
    resolutions: ["1080p"], maxReferenceImages: 30, maxPromptChars: 4000,
  },
  assets: [],
};

describe("no-person portrait declaration", () => {
  it("treats the native no-character field text as not applicable without an image asset", () => {
    const shot: PromptCompileShot = { shotId: "ending", duration: 4, fields };
    const result = compilePromptShot(shot, options);
    const portraits = result.contract.bindings.find(binding => binding.field === "portraits");
    expect(portraits?.assetApplicability).toBe("not_applicable");
    expect(portraits?.assets).toEqual([]);
    expect(result.hardErrors.some(error => error.code === "HARD_ASSET_MISSING")).toBe(false);
  });
});
