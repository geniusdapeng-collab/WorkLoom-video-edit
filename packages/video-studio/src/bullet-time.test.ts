import { describe, expect, it } from "vitest";
import {
  BULLET_TIME_META_KEY,
  BULLET_TIME_POLICY_VERSION,
  bulletTimeReferenceClause,
  bulletTimeReferencePlan,
  compileBulletTimeShot,
  inspectBulletTimeMotion,
  validateBulletTimeContract,
  validateBulletTimePrompt,
  type BulletTimeContract,
} from "./bullet-time.js";
import { prepareShotPrompt } from "./shot-spec.js";

const contract = (): BulletTimeContract => ({
  schemaVersion: "workloom.video-studio/bullet-time/v1",
  enabled: true,
  mode: "freeze_orbit",
  narrative: {
    purpose: "把起步前的犹豫与决断拉成可观察的主观时间",
    whyNotNormalCut: "普通切镜只能看到结果，无法同时保留姿态、服装和空间关系",
    viewerTakeaway: "她停顿了一下，但方向已经决定",
  },
  time: {
    subjectTime: "near_freeze",
    subjectTimeRange: { start: 0.75, end: 3.5 },
    entrySeconds: 0.75,
    exitSeconds: 0.5,
    timeReturn: "smooth",
    motionLayers: {
      face: "locked",
      body: "locked",
      hairTips: "very_slow",
      fabricHem: "very_slow",
      background: "locked",
      ambientParticles: "not_applicable",
    },
  },
  camera: {
    movement: "continuous_orbit",
    direction: "clockwise",
    startView: "人物右前方四分之三视角",
    endView: "人物左侧面",
    approxArcDegrees: 100,
    height: "胸腰高度",
    speed: "slow_constant",
    cuts: 0,
    focusBehavior: "脸和上身服装保持可读",
    narrativeReveal: "从眼神、前襟绕到肩线、衣摆和马尾",
  },
  generation: {
    inputMode: "reference-image",
    durationSeconds: 5,
    maxContinuousOrbit: 120,
    characterReferenceSet: ["actionPose", "front", "threeQuarter", "side"],
    previsReference: { requested: false, purpose: "camera_and_timing_only" },
  },
  entryExit: {
    entryAction: "右脚刚落地，重心开始前移",
    exitAction: "完成同方向的一小步",
    exitMustMatchNextShot: false,
  },
  quality: {
    mustBePhotoreal: true,
    mustPreserveIdentity: true,
    mustPreserveWardrobe: true,
    mustPreservePropState: true,
    mustHaveRealParallax: true,
    mustHaveSubjectNearFreeze: true,
    mustHaveLayerMicroMotion: true,
    mustNotContainBgm: true,
  },
  audioPolicy: "diegetic_only",
  fallback: {
    ifNoContinuousOrbit: "guided_orbit",
    ifNoModelSupport: "editorial_fake",
    mustRelabelInUi: true,
  },
});

const card = () => ({
  shotId: "BT-01",
  duration: 5,
  sceneType: "establishing",
  director_instruction: "把起步前的犹豫与决断拉成可观察的主观时间",
  constraint: "9:16画幅，1080x1920，24fps，MP4，无文字、无水印、无字幕",
  baseline: "真实电影质感，材质层次自然",
  scene: "浅灰无缝摄影棚",
  lighting: "左前方柔光，右后方轻轮廓光",
  composition: "右前方四分之三中全身",
  color_palette: "中性低饱和电影色彩",
  depth_of_field: "主体清晰，背景轻微柔化",
  character: "原创虚构成年女性，黑色高马尾",
  costume: "黑色夹克、白T、深炭灰长裤和黑靴",
  makeup: "自然轻薄日常妆，皮肤纹理真实",
  action: "右脚落地，重心开始前移",
  props: "本镜没有手持道具",
  portraits: ["portrait:actionPose", "portrait:front", "portrait:threeQuarter", "portrait:side"],
  dialogueFree: true,
  camera_movement: "缓慢环绕",
  timeline: "真实动作进入，时间压慢",
  mood: "安静专注；眼神保持原注视点，肩线稳定",
  pacing: "主体压慢，摄影机持续",
  transition: "入口为右脚落地，出口为完成一小步",
  audio: "脚步与布料声",
  negative: "无文字、无水印、无换脸、无换装",
  bright_constraint: "主体不死黑，高光不过曝",
  character_constraint: "始终只有一个人，禁止分身",
  consistency: "保持同一身份、服装、道具、光源和空间轴向",
  bulletTime: contract(),
});

