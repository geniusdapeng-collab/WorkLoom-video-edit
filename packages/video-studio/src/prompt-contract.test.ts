import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SHOT_FIELD_SCHEMA_V1,
  SHOT_FIELD_SCHEMA_V2,
  promptFieldPolicy,
  sha256Text,
  validatePromptContract,
} from "./prompt-contract.js";
import {
  compilePromptShot,
  type PromptCompileAsset,
  type PromptCompileOptions,
  type PromptCompileShot,
} from "./prompt-compiler.js";

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const contentFields: Record<string, unknown> = {
  director_instruction: "写实纪录片方向，人物与环境均按真实物理关系呈现。",
  constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
  baseline: "电影级写实基础，细节清晰，皮肤纹理自然。",
  scene: "清晨临水回廊，薄雾贴着水面缓慢移动。",
  lighting: "侧后方晨光穿过木格窗，水面提供柔和反射补光。",
  camera_movement: "固定机位，轻微呼吸感，不进行推拉摇移。",
  character: "林夏穿着浅色亚麻衬衫，从回廊尽头走入画面。",
  action: "林夏停在栏杆旁，抬手触碰木纹后安静看向水面。",
  portraits: ["image://characters/linxia/front.png"],
  dialogue: "无台词；只保留脚步声、水声与鸟鸣。",
  negative: "no text, no watermark, no logo, no duplicate person",
  consistency: "保持林夏的脸型、发型、服装和回廊空间一致。",
  composition: "竖版三分构图，人物位于右侧三分线，水面形成前中景层次。",
  color_palette: "冷灰水面、浅木色回廊、低饱和亚麻色。",
  depth_of_field: "中景清晰，近处栏杆轻微虚化，远处树影柔和。",
  timeline: "T00:00至T00:05，人物进入并在T00:04停稳。",
  mood: "安静、克制、清晨未醒的松弛感。",
  bright_constraint: "人物面部与水面反光保持清晰，不出现过曝。",
  character_constraint: "只出现林夏一个主体人物，不增加其他角色。",
  costume: "浅色亚麻衬衫与深色长裤，面料纹理自然。",
  props: "木质栏杆、薄雾、水面落叶，均为真实空间道具。",
  pacing: "前段慢，后段停稳，整体节奏均匀。",
  audio: "环境水声、鸟鸣、脚步声，无背景音乐。",
  makeup: "自然裸妆，保留真实皮肤纹理。",
  transition: "硬切入镜，结尾保持稳定供下一镜硬切。",
};

const openingFields: Record<string, unknown> = {
  ...contentFields,
  title_content: "水先醒",
  subtitle_content: "一座园林的清晨",
  title_animation: "标题以扫描线逐字出现，T00:03停稳。",
  title_font_design: "克制的中文衬线体，冷白发光，边缘清晰。",
  opening_audio_design: "仅保留水声和鸟鸣，无配乐与人声。",
};

const assetBytes = Buffer.from("real-portrait-bytes");
const assets: PromptCompileAsset[] = [{
  field: "portraits",
  role: "reference_image",
  sha256: digest(assetBytes),
  bytes: assetBytes.length,
  mediaType: "image/png",
  sourceRef: "characters/linxia/front.png",
}];

const model: PromptCompileOptions["model"] = {
  modelId: "doubao-seedance-2-5",
  provider: "seedance",
  providerModel: "doubao-seedance-2-5-260628",
  version: "media-catalog/v1:2026-11-01",
  modes: ["t2v", "i2v", "r2v"],
  durationSec: { min: 4, max: 30 },
  aspectRatios: ["9:16", "16:9"],
  resolutions: ["720p", "1080p"],
  maxReferenceImages: 30,
  maxPromptChars: 4000,
};

const options: PromptCompileOptions = {
  delivery: {
    aspectRatio: "9:16",
    resolution: "1080p",
    fps: 30,
    format: "mp4",
    generateAudio: true,
  },
  model,
  assets,
  createdAt: "2026-11-01T00:00:00.000Z",
};

