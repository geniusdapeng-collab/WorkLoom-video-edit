/** 实际 tRPC caller：schema/身份/参数传递与门禁使用真实路由，权限事实和业务边界显式替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../trpc/context.js";
const d = vi.hoisted(() => ({ query: vi.fn(), qualify: vi.fn(), shots: vi.fn(), load: vi.fn(), submit: vi.fn(),
  status: vi.fn(), recover: vi.fn(), judge: vi.fn(), budget: vi.fn(), cap: vi.fn(), writable: true }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: async () => ({ query: d.query, release: vi.fn() }) }), getGatewayPool: () => ({}) }));
vi.mock("../service/access-authority.js", async original => ({ ...await original<Record<string, unknown>>(),
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ actionPermissions: d.writable ? ["workspace.write"] : [] }),
}));
vi.mock("./production-authority.js", () => ({ qualifyProductionShot: d.qualify, listProductionShots: d.shots, loadQualifiedRenderInput: d.load, productionG8Status: d.status, recoverG8Qualification: d.recover }));
vi.mock("./gen/submit.js", () => ({ submitGenJob: d.submit }));
vi.mock("./archive-host.js", async original => ({ ...await original<Record<string, unknown>>(), makeStageArchive: () => null }));
vi.mock("@workloom/base/fence-engine", async original => ({ ...await original<Record<string, unknown>>(), judge: d.judge }));
vi.mock("@workloom/base/model-router", async original => ({ ...await original<Record<string, unknown>>(), checkRenderBudget: d.budget }));
vi.mock("./gen/cost.js", async original => {
  const actual = await original<typeof import("./gen/cost.js")>();
  return { ...actual, estimateCost: vi.fn(actual.estimateCost), checkCostCaps: d.cap, renderSpendCny: async () => ({ day: 0, month: 0 }) };
});
vi.mock("@workloom/base/workdata", async original => ({
  ...await original<Record<string, unknown>>(),
  gatewayAppend: vi.fn(async () => ({ eventId: "EV-auto-approval" })),
  gatewayAppendOnClient: vi.fn(async () => ({ eventId: "EV-inert-native-g8" })),
}));
import { videoRouter } from "./router.js";
import { SubmissionError } from "./gen/submission-ledger.js";
import { estimateCost } from "./gen/cost.js";
import { getModel } from "./gen/catalog.js";
const identity = { tenantId: "tenant-router", workspaceId: "ws-router", memberNo: "MEM-T", plan: "pro", role: "owner" } as NonNullable<TrpcContext["identity"]>;
const context: TrpcContext = { identity, session: identity, partnerIdentity: null, headers: new Headers() };
const caller = () => videoRouter.createCaller(context);
const canonical = () => ({ script: { id: "RS-CANONICAL", project_id: "P1", shot_id: "S1", script_key: "qualified:PQ-1", version: 1,
  status: "draft", md: "服务端完整镜头正文", fields: { durationSec: 5 } }, modelId: "doubao-seedance-2-5", mode: "manual", params: { durationSec: 5, aspectRatio: "16:9", extra: { cfg_scale: 2 } },
  requestHash: "a".repeat(64), qualificationId: "PQ-1", compiled: {}, reconciliationOnly: false });
beforeEach(() => {
  vi.clearAllMocks(); d.writable = true; vi.stubEnv("ARCHIVE_AUTO_RESUME", "0");
  d.query.mockResolvedValue({ rows: [], rowCount: 0 });
  d.qualify.mockResolvedValue({ qualificationId: "PQ-1", qualificationToken: "test-token", scriptId: "RS-CANONICAL", promptSha256: "a".repeat(64) });
  d.shots.mockResolvedValue({ projectId: "P1", shots: [{ shotId: "S1", durationSec: 5, prompt: "服务端完整镜头正文" }] });
  d.load.mockResolvedValue(canonical());
  d.judge.mockReturnValue({ level: "auto", impacts: [], triggeredBy: [] });
  d.budget.mockReturnValue({ allowed: true, overageSeconds: 0 }); d.cap.mockReturnValue({ allowed: true });
  d.submit.mockResolvedValue({ jobId: "RJ-1", taskId: "remote-1", mock: false, provider: "seedance", providerModel: "m", estUsd: 1, estCny: 7, deduped: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(estimateCost).mockReset(); });

describe("生产入口正常可达且不能覆盖已审核请求", () => {
  it("真实根路由挂载shots/qualify，scope只来自登录身份；随后只给token完成提交", async () => {
    expect((await caller().production.shots({ projectId: "P1" })).shots).toHaveLength(1);
    const qualification = await caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "doubao-seedance-2-5", params: { aspectRatio: "16:9" } });
    expect(d.qualify).toHaveBeenCalledWith(expect.objectContaining({ scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId }, actor: "MEM-T", projectId: "P1", shotId: "S1" }));
    const result = await caller().render.submit({ qualificationToken: qualification.qualificationToken });
    expect(result).toMatchObject({ mock: false, durationSec: 5, clamped: false });
    expect(d.submit).toHaveBeenCalledWith(expect.objectContaining({ script: canonical().script, params: canonical().params,
      qualificationToken: "test-token", modelId: "doubao-seedance-2-5", mode: "manual", durationProvenance: { source: "script-fields", planSeconds: 5, requestedSeconds: 5, mismatchSeconds: 0, strict: true } }));
  });
  it("精简资格走同一正式签发和权限范围，只返回签名回执", async () => {
    const input = { projectId: "P1", shotId: "S1", modelId: "doubao-seedance-2-5", params: { durationSec: 10 } };
    const result = await caller().production.qualifyShotReceipt(input);
    expect(d.qualify).toHaveBeenCalledWith(expect.objectContaining({ ...input, response: "receipt",
      scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId }, actor: "MEM-T" }));
    expect(result).not.toHaveProperty("params");
    expect(result.qualificationToken).toBe("test-token");
    expect(d.submit).not.toHaveBeenCalled();
    await expect(caller().production.qualifyShotReceipt({ ...input, passed: true } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(videoRouter.createCaller({ ...context, identity: null, session: null }).production.qualifyShotReceipt(input))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    d.writable = false;
    await expect(caller().production.qualifyShotReceipt(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.qualify).toHaveBeenCalledTimes(1);
  });
  it("没有token的旧CMS approved直提在查脚本/供应商之前拒绝", async () => {
    await expect(caller().render.submit({ scriptId: "RS-handmade", mode: "auto" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(d.load).not.toHaveBeenCalled(); expect(d.query).not.toHaveBeenCalled(); expect(d.submit).not.toHaveBeenCalled();
  });
  it.each([{ scriptId: "other" }, { modelId: "other" }, { mode: "auto" as const }, { durationSec: 120 },
    { estimatedSeconds: 30 }, { firstFrameUrl: "https://new.example.test/changed.png" }, { generateAudio: true }])("客户端覆盖 %j 失败关闭", async patch => {
    await expect(caller().render.submit({ qualificationToken: "test-token", ...patch })).rejects.toThrow("QUALIFICATION_REQUEST_MISMATCH");
    expect(d.submit).not.toHaveBeenCalled();
  });
  it("未知字段不静默丢弃；服务签发不接受正文、路径、评分或scope自述", async () => {
    await expect(caller().render.submit({ qualificationToken: "test-token", prompt: "forged" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "m", passed: true, md: "forged" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.qualify).not.toHaveBeenCalled(); expect(d.submit).not.toHaveBeenCalled();
  });
  it("旧字段相等时仍原样提交全部canonical参数，包括UI未列出的extra", async () => {
    await caller().render.submit({ qualificationToken: "test-token", scriptId: "RS-CANONICAL", mode: "manual", durationSec: 5, aspectRatio: "16:9" });
    expect(d.submit.mock.calls[0]![0].params).toEqual(canonical().params);
  });
  it("G8 review 在全部策略证据通过后自动放行并提交", async () => {
    vi.stubEnv("WORKLOOM_RENDER_AUTO", "0"); d.load.mockResolvedValue({ ...canonical(), mode: "auto" });
    d.judge.mockReturnValue({ level: "review", impacts: [], triggeredBy: ["G8"] });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).resolves.toMatchObject({ jobId: "RJ-1" });
    expect(d.judge.mock.calls[0]![0].context.render_auto).toBe(true);
    expect(d.submit).toHaveBeenCalledTimes(1);
  });
  it("全局 kill switch 关闭时 G8 review 直接 FORBIDDEN，不生成人工等待", async () => {
    vi.stubEnv("PIPELINE_SYSTEM_AUTO_APPROVAL", "off");
    d.load.mockResolvedValue({ ...canonical(), mode: "auto" });
    d.judge.mockReturnValue({ level: "review", impacts: [], triggeredBy: ["G8"] });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.judge.mock.calls[0]![0].context.render_auto).toBe(false);
    expect(d.submit).not.toHaveBeenCalled();
  });
  it.each(["block", "budget", "cost"])("%s 不允许新外部动作", async kind => {
    if (kind === "block") d.judge.mockReturnValue({ level: "block", impacts: [], triggeredBy: ["G8"] });
    if (kind === "budget") d.budget.mockReturnValue({ allowed: false, reason: "配额不足" });
    if (kind === "cost") d.cap.mockReturnValue({ allowed: false, reason: "成本上限" });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).rejects.toThrow(); expect(d.submit).not.toHaveBeenCalled();
  });
  it("已接受任务的补账不会再次消耗配额，也不因新成本上限阻断", async () => {
    d.load.mockResolvedValue({ ...canonical(), reconciliationOnly: true });
    d.judge.mockReturnValue({ level: "block", impacts: [], triggeredBy: ["G8"] });
    d.budget.mockReturnValue({ allowed: false, reason: "配额不足" }); d.cap.mockReturnValue({ allowed: false, reason: "成本上限" });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).resolves.toMatchObject({ jobId: "RJ-1" });
  });
  it("资格拒绝返回可操作的前置条件错误；未登录和只读身份不能签发/提交", async () => {
    d.qualify.mockRejectedValue(new SubmissionError("PREPRODUCTION_REQUIRED", "先完成预生产"));
    await expect(caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "m" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(videoRouter.createCaller({ ...context, identity: null, session: null }).production.shots({ projectId: "P1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    d.writable = false;
    await expect(caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "m" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.submit).not.toHaveBeenCalled();
  });
});

it("native G8 continuation uses the recovered original qualification and consumes approval only once", async () => {
  vi.stubEnv("PROMPT_CONTRACT_V2", "enforce");
  const quote = estimateCost(getModel("doubao-seedance-2-5")!, { seconds: 5 });
  vi.mocked(estimateCost).mockReturnValue({ ...quote, usd: 1, cny: 7.2 });
  type Row = { approval_id: string; status: string; snapshot: Record<string, unknown>; consumed_at: string | null };
  const rows = new Map<string, Row>();
  d.status.mockResolvedValue({ contract: null, ticket: null });
  d.recover.mockImplementation(async ({ approvalId }) => {
    const row = rows.get(approvalId);
    if (!row || row.status !== "approved" || row.consumed_at) throw new SubmissionError("G8_APPROVAL_NOT_RESUMABLE", "fixture");
    return "inert-q1";
  });
  expect(await caller().production.g8Status({ projectId: "P1", shotId: "S1" })).toEqual({ contract: null, ticket: null });
  expect(d.status).toHaveBeenCalledWith(expect.objectContaining({ scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
    projectId: "P1", shotId: "S1" }));
  await expect(videoRouter.createCaller({ ...context, identity: null, session: null }).production.g8Status({ projectId: "P1", shotId: "S1" }))
    .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  d.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO approvals")) {
      const id = String(params[0]);
      rows.set(id, { approval_id: id, status: "pending", snapshot: JSON.parse(String(params[4])), consumed_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM approvals") && sql.includes("status='pending'")) {
      const row = [...rows.values()].find(row => row.status === "pending" && row.snapshot.binding_sha256 === params[2]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM approvals") && sql.includes("FOR UPDATE")) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE approvals SET consumed_at")) {
      const row = rows.get(String(params[0]))!;
      if (row.consumed_at || row.status !== "approved") return { rows: [], rowCount: 0 };
      row.consumed_at = "fixture-one-use";
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const q1 = { ...canonical(), compiled: { payloadHash: "b".repeat(64) } };
  const q2 = { ...q1, qualificationId: "PQ-2", requestHash: "c".repeat(64), script: { ...q1.script, id: "RS-2" } };
  d.load.mockImplementation(async (_app, _scope, token) => token === "inert-q1" ? q1 : q2);
  await expect(caller().render.submit({ qualificationToken: "inert-q1" }))
    .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^G8_HUMAN_APPROVAL_REQUIRED:apr-[a-f0-9]{20}$/) });
  const firstId = [...rows.keys()][0]!;
  expect(rows.get(firstId)?.snapshot.params).toMatchObject({ qualificationId: "PQ-1", shotId: "S1", estimatedCny: 7.2 });
  await expect(caller().render.submit({ qualificationToken: "inert-q1" }))
    .rejects.toThrow("G8_HUMAN_APPROVAL_REQUIRED:" + firstId);
  expect(rows.size).toBe(1);
  await expect(caller().render.submit({ qualificationToken: "inert-q2" }))
    .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^G8_HUMAN_APPROVAL_REQUIRED:apr-[a-f0-9]{20}$/) });
  expect(rows.size).toBe(2);
  await expect(caller().render.submit({ g8ApprovalId: firstId })).rejects.toThrow("G8_APPROVAL_NOT_RESUMABLE");
  expect(d.submit).not.toHaveBeenCalled();
  // Local fixture projection only. No approvals.decide or real DB/service is called.
  rows.get(firstId)!.status = "approved";
  await expect(caller().render.submit({ qualificationToken: "inert-q2", g8ApprovalId: firstId }))
    .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("G8_APPROVAL_PAYLOAD_MISMATCH") });
  d.writable = false;
  await expect(caller().render.submit({ g8ApprovalId: firstId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  d.writable = true;
  await expect(caller().render.submit({ g8ApprovalId: firstId })).resolves.toMatchObject({ jobId: "RJ-1" });
  expect(d.recover).toHaveBeenCalledWith(expect.objectContaining({ approvalId: firstId,
    scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId } }));
  expect(d.submit).toHaveBeenCalledWith(expect.objectContaining({ qualificationToken: "inert-q1", script: q1.script }));
  expect(d.submit).toHaveBeenCalledTimes(1);
  await expect(caller().render.submit({ qualificationToken: "inert-q1", g8ApprovalId: firstId }))
    .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("G8_APPROVAL_CONSUMED") });
  expect(d.submit).toHaveBeenCalledTimes(1);
});
