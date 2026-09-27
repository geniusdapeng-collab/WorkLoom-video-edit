/**
 * T-2026-0927-0013：真实 startRun + StageRunner + ArchiveStore 回归。
 * vendor、PG、媒体登记用边界替身；档案写盘与重试/终态/商品摘要走实际代码。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  workDir: "",
  runPreproduction: vi.fn(),
  ingest: vi.fn(),
  project: vi.fn(),
  finish: vi.fn(),
  release: vi.fn(),
  uninstall: vi.fn(),
  nextAttempt: 0,
}));

vi.mock("@workloom/db", () => ({ getAppPool: () => ({}), getGatewayPool: () => ({}) }));
vi.mock("@workloom/base/model-router", () => ({
  GatewayEventSink: class {}, poolFromEnv: () => new Map(),
}));
vi.mock("@workloom/base/workdata", () => ({ gatewayAppend: vi.fn(), gatewayAppendOnClient: vi.fn() }));
vi.mock("../service/llm.js", () => ({ modelPolicyFor: () => undefined }));
vi.mock("./data-mining-executor.js", () => ({ createDataMiningExecutor: vi.fn() }));
vi.mock("./media/library.js", () => ({ ingestPortraitsFromIndex: doubles.ingest }));
vi.mock("./media/products.js", () => ({ upsertProductProfileFromDossier: doubles.project }));
vi.mock("./archive-host.js", () => ({
  archiveWorkDir: () => doubles.workDir,
  acquireProjectLease: async () => ({ release: doubles.release }),
  readProjectMeta: async () => ({ kind: "marketing", title: "结果完整性", threadId: "T1", createdAt: "2026-09-27T00:00:00Z" }),
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
  VideoStudio: class { runPreproduction = doubles.runPreproduction; },
  WorkloomLLMEngine: { fromEnv: () => ({ attachRouter: vi.fn() }) },
  installVendorEngineBridge: vi.fn(),
  installVendorRenderCompatBridge: vi.fn(),
  installVendorPortraitBindingBridge: () => doubles.uninstall,
  attachStructuredLog: () => () => undefined,
}));

let worker: typeof import("./studio-worker.js");
const scope = { tenantId: "tenant-test", workspaceId: "ws-test" };
let projectSequence = 0;

beforeAll(async () => {
  doubles.workDir = await mkdtemp(path.join(tmpdir(), "studio-result-"));
  worker = await import("./studio-worker.js");
});

afterAll(async () => { await rm(doubles.workDir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.clearAllMocks();
  doubles.nextAttempt = 0;
  doubles.runPreproduction.mockReset();
  doubles.finish.mockResolvedValue(undefined);
  doubles.release.mockResolvedValue(undefined);
  doubles.ingest.mockResolvedValue({ scanned: 0, ingested: 0, deduped: 0, skipped: 0, errors: [] });
  doubles.project.mockResolvedValue({ profile: { productName: "商品", dossierSha256: "a".repeat(64) }, changed: true, heroIngested: false });
  vi.stubEnv("ARCHIVE_ENABLED", "1");
  vi.stubEnv("MEDIA_INGEST_ENABLED", "1");
  vi.stubEnv("HR_PORTRAIT_ENABLED", "0");
  vi.stubEnv("VM_PRODUCER_RETRY", "1");
});

const success = () => ({
  success: true,
  confirmations: { theme: { approved: true, reason: "producer-approved" } },
  stages: {
    dataMining: { status: "completed", product_id: "product-a", data: { ok: true, reused: false, dossier: { provenance: [{ id: "source-a" }], gaps: [] } } },
    productionEngine: { shots: [{ shotId: "SC-1", prompt: "01.【场景】窗边桌面", fields: { scene: "窗边桌面" } }] },
  },
});
const rejected = () => ({
  success: false,
  confirmations: { theme: { approved: false, reason: "producer-rejected(G2_THEME)：需求冲突" } },
  stages: { creativeTheme: { title: "需要重做" } },
});

async function runToTerminal() {
  const projectId = `VID-result-${++projectSequence}`;
  const runId = worker.startRun(scope, { projectId, intent: "测试预生产结果", isMarketing: true });
  await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
  const entry = worker.getRun(runId, scope.workspaceId)!;
  return { projectId, runId, entry };
}

async function archiveOutput(projectId: string, attempt: number) {
  const file = path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "stages", "preproduction", `attempt-${attempt}.output.json`);
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("预生产原始结果与诚实终态", () => {
  it("启用档案时，监制打回仍触发有限重试，成功结果保留 stages.dataMining 驱动商品投影", async () => {
    doubles.runPreproduction.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success());
    const { entry, projectId, runId } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
    expect(entry).toMatchObject({ status: "finished", error: null, resultSummary: {
      success: true, stages: ["dataMining", "productionEngine"], producerAttempts: 2,
      dataMining: { productId: "product-a", ok: true, evidenceCount: 1, gaps: 0 },
    } });
    expect(doubles.project).toHaveBeenCalledWith(expect.anything(), expect.anything(), scope, expect.objectContaining({ productId: "product-a" }));
    expect(doubles.finish.mock.calls.map(([row]) => row.status)).toEqual(["failed", "done"]);
    expect((await archiveOutput(projectId, 1)).success).toBe(false);
    expect((await archiveOutput(projectId, 2)).stages).toEqual(["dataMining", "productionEngine"]);
    expect(worker.getRun(runId, "another-workspace")).toBeNull();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("监制连续打回到上限后 status=failed，保留具体拒绝原因", async () => {
    doubles.runPreproduction.mockResolvedValue(rejected());
    const { entry } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("producer-rejected(G2_THEME)：需求冲突");
    expect(entry.resultSummary).toMatchObject({ success: false, producerAttempts: 2, stages: ["creativeTheme"] });
    expect(worker.summarizeWorkspaceRuns(scope.workspaceId).failedRecent).toBeGreaterThan(0);
  });

  it.each(["0", "1"])("ARCHIVE_ENABLED=%s：业务软失败都不得显示 finished", async (archiveEnabled) => {
    vi.stubEnv("ARCHIVE_ENABLED", archiveEnabled);
    doubles.runPreproduction.mockResolvedValue({ success: false, errors: [{ stage: "insight", message: "来源不足" }], stages: {} });
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "来源不足", resultSummary: { success: false, producerAttempts: 1 } });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.finish).toHaveBeenCalledTimes(archiveEnabled === "1" ? 1 : 0);
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

  it("关闭档案后仍保留原有成功结果和商品档案投影", async () => {
    vi.stubEnv("ARCHIVE_ENABLED", "0");
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "finished", error: null, resultSummary: { dataMining: { productId: "product-a" } } });
    expect(doubles.project).toHaveBeenCalledTimes(1);
    expect(doubles.finish).not.toHaveBeenCalled();
  });

  it("失败原因兼容已有 failures 与 errorMessage，空消息回退且限制长度", () => {
    expect(worker.terminalFailureMessageOf({ errorMessage: "备用错误字段" })).toBe("备用错误字段");
    expect(worker.terminalFailureMessageOf({ failures: [{ message: "已有失败列表" }] })).toBe("已有失败列表");
    expect(worker.terminalFailureMessageOf({ error: " ", errors: [{ error: "底层错误" }] })).toBe("底层错误");
    expect(worker.terminalFailureMessageOf({}, "运行器异常")).toBe("运行器异常");
    expect(worker.terminalFailureMessageOf({ error: "x".repeat(600) })).toHaveLength(500);
    expect(worker.terminalFailureMessageOf({})).toBe("vendor 返回 success:false");
  });
});