function shot(overrides: Partial<PromptCompileShot> = {}): PromptCompileShot {
  return {
    shotId: "S01",
    sceneType: "content",
    duration: 5,
    fields: contentFields,
    portraits: contentFields.portraits,
    ...overrides,
  };
}

describe("versioned 25/30 prompt field policy", () => {
  it("keeps v1 and v2 semantics distinct instead of rewriting historical runs", () => {
    expect(promptFieldPolicy(SHOT_FIELD_SCHEMA_V1, false).fieldCount).toBe(25);
    expect(promptFieldPolicy(SHOT_FIELD_SCHEMA_V1, true).fieldCount).toBe(25);
    expect(promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, false).fieldCount).toBe(25);
    const opening = promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, true);
    expect(opening.fieldCount).toBe(30);
    expect(opening.fields.slice(-5).map((field) => field.key)).toEqual([
      "title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design",
    ]);
  });

  it("declares prompt, request, asset, downstream and eligibility channels in code", () => {
    const fields = new Map(promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, true).fields.map((field) => [field.key, field]));
    expect(fields.get("portraits")?.channels).toEqual(expect.arrayContaining(["prompt", "asset", "eligibility"]));
    expect(fields.get("constraint")?.channels).toEqual(expect.arrayContaining(["prompt", "request", "eligibility"]));
    expect(fields.get("transition")?.channels).toEqual(expect.arrayContaining(["prompt", "downstream"]));
    expect(fields.get("title_content")?.channels).toEqual(expect.arrayContaining(["prompt", "downstream"]));
  });
});

