/**
 * T-2026-0927-0013：真实 startRun + StageRunner + ArchiveStore 回归。
 * vendor、PG、媒体登记用边界替身；档案写盘与重试/终态/商品摘要走实际代码。
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayAppend, gatewayAppendOnClient } from "@workloom/base/workdata";
import { applyScenePolicy, auditScenePolicy, loadScenePolicies, resolveShotCast, type ScenePolicyShot } from "@hyperreality/video-studio";
import { verifyScenePolicyProductionSource } from "./scene-policy-render-gate.js";
import { portraitReuseFixture } from "./portrait-reuse.test-support.js";
import { builtinCatalogFixture } from "./builtin-character-selection.test-support.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

const doubles = vi.hoisted(() => ({
  workDir: "",
  runPreproduction: vi.fn(),
  ingest: vi.fn(),
  project: vi.fn(),
  finish: vi.fn(),
  release: vi.fn(),
  uninstall: vi.fn(),
  nextAttempt: 0,
  lease: vi.fn(),
  meta: vi.fn(),
  detach: vi.fn(),
  review: vi.fn(),
  prepare: vi.fn(),
  finalize: vi.fn(),
  studioConfigs: [] as Array<Record<string, any>>,
  gateReplies: [] as Array<{ gate: string; verdict: any }>,
  emitGates: true,
  connect: vi.fn(),
  query: vi.fn(),
  releaseDb: vi.fn(),
}));

vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: doubles.connect }), getGatewayPool: () => ({}) }));
vi.mock("@workloom/base/model-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workloom/base/model-router")>(),
  GatewayEventSink: class {}, poolFromEnv: () => new Map(),
}));
/**
 * GR-02（2026-09-29 第二次修复）：号源改为共享的 `insertWithReadableId`（纯 nextval + SAVEPOINT 换号）。
 * 这里按真实契约实现 stub：取号 SQL 仍走 mock 的 `video_projects_max_vid_no()`（返回 9000），
 * 于是项目号 = VID-9000（**不再 +1**；旧实现在调用点 +1 得到 VID-9001）。
 */
vi.mock("@workloom/base/workdata", async () => {
  const { makeReadableId } = await import("@workloom/shared");
  return {
    gatewayAppend: vi.fn(),
    gatewayAppendOnClient: vi.fn(),
    VIDEO_PROJECT_ID_SOURCE: { prefix: "VID", nextNumberSql: "public.video_projects_max_vid_no()", label: "视频项目号 VID-*" },
    insertWithReadableId: async (
      client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ n: string | number }> }> },
      source: { prefix: string; nextNumberSql: string },
      insert: (id: string) => Promise<unknown>,
    ) => {
      const r = await client.query(`SELECT ${source.nextNumberSql} AS n`);
      const id = makeReadableId(source.prefix, Number(r.rows[0]!.n));
      return { id, value: await insert(id) };
    },
  };
});
vi.mock("../service/llm.js", () => ({ modelPolicyFor: () => undefined }));
vi.mock("./marketing-authority.js", async importOriginal => ({
  ...await importOriginal<typeof import("./marketing-authority.js")>(),
  prepareMarketingFacts: doubles.prepare, finalizeMarketingFacts: doubles.finalize,
}));
vi.mock("./data-mining-executor.js", () => ({ createDataMiningExecutor: vi.fn() }));
vi.mock("./media/library.js", () => ({ ingestPortraitsFromIndex: doubles.ingest }));
vi.mock("./media/products.js", () => ({ upsertProductProfileFromDossier: doubles.project }));
vi.mock("./archive-host.js", () => ({
  archiveWorkDir: () => doubles.workDir,
  acquireProjectLease: doubles.lease,
  readProjectMeta: doubles.meta,
  makeLedgerWriter: () => ({
    claimRun: async (row: { inputRefTemplate: string }) => {
      const attempt = ++doubles.nextAttempt;
      return { attempt, inputRef: row.inputRefTemplate.replace("{attempt}", String(attempt)) };
    },
    finishRun: doubles.finish,
    heartbeatRun: async () => undefined,
    nextAttempt: async () => doubles.nextAttempt + 1,
  }),
}));
vi.mock("@hyperreality/video-studio", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hyperreality/video-studio")>(),
  VideoStudio: class {
    constructor(private readonly config: { onApproval: (input: Record<string, unknown>) => Promise<unknown> }) { doubles.studioConfigs.push(config); }
    async runPreproduction(...args: unknown[]) {
      const result = await doubles.runPreproduction(...args);
      if (result.success && doubles.emitGates) for (const gate of ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT", "G7_FINAL"]) {
        const verdict = await this.config.onApproval({ gate, vendorType: "test-gate", runId: "vendor-run", title: "完整确认单", contentMd: "具体场景、角色、动作与镜头交付标准。".repeat(20) });
        doubles.gateReplies.push({ gate, verdict });
      }
      return result;
    }
  },
  reviewStage: doubles.review,
  WorkloomLLMEngine: { fromEnv: () => ({ attachRouter: vi.fn() }) },
  installVendorEngineBridge: vi.fn(),
  installVendorRenderCompatBridge: vi.fn(),
  installVendorPortraitBindingBridge: () => doubles.uninstall,
  attachStructuredLog: () => doubles.detach,
}));

let worker: typeof import("./studio-worker.js");
let catalogFixture: ReturnType<typeof builtinCatalogFixture>;
const scope = { tenantId: "tenant-test", workspaceId: "ws-test" };
let projectSequence = 0;

beforeAll(async () => {
  doubles.workDir = await realpath(await mkdtemp(path.join(tmpdir(), "studio-result-")));
  catalogFixture = builtinCatalogFixture(doubles.workDir);
  worker = await import("./studio-worker.js");
});

afterAll(async () => { await rm(doubles.workDir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.clearAllMocks();
  doubles.nextAttempt = 0;
  doubles.studioConfigs.length = 0;
  doubles.gateReplies.length = 0;
  doubles.prepare.mockReset().mockImplementation(async ({ scope, root }) => {
    const raw = { A1: { identity: { name: "本次商品", specs: { 功率: "1 W" } }, images: [] }, A2: { reviews: [] }, A3: { competitors: [] } };
    const sourceId = `SRC-${renderSha256(`https://source.example.com/final\n${"a".repeat(64)}`).slice(0, 24)}`;
    return {
    bundle: { scope: { ...scope }, rawSha256: renderSha256(canonicalRenderJson(raw)), rawByAgent: structuredClone(raw), productQuery: { name: "本次商品" },
      sources: [{ sourceId, finalUrl: "https://source.example.com/final", textSha256: "a".repeat(64) }],
      stages: [{ stage: "A1", sourceIds: [sourceId], facts: { stage: "A1", status: "source_bound", payload: structuredClone(raw.A1),
        claims: [{ stage: "A1", status: "source-bound", pointer: "/identity/specs/功率", value: "1 W", sourceId, textSha256: "a".repeat(64) }] } }] }, raw,
    prefix: `stages/preproduction/attempt-${scope.attempt}.marketing`,
    storeRoot: path.join(root, `stages/preproduction/attempt-${scope.attempt}.marketing-dossier`),
    g1Content: JSON.stringify({ facts: { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority",
      scope: { ...scope }, stages: [{ stage: "A1", review: { score: 88,
        issues: ["媒体报道与厂家确认要区分，并保留报道日期", "SBK 赛事型号不能替代零售型号"],
        suggestions: ["保留封闭赛道限定", "未知外观不得扩写"] } }, { stage: "A2" }, { stage: "A3" }],
      restrictions: ["未提供评价", "未提供竞品"], sources: [1], optionalValue: null } }),
  }; });
  doubles.finalize.mockReset().mockResolvedValue({ ref: "stages/preproduction/attempt-1.marketing-facts.json", sha256: "b".repeat(64) });
  doubles.emitGates = true;
  doubles.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  doubles.review.mockReset().mockImplementation(async (options) => {
    const failed = options.deterministic.some((check: { hard?: boolean; pass: boolean }) => check.hard && !check.pass);
    return { stage: options.stage, status: failed ? "failed" : "passed", approved: !failed, score: failed ? 0 : 95,
      via: "llm", model: "test-judge", degraded: false, issues: [], suggestions: [], hardFailures: [], rerun: failed,
      reason: failed ? "真实证据缺失" : "完整审阅通过", ms: 1, evidence: await Promise.all(options.artifacts.map(async (artifact: { path: string; kind: string }) => ({
        path: artifact.path, sha256: createHash("sha256").update(await readFile(artifact.path)).digest("hex"), scope: artifact.kind === "image" ? "image" : "complete-text",
      }))) };
  });
  doubles.runPreproduction.mockReset();
  doubles.finish.mockResolvedValue(undefined);
  doubles.release.mockReset().mockResolvedValue(undefined);
  doubles.uninstall.mockReset();
  doubles.detach.mockReset();
  doubles.lease.mockReset().mockResolvedValue({ release: doubles.release });
  doubles.meta.mockReset().mockResolvedValue({ kind: "marketing", title: "结果完整性", threadId: "T1", createdAt: "2026-09-27T00:00:00Z" });
  doubles.ingest.mockResolvedValue({ scanned: 0, ingested: 0, deduped: 0, skipped: 0, errors: [] });
  doubles.project.mockResolvedValue({ profile: { productName: "商品", dossierSha256: "a".repeat(64) }, changed: true, heroIngested: false });
  doubles.connect.mockReset().mockResolvedValue({ query: doubles.query, release: doubles.releaseDb });
  doubles.query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes("video_projects_max_vid_no") ? [{ n: 9000 }] : [], rowCount: 1,
  }));
  doubles.releaseDb.mockReset();
  vi.stubEnv("ARCHIVE_ENABLED", "1");
  vi.stubEnv("MEDIA_INGEST_ENABLED", "1");
  vi.stubEnv("HR_PORTRAIT_ENABLED", "0");
  vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", "");
  vi.stubEnv("BUNDLES_ROOT", catalogFixture.bundleRoot);
});