describe("bullet-time contract", () => {
  it("accepts a complete subject-freeze plus camera-orbit contract", () => {
    const result = validateBulletTimeContract(contract(), { shot: card() });
    expect(result.valid).toBe(true);
    expect(result.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inspectBulletTimeMotion(card())).toMatchObject({ valid: true, subjectFrozen: true, cameraMoving: true, motionException: true });
  });

  it("keeps normal lock-off shots fail-closed when no contract exists", () => {
    const inspection = inspectBulletTimeMotion({ timeline: "定住", camera_movement: "环绕" });
    expect(inspection.enabled).toBe(false);
    expect(inspection.motionException).toBe(false);
  });

  it.each([
    ["camera cuts", (value: BulletTimeContract) => { (value.camera as { cuts: number }).cuts = 1; }, "BULLET_TIME_CUTS_REQUIRED_ZERO"],
    ["missing exit action", (value: BulletTimeContract) => { value.entryExit.exitAction = ""; }, "BULLET_TIME_EXIT_ACTION_MISSING"],
    ["false BGM policy", (value: BulletTimeContract) => { value.audioPolicy = "scene_music_allowed"; }, "BULLET_TIME_AUDIO_CONTRADICTION"],
    ["too many refs", (value: BulletTimeContract) => { value.generation.characterReferenceSet = ["front", "side", "back", "actionPose", "closeup"]; }, "BULLET_TIME_REFERENCE_LIMIT"],
    ["no micro motion", (value: BulletTimeContract) => { value.time.motionLayers.hairTips = "locked"; value.time.motionLayers.fabricHem = "locked"; value.time.motionLayers.ambientParticles = "locked"; }, "BULLET_TIME_LAYER_MOTION_MISSING"],
  ])("rejects %s", (_name, mutate, code) => {
    const value = contract();
    mutate(value);
    const result = validateBulletTimeContract(value, { shot: card() });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  });

  it("rejects unsupported reference video instead of silently dropping it", () => {
    const value = contract();
    value.generation.inputMode = "reference-video";
    value.generation.previsReference = { requested: true, purpose: "camera_and_timing_only" };
    expect(validateBulletTimeContract(value, { shot: card() }).issues.map((issue) => issue.code))
      .toEqual(expect.arrayContaining(["BULLET_TIME_INPUT_MODE_UNAVAILABLE", "BULLET_TIME_PREVIS_UNAVAILABLE"]));
  });

  it("plans an ordered four-angle reference set without inventing bytes", () => {
    const plan = bulletTimeReferencePlan(card());
    expect(plan).toMatchObject({ applicable: true, valid: true, inputMode: "reference-image", maxImages: 4 });
    expect(plan.angles).toEqual(["actionPose", "front", "threeQuarter", "side"]);
    expect(bulletTimeReferenceClause(plan.angles)).toContain("图1是动作与全身比例锚点");
    expect(bulletTimeReferenceClause(plan.angles)).toContain("图4是侧面轮廓");
  });
  it("uses a wider model capability contract instead of a hard-coded four-image ceiling", () => {
    const value = contract();
    value.generation.characterReferenceSet = ["actionPose", "front", "threeQuarter", "side", "back"];
    const capabilities = { durationSeconds: { min: 4, max: 30 }, maxReferenceImages: 30, supportedInputModes: ["text", "first-frame", "reference-image"] as const, supportsReferenceVideo: false };
    const result = validateBulletTimeContract(value, { shot: card(), capabilities: { ...capabilities, supportedInputModes: [...capabilities.supportedInputModes] } });
    expect(result.valid).toBe(true);
    expect(bulletTimeReferencePlan({ ...card(), bulletTime: value }, { ...capabilities, supportedInputModes: [...capabilities.supportedInputModes] }).angles)
      .toEqual(["actionPose", "front", "threeQuarter", "side", "back"]);
  });
});