describe("deterministic prompt and request compiler", () => {
  it("compiles all 25 content fields into stable prompt, request and binding hashes", () => {
    const first = compilePromptShot(shot(), options);
    const second = compilePromptShot(shot(), options);
    expect(first.hardErrors).toEqual([]);
    expect(second.contract).toEqual(first.contract);
    expect(first.contract.fieldCount).toBe(25);
    expect(first.contract.bindings).toHaveLength(25);
    expect(first.prompt).toContain("【导演指令】");
    expect(first.prompt).toContain("【角色一致性】");
    expect(first.request.parameters).toMatchObject({
      duration_sec: 5,
      aspect_ratio: "9:16",
      resolution: "1080p",
      fps: 30,
      format: "mp4",
      generate_audio: true,
    });
    expect(first.contract.bindings.find((binding) => binding.field === "constraint")?.requestKeys)
      .toEqual(expect.arrayContaining(["parameters.aspect_ratio", "parameters.resolution"]));
    expect(first.contract.bindings.find((binding) => binding.field === "portraits")?.assets?.[0]).toMatchObject({
      sha256: digest(assetBytes), bytes: assetBytes.length, mediaType: "image/png",
    });
    expect(validatePromptContract(first.contract)).toEqual({ valid: true, errors: [] });
    expect(first.contract.promptSha256).toBe(sha256Text(first.prompt));
  });

  it("restores the five opening-only fields only under v2 and binds them to prompt plus downstream", () => {
    const result = compilePromptShot(shot({
      shotId: "S00",
      sceneType: "opening",
      fields: openingFields,
      portraits: openingFields.portraits,
    }), options);
    expect(result.hardErrors).toEqual([]);
    expect(result.contract.fieldSchema).toBe(SHOT_FIELD_SCHEMA_V2);
    expect(result.contract.fieldCount).toBe(30);
    expect(result.prompt).toContain("【主标题内容】水先醒");
    expect(result.contract.bindings.slice(-5).every((binding) =>
      binding.channels.includes("downstream") && binding.downstreamSpec)).toBe(true);
  });

  it("rejects missing, unknown, placeholder, object leakage and model capability defects", () => {
    const missing = { ...contentFields };
    delete missing.scene;
    const broken = {
      ...contentFields,
      lighting: { key_light: "[object Object]" },
      unknown_contract_field: "not allowed",
    };
    const cases: Array<[PromptCompileShot, Partial<PromptCompileOptions>, string]> = [
      [shot({ fields: missing }), {}, "HARD_FIELD_VALUE_MISSING"],
      [shot({ fields: broken }), {}, "HARD_FIELD_UNKNOWN"],
      [shot(), { delivery: { ...options.delivery, aspectRatio: "21:9" } }, "HARD_ASPECT_UNSUPPORTED"],
      [shot({ duration: 31 }), {}, "HARD_DURATION_UNSUPPORTED"],
      [shot({ fields: { ...contentFields, portraits: ["image://remote"] } }), { assets: [] }, "HARD_ASSET_MISSING"],
    ];
    for (const [value, patch, code] of cases) {
      const result = compilePromptShot(value, { ...options, ...patch });
      expect(result.hardErrors.some((error) => error.code === code)).toBe(true);
    }
  });

  it("rejects cross-field contradictions before semantic review", () => {
    const cases = [
      shot({ fields: { ...contentFields, timeline: "T00:00至T00:12，结尾停稳。" } }),
      shot({ fields: { ...contentFields, constraint: "16:9画幅，1080x1920，30fps，MP4格式。" } }),
    ];
    expect(compilePromptShot(cases[0]!, options).hardErrors.some((error) => error.code === "HARD_TIMELINE_EXCEEDS_DURATION")).toBe(true);
    expect(compilePromptShot(cases[1]!, options).hardErrors.some((error) => error.code === "HARD_CONSTRAINT_ASPECT_CONFLICT")).toBe(true);
    expect(compilePromptShot(shot({ fields: { ...contentFields, dialogue: "林夏轻声说：水先醒了。" } }), {
      ...options,
      delivery: { ...options.delivery, generateAudio: false },
    }).hardErrors.some((error) => error.code === "HARD_DIALOGUE_WITHOUT_AUDIO")).toBe(true);
  });

  it("supports an explicit no-person portraits marker without pretending external text is image bytes", () => {
    const result = compilePromptShot(shot({
      fields: {
        ...contentFields,
        character: "全片无人，不出现人物。",
        portraits: "NONE",
        character_constraint: "禁止人物入镜。",
      },
      portraits: "NONE",
    }), { ...options, assets: [] });
    expect(result.hardErrors).toEqual([]);
    expect(result.request.inputMode).toBe("text");
    expect(result.contract.bindings.find((binding) => binding.field === "portraits")).toMatchObject({
      assetApplicability: "not_applicable",
      assets: [],
    });
  });

  it("invalidates the contract when the same-size asset bytes change", () => {
    const original = compilePromptShot(shot(), options);
    const replacement = Buffer.alloc(assetBytes.length, 9);
    const changed: PromptCompileAsset = { ...assets[0]!, sha256: digest(replacement), bytes: replacement.length };
    const next = compilePromptShot(shot(), { ...options, assets: [changed] });
    expect(next.contract.promptSha256).toBe(original.contract.promptSha256);
    expect(next.contract.fieldsSha256).not.toBe(original.contract.fieldsSha256);
  });

  it("runs 20 positive and 20 missing-field regression cases without sharing state", () => {
    for (let index = 1; index <= 20; index += 1) {
      const result = compilePromptShot(shot({ shotId: `S${String(index).padStart(2, "0")}` }), options);
      expect(result.hardErrors).toEqual([]);
    }
    for (const key of Object.keys(contentFields).slice(0, 20)) {
      const brokenFields = { ...contentFields };
      delete brokenFields[key];
      const brokenSource = shot({ fields: brokenFields, ...(key === "portraits" ? { portraits: undefined } : {}) });
      expect(compilePromptShot(brokenSource, options).hardErrors.some((error) =>
        error.field === key || error.code === "HARD_FIELD_VALUE_MISSING")).toBe(true);
    }
  });
});