const success = () => ({
  success: true,
  confirmations: { theme: { approved: true, reason: "producer-approved" } },
  shots: [{ shotId: "SC-1", duration: 5, prompt: "01.【场景】窗边桌面", fields: { scene: "窗边桌面" } }],
  stages: {
    portraitStudio: { status: "skipped", reason: "no-characters-or-products" },
    scriptEngine: { report: { characters_count: 0 } },
    dataMining: { status: "completed", product_id: "product-a", data: { ok: true, reused: false, dossier: { provenance: [{ id: "source-a" }], gaps: [] } } },
    // Match the real native final stage summary: complete prompt/fields live only in result.shots.
    productionEngine: { shots: [{ shotId: "SC-1", duration: 5, promptLength: 13, status: "completed", scene: "窗边桌面" }] },
  },
});
const commercialSuccess = () => {
  const policy = loadScenePolicies(path.resolve(import.meta.dirname, "../../../../bundles/ai-video/library/scene-policies"))
    .find((item) => item.id === "commercial-person")!;
  const specs: Array<[string[], string, string?]> = [
    [["wide", "moving"], "大场面全景，人物站在大厅中央", "缓推镜展示空间纵深"],
    [["wide"], "广角全景，人物站在空间视觉主导位"],
    [["medium", "moving"], "半身中景，人物与实体材质同框", "轨道移镜围绕访谈位"],
    [["medium"], "腰部以上中景，人物与实体墙屏同框"],
    [["medium"], "膝上中景，人物站在会客厅首层"],
    [["person-close", "moving"], "面部近景特写，神态沉稳", "轻推镜到人物双眼"],
    [["person-close"], "胸部以上人物特写，说明手势清晰"],
    [["person-close"], "面部近景，人物直视镜头"],
    [["environment-detail"], "实体羊毛经纬纹样特写与材质工艺微距"],
    [["environment-detail"], "胡桃木与大理石材质特写，人物不入镜"],
  ];
  const shots: ScenePolicyShot[] = specs.map(([tags, composition, camera], index) => {
    const shot: ScenePolicyShot = {
      shotId: `SC-${index + 1}`, duration: 4.5, policyTags: tags,
      scene: "明亮的别墅式企业会客厅首层正式访谈位",
      composition, camera_movement: camera ?? "固定访谈机位",
      costume: "合体商务正装，衣料挺括整洁",
      speechMode: tags.includes("environment-detail") ? "voice-over" : "on-camera",
      speechScene: "interview",
      dialogue: [{ speaker: "主讲人", text: "欢迎了解方案。" }],
      action: [
        "正面直视镜头，以坚定眼神和从容停掌开始口播",
        "镜头从45°侧前方看她自然微笑",
        "侧面轮廓可辨，她用一个小手势说明重点",
        "背影气场后转身，留下沉思瞬间",
      ][index] ?? "自然讲述并保持专业气质",
      ...(index === 8 ? { props: "实体羊毛交织纹样与材质工艺" } : {}),
    };
    return applyScenePolicy({ ...shot, prompt: `${shot.scene}；${shot.composition}` }, policy);
  });
  expect(auditScenePolicy({ title: "正式商务短片", shots }, policy).passed).toBe(true);
  return { ...success(), shots: shots.map(shot => ({ ...shot, fields: { scene: shot.scene } })),
    stages: { ...success().stages, productionEngine: { shots: shots.map(shot => ({ shotId: shot.shotId, duration: shot.duration, status: "completed" })) } } };
};
const rejected = () => ({
  success: false,
  confirmations: { theme: { approved: false, reason: "producer-rejected(G2_THEME)：需求冲突" } },
  stages: { creativeTheme: { title: "需要重做" } },
});

async function runToTerminal(isMarketing = true, metadata?: Record<string, unknown>) {
  const projectId = `VID-result-${++projectSequence}`;
  if (!isMarketing) useNarrativeProject();
  const runId = worker.startRun(scope, { projectId, intent: "测试预生产结果", isMarketing, metadata });
  await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
  const entry = worker.getRun(runId, scope.workspaceId)!;
  return { projectId, runId, entry };
}

/**
 * 上游新增 PIPELINE_KIND_MISMATCH 校验：预生产管线必须与服务项目 kind 一致。
 * 本文件默认 meta 是 marketing，叙事用例必须先声明叙事项目，否则 run 会在建档前失败。
 */
function useNarrativeProject() {
  doubles.meta.mockResolvedValue({ kind: "narrative", title: "叙事结果", threadId: "T1", createdAt: "2026-09-27T00:00:00Z" });
}

async function archiveJson(projectId: string, ref: string, workspaceId = scope.workspaceId) {
  const bytes = await readFile(path.join(doubles.workDir, "archive", workspaceId, projectId, ref));
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as Record<string, any> };
}

