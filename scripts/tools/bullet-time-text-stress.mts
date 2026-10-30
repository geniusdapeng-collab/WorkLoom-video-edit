#!/usr/bin/env node
/**
 * Bullet-time text-chain live test and deterministic stress test.
 *
 * This script intentionally has no video-provider import and cannot submit a
 * render. `--live` calls the configured text model to produce bulletTime
 * contracts; every request is then compiled through the real 25-field prompt
 * preparation and final guard. The stress phase measures the deterministic
 * compiler under bounded concurrency.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONSERVATIVE_BULLET_TIME_CAPABILITIES,
  compileBulletTimeShot,
  validateBulletTimeContract,
  validateBulletTimePrompt,
  type BulletTimeCapabilities,
  type BulletTimeContract,
} from "../../packages/video-studio/src/bullet-time.js";
import { WorkloomLLMEngine } from "../../packages/video-studio/src/llm-adapter.js";
import { prepareShotPrompt } from "../../packages/video-studio/src/shot-spec.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCHEMA_FILE = join(REPO_ROOT, "bundles/ai-video/schemas/bullet-time-effect.schema.json");
const WORK_DIR = join(REPO_ROOT, "work/bullet-time-text-stress");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_FILE = join(WORK_DIR, `report-${RUN_ID}.json`);
const CONTRACTS_FILE = join(WORK_DIR, `contracts-${RUN_ID}.json`);
const LIVE = process.argv.includes("--live");
const argValue = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const LIVE_REQUESTS = argValue("--requests", 6);
const ITERATIONS = argValue("--iterations", 600);
const CONCURRENCY = argValue("--concurrency", 6);
const contractArgIndex = process.argv.indexOf("--contracts");
const CONTRACT_INPUT = contractArgIndex >= 0 ? resolve(process.argv[contractArgIndex + 1] ?? "") : null;
const CAPABILITIES: BulletTimeCapabilities = {
  ...CONSERVATIVE_BULLET_TIME_CAPABILITIES,
  maxReferenceImages: 30,
};

type Case = {
  id: string;
  subject: string;
  purpose: string;
  entryAction: string;
  exitAction: string;
  startView: string;
  endView: string;
  wardrobe: string;
  scene: string;
  references: string[];
};

const CASES: Case[] = [
  {
    id: "decision-orbit",
    subject: "李英子，原创虚构成年女性，黑色高马尾，黑色轻便夹克、白T、深炭灰长裤和黑靴",
    purpose: "把起步前的犹豫与决断拉成可观察的主观时间",
    entryAction: "右脚刚落地，身体重心开始前移",
    exitAction: "时间恢复后完成同一方向的一小步",
    startView: "人物右前方四分之三中全身",
    endView: "人物左侧面",
    wardrobe: "同一个人、同一套黑夹克白T深色长裤黑靴，服装结构稳定",
    scene: "浅灰无缝摄影棚，左前方大面积柔光，右后方轻轮廓光",
    references: ["actionPose", "front", "threeQuarter", "side"],
  },
  {
    id: "impact-freeze",
    subject: "一名原创虚构成年女性运动员，短马尾，白色运动上衣和深蓝训练长裤",
    purpose: "在触球前的一瞬拉长时间，让观众看清身体姿态和接触关系",
    entryAction: "右脚蹬地，膝盖前送，脚背即将接触球",
    exitAction: "脚背完成接触，球向画面右侧离开",
    startView: "人物左侧前方低位中全身",
    endView: "人物正面偏右的侧面",
    wardrobe: "同一运动上衣、训练长裤和运动鞋，无额外护具与商标",
    scene: "傍晚室外训练场，低位自然逆光，地面有清晰接触阴影",
    references: ["actionPose", "front", "threeQuarter", "side"],
  },
  {
    id: "product-reveal",
    subject: "一只原创无商标哑光黑保温杯，银色旋盖，竖直放在浅木台面",
    purpose: "在杯口热气升起的一瞬拉长时间，让观众看清杯盖、杯身与材质",
    entryAction: "杯盖刚旋开四分之一圈，第一缕热气上升",
    exitAction: "杯盖停住，热气继续向画面左上散开",
    startView: "产品右前方四分之三中近景",
    endView: "产品左侧面结构",
    wardrobe: "同一只杯，颜色、容量、杯盖结构和表面纹理不变",
    scene: "清晨窗边浅木台面，左向窗光，背景为柔和虚化的室内绿植",
    references: ["front", "threeQuarter", "side", "closeup"],
  },
];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cardFor(item: Case, contract: BulletTimeContract): Record<string, unknown> {
  return {
    shotId: item.id,
    sceneType: "establishing",
    duration: contract.generation.durationSeconds,
    director_instruction: contract.narrative.purpose,
    constraint: "9:16画幅，1080x1920，24fps，MP4，无文字、无水印、无字幕",
    baseline: "真实电影质感，材质层次自然",
    scene: item.scene,
    lighting: "光源方向固定，主体有层次",
    camera_movement: "按 bulletTime 合同连续环绕",
    composition: `${item.startView}，真实空间视差`,
    color_palette: "中性低饱和电影色彩",
    depth_of_field: "主体清晰，背景有层次",
    character: item.subject.split("，").slice(0, 2).join("，"),
    costume: "以当前角色或产品档案为准，不换装",
    makeup: "自然轻薄日常妆，皮肤纹理真实",
    action: item.entryAction,
    props: "不增加合同之外的物体",
    portraits: item.references.map((angle) => `portrait:${angle}`),
    dialogueFree: true,
    timeline: `入场；主体近冻结；恢复；${item.exitAction}`,
    mood: item.id === "product-reveal"
      ? "安静克制；指尖旋开杯盖后停住，呼吸保持极轻，杯口热气极慢上升，杯盖与杯身保持稳定"
      : "安静专注；眼神保持原注视点，眉部放松，肩线稳定，不是科幻超能力",
    pacing: "主体压慢再恢复，摄影机持续缓慢运动",
    transition: `入口：${item.entryAction}；出口：${item.exitAction}`,
    audio: "只保留画内脚步、布料、接触和环境空气声",
    negative: "无切点、无重置、无二维推拉、无换脸、无换装、无文字、无水印、无BGM",
    bright_constraint: "主体不死黑，高光不过曝",
    character_constraint: "始终只有一个指定主体，禁止分身和额外人物",
    consistency: "同身份、造型、道具、光源和空间轴向",
    bulletTime: contract,
  };
}

function normalizedContract(item: Case, overrides: Partial<BulletTimeContract> = {}): BulletTimeContract {
  const base: BulletTimeContract = {
    schemaVersion: "workloom.video-studio/bullet-time/v1",
    enabled: true,
    mode: "freeze_orbit",
    narrative: {
      purpose: item.purpose,
      whyNotNormalCut: "普通切镜只能看到动作结果，无法同时保留主体姿态、材质和空间关系",
      viewerTakeaway: "动作的结果尚未发生，但人物的方向已经清楚",
    },
    time: {
      subjectTime: "near_freeze",
      subjectTimeRange: { start: 0.8, end: 3.6 },
      entrySeconds: 0.8,
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
      startView: item.startView,
      endView: item.endView,
      approxArcDegrees: 100,
      height: "胸腰高度",
      speed: "slow_constant",
      cuts: 0,
      focusBehavior: "主体和关键材质保持清晰可读",
      narrativeReveal: "从主体正面结构绕到侧面轮廓和空间层次",
    },
    generation: {
      inputMode: "reference-image",
      durationSeconds: 5,
      maxContinuousOrbit: 120,
      characterReferenceSet: item.references,
      previsReference: { requested: false, purpose: "camera_and_timing_only" },
    },
    entryExit: {
      entryAction: item.entryAction,
      exitAction: item.exitAction,
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
  };
  return structuredClone({ ...base, ...overrides });
}

function compileAndAudit(item: Case, contract: BulletTimeContract): {
  pass: boolean;
  contractHash: string | null;
  promptChars: number;
  issues: string[];
} {
  const validation = validateBulletTimeContract(contract, {
    shot: { shotId: item.id, duration: contract.generation.durationSeconds },
    capabilities: CAPABILITIES,
  });
  if (!validation.valid) return { pass: false, contractHash: null, promptChars: 0, issues: validation.issues.map((issue) => `${issue.code}@${issue.path}`) };
  const compiled = compileBulletTimeShot(cardFor(item, contract), { capabilities: CAPABILITIES });
  if (compiled.error) return { pass: false, contractHash: validation.contractHash, promptChars: 0, issues: [compiled.error] };
  const report = prepareShotPrompt(compiled.card, {
    ratio: "9:16",
    resolution: "1080p",
    fps: 24,
    bulletTimeCapabilities: CAPABILITIES,
    allowRedlines: ["虚拟", "投影"],
  });
  const final = validateBulletTimePrompt(report.prompt, compiled.card, { capabilities: CAPABILITIES });
  return {
    pass: report.delivery.pass && final.pass,
    contractHash: validation.contractHash,
    promptChars: report.prompt.length,
    issues: [...report.delivery.issues, ...final.issues],
  };
}

async function boundedMap<T, R>(items: readonly T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await task(items[index]!, index);
    }
  }));
  return output;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function livePrompt(item: Case, nonce: number): string {
  return [
    "你是 WorkLoom 的子弹时间镜头设计师。",
    "只生成一个符合目标 JSON Schema 的 bulletTime 对象，不生成成片提示词，不提交任何渲染。",
    `镜头案例：${JSON.stringify({ ...item, nonce })}`,
    "硬约束：5 秒；单镜连续；零切点；主体近冻结而摄影机持续环绕；90-120 度；入口与出口动作完整；画内声；禁止 BGM；参考图顺序必须保持案例给定的顺序；不得新增人物、商品、道具或事实。",
    "时间数值：subjectTimeRange.start=0.8，subjectTimeRange.end=3.6，entrySeconds=0.8，exitSeconds=0.5；不得占满 5 秒。",
    "冻结层：face=locked，body=locked；至少一个 hairTips/fabricHem/ambientParticles/props 层为 very_slow，其余背景 locked。",
    "当前能力不支持参考视频：previsReference.requested 必须为 false，purpose 仍写 camera_and_timing_only。audioPolicy 必须为 diegetic_only。",
    "时间层必须明确 face/body/hairTips/fabricHem/background/ambientParticles。人物案例可让发梢和衣摆极慢；产品案例可让热气极慢。",
    "fallback 只允许 guided_orbit/segmented_orbit 与 editorial_fake/block，并且必须 relabel。",
  ].join("\n");
}

async function main(): Promise<void> {
  mkdirSync(WORK_DIR, { recursive: true });
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
  const engine = LIVE ? WorkloomLLMEngine.fromEnv(process.env) : null;
  if (LIVE && !engine) throw new Error("LIVE_TEXT_MODEL_NOT_CONFIGURED");
  const startedAt = new Date().toISOString();
  const liveRows: Array<Record<string, unknown>> = [];
  const contracts: Array<{ case: Case; contract: BulletTimeContract }> = [];

  if (engine) {
    const requests = Array.from({ length: LIVE_REQUESTS }, (_, index) => ({ case: CASES[index % CASES.length]!, nonce: index + 1 }));
    const liveResults = await boundedMap(requests, Math.min(CONCURRENCY, 4), async ({ case: item, nonce }) => {
      const started = Date.now();
      const result = await engine.reasonStructured(livePrompt(item, nonce), schema, {
        scene: "video.preproduction.plan",
        temperature: 0.1,
        maxTokens: 12_000,
        signal: AbortSignal.timeout(180_000),
      });
      const validation = validateBulletTimeContract(result.data, {
        shot: { shotId: item.id, duration: 5 },
        capabilities: CAPABILITIES,
      });
      if (validation.valid && validation.contract) contracts.push({ case: item, contract: validation.contract });
      return {
        case: item.id,
        nonce,
        model: engine.model,
        elapsedMs: Date.now() - started,
        success: result.success,
        valid: validation.valid,
        issues: validation.issues,
        usage: result.usage ?? null,
        responseHash: result.content ? sha256(result.content) : null,
      };
    });
    liveRows.push(...liveResults);
    writeFileSync(CONTRACTS_FILE, `${JSON.stringify(contracts.map(({ case: item, contract }) => ({ caseId: item.id, contract })), null, 2)}\n`, "utf8");
  }

  if (!engine && CONTRACT_INPUT) {
    const saved = JSON.parse(readFileSync(CONTRACT_INPUT, "utf8")) as Array<{ caseId?: string; contract?: unknown }>;
    for (const entry of saved) {
      const item = CASES.find((candidate) => candidate.id === entry.caseId);
      const validation = validateBulletTimeContract(entry.contract, {
        shot: item ? { shotId: item.id, duration: 5 } : undefined,
        capabilities: CAPABILITIES,
      });
      if (!item || !validation.valid || !validation.contract) throw new Error(`CONTRACT_INPUT_INVALID:${entry.caseId ?? "unknown"}`);
      contracts.push({ case: item, contract: validation.contract });
    }
  }

  for (const item of CASES) {
    if (!contracts.some((entry) => entry.case.id === item.id)) contracts.push({ case: item, contract: normalizedContract(item) });
  }

  const liveFailures = liveRows.filter((row) => row.success !== true || row.valid !== true);
  const livePass = !LIVE || liveFailures.length === 0;

  const stressInputs = Array.from({ length: ITERATIONS }, (_, index) => {
    const item = CASES[index % CASES.length]!;
    const seeded = contracts.find((entry) => entry.case.id === item.id)!.contract;
    const contract = structuredClone(seeded);
    contract.camera.startView = `${item.startView} ${index % 5 === 0 ? "近景" : "中全身"}`;
    contract.camera.narrativeReveal = `${item.purpose} 视角 ${index}`;
    return { item, contract };
  });
  const stressStarted = Date.now();
  const stressRows = await boundedMap(stressInputs, CONCURRENCY, async ({ item, contract }) => {
    const started = performance.now();
    const result = compileAndAudit(item, contract);
    return { case: item.id, ...result, elapsedMs: performance.now() - started };
  });
  const stressElapsedMs = Date.now() - stressStarted;
  const failures = stressRows.filter((row) => !row.pass);
  const durations = stressRows.map((row) => row.elapsedMs);
  const report = {
    schemaVersion: "workloom.video-studio/bullet-time-text-stress/v1",
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: LIVE ? "live-text-plus-deterministic-stress" : "deterministic-only",
    contractInput: CONTRACT_INPUT,
    renderSubmitted: false,
    model: engine?.model ?? null,
    liveRequests: liveRows.length,
    livePass,
    liveRows,
    contractsFile: engine ? CONTRACTS_FILE : null,
    deterministic: {
      iterations: ITERATIONS,
      concurrency: CONCURRENCY,
      pass: failures.length === 0,
      failures: failures.slice(0, 20),
      wallMs: stressElapsedMs,
      throughputPerSecond: Number((ITERATIONS / (stressElapsedMs / 1000)).toFixed(2)),
      p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
      p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
      maxMs: Number(Math.max(...durations).toFixed(3)),
      promptChars: {
        min: Math.min(...stressRows.map((row) => row.promptChars)),
        max: Math.max(...stressRows.map((row) => row.promptChars)),
      },
    },
  };
  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportFile: REPORT_FILE, ...report }, null, 2));
  if (!livePass || failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