describe("bullet-time compilation", () => {
  it("writes all decisions into existing fields and is idempotent", () => {
    const first = compileBulletTimeShot(card());
    expect(first.error).toBeNull();
    expect(first.changed).toBe(true);
    expect(first.card.director_instruction).toContain("主观时间");
    expect(first.card.camera_movement).toContain("顺时针");
    expect(first.card.camera_movement).toContain("约三分之一圈");
    expect(first.card.action).toContain("主体时间近冻结");
    expect(first.card.audio).toContain("不添加镜头外音乐");
    expect(first.card.negative).toContain("无镜头外BGM");
    expect(first.card[BULLET_TIME_META_KEY]).toBeTruthy();
    const second = compileBulletTimeShot(first.card);
    expect(second.changed).toBe(false);
    expect(second.card).toEqual(first.card);
  });

  it("replaces prior owned text when the contract changes and detects tampering", () => {
    const first = compileBulletTimeShot(card()).card;
    const changedCard = card();
    changedCard.bulletTime.camera.direction = "counterclockwise";
    const changed = compileBulletTimeShot({ ...first, bulletTime: changedCard.bulletTime });
    expect(changed.error).toBeNull();
    expect(changed.card.camera_movement).toContain("逆时针");
    expect(changed.card.camera_movement).not.toContain("顺时针");
    const tampered = { ...first, camera_movement: `${String(first.camera_movement).replace("顺时针", "顺时针")} manual` };
    expect(compileBulletTimeShot(tampered).error).toBeNull();
    const broken = { ...first, action: "tampered" };
    expect(compileBulletTimeShot(broken).error).toContain("BULLET_TIME_OWNED_CONTRIBUTION_CHANGED");
  });

  it("does not modify ordinary shots", () => {
    const ordinary = { shotId: "S1", action: "走路" };
    const result = compileBulletTimeShot(ordinary);
    expect(result.changed).toBe(false);
    expect(result.card).toEqual(ordinary);
    expect(result.validation.policy).toBe(BULLET_TIME_POLICY_VERSION);
  });
});

describe("bullet-time final prompt guard", () => {
  const promptFor = (value: ReturnType<typeof card>) => {
    const compiled = compileBulletTimeShot(value).card;
    return [
      "【约束】9:16画幅，1080x1920，30fps，MP4格式",
      `【交付约束】${compiled.constraint}`,
      `【场景】${compiled.scene}。${"浅灰无缝背景与同色地面保持稳定，人物、服装、光源和脚下接触阴影均连续。".repeat(14)}`,
      `【导演意图】${compiled.director_instruction}`,
      `【运镜】${compiled.camera_movement}`,
      `【动作】${compiled.action}`,
      `【时间轴】${compiled.timeline}`,
      `【节奏】${compiled.pacing}`,
      `【转场】${compiled.transition}`,
      `【音频】${compiled.audio}`,
      `【负面】${compiled.negative}`,
      "【写实纪律】保持真人电影质感，真实空间视差。no background music",
    ].join("\n");
  };

  it("passes a complete compiled prompt", () => {
    const value = card();
    const result = validateBulletTimePrompt(promptFor(value), value, { minChars: 1200 });
    expect(result.pass).toBe(true);
    expect(result.checks.every((check) => check.pass)).toBe(true);
  });

  it("fails closed on a missing contract marker, fake orbit or hard lens parameters", () => {
    const value = card();
    const broken = promptFor(value).replace("无二维平移式假环绕", "二维平移式真环绕").replace("30fps", "30fps，f/2.8");
    const result = validateBulletTimePrompt(broken.replace(/【子弹时间 [a-f0-9]{12}】/g, ""), value, { minChars: 1200 });
    expect(result.pass).toBe(false);
    expect(result.issues.join()).toContain("contract-marker");
    expect(result.issues.join()).toContain("no-hard-params");
  });
});

describe("bullet-time 25-field integration", () => {
  it("uses the real prompt preparation and final delivery guard", () => {
    const report = prepareShotPrompt(card(), { ratio: "9:16", resolution: "1080p", fps: 24 });
    expect(report.delivery.pass).toBe(true);
    expect(report.bulletTime?.pass).toBe(true);
    expect(report.prompt).toContain("一个单镜连续镜头，无切点");
    expect(report.prompt).toContain("主体时间近冻结");
    expect(report.prompt).toContain("真实空间视差");
    expect(report.prompt.length).toBeGreaterThanOrEqual(1200);
    expect(report.prompt.length).toBeLessThanOrEqual(3000);
  });
});