async function archiveOutput(projectId: string, attempt: number) {
  const file = path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "stages", "preproduction", `attempt-${attempt}.output.json`);
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("预生产原始结果与诚实终态", () => {
  it("坏复用配置在启动注册、vendor和租约之前失败，不回退生成", () => {
    vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", path.join(doubles.workDir, "missing-manifest.json"));
    expect(() => worker.startRun(scope, { projectId: "VID-reuse-invalid", intent: "使用已有AI模特" })).toThrow("拒绝回退生成");
    expect(doubles.runPreproduction).not.toHaveBeenCalled(); expect(doubles.lease).not.toHaveBeenCalled();
  });
  it.each([false, true])("已有角色四角度复用 generated=%s：独立证据放行或失败，不插假人工审批", async generated => {
    const projectId = `VID-reuse-${++projectSequence}`, runDir = path.join(doubles.workDir, "workspaces", scope.workspaceId);
    await mkdir(runDir, { recursive: true });
    const f = portraitReuseFixture(runDir, projectId);
    vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", f.manifestPath); vi.stubEnv("HR_PORTRAIT_ENABLED", "1");
    vi.stubEnv("VOLCENGINE_ARK_API_KEY", "test-only-config"); vi.stubEnv("ARK_IMAGE_MODEL", "test-only-model");
    if (generated) f.stage.generatedPortraits = 1;
    doubles.runPreproduction.mockResolvedValue({ ...success(), stages: { ...success().stages, portraitStudio: f.stage, scriptEngine: { report: { characters_count: 1 } } } });
    useNarrativeProject();
    const runId = worker.startRun(scope, { projectId, intent: "使用既有AI模特v4", metadata: { products: [],
      characters: [{ id: "c1", name: "一号AI模特", description: "既有明确选择的成年虚构AI女性角色，白T与长裤。" }] } });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(runId, scope.workspaceId)?.status).toBe(generated ? "failed" : "finished");
    expect(doubles.studioConfigs[0]?.portraits).toMatchObject({ archivedCharactersOnly: true, archivedCharacters: { manifestPath: f.manifestPath, approvedSelection: f.approvedSelection } });
    expect(doubles.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO approvals"))).toBe(false);
    expect(doubles.review.mock.calls.some(([options]) => options.context.gate === "G5_PORTRAIT")).toBe(false);
    if (!generated) {
      const output = await archiveOutput(projectId, 1);
      const gate = (output.productionEvidence as { gates: Array<Record<string, any>> }).gates.find(item => item.gate === "G5_PORTRAIT");
      expect(gate).toMatchObject({ via: "archive-reuse-acceptance", model: null, degraded: false, archiveReuse: { stage: { generatedPortraits: 0, reusedPortraits: 4 } } });
      expect(gate?.evidence.filter((item: Record<string, unknown>) => item.scope === "archive-reuse-image")).toHaveLength(4);
    }
  });
  it.each([[undefined, "young-rider-01", 1], [{ character: "英子" }, "young-rider-01", 1], [{ characterOrdinal: 2 }, "chen-zhuo", 2], [{ character: "林予安" }, "lin-yu-an", 3]] as const)("worker把真实registry人选%j和完整persona送入vendor", async (metadata, id, ordinal) => {
    doubles.runPreproduction.mockResolvedValue(success()); useNarrativeProject();
    const projectId = `VID-actor-${++projectSequence}`;
    const runId = worker.startRun(scope, { projectId, intent: "制作短片", metadata: metadata ? structuredClone(metadata) : undefined });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const request = doubles.runPreproduction.mock.calls[0]?.[0];
    expect(request.metadata.characters).toMatchObject([{ id, name: expect.any(String), ordinal, activeWardrobeId: "w1", wardrobeId: "w1", persona: { interests: ["极限运动"] }, biography: expect.any(Array), speakingStyle: expect.any(Object), behavioralRules: expect.any(Array) }]);
    expect(request.intent).toContain("极限运动"); expect(request.intent).toContain("虚构的大学在读人物");
    expect(request.metadata.builtinCharacterSelection.characters[0]).toMatchObject({ id, profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("建档前拒绝角色冲突，明确无人不向vendor补默认角色", async () => {
    await expect(worker.startVideoProjectRun(scope, { intent: "制作短片", metadata: { character: { id: "young-rider-01", name: "陈卓" } }, by: { id: "MEM-1", type: "human" } })).rejects.toThrow("不同角色");
    expect(doubles.connect).not.toHaveBeenCalled(); expect(doubles.runPreproduction).not.toHaveBeenCalled();
    doubles.runPreproduction.mockResolvedValue(success()); useNarrativeProject();
    const runId = worker.startRun(scope, { projectId: `VID-no-person-${++projectSequence}`, intent: "纯产品，明确无人" });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(doubles.runPreproduction.mock.calls[0]?.[0].metadata.characters).toEqual([]);
  });
  it("建项目之前拦截显式未知片型，未触及数据库和供应商", async () => {
    await expect(worker.startVideoProjectRun(scope, {
      intent: "给陈卓拍一条正式商务短片",
      metadata: { scenePolicy: { id: "not-installed" } },
      by: { id: "MEM-1", type: "human" },
    })).rejects.toThrow(/未知片型/);
    await expect(worker.startVideoProjectRun(scope, {
      intent: "做一条母婴亲子短片",
      by: { id: "MEM-1", type: "human" },
    })).rejects.toThrow(/没有可核实的已安装片型知识条目/);
    expect(doubles.connect).not.toHaveBeenCalled();
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });

  it("分流器加工出的 brief 不充当客户原始选型证据", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    const started = await worker.startVideoProjectRun(scope, {
      rawIntent: "拍一条山间日出风景片",
      intent: "拍一条山间日出风景片\n[需求口径] 时长：30秒",
      customerMetadata: null,
      metadata: { brief: { product: "企业负责人" }, pipelineRoute: { kind: "marketing" } },
      isMarketing: true,
      by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(doubles.runPreproduction.mock.calls[0]?.[0].metadata).toMatchObject({
      brief: { product: "企业负责人" }, scenePolicySelection: { id: null },
    });
  });

  it("原始需求选出的 T1 进入建档事件、routeMeta、供应商入参与分镜/提示词包", async () => {
    doubles.runPreproduction.mockResolvedValue(commercialSuccess());
    useNarrativeProject();
    const started = await worker.startVideoProjectRun(scope, {
      rawIntent: "给企业负责人拍正式商务短片，陈卓出镜口播",
      intent: "给企业负责人拍短片\n[需求口径] 时长：30秒",
      metadata: { brief: { audience: "企业负责人" } },
      isMarketing: false,
      by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(started.runId, scope.workspaceId)?.status).toBe("finished");
    const creation = vi.mocked(gatewayAppendOnClient).mock.calls.find(([, , event]) => event.decision.action === "video.project.create");
    expect(creation?.[2].decision.after).toMatchObject({ scenePolicy: { id: "commercial-person", evidence: expect.any(Array) } });
    const selectionEvent = vi.mocked(gatewayAppend).mock.calls.find(([, , event]) => event.decision.action === "video.scene_policy.selected");
    expect(selectionEvent?.[2].decision.after).toMatchObject({ id: "commercial-person", runId: started.runId });
    const runInput = doubles.runPreproduction.mock.calls[0]?.[0];
    expect(runInput.intent).toContain("[片型制作规范 commercial-person@");
    expect(runInput.metadata.scenePolicy).toMatchObject({ id: "commercial-person" });
    const dir = path.join(doubles.workDir, "archive", scope.workspaceId, started.projectId);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const prompts = JSON.parse(await readFile(path.join(dir, "stages/preproduction/attempt-1.prompts.json"), "utf8"));
    const shotlist = JSON.parse(await readFile(path.join(dir, "stages/preproduction/attempt-1.shotlist.json"), "utf8"));
    expect(manifest.routeMeta.scenePolicy).toMatchObject({ id: "commercial-person" });
    expect(prompts.scenePolicy).toMatchObject({ id: "commercial-person" });
    expect(shotlist).toMatchObject({ scenePolicy: { id: "commercial-person" }, draft: true });
    expect(shotlist.shots).toHaveLength(10);
    const reportBytes = await readFile(path.join(dir, "stages/preproduction/attempt-1.scene-policy-report.json"));
    const shotlistBytes = await readFile(path.join(dir, "stages/preproduction/attempt-1.shotlist.json"));
    const report = JSON.parse(reportBytes.toString("utf8"));
    expect(report).toMatchObject({ passed: true, totalSeconds: 45 });
    const output = await archiveOutput(started.projectId, 1);
    expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(output.scenePolicyReportSha256);
    expect(createHash("sha256").update(shotlistBytes).digest("hex")).toBe(output.shotlistSha256);
    const policy = loadScenePolicies(path.resolve(import.meta.dirname, "../../../../bundles/ai-video/library/scene-policies"))
      .find((item) => item.id === "commercial-person")!;
    expect(verifyScenePolicyProductionSource({
      decision: manifest.routeMeta.scenePolicy, policy,
      projectId: started.projectId, attempt: 1, shotId: "SC-1", output, prompts, report, shotlist,
    })).toMatchObject({ policyId: "commercial-person", shotId: "SC-1", attempt: 1 });
  });

  it("供应商返回不合规镜头表时报告落档并在渲染前打回", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    useNarrativeProject();
    const started = await worker.startVideoProjectRun(scope, {
      rawIntent: "给企业负责人拍正式商务短片，陈卓出镜口播",
      intent: "给企业负责人拍短片",
      by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(started.runId, scope.workspaceId)?.status).toBe("failed");
    const dir = path.join(doubles.workDir, "archive", scope.workspaceId, started.projectId);
    const report = JSON.parse(await readFile(path.join(dir, "stages/preproduction/attempt-1.scene-policy-report.json"), "utf8"));
    expect(report.passed).toBe(false);
    expect(report.defects.some((item: { rule: string }) => item.rule === "ratio-min")).toBe(true);
  });

  it("既有项目补跑重新选型并留下 routeMeta 变更事件", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    useNarrativeProject();
    const projectId = `VID-route-${++projectSequence}`;
    const first = worker.startRun(scope, { projectId, intent: "山间风景片" });
    await vi.waitFor(() => expect(worker.getRun(first, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const second = worker.startRun(scope, {
      projectId, intent: "给企业负责人拍正式商务短片", rawIntent: "给企业负责人拍正式商务短片",
    });
    await vi.waitFor(() => expect(worker.getRun(second, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const dir = path.join(doubles.workDir, "archive", scope.workspaceId, projectId);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const events = (await readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(manifest.routeMeta.scenePolicy.id).toBe("commercial-person");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "scene-policy.route-changed",
      previous: expect.objectContaining({ id: null }),
      current: expect.objectContaining({ id: "commercial-person" }),
    }));
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
  });

  it("显式 VM_PRODUCER_RETRY=1 时才恢复有限重试；成功结果保留 stages.dataMining 驱动商品投影", async () => {
    vi.stubEnv("VM_PRODUCER_RETRY", "1");
    doubles.runPreproduction.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success());
    const { entry, projectId, runId } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
    expect(entry).toMatchObject({ status: "finished", error: null, resultSummary: {
      success: true, stages: ["portraitStudio", "scriptEngine", "dataMining", "productionEngine"], producerAttempts: 2,
      dataMining: { productId: "product-a", ok: true, evidenceCount: 1, gaps: 0 },
    } });
    expect(doubles.project).toHaveBeenCalledWith(expect.anything(), expect.anything(), scope, expect.objectContaining({ productId: "product-a" }));
    expect(doubles.finish.mock.calls.map(([row]) => row.status)).toEqual(["failed", "done"]);
    expect((await archiveOutput(projectId, 1)).success).toBe(false);
    expect((await archiveOutput(projectId, 2)).stages).toEqual(["portraitStudio", "scriptEngine", "dataMining", "productionEngine"]);
    const dossierRef = `archive/${scope.workspaceId}/${projectId}/stages/preproduction/attempt-2.marketing-dossier`;
    expect((await archiveOutput(projectId, 2)).dossier).toMatchObject({ root: dossierRef });
    const projectRoot = path.join(doubles.workDir, "archive", scope.workspaceId, projectId);
    const prompts = JSON.parse(await readFile(path.join(projectRoot, "stages/preproduction/attempt-2.prompts.json"), "utf8"));
    expect(prompts.dossier.root).toBe(dossierRef);
    expect(await readFile(path.join(projectRoot, "context-bundle.json"), "utf8")).toContain(dossierRef);
    expect(doubles.project.mock.calls[0]?.[3].dossierRoot).toBe(path.join(projectRoot, "stages/preproduction/attempt-2.marketing-dossier"));
    expect(worker.getRun(runId, "another-workspace")).toBeNull();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("默认：监制打回即停，不自动重跑（不再把 AI 打回变成重复烧钱）", async () => {
    doubles.runPreproduction.mockResolvedValue(rejected());
    const { entry } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("producer-rejected(G2_THEME)：需求冲突");
    expect(entry.resultSummary).toMatchObject({ success: false, producerAttempts: 1, stages: ["creativeTheme"] });
    expect(worker.summarizeWorkspaceRuns(scope.workspaceId).failedRecent).toBeGreaterThan(0);
  });

  it("业务软失败不得显示 finished", async () => {
    doubles.runPreproduction.mockResolvedValue({ success: false, errors: [{ stage: "insight", message: "来源不足" }], stages: {} });
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "来源不足", resultSummary: { success: false, producerAttempts: 1 } });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.finish).toHaveBeenCalledTimes(1);
  });

  it("vendor 抛错保留原始错误，仍释放资源并写失败档案", async () => {
    doubles.runPreproduction.mockRejectedValue(new Error("模型请求失败"));
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "模型请求失败", resultSummary: null });
    expect(doubles.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorMsg: "模型请求失败" }));
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("归档输出写入失败时，不因已取得 rawResult 而伪称成功", async () => {
    const { ArchiveStore } = await import("@hyperreality/video-studio");
    const original = ArchiveStore.prototype.writeJsonAtomic;
    vi.spyOn(ArchiveStore.prototype, "writeJsonAtomic").mockImplementation(function (this: InstanceType<typeof ArchiveStore>, relPath, data) {
      if (relPath.endsWith(".output.json")) return Promise.reject(new Error("档案磁盘写入失败"));
      return original.call(this, relPath, data);
    });
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "档案磁盘写入失败", resultSummary: null });
    expect(doubles.project).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("禁止关闭生产档案，拒绝发生在供应商与租约调用之前", () => {
    vi.stubEnv("ARCHIVE_ENABLED", "0");
    expect(() => worker.startRun(scope, { projectId: "VID-off", intent: "x" })).toThrow("ARCHIVE_ENABLED=0");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.lease).not.toHaveBeenCalled();
  });

  it.each(["busy", "error"])("租约 %s 不会无锁执行，并清理已安装的桥", async (failure) => {
    if (failure === "busy") doubles.lease.mockResolvedValue(null);
    else doubles.lease.mockRejectedValue(new Error("lease network failed"));
    const { entry } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.meta).not.toHaveBeenCalled();
    expect(doubles.finish).not.toHaveBeenCalled();
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
    expect(doubles.release).not.toHaveBeenCalled();
  });

  it.each(["missing", "error", "archive"])("项目/档案初始化 %s 时不执行并释放租约", async (failure) => {
    if (failure === "missing") doubles.meta.mockResolvedValue(null);
    else if (failure === "error") doubles.meta.mockRejectedValue(new Error("project metadata failed"));
    else {
      const { ArchiveStore } = await import("@hyperreality/video-studio");
      vi.spyOn(ArchiveStore.prototype, "ensure").mockRejectedValue(new Error("archive failed"));
    }
    const { entry, projectId } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
    if (failure !== "archive") {
      await expect(readFile(path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "context-bundle.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("完成回执未核实不投影商品也不自动重试", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    doubles.finish.mockRejectedValueOnce(new Error("receipt unverified"));
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "receipt unverified", resultSummary: null });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.project).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledTimes(1);
  });

  it("解锁和日志清理抛错仍清理绑定桥并写终态", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    doubles.detach.mockImplementation(() => { throw new Error("detach failed"); });
    doubles.release.mockRejectedValue(new Error("unlock failed"));
    const { entry } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("detach failed");
    expect(entry.error).toContain("unlock failed");
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("失败原因兼容已有 failures 与 errorMessage，空消息回退且限制长度", () => {
    expect(worker.terminalFailureMessageOf({ errorMessage: "备用错误字段" })).toBe("备用错误字段");
    expect(worker.terminalFailureMessageOf({ failures: [{ message: "已有失败列表" }] })).toBe("已有失败列表");
    expect(worker.terminalFailureMessageOf({ error: " ", errors: [{ error: "底层错误" }] })).toBe("底层错误");
    expect(worker.terminalFailureMessageOf({}, "运行器异常")).toBe("运行器异常");
    expect(worker.terminalFailureMessageOf({ error: "x".repeat(600) })).toHaveLength(500);
    expect(worker.terminalFailureMessageOf({})).toBe("vendor 返回 success:false");
  });
  it("叙事成功档案保留本次六门证据；G5没有人物时明确不适用，G7使用prompt", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry, projectId } = await runToTerminal(false);
    expect(entry.status).toBe("finished");
    const output = await archiveOutput(projectId, 1);
    expect(output.productionEvidence).toMatchObject({ schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker",
      tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId, attempt: 1, pipelineKind: "narrative" });
    const proofs = (output.productionEvidence as { gates: Array<Record<string, unknown>> }).gates;
    expect(proofs).toHaveLength(6);
    expect(proofs.find(item => item.gate === "G5_PORTRAIT")).toMatchObject({ status: "not_applicable", basis: "no-characters-or-products" });
    expect(doubles.review.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "prompt", context: { gate: "G7_FINAL" } });
    expect(proofs.find(item => item.gate === "G7_FINAL")?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
  });
  it("只有vendor自报成功但没有本次服务门回执，叙事档案不得done", async () => {
    doubles.emitGates = false; doubles.runPreproduction.mockImplementation(async () => success());
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("缺少服务监制裁决");
    expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
  });
  it("定妆照只完成计划却缺实际图片时，G5 事实核验先行失败关闭（不占用人类时间、不调 AI 评审）", async () => {
    doubles.runPreproduction.mockImplementation(async () => ({ ...success(), stages: { ...success().stages,
      portraitStudio: { status: "completed", completedPortraits: 0, pendingPortraits: 4, characters: 1, products: 0 },
      scriptEngine: { report: { characters_count: 1 } } } }));
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed");
    expect(entry.error).toMatch(/portrait-evidence-failed|定妆照未完整生成/);
    /** T-2026-1001-0007：G5 不再走 AI 监制自动裁决，也不自动重出 */
    expect(doubles.review.mock.calls.some(([options]) => options.context.gate === "G5_PORTRAIT")).toBe(false);
  });

});

describe("完整原生前期到正式 CLI 草稿交接", () => {
  it("policy=null成功从完整result.shots落盘，保留顺序/原字段/人物来源，旧资格门不被片型指针污染", async () => {
    const native = { ...success(), character: { id: "young-rider-01", name: "李英子", appearanceInShots: ["N-09"], source: { kind: "native-character", path: "approved-G3-G4" } },
      shots: [
        { shot_id: "N-09", duration: 7.25, scene_id: "opening", sceneType: "opening", prompt: "01.【场景】李英子抬手。\n原始完整末行。", fields: { scene: "李英子抬手", character: "young-rider-01", extra: { original: ["完整值", null] } },
          cast: [{ id: "young-rider-01", pinnedVersion: 2 }], dialogue: [{ speaker: "李英子", text: "这就是原台词。", emotion: "自然" }], customNative: { preserve: true } },
        { shotId: "N-02", duration: 5, sceneType: "middle", prompt: "01.【场景】无人空镜，桌面物件。", fields: { scene: "无人空镜，桌面物件", character: { id: "young-rider-01", onScreen: false } },
          subject: { kind: "object", count: 0 }, dialogueBlocks: [{ speaker: "李英子", text: "仅画外旁白" }] },
      ],
      stages: { ...success().stages, requirementDiscovery: { data: { actualG3Cast: ["young-rider-01"], marker: "完整原始G3" } },
        prdGeneration: { data: { productionContract: { actorId: "young-rider-01" }, marker: "完整原始G4" } },
        productionEngine: { shots: [{ shotId: "WRONG-SUMMARY", duration: 999, prompt: "禁止用此摘要", fields: { invented: true } }] } } };
    const before = structuredClone(native);
    doubles.runPreproduction.mockResolvedValue(native);
    const { entry, projectId, runId } = await runToTerminal(false, { source: "客户输入来源", character: "英子",
      brief: { duration: 12.25, aspectRatio: "9:16", productionRequirements: { resolution: "1080p" } } });
    expect(entry.status).toBe("finished");
    const output = await archiveOutput(projectId, 1);
    expect(output).toMatchObject({ cliShotlistRef: "stages/preproduction/attempt-1.shotlist.json", cliShotlistSha256: expect.stringMatching(/^[a-f0-9]{64}$/), promptShotCount: 2 });
    expect(output.shotlistRef).toBeUndefined(); expect(output.shotlistSha256).toBeUndefined(); expect(output.scenePolicyPassed).toBeUndefined();
    const sheet = await archiveJson(projectId, String(output.cliShotlistRef));
    const pack = await archiveJson(projectId, String(output.promptsRef));
    expect(renderSha256(sheet.bytes)).toBe(output.cliShotlistSha256); expect(renderSha256(pack.bytes)).toBe(output.promptsSha256);
    expect(sheet.value).toMatchObject({ schemaVersion: "workloom.preproduction-cli-handoff/v1", projectId, draft: true,
      durationSeconds: 12.25, aspect: "9:16", resolution: "1080p", scenePolicySelection: { id: null },
      source: { kind: "system-preproduction", issuer: "workloom.studio-worker", resultPath: "result.shots", ...scope, projectId, runId, attempt: 1 },
      metadata: { inputSource: "客户输入来源", builtinCharacterSelection: { characters: [{ id: "young-rider-01" }] } },
      character: { id: "young-rider-01", appearanceInShots: ["N-09"], source: { kind: "host-selected-character", selection: { mode: "builtin" }, nativeSource: before.character.source } } });
    expect(sheet.value.metadata.source).toEqual(sheet.value.source);
    expect(sheet.value.preproduction.stages).toEqual(before.stages);
    expect(sheet.value.preproduction.confirmations).toEqual(native.confirmations);
    expect(sheet.value.shots).toEqual(before.shots.map(shot => ({ ...shot, shotId: (shot as any).shotId ?? (shot as any).shot_id })));
    expect(sheet.value.shots.map((shot: any) => shot.shotId)).toEqual(["N-09", "N-02"]);
    expect(pack.value.shots.map((shot: any) => ({ shotId: shot.shotId, durationSec: shot.durationSec, prompt: shot.prompt, fields: shot.fields })))
      .toEqual(sheet.value.shots.map((shot: any) => ({ shotId: shot.shotId, durationSec: shot.duration, prompt: shot.prompt, fields: shot.fields })));
    // Real downstream cast consumer resolves the original visible card and keeps voice-over off screen.
    const identities = sheet.value.characters;
    expect(resolveShotCast(sheet.value.shots[0], identities)).toMatchObject({ status: "passed", characters: [{ id: "young-rider-01" }], selections: [{ characterId: "young-rider-01", pinnedVersion: 2 }] });
    expect(resolveShotCast(sheet.value.shots[1], identities)).toMatchObject({ status: "not_applicable", characters: [] });
    expect(verifyScenePolicyProductionSource({ decision: pack.value.scenePolicy, policy: null, projectId, attempt: 1,
      shotId: "N-09", output, prompts: pack.value, report: null, shotlist: null })).toBeNull();
    expect(native.shots).toEqual(before.shots); expect(native.stages).toEqual(before.stages);
  });

  it("不根据全片默认主角或画外speaker补造逐镜cast与appearanceInShots", async () => {
    const native = { ...success(), shots: [{ shotId: "VOICE-1", duration: 5, prompt: "01.【场景】无人空镜", fields: { scene: "无人空镜" }, dialogueBlocks: [{ speaker: "李英子", text: "只有声音。" }] }] };
    doubles.runPreproduction.mockResolvedValue(native);
    const { entry, projectId } = await runToTerminal(false); expect(entry.status).toBe("finished");
    const output = await archiveOutput(projectId, 1), { value } = await archiveJson(projectId, String(output.cliShotlistRef));
    expect(value.shots).toEqual(native.shots); expect(value.character.id).toBe("young-rider-01");
    expect(value.character.appearanceInShots).toBeUndefined(); expect(value.shots[0].cast).toBeUndefined();
    expect(value.shots[0].characterId).toBeUndefined(); expect(value.shots[0].character).toBeUndefined();
  });

  it.each(["missing-shots", "empty-shots", "summary-only", "empty-prompt", "missing-fields", "array-fields", "empty-fields", "invalid-id", "duplicate-id", "conflicting-id", "zero-duration", "negative-duration", "string-duration", "nan-duration", "infinite-duration", "overflow-total", "shot-degraded", "result-degraded"])("成功结果%s不能退回摘要或补值，运行不得done", async kind => {
    const native: Record<string, any> = success();
    if (kind === "missing-shots" || kind === "summary-only") delete native.shots;
    if (kind === "empty-shots") native.shots = [];
    if (kind === "empty-prompt") native.shots[0].prompt = "  ";
    if (kind === "missing-fields") delete native.shots[0].fields;
    if (kind === "array-fields") native.shots[0].fields = ["非字段对象"];
    if (kind === "empty-fields") native.shots[0].fields = {};
    if (kind === "invalid-id") native.shots[0].shotId = "../escape";
    if (kind === "duplicate-id") native.shots.push(structuredClone(native.shots[0]));
    if (kind === "conflicting-id") native.shots[0].shot_id = "OTHER";
    if (kind === "zero-duration") native.shots[0].duration = 0;
    if (kind === "negative-duration") native.shots[0].duration = -5;
    if (kind === "infinite-duration") native.shots[0].duration = Number.POSITIVE_INFINITY;
    if (kind === "overflow-total") native.shots = ["LARGE-1", "LARGE-2"].map(shotId => ({ ...native.shots[0], shotId, duration: Number.MAX_VALUE }));
    if (kind === "string-duration") native.shots[0].duration = "5";
    if (kind === "nan-duration") native.shots[0].duration = Number.NaN;
    if (kind === "shot-degraded") native.shots[0].degraded = true;
    if (kind === "result-degraded") native.degraded = true;
    doubles.runPreproduction.mockResolvedValue(native);
    const { entry, projectId } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("PREPRODUCTION_HANDOFF_INVALID");
    expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
    await expect(archiveJson(projectId, "stages/preproduction/attempt-1.shotlist.json")).rejects.toMatchObject({ code: "ENOENT" });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1); expect(doubles.release).toHaveBeenCalledTimes(1);
  });

  it("原生项目人物与宿主本次选择冲突时不导出错误人选", async () => {
    doubles.runPreproduction.mockResolvedValue({ ...success(), character: { id: "someone-else" } });
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("原生项目人物与本次宿主选角不一致");
    expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
  });

  it.each([false, true])("真实G4拒绝（selectedPolicy=%s）不被缺失shots/片型审计覆盖", async selectedPolicy => {
    const reason = "producer-rejected(G4_PRD)：保留真实62分拒绝与原建议";
    const failure = { success: false, errors: [{ stage: "G4_PRD", message: reason }],
      confirmations: { prd: { approved: false, reason, suggestions: ["保留原始修改项"] } }, stages: { prdGeneration: { data: { actual: "原始拒绝PRD" } } } };
    doubles.runPreproduction.mockResolvedValue(failure);
    const { entry, projectId } = await runToTerminal(false, selectedPolicy ? { scenePolicy: { id: "commercial-person" } } : undefined);
    expect(entry.status).toBe("failed"); expect(entry.error).toBe(reason);
    const output = await archiveOutput(projectId, 1); expect(output).toMatchObject({ success: false, failures: failure.errors, vendorConfirmations: failure.confirmations });
    expect(output.cliShotlistRef).toBeUndefined(); expect(output.promptsRef).toBeUndefined(); expect(output.scenePolicyReportRef).toBeUndefined();
    expect(doubles.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorClass: "GATE_REJECTED", errorMsg: expect.stringContaining(reason) }));
    expect(failure.confirmations.prd).toEqual({ approved: false, reason, suggestions: ["保留原始修改项"] });
  });

  it("仅confirmations的G4拒绝及长建议完整落盘，摘要上限不裁原拒绝", async () => {
    const reason = "producer-rejected(G4_PRD)：" + "完整原始拒绝依据。".repeat(100);
    const confirmations = { prd: { approved: false, reason, suggestions: Array.from({ length: 12 }, (_, index) => `原建议-${index + 1}`) } };
    doubles.runPreproduction.mockResolvedValue({ success: false, confirmations, stages: {} });
    const { entry, projectId } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toBe(reason.slice(0, 500));
    const output = await archiveOutput(projectId, 1);
    expect(output.failureMessage).toBe(reason.slice(0, 500)); expect(output.vendorConfirmations).toEqual(confirmations);
    expect(doubles.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorClass: "GATE_REJECTED", errorMsg: reason.slice(0, 500) }));
    expect(output.cliShotlistRef).toBeUndefined(); expect(output.scenePolicyReportRef).toBeUndefined();
  });

  it.each(["shotlist-write", "prompts-write", "shotlist-too-large", "prompts-too-large"])("%s使完整交接缺失时失败关闭，不签出成功指针", async kind => {
    const { ArchiveStore } = await import("@hyperreality/video-studio"), original = ArchiveStore.prototype.writeJsonAtomic;
    if (kind.endsWith("write")) vi.spyOn(ArchiveStore.prototype, "writeJsonAtomic").mockImplementation(function (this: InstanceType<typeof ArchiveStore>, ref, data) {
      if (ref.endsWith(kind === "shotlist-write" ? ".shotlist.json" : ".prompts.json")) return Promise.reject(new Error("交接磁盘写入失败"));
      return original.call(this, ref, data);
    });
    const native: Record<string, any> = success();
    if (kind === "shotlist-too-large") native.shots[0].nativeExtra = "x".repeat(4 * 1024 * 1024 + 1);
    // Repeated real labels enlarge promptFieldNames: sheet <4MB, complete pack >4MB.
    if (kind === "prompts-too-large") native.shots[0].prompt = "01.【场景】x\n".repeat(180_000);
    doubles.runPreproduction.mockResolvedValue(native);
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("PREPRODUCTION_HANDOFF_INCOMPLETE");
    expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true); expect(doubles.project).not.toHaveBeenCalled();
  });

  it("同项目新attempt输出独立草稿，保留上一轮原始字节与来源", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    const first = await runToTerminal(false), firstOutput = await archiveOutput(first.projectId, 1);
    const previous = await archiveJson(first.projectId, String(firstOutput.cliShotlistRef));
    doubles.runPreproduction.mockResolvedValue({ ...success(), shots: [{ ...success().shots[0]!, shotId: "SECOND", duration: 7, prompt: "第二轮原始提示词" }] });
    const secondRun = worker.startRun(scope, { projectId: first.projectId, intent: "第二轮明确需求" });
    await vi.waitFor(() => expect(worker.getRun(secondRun, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(secondRun, scope.workspaceId)?.status).toBe("finished");
    const secondOutput = await archiveOutput(first.projectId, 2), next = await archiveJson(first.projectId, String(secondOutput.cliShotlistRef));
    expect(next.value.source).toMatchObject({ runId: secondRun, attempt: 2 }); expect(next.value.shots[0]).toMatchObject({ shotId: "SECOND", duration: 7, prompt: "第二轮原始提示词" });
    expect((await archiveJson(first.projectId, String(firstOutput.cliShotlistRef))).bytes.equals(previous.bytes)).toBe(true);
    expect(secondOutput.cliShotlistSha256).not.toBe(firstOutput.cliShotlistSha256);
  });

  it("两个工作区并发完成时只携带各自run/attempt/原始镜头和选角", async () => {
    useNarrativeProject();
    doubles.runPreproduction.mockImplementation(async (input: Record<string, any>) => {
      await new Promise(resolve => setTimeout(resolve, input.projectId.endsWith("A") ? 20 : 1));
      return { ...success(), shots: [{ ...success().shots[0]!, shotId: input.projectId.endsWith("A") ? "A-ORIGINAL" : "B-ORIGINAL", prompt: input.projectId }] };
    });
    const scopes = [scope, { tenantId: "tenant-other", workspaceId: "ws-other" }], ids = [`VID-parallel-${++projectSequence}A`, `VID-parallel-${++projectSequence}B`];
    const runs = scopes.map((current, index) => worker.startRun(current, { projectId: ids[index]!, intent: "并行叙事", metadata: { characterOrdinal: index + 1 } }));
    await Promise.all(runs.map((runId, index) => vi.waitFor(() => expect(worker.getRun(runId, scopes[index]!.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 })));
    for (let index = 0; index < runs.length; index++) {
      expect(worker.getRun(runs[index]!, scopes[index]!.workspaceId)?.status).toBe("finished");
      const dir = path.join(doubles.workDir, "archive", scopes[index]!.workspaceId, ids[index]!, "stages/preproduction");
      const outputFile = (await readdir(dir)).find(name => name.endsWith(".output.json"))!;
      const { value: output } = await archiveJson(ids[index]!, `stages/preproduction/${outputFile}`, scopes[index]!.workspaceId);
      const { value: sheet } = await archiveJson(ids[index]!, output.cliShotlistRef, scopes[index]!.workspaceId);
      expect(sheet.source).toMatchObject({ ...scopes[index], projectId: ids[index], runId: runs[index], attempt: output.productionEvidence.attempt });
      expect(sheet.shots[0].prompt).toBe(ids[index]); expect(sheet.character.id).toBe(index === 0 ? "young-rider-01" : "chen-zhuo");
      expect(worker.getRun(runs[index]!, scopes[1 - index]!.workspaceId)).toBeNull();
    }
  });
});

 describe("宿主营销G1必须先于vendor", () => {
  it("当前attempt事实G1通过后才调用vendor，最终完整镜头审核写回事实引用", async () => {
    doubles.runPreproduction.mockImplementation(async () => {
      expect(doubles.prepare).toHaveBeenCalledTimes(1);
      expect(doubles.review.mock.calls.some(([options]) => options.context.gate === "G1_DOSSIER")).toBe(true);
      return success();
    });
    const { entry, projectId } = await runToTerminal(); expect(entry.status).toBe("finished");
    expect(doubles.prepare).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ ...scope, projectId, attempt: 1 }) }));
    expect(doubles.finalize).toHaveBeenCalledWith(expect.anything(), [{ shotId: "SC-1", prompt: "01.【场景】窗边桌面", fields: { scene: "窗边桌面" } }]);
    expect(await archiveOutput(projectId, 1)).toMatchObject({ marketingFactsRef: "stages/preproduction/attempt-1.marketing-facts.json", marketingFactsSha256: "b".repeat(64) });
    expect(doubles.studioConfigs[0]?.dataMining.verifiedRaw.projectId).toBe(projectId);
    const verifiedRaw = doubles.studioConfigs[0]?.dataMining.verifiedRaw;
    expect(JSON.parse(verifiedRaw.rawJson).A1.identity.specs).toEqual({ 功率: { value: "1 W", source_url: "https://source.example.com/final" } });
    expect(verifiedRaw.sha256).toBe(renderSha256(verifiedRaw.rawJson));
    const prepared = await doubles.prepare.mock.results[0]!.value;
    expect(prepared.raw.A1.identity.specs).toEqual({ 功率: "1 W" });
    expect(prepared.bundle.rawSha256).toBe(renderSha256(canonicalRenderJson(prepared.raw)));
    expect(verifiedRaw.sha256).not.toBe(prepared.bundle.rawSha256);
  });
  it("PRD配置只交接本次私有G1原件与完整裁决，不采信metadata同名authority", async () => {
    const review = doubles.review.getMockImplementation()!;
    const advisories = Array.from({ length: 8 }, (_, index) => `G1完整审阅建议-${index + 1}`);
    doubles.review.mockImplementation(async options => ({ ...await review(options),
      ...(options.context.gate === "G1_DOSSIER" ? { issues: ["保留来源归因"], suggestions: advisories } : {}) }));
    const forged = { schemaVersion: "workloom.prd-marketing-authority/v1", scope: { ...scope, projectId: "other", runId: "old", attempt: 9 },
      g1Artifact: { path: "/metadata/G1.md", sha256: "0".repeat(64), content: "browser伪造正文" },
      g1Proof: { gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm", model: "browser", degraded: false, evidence: [] } };
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry, projectId, runId } = await runToTerminal(true, { prdAuthority: forged,
      dataMining: { verifiedRaw: { prdAuthority: forged } }, marketingFactsAuthority: forged });
    expect(entry.status).toBe("finished");
    const authority = doubles.studioConfigs[0]?.dataMining.verifiedRaw.prdAuthority;
    const prepared = await doubles.prepare.mock.results[0]!.value;
    const file = path.join(doubles.workDir, "workspaces", scope.workspaceId, "gates", projectId, "attempt-1", "G1_DOSSIER.md");
    expect(authority).toMatchObject({ schemaVersion: "workloom.prd-marketing-authority/v1", scope: { ...scope, projectId, runId, attempt: 1 },
      g1Artifact: { path: file, content: prepared.g1Content, sha256: renderSha256(prepared.g1Content) },
      g1Proof: { gate: "G1_DOSSIER", status: "passed", approved: true, via: "llm", model: "test-judge", degraded: false,
        issues: ["保留来源归因"], suggestions: advisories, advisories,
        evidence: [{ path: file, sha256: renderSha256(prepared.g1Content), scope: "complete-text" }] } });
    expect(authority.g1Artifact.content).toBe(await readFile(file, "utf8"));
    expect(JSON.parse(authority.g1Artifact.content).facts.stages[0].review).toEqual(JSON.parse(prepared.g1Content).facts.stages[0].review);
    const proofs = (await archiveOutput(projectId, 1)).productionEvidence as { gates: Array<Record<string, unknown>> };
    expect(authority.g1Proof).toEqual(proofs.gates.find(item => item.gate === "G1_DOSSIER"));
    expect(authority.g1Artifact.content).not.toBe(forged.g1Artifact.content);
    expect(doubles.runPreproduction.mock.calls[0]?.[0].metadata.prdAuthority).toEqual(forged);
  });

  it("未通过真实G1时metadata伪造authority不能构造或运行vendor", async () => {
    doubles.review.mockResolvedValue({ stage: "script", status: "failed", approved: false, score: 40, via: "llm", model: "test-judge",
      degraded: false, reason: "来源主张不支持", issues: ["拒绝"], suggestions: ["修正来源"], evidence: [] });
    doubles.runPreproduction.mockResolvedValue(success());
    const forged = { approved: true, status: "passed", via: "llm", degraded: false, model: "browser" };
    const { entry } = await runToTerminal(true, { prdAuthority: forged, dataMining: { verifiedRaw: { prdAuthority: forged } } });
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("本次来源与事实未通过真实监制");
    expect(doubles.studioConfigs).toHaveLength(0); expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.finalize).not.toHaveBeenCalled();
  });

  it("approved机审建议完整留在账本与档案，返回advisories不触发未审二次改写", async () => {
    const review = doubles.review.getMockImplementation()!;
    const advisories = Array.from({ length: 8 }, (_, index) => `非阻断建议-${index + 1}`);
    const issues = Array.from({ length: 7 }, (_, index) => `审阅记录-${index + 1}`);
    doubles.review.mockImplementation(async options => ({ ...await review(options),
      ...(options.context.gate === "G4_PRD" ? { suggestions: advisories, issues } : {}) }));
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry, projectId } = await runToTerminal(); expect(entry.status).toBe("finished");
    const reply = doubles.gateReplies.find(item => item.gate === "G4_PRD")?.verdict;
    expect(reply).toMatchObject({ approved: true, suggestions: [], advisories });
    expect(reply.fatal).toBeUndefined();
    const ledger = vi.mocked(gatewayAppendOnClient).mock.calls.find(([, , event]) => event.decision.action === "prd.confirm")?.[2].decision.after;
    expect(ledger).toMatchObject({ approved: true, score: 95, issues, suggestions: advisories, advisories });
    const output = await archiveOutput(projectId, 1);
    expect((output.productionEvidence as { gates: Array<Record<string, unknown>> }).gates.find(item => item.gate === "G4_PRD"))
      .toMatchObject({ approved: true, score: 95, issues, suggestions: advisories, advisories });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
  });

  it("rejected机审仍返回原始修改建议与fatal，不转为advisory放行", async () => {
    const review = doubles.review.getMockImplementation()!;
    const suggestions = Array.from({ length: 8 }, (_, index) => `阻断修改-${index + 1}`);
    doubles.review.mockImplementation(async options => ({ ...await review(options),
      ...(options.context.gate === "G4_PRD" ? { approved: false, status: "failed", score: 58,
        reason: "制作规格不符", suggestions } : {}) }));
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry, projectId } = await runToTerminal(); expect(entry.status).toBe("failed");
    const reply = doubles.gateReplies.find(item => item.gate === "G4_PRD")?.verdict;
    expect(reply).toMatchObject({ approved: false, suggestions, fatal: "producer_rejected" });
    expect(reply.advisories).toBeUndefined();
    const proofs = (await archiveOutput(projectId, 1)).productionEvidence as { gates: Array<Record<string, unknown>> };
    expect(proofs.gates.find(item => item.gate === "G4_PRD"))
      .toMatchObject({ approved: false, status: "failed", score: 58, suggestions });
    expect(doubles.finalize).not.toHaveBeenCalled();
  });

  it("人类edited_after仍作为明确修改建议返回，不改成机审advisory", async () => {
    const edited = { resolution: "1080p", reason: "用户明确改动" };
    const query = doubles.query.getMockImplementation()!;
    doubles.query.mockImplementation(async (sql: string) => sql.includes("SELECT status, gesture FROM approvals")
      ? { rows: [{ status: "edited", gesture: { edited_after: edited } }], rowCount: 1 } : query(sql));
    vi.mocked(gatewayAppendOnClient).mockResolvedValueOnce({ eventId: "EV-HUMAN-EDIT" } as Awaited<ReturnType<typeof gatewayAppendOnClient>>);
    let reply: Record<string, unknown> | undefined;
    doubles.runPreproduction.mockImplementation(async () => {
      reply = await doubles.studioConfigs[0]!.onApproval({ gate: "G8_RENDER", vendorType: "render", runId: "vendor-run",
        title: "明确生产操作的人审修改", contentMd: "隔离测试，不执行真实渲染" });
      return success();
    });
    const { entry } = await runToTerminal(false); expect(entry.status).toBe("finished");
    expect(reply).toEqual({ approved: true, suggestions: [JSON.stringify(edited)] });
    expect(reply?.advisories).toBeUndefined();
  });
  it("G2至G7模型门持有同一当前attempt的G1原件和当前门完整摘要，叙事不增加事实权限", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry, projectId, runId } = await runToTerminal(); expect(entry.status).toBe("finished");
    const prepared = await doubles.prepare.mock.results[0]!.value;
    const g1Path = path.join(doubles.workDir, "workspaces", scope.workspaceId, "gates", projectId, "attempt-1", "G1_DOSSIER.md");
    const downstream = doubles.review.mock.calls.map(([options]) => options).filter(options => options.context.gate !== "G1_DOSSIER");
    expect(downstream.map(options => options.context.gate)).toEqual(["G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT", "G7_FINAL"]);
    for (const options of downstream) {
      expect(options.artifacts).toHaveLength(2);
      expect(options.artifacts[1]).toMatchObject({ path: g1Path, kind: "json", expectedSha256: renderSha256(prepared.g1Content) });
      expect(options.artifacts[0].expectedSha256).toBe(renderSha256(await readFile(options.artifacts[0].path, "utf8")));
      expect(options.requiredCheckIds).toEqual(["marketing-g1-current-evidence"]);
      expect(options.context.marketingFactsAuthority).toMatchObject({ authorityStatus: "accepted-current-g1",
        scope: { ...scope, projectId, runId, attempt: 1 }, g1: { path: g1Path, sha256: renderSha256(prepared.g1Content), model: "test-judge" } });
    }
    const proofs = (await archiveOutput(projectId, 1)).productionEvidence as { gates: Array<Record<string, any>> };
    for (const gate of proofs.gates.filter(item => item.gate !== "G1_DOSSIER" && item.gate !== "G5_PORTRAIT")) {
      expect(gate.evidence).toHaveLength(2);
      expect(gate.evidence).toContainEqual({ path: g1Path, sha256: renderSha256(prepared.g1Content), scope: "complete-text" });
    }
    doubles.review.mockClear(); doubles.runPreproduction.mockResolvedValue(success());
    const narrative = await runToTerminal(false); expect(narrative.entry.status).toBe("finished");
    expect(doubles.studioConfigs.at(-1)?.dataMining?.verifiedRaw?.prdAuthority).toBeUndefined();
    for (const [options] of doubles.review.mock.calls) {
      expect(options.artifacts).toHaveLength(1); expect(options.requiredCheckIds).toBeUndefined();
      expect(options.context.marketingFactsAuthority).toBeUndefined(); expect(options.artifacts[0].expectedSha256).toBeUndefined();
    }
  });
  it("vendor执行期间G1原件被换后下游即使自报成功也不能形成正式通过", async () => {
    doubles.runPreproduction.mockImplementation(async () => {
      const g1 = doubles.review.mock.calls.find(([options]) => options.context.gate === "G1_DOSSIER")![0].artifacts[0].path;
      await writeFile(g1, "被替换的G1"); return success();
    });
    const { entry } = await runToTerminal(); expect(entry.status).toBe("failed");
    const downstream = doubles.review.mock.calls.map(([options]) => options).filter(options => options.context.gate !== "G1_DOSSIER");
    expect(downstream.length).toBeGreaterThan(0);
    for (const options of downstream) expect(options.deterministic).toContainEqual(expect.objectContaining({
      id: "marketing-g1-current-evidence", status: "unverified", pass: false, hard: true,
    }));
    expect(doubles.finalize).not.toHaveBeenCalled();
    expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
  });
  it("retry重新准备G1并只传本attempt原件，不复用前次通过证据", async () => {
    vi.stubEnv("VM_PRODUCER_RETRY", "1"); doubles.runPreproduction.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success());
    const { entry, projectId } = await runToTerminal(); expect(entry.status).toBe("finished");
    expect(doubles.prepare).toHaveBeenCalledTimes(2);
    const g1 = doubles.review.mock.calls.map(([options]) => options).filter(options => options.context.gate === "G1_DOSSIER");
    expect(g1).toHaveLength(2); expect(g1[0].artifacts[0].path).toContain("attempt-1"); expect(g1[1].artifacts[0].path).toContain("attempt-2");
    expect(doubles.studioConfigs).toHaveLength(2);
    for (const [index, config] of doubles.studioConfigs.entries()) {
      expect(config.dataMining.verifiedRaw.prdAuthority).toMatchObject({ scope: { projectId, attempt: index + 1 },
        g1Artifact: { path: g1[index].artifacts[0].path,
          sha256: g1[index].artifacts[0].expectedSha256 ?? renderSha256(await readFile(g1[index].artifacts[0].path, "utf8")) } });
      expect(config.dataMining.verifiedRaw.prdAuthority.g1Artifact.content).toBe(await readFile(g1[index].artifacts[0].path, "utf8"));
    }
    expect(doubles.studioConfigs[1]!.dataMining.verifiedRaw.prdAuthority.g1Artifact.sha256)
      .not.toBe(doubles.studioConfigs[0]!.dataMining.verifiedRaw.prdAuthority.g1Artifact.sha256);
    for (const [options] of doubles.review.mock.calls.filter(([options]) => options.context.gate !== "G1_DOSSIER")) {
      expect(options.artifacts[1].path).toBe(g1[1].artifacts[0].path);
      expect(options.context.marketingFactsAuthority.scope).toMatchObject({ projectId, attempt: 2 });
      expect(options.artifacts[1].expectedSha256).not.toBe(g1[0].artifacts[0].expectedSha256);
    }
  });
  it.each(["source", "claim", "value"])("Jenny格式桥%s变化在vendor之前失败，保留原事实包", async kind => {
    const original = doubles.prepare.getMockImplementation()!;
    doubles.prepare.mockImplementation(async options => {
      const prepared = await original(options);
      if (kind === "source") prepared.bundle.sources = [];
      if (kind === "claim") prepared.bundle.stages[0].facts.claims = [];
      if (kind === "value") prepared.raw.A1.identity.specs.功率 = "9 W";
      return prepared;
    });
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry } = await runToTerminal();
    expect(entry.status).toBe("failed"); expect(entry.error).toMatch(/MARKETING_(SPEC_UNVERIFIED|FACTS_CHANGED)/);
    expect(doubles.studioConfigs).toHaveLength(0); expect(doubles.runPreproduction).not.toHaveBeenCalled(); expect(doubles.finalize).not.toHaveBeenCalled();
  });
  it.each(["source", "g1", "unverified-proof", "unbound-proof"])("%s未核实不执行vendor或终态事实审核", async kind => {
    if (kind === "source") doubles.prepare.mockRejectedValue(new Error("MARKETING_A1_UNVERIFIED"));
    if (kind === "g1") doubles.review.mockResolvedValue({ status: "failed", approved: false, via: "llm", degraded: false, reason: "不支持主张", score: 0 });
    if (kind === "unverified-proof") doubles.review.mockResolvedValue({ status: "unverified", approved: true, via: "fallback", degraded: true, reason: "来源不可用", score: 95, issues: [], suggestions: [], evidence: [] });
    if (kind === "unbound-proof") doubles.review.mockResolvedValue({ status: "passed", approved: true, via: "llm", model: "judge", degraded: false, reason: "通过", score: 95, issues: [], suggestions: [], evidence: [{ sha256: "0".repeat(64), scope: "complete-text" }] });
    const { entry } = await runToTerminal(); expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled(); expect(doubles.finalize).not.toHaveBeenCalled();
  });
  it("最终事实审核失败时不写done、不投影商品，保留失败原因", async () => {
    doubles.runPreproduction.mockResolvedValue(success()); doubles.finalize.mockRejectedValue(new Error("MARKETING_PROMPT_FACTS_REJECTED"));
    const { entry } = await runToTerminal(); expect(entry.status).toBe("failed"); expect(entry.error).toContain("MARKETING_PROMPT_FACTS_REJECTED");
    expect(doubles.project).not.toHaveBeenCalled(); expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
  });
});