describe("authorized title-card applicability and frozen delivery", () => {
  it("keeps the actual opening action and uses 25 fields when the title card is disabled", () => {
    const source = shot({ shotId: "opening", sceneType: "opening" });
    const compiled = compilePromptShot(source, { ...options, titleCard: false });
    expect(compiled.hardErrors).toEqual([]);
    expect(compiled.contract.fieldCount).toBe(25);
    expect(compiled.prompt).toContain(String(source.fields.action));
    expect(compiled.prompt).not.toMatch(/主标题|副标题|标题动画|标题字体|开场音频设计/);
    expect(validatePromptContract(compiled.contract).valid).toBe(true);
    expect(compilePromptShot(source, options).hardErrors).toContainEqual(expect.objectContaining({ field: "title_content" }));
    expect(compilePromptShot({ ...source, fields: openingFields }, { ...options, titleCard: false }).hardErrors)
      .toContainEqual(expect.objectContaining({ field: "title_content", code: "HARD_FIELD_UNKNOWN" }));
  });

  it("projects the stale native 4K/24 technical template only when the frozen source explicitly applies", () => {
    const source = shot({ fields: { ...contentFields, constraint: "9:16画幅，4K分辨率，24fps，MP4格式" } });
    expect(compilePromptShot(source, options).hardErrors).toContainEqual(expect.objectContaining({ code: "HARD_CONSTRAINT_FPS_CONFLICT" }));
    const compiled = compilePromptShot(source, { ...options, applyFrozenDelivery: true });
    expect(compiled.hardErrors).toEqual([]);
    expect(compiled.fieldValues.constraint).toBe("9:16画幅，1080p分辨率，30fps，MP4格式");
    expect(compiled.contract.request.parameters).toMatchObject({ aspect_ratio: "9:16", resolution: "1080p", fps: 30, format: "mp4" });
    expect(compilePromptShot({ ...source, fields: compiled.fieldValues }, options).contract.fieldsSha256)
      .toBe(compiled.contract.fieldsSha256);
    expect(source.fields.constraint).toBe("9:16画幅，4K分辨率，24fps，MP4格式");
    const ambiguous = shot({ fields: { ...contentFields, constraint: `${source.fields.constraint}；用其他播放速度。` } });
    expect(compilePromptShot(ambiguous, { ...options, applyFrozenDelivery: true }).hardErrors)
      .toContainEqual(expect.objectContaining({ code: "HARD_CONSTRAINT_FPS_CONFLICT" }));
  });
  it("binds the no-speech declaration while removing only a known host annotation and refusing an injected voice", () => {
    const authorAudio = "仅保留引擎、轮胎与看台原生环境声。";
    const dialogue = "无台词（全片无对白、无口播、无旁白）。";
    const source = shot({ fields: { ...contentFields, dialogue,
      audio: `${authorAudio}；【音频纪律】本镜头音频仅允许：台词人声、旁白、环境音效与动作音` } });
    const compiled = compilePromptShot(source, options);
    expect(compiled.hardErrors).toEqual([]);
    expect(compiled.contract.request.technical.audio).toBe(authorAudio);
    expect(compiled.contract.request.technical.dialogue).toBe(dialogue);
    expect(compiled.prompt).toContain("不得出现台词/旁白/口播与可辨词句人声");
    expect(compiled.prompt).not.toContain("仅允许：台词人声");
    expect(compilePromptShot({ ...source, fields: { ...source.fields, audio: `人声对话清晰可辨，${authorAudio}` } }, options).hardErrors)
      .toContainEqual(expect.objectContaining({ code: "HARD_DIALOGUE_AUDIO_CONFLICT", field: "audio" }));
    const realSpeech = compilePromptShot(shot({ fields: { ...contentFields, dialogue: "无台词。她说：我赢了。", audio: "人声对话清晰可辨。" } }), options);
    expect(realSpeech.prompt).not.toContain("不得出现台词/旁白/口播与可辨词句人声");
  });
});
