/** Real tRPC input/auth/routing; native workers, project SQL and model transport are explicit doubles. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../trpc/context.js";

const d = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(), startRun: vi.fn(), startProject: vi.fn(),
  createDraft: vi.fn(), routeLlmFactory: vi.fn(), routeLlm: vi.fn(), scenePolicy: vi.fn(), writable: true,
}));
vi.mock("@workloom/db", () => ({
  getAppPool: () => ({ connect: d.connect }), getGatewayPool: () => ({}),
}));
vi.mock("../service/access-authority.js", async original => ({
  ...await original<Record<string, unknown>>(),
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ actionPermissions: d.writable ? ["workspace.write"] : [] }),
}));
vi.mock("../service/llm.js", async original => ({
  ...await original<Record<string, unknown>>(), routedLlmCall: d.routeLlmFactory,
}));
vi.mock("./studio-worker.js", async original => ({
  ...await original<Record<string, unknown>>(), startRun: d.startRun, startVideoProjectRun: d.startProject,
}));
vi.mock("./explainer/db.js", async original => ({
  ...await original<Record<string, unknown>>(), createExplainerDraft: d.createDraft,
}));
vi.mock("./scene-policy-routing.js", async original => ({
  ...await original<Record<string, unknown>>(), resolveScenePolicyForIntent: d.scenePolicy,
}));

import { videoRouter } from "./router.js";

const identity = { tenantId: "tenant-studio-start", workspaceId: "ws-studio-start", memberNo: "MEM-T", plan: "pro", role: "owner" } as NonNullable<TrpcContext["identity"]>;
const context: TrpcContext = { identity, session: identity, partnerIdentity: null, headers: new Headers() };
const caller = () => videoRouter.createCaller(context).studio;
const intent = "商品名：星野循环扇，制作短视频，保留客户原文 <&> 与 café。";
const scope = { tenantId: identity.tenantId, workspaceId: identity.workspaceId };
const branches = ["new", "existing"] as const;

function input(branch: typeof branches[number], metadata?: Record<string, unknown>, route: "auto" | "marketing" | "narrative" = "marketing") {
  return { intent, route, ...(branch === "existing" ? { projectId: "VID-existing" } : {}), ...(metadata === undefined ? {} : { metadata }) };
}
function workerInput(branch: typeof branches[number]): {
  intent: string; rawIntent?: string; metadata: Record<string, unknown>; customerMetadata?: Record<string, unknown>; isMarketing?: boolean;
} {
  const selected = branch === "new" ? d.startProject : d.startRun;
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected.mock.calls[0]![0]).toEqual(scope);
  return selected.mock.calls[0]![1];
}
function expectNoBusinessSideEffects() {
  expect(d.routeLlmFactory).not.toHaveBeenCalled();
  expect(d.routeLlm).not.toHaveBeenCalled();
  expect(d.connect).not.toHaveBeenCalled();
  expect(d.query).not.toHaveBeenCalled();
  expect(d.scenePolicy).not.toHaveBeenCalled();
  expect(d.createDraft).not.toHaveBeenCalled();
  expect(d.startProject).not.toHaveBeenCalled();
  expect(d.startRun).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks(); d.writable = true; vi.stubEnv("ARCHIVE_AUTO_RESUME", "0");
  d.connect.mockResolvedValue({ query: d.query, release: d.release });
  d.query.mockResolvedValue({ rows: [{ kind: "marketing" }], rowCount: 1 });
  d.startRun.mockReturnValue("RUN-existing");
  d.startProject.mockResolvedValue({ projectId: "VID-new", runId: "RUN-new" });
  d.createDraft.mockResolvedValue({ projectId: "EX-new", shotbookId: "BOOK-new" });
  d.routeLlmFactory.mockReturnValue(d.routeLlm);
  d.routeLlm.mockRejectedValue(new Error("Unexpected provider call in a deterministic routing test"));
  d.scenePolicy.mockReturnValue({ decision: { id: null }, metadata: {} });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(branches)("studio.start %s project duration", branch => {
  it("uses this request's 35 seconds once and preserves the original intent and complete metadata", async () => {
    const request = input(branch, { platform: "douyin", keep: { text: "原始完整字段" },
      brief: { duration: 35, product: "星野循环扇", aspectRatio: "9:16", description: "本片正式目标35秒" } });
    const before = structuredClone(request);
    const result = await caller().start(request);
    expect(result).toMatchObject({ kind: "routed", pipeline: "marketing", runId: `RUN-${branch}` });
    const passed = workerInput(branch);
    expect(passed.rawIntent).toBe(intent);
    expect(passed.intent.split("\n").filter((line: string) => line.startsWith("[需求口径]")))
      .toEqual(["[需求口径] 时长：35秒；画幅：9:16；平台：douyin"]);
    expect(passed.intent).not.toContain("时长：30秒");
    expect(passed.metadata.brief).toEqual(request.metadata!.brief);
    expect(passed.metadata.keep).toEqual({ text: "原始完整字段" });
    expect(request).toEqual(before);
    expect(d.routeLlm).not.toHaveBeenCalled();
    if (branch === "new") {
      expect(passed.customerMetadata).toEqual(request.metadata);
      expect(d.startRun).not.toHaveBeenCalled(); expect(d.query).not.toHaveBeenCalled();
    } else {
      expect(d.startProject).not.toHaveBeenCalled();
      expect(d.query).toHaveBeenCalledWith(expect.stringContaining("SELECT kind FROM video_projects"), ["VID-existing", identity.workspaceId]);
    }
  });

  it.each([5, "5", "35", 30.5, "30.5", 180, "180.0"])("retains the accepted numeric/string boundary %j", async duration => {
    await caller().start(input(branch, { brief: { duration } }));
    expect(workerInput(branch).intent).toContain(`[需求口径] 时长：${Number(duration)}秒`);
  });

  it.each([undefined, {}, { brief: {} }, { brief: { duration: undefined } }, { brief: null }, { brief: "旧版完整客户描述" }, { brief: [] }])("defaults only an omitted duration in legacy metadata %j", async metadata => {
    await caller().start(input(branch, metadata));
    expect(workerInput(branch).intent).toContain("[需求口径] 时长：30秒");
  });

  it.each([null, false, true, [], {}, 0, -1, 4.999, 180.001, NaN, Infinity, -Infinity,
    "", " 35", "35 ", "35s", "3.5e1", "0x23"].map(value => [value]))("rejects explicit invalid duration %j before routing or any business side effect", async duration => {
    await expect(caller().start(input(branch, { brief: { duration } }))).rejects.toMatchObject({
      code: "BAD_REQUEST", message: "PRD_PROFILE_INVALID: Brief 明确时长非法",
    });
    expectNoBusinessSideEffects();
  });

  it("does not validate or rewrite unrelated legacy platform, aspect or partial production fields", async () => {
    const metadata = { platform: "kuaishou", brief: { duration: "35", product: "星野循环扇", platform: "youtube", aspectRatio: "16:9", productionRequirements: { resolution: "1080p" } } };
    const before = structuredClone(metadata);
    await caller().start(input(branch, metadata));
    const passed = workerInput(branch);
    // Existing root platform precedence and platform-derived marketing ratio remain in force.
    expect(passed.intent).toContain("[需求口径] 时长：35秒；画幅：9:16；平台：kuaishou");
    expect(passed.metadata.brief).toEqual(before.brief);
    expect(passed.metadata.platform).toBe("kuaishou");
    expect(metadata).toEqual(before);
  });

  it("keeps narrative headers without a newly inferred aspect ratio", async () => {
    d.query.mockResolvedValue({ rows: [{ kind: "narrative" }], rowCount: 1 });
    await caller().start(input(branch, { platform: "youtube", brief: { duration: 35, aspectRatio: "9:16" } }, "narrative"));
    const passed = workerInput(branch);
    expect(passed.intent.split("\n").filter((line: string) => line.startsWith("[需求口径]")))
      .toEqual(["[需求口径] 时长：35秒；平台：youtube"]);
    expect(passed.isMarketing).toBe(false);
  });
});

describe("studio.start explainer and authorization boundaries", () => {
  it("retains the explainer draft flow and exact raw intent without starting a Studio worker", async () => {
    const raw = "走口播片：用一条口播讲解视频科普光线原理。";
    const result = await caller().start({ intent: raw, metadata: { brief: { duration: 35 } } });
    expect(result).toMatchObject({ kind: "routed", pipeline: "explainer", runId: null, projectId: "EX-new", shotbookId: "BOOK-new" });
    expect(d.createDraft).toHaveBeenCalledExactlyOnceWith(scope, { intent: raw, by: identity.memberNo });
    expect(d.startRun).not.toHaveBeenCalled(); expect(d.startProject).not.toHaveBeenCalled();
    expect(d.query).not.toHaveBeenCalled(); expect(d.routeLlm).not.toHaveBeenCalled();
  });

  it("rejects an invalid explicit duration before an explainer draft or route model can be created", async () => {
    await expect(caller().start({ intent: "走口播片：讲解光线原理。", metadata: { brief: { duration: 0 } } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expectNoBusinessSideEffects();
  });

  it("retains deterministic clarification without starting a project", async () => {
    const result = await caller().start({ intent: "做个视频", metadata: { brief: { duration: 35 } } });
    expect(result.kind).toBe("clarify");
    expect(d.startRun).not.toHaveBeenCalled(); expect(d.startProject).not.toHaveBeenCalled();
    expect(d.query).not.toHaveBeenCalled(); expect(d.createDraft).not.toHaveBeenCalled();
  });

  it("keeps unauthenticated and non-writable callers outside all business paths", async () => {
    await expect(videoRouter.createCaller({ ...context, identity: null, session: null }).studio.start(input("new", { brief: { duration: 35 } })))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    d.writable = false;
    await expect(caller().start(input("existing", { brief: { duration: 35 } })))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expectNoBusinessSideEffects();
  });
});
