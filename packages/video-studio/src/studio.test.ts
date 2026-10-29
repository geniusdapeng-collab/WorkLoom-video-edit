import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGate } from "./gates.js";
import { autoApproveHandler, runWithConfirmationHandler } from "./confirmation.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { buildRenderScript, loadPromptLengthSpec } from "./render-scripts.js";
import { VideoStudio, type ApprovalCallback, type EventSink, type StudioConfig } from "./studio.js";
import { prdFixture } from "./prd-authority.test-support.js";
import type { PrdAuthority } from "./prd-authority.js";
import type { RequirementApprovedTheme } from "./requirement-authority.js";

interface ObservedRequirementAuthority {
  authority: PrdAuthority;
  approvedTheme: () => RequirementApprovedTheme | undefined;
  validateAuthority: () => void;
}
interface ObservedPrdScope {
  authority: PrdAuthority | undefined;
  validateAuthority: (() => void) | undefined;
  approvedTheme: (() => RequirementApprovedTheme | undefined) | undefined;
}

const studioMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  create: vi.fn(),
  installed: [] as string[],
  disposed: [] as string[],
  requirementScopes: [] as Array<{ metadata: unknown; options: ObservedRequirementAuthority | undefined }>,
  prdScopes: [] as ObservedPrdScope[],
  failInstall: "",
  failDispose: ""
}));

// Stub the explicit entry/contract seams, keeping production constructor/model work outside wiring tests.
vi.mock("./vendor-requirement-entry.js", () => ({
  acquireVendorRequirementEntry: () => {
    if (studioMocks.failInstall === "entry") throw new Error("install failed: entry");
    studioMocks.installed.push("entry");
    return {
      exports: { HyperrealitySystem: class {
        constructor(options: unknown) { studioMocks.construct(options); }
        create(...input: unknown[]) { return studioMocks.create(...input); }
      } },
      identity: { entryPath: "/fixture/vendor/index.js" },
      release: () => { studioMocks.disposed.push("entry"); if (studioMocks.failDispose === "entry") throw new Error("dispose failed: entry"); }
    };
  }
}));
vi.mock("./requirement-contract-bridge.js", () => ({
  assertRequirementContractBridge: () => undefined,
  withRequirementContractScope: (metadata: unknown, operation: () => unknown, options?: ObservedRequirementAuthority) => {
    studioMocks.requirementScopes.push({ metadata, options });
    return operation();
  },
  installVendorRequirementContractBridge: () => {
    if (studioMocks.failInstall === "requirement") throw new Error("install failed: requirement");
    studioMocks.installed.push("requirement");
    return () => { studioMocks.disposed.push("requirement"); if (studioMocks.failDispose === "requirement") throw new Error("dispose failed: requirement"); };
  }
}));
// These are assembly/lifecycle tests. Native PRD generation and strict scope
// behavior are exercised with the real generator/agents in prd-authority-bridge.test.ts.
vi.mock("./prd-authority-bridge.js", () => ({
  assertPrdAuthorityBridge: () => undefined,
  withPrdAuthorityScope: (authority: PrdAuthority | undefined, operation: () => unknown,
    validateAuthority?: () => void, approvedTheme?: () => RequirementApprovedTheme | undefined) => {
    studioMocks.prdScopes.push({ authority, validateAuthority, approvedTheme });
    return operation();
  },
  installVendorPrdAuthorityBridge: () => {
    if (studioMocks.failInstall === "prd") throw new Error("install failed: prd");
    studioMocks.installed.push("prd");
    return () => { studioMocks.disposed.push("prd"); if (studioMocks.failDispose === "prd") throw new Error("dispose failed: prd"); };
  },
  installVendorPrdProductionBridge: () => {
    if (studioMocks.failInstall === "production") throw new Error("install failed: production");
    studioMocks.installed.push("production");
    return () => { studioMocks.disposed.push("production"); if (studioMocks.failDispose === "production") throw new Error("dispose failed: production"); };
  }
}));

vi.mock("./vendor-compat.js", () => {
  const install = (name: string) => () => {
    if (studioMocks.failInstall === name) throw new Error(`install failed: ${name}`);
    studioMocks.installed.push(name);
    return () => {
      studioMocks.disposed.push(name);
      if (studioMocks.failDispose === name) throw new Error(`dispose failed: ${name}`);
    };
  };
  return {
    applyDurationPolicyToManager: vi.fn(),
    installVendorConfigIsolatorBridge: install("isolator"),
    installVendorPhaseDiagnosticsBridge: install("phase"),
    installVendorFieldQualityBridge: install("field"),
    installVendorMicroMotionBridge: install("micro"),
    installVendorContractBridge: install("contract"),
    installVendorPromptRebuildBridge: install("prompt"),
    installVendorDiscoveryFixBridge: install("discovery"),
    installVendorPhaseInternalsDiagnostics: install("inner"),
    installVendorAudioDisciplineBridge: install("audio"),
    installVendorDurationPolicyBridge: install("duration"),
    installVendorDurationProjectionBridge: install("projection"),
    installSharedBridge: (_key: string, factory: () => () => void) => factory()
  };
});

vi.mock("./duration-rules.js", () => ({
  loadDurationRules: () => ({ modelMin: 4, modelMax: 30, sources: [], nonLive: [], blockers: [], aligned: true })
}));

beforeEach(() => {
  studioMocks.construct.mockReset();
  studioMocks.create.mockReset();
  studioMocks.installed.length = 0;
  studioMocks.disposed.length = 0;
  studioMocks.requirementScopes.length = 0;
  studioMocks.prdScopes.length = 0;
  studioMocks.failInstall = "";
  studioMocks.failDispose = "";
});

describe("gates 映射", () => {
  it("vendor 确认门 type 映射到业务门", () => {
    expect(resolveGate("creative-theme")).toBe("G2_THEME");
    expect(resolveGate("prd")).toBe("G4_PRD");
    expect(resolveGate("portraits")).toBe("G5_PORTRAIT");
    expect(resolveGate("prompt")).toBe("G6_PROMPT");
    expect(resolveGate("dossier")).toBe("G1_DOSSIER");
    expect(resolveGate("nonexistent")).toBe("UNKNOWN");
  });
});

describe("确认门桥", () => {
  it("作用域内可读取批准，退出后固定分发器拒绝无作用域调用", async () => {
    const handler = autoApproveHandler();
    const request = { type: "prd", content: "# PRD", runId: "r1" };
    const verdict = await runWithConfirmationHandler(handler, () => globalThis.__HR_CONFIRMATION_HANDLER__!(request));
    expect(verdict.approved).toBe(true);
    expect(await globalThis.__HR_CONFIRMATION_HANDLER__!(request)).toMatchObject({
      approved: false, fatal: "confirmation-scope-missing"
    });
  });
});

function studio(onApproval: ApprovalCallback, onEvent?: EventSink): VideoStudio {
  return new VideoStudio({
    llm: new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "deepseek-flash" }),
    workDir: "/unused/confirmation-scope-test",
    onApproval,
    onEvent,
    log: () => undefined
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("VideoStudio 确认作用域与装配清理", () => {
  it("两条真实 studio 运行交错确认，项目与事件不串线", async () => {
    const ready = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const approvals = [vi.fn(async () => ({ approved: true, reason: "A" })), vi.fn(async () => ({ approved: false, reason: "B" }))];
    const events = [vi.fn(), vi.fn()];
    studioMocks.create.mockImplementation(async (intent: string) => {
      const i = intent === "A" ? 0 : 1;
      ready[i]!.resolve();
      await release[i]!.promise;
      const verdict = await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "prd", content: intent, runId: `run-${intent}` });
      return { success: verdict.approved, verdict, stages: {} };
    });
    const running = [
      studio(approvals[0]!, events[0]).runPreproduction({ projectId: "project-A", intent: "A" }),
      studio(approvals[1]!, events[1]).runPreproduction({ projectId: "project-B", intent: "B" })
    ];
    await Promise.all(ready.map((r) => r.promise));
    release[1]!.resolve();
    expect(await running[1]).toMatchObject({ success: false, verdict: { reason: "B" } });
    release[0]!.resolve();
    expect(await running[0]).toMatchObject({ success: true, verdict: { reason: "A" } });
    for (const [i, label] of ["A", "B"].entries()) {
      expect(approvals[i]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        gate: "G4_PRD", contentMd: label, runId: `run-${label}`
      }));
      for (const [event] of events[i]!.mock.calls) expect(event.projectId).toBe(`project-${label}`);
      expect(events[i]).toHaveBeenCalledWith(expect.objectContaining({ kind: "pipeline.gate.resolved" }));
    }
  });

  it.each(["install", "constructor", "started", "create", "approval"])("%s 失败也逆序清理所有已装桥并关闭确认作用域", async (failureAt) => {
    const failure = new Error(`failed at ${failureAt}`);
    const onApproval = vi.fn(async () => {
      if (failureAt === "approval") throw failure;
      return { approved: true };
    });
    const events = vi.fn(async (event: Parameters<EventSink>[0]) => {
      if (failureAt === "started" && event.kind === "pipeline.started") throw failure;
    });
    if (failureAt === "install") studioMocks.failInstall = "field";
    if (failureAt === "constructor") studioMocks.construct.mockImplementation(() => { throw failure; });
    studioMocks.create.mockImplementation(async () => {
      if (failureAt === "create") throw failure;
      await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "prd", content: "content", runId: "r" });
      return { success: true };
    });
    await expect(studio(onApproval, events).runPreproduction({ projectId: "p", intent: "intent" }))
      .rejects.toThrow(failureAt === "install" ? "install failed: field" : failure.message);
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: "pipeline.failed" }));
    expect(await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "prd", content: "outside", runId: "r" }))
      .toMatchObject({ approved: false, fatal: "confirmation-scope-missing" });
    if (["install", "constructor", "started"].includes(failureAt)) expect(studioMocks.create).not.toHaveBeenCalled();
  });

  it("一个桥清理失败仍尝试其余清理，并保留运行与清理两个错误", async () => {
    const failure = new Error("create failed");
    studioMocks.create.mockRejectedValue(failure);
    studioMocks.failDispose = "audio";
    const result = studio(async () => ({ approved: true })).runPreproduction({ projectId: "p", intent: "intent" });
    await expect(result).rejects.toMatchObject({
      name: "AggregateError", message: "video-studio-bridge-cleanup-failed",
      errors: [failure, expect.objectContaining({ message: "dispose failed: audio" })]
    });
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });

  it("成功路径也逆序清理，返回原始业务结果", async () => {
    const result = { success: true, stages: { fixture: { intact: true } } };
    studioMocks.create.mockResolvedValue(result);
    expect(await studio(async () => ({ approved: true })).runPreproduction({ projectId: "p", intent: "intent" })).toBe(result);
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
    expect(studioMocks.installed).not.toContain("prd");
    expect(studioMocks.installed).not.toContain("production");
    expect(studioMocks.construct).toHaveBeenCalledWith(expect.objectContaining({ productionEngine: expect.objectContaining({ agentConfig: expect.objectContaining({ enableResume: true }) }) }));
    expect(studioMocks.prdScopes).toEqual([{ authority: undefined, validateAuthority: undefined, approvedTheme: undefined }]);
  });

  it("非营销metadata自报production authority不启用私有制作桥且保留resume", async () => {
    studioMocks.create.mockResolvedValue({ success: true, stages: {} });
    const metadata = { prdAuthority: { approved: true }, _workloomPrdAuthority: { status: "ready-for-g4" },
      _workloomProductionAuthority: { profile: { titleCard: false }, g4Hash: "forged" } };
    await studio(async () => ({ approved: true })).runPreproduction({ projectId: "legacy", intent: "原始叙事", metadata });
    expect(studioMocks.installed).not.toContain("production"); expect(studioMocks.installed).not.toContain("prd");
    expect(studioMocks.construct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ productionEngine: expect.objectContaining({ agentConfig: expect.objectContaining({ enableResume: true }) }) }));
    expect(studioMocks.prdScopes).toEqual([{ authority: undefined, validateAuthority: undefined, approvedTheme: undefined }]);
    expect(studioMocks.create).toHaveBeenCalledWith("原始叙事", metadata, expect.any(Object));
  });

  it.each(["entry", "requirement"])("%s 准入失败不会构造vendor，并清理已取得的资源", async name => {
    studioMocks.failInstall = name;
    await expect(studio(async () => ({ approved: true })).runPreproduction({ projectId: "p", intent: "intent" }))
      .rejects.toThrow(`install failed: ${name}`);
    expect(studioMocks.construct).not.toHaveBeenCalled();
    expect(studioMocks.create).not.toHaveBeenCalled();
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });
});

describe("LLM 适配器", () => {
  it("从环境变量构建：缺变量返回 null", () => {
    expect(WorkloomLLMEngine.fromEnv({})).toBeNull();
    const engine = WorkloomLLMEngine.fromEnv({
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "deepseek-flash"
    });
    expect(engine).not.toBeNull();
    expect(engine?.model).toBe("deepseek-flash");
  });

  it("DeepSeek 部署从 DEEPSEEK_* 与 OpenAI 端点构建官方模型名", () => {
    const engine = WorkloomLLMEngine.fromEnv({
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
      LLM_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_API_KEY: "test-only",
      DEEPSEEK_MODEL: "deepseek-flash",
    });
    expect(engine).not.toBeNull();
    expect(engine?.model).toBe("deepseek-flash");
    expect(engine?.getStats()).toMatchObject({ model: "deepseek-flash" });
  });

  it("legacy DeepSeek aliases fail closed", () => {
    expect(() => WorkloomLLMEngine.fromEnv({
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "test-only",
      LLM_MODEL: "deepseek-v4-flash",
    })).toThrow("MODEL_ID_NOT_ALLOWED");
  });

  it("JSON extraction is strict and does not repair model prose", () => {
    const extract = (WorkloomLLMEngine as unknown as { extractJson(t: string): unknown })
      .extractJson;
    expect(extract('{"a":1}')).toEqual({ a: 1 });
    expect(() => extract('```json\n{"a":1}\n```')).toThrow();
    expect(() => extract('前言{"b":2}')).toThrow();
  });

  /** 真机 2026-09-22：requirement-discovery 直接调 llmEngine._extractJsonObject → 我们缺该方法 → SceneArchitect 全失败兜底 */
  it("vendor 期望的引擎助手：_extractJsonObject / getStats / close 齐备", async () => {
    const engine = WorkloomLLMEngine.fromEnv({
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "deepseek-flash"
    })!;
    const extract = (engine as unknown as { _extractJsonObject(text: unknown): unknown })._extractJsonObject;
    // 与 vendor 同语义：返回 JSON 文本（调用方自行 JSON.parse）；非字符串输入返回 null
    const fenced = extract('```json\n{"scenes":[1,2]}\n```');
    expect(typeof fenced).toBe("string");
    expect(JSON.parse(String(fenced))).toEqual({ scenes: [1, 2] });
    expect(typeof extract("前言 {\"a\":1} 后语")).toBe("string");
    expect(extract({ already: "object" })).toBeNull();
    expect(extract("没有 JSON 的文本")).toBeNull();
    expect(extract("")).toBeNull();
    const stats = (engine as unknown as { getStats(): { totalCalls: number; model: string } }).getStats();
    expect(stats.model).toBe("deepseek-flash");
    expect(stats.totalCalls).toBe(0);
    await expect((engine as unknown as { close(): Promise<void> }).close()).resolves.toBeUndefined();
  });
});

describe("渲染脚本", () => {
  it("从 vendor 读取长度口径（唯一真源）", () => {
    const spec = loadPromptLengthSpec();
    expect(spec.hardMax).toBeGreaterThanOrEqual(3000);
    expect(spec.idealMin).toBeGreaterThan(0);
  });

  it("生成 MD 脚本：序号+独立行排版 + 口径校验", () => {
    const script = buildRenderScript(
      "p1",
      {
        shotId: "S01",
        sceneType: "establishing",
        durationSec: 8,
        promptText: "x".repeat(100),
        fields: { 语言约束: "中文", 台词: "[00:00] 主角 说:\"你好\"" },
        bindings: { heroImageId: "BRAND-HERO-001" }
      },
      1
    );
    expect(script.version).toBe(1);
    expect(script.markdown).toContain("01.【语言约束】");
    expect(script.markdown).toContain("BRAND-HERO-001");
    expect(script.charCount).toBe(100);
    expect(script.withinSpec).toBe(true);
  });
});

describe("vendor 核心可加载", () => {
  it("HyperrealitySystem 在真实 node 进程内可加载", () => {
    // vitest 的 ESM 转换会误处理 vendor 的 CJS，改用子进程验证真实运行环境
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const path = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(
      here,
      "../../../vendor/supermickey/hyperreality-system/index.js"
    );
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "wl-vendor-load-test-"));
    try {
      const out = execFileSync(
        process.execPath,
        ["-e", `const m=require(${JSON.stringify(entry)});console.log(typeof m.HyperrealitySystem)`],
        { cwd: isolated, env: {}, encoding: "utf8", timeout: 30_000 }
      );
      // vendor 加载时会打印日志噪声，断言最后一行输出。
      // The class-only subprocess receives no credentials or repository working directory.
      expect(out.trim().split("\n").pop()).toBe("function");
    } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
  }, 35_000);
});

 describe("营销只消费宿主绑定回填", () => {
  const rawJson = JSON.stringify({ A1: { identity: { name: "本次商品" } }, A2: { reviews: [] }, A3: { competitors: [] } });
  const sha256 = createHash("sha256").update(rawJson).digest("hex");
  const owned: ReturnType<typeof prdFixture>[] = [];
  afterEach(() => { for (const value of owned.splice(0)) value.cleanup(); });
  function marketing(verifiedRaw?: NonNullable<StudioConfig["dataMining"]>["verifiedRaw"], workDir = "/unused/marketing-test",
    onApproval: ApprovalCallback = async () => ({ approved: true })) {
    return new VideoStudio({ llm: new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "deepseek-flash" }),
      workDir, onApproval, log: () => undefined,
      dataMining: { mode: "api", raw: { A1: { identity: { name: "旧缓存商品" } } }, storeRoot: "/unused/current-attempt", verifiedRaw } });
  }
  function privateProof(value: ReturnType<typeof prdFixture>) {
    return { projectId: value.scope.projectId, rawJson, sha256, productQuery: { name: "本次商品" }, prdAuthority: value.marketing };
  }
  function requirementOptions(projectId = "P1"): ObservedRequirementAuthority {
    const options = studioMocks.requirementScopes.find(item => item.options?.authority.marketing.scope.projectId === projectId)?.options;
    expect(options).toBeDefined();
    return options!;
  }
  function prdOptions(projectId = "P1"): ObservedPrdScope {
    const options = studioMocks.prdScopes.find(item => item.authority?.marketing.scope.projectId === projectId);
    expect(options).toBeDefined();
    expect(options!.validateAuthority).toBe(requirementOptions(projectId).validateAuthority);
    expect(options!.authority).toBe(requirementOptions(projectId).authority);
    expect(typeof options!.approvedTheme).toBe("function");
    return options!;
  }
  it.each(["missing", "wrong-project", "wrong-hash", "missing-stage"])("%s在vendor构造与create之前拒绝", async kind => {
    let proof = { projectId: "P1", rawJson, sha256, productQuery: { name: "本次商品" } };
    if (kind === "wrong-project") proof.projectId = "other";
    if (kind === "wrong-hash") proof.sha256 = "0".repeat(64);
    if (kind === "missing-stage") { proof.rawJson = JSON.stringify({ A1: {} }); proof.sha256 = createHash("sha256").update(proof.rawJson).digest("hex"); }
    await expect(marketing(kind === "missing" ? undefined : proof).runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true,
      metadata: { _dataDossier: { approved: true }, dataMiningRaw: { forged: true } } })).rejects.toThrow("MARKETING_G1_REQUIRED");
    expect(studioMocks.construct).not.toHaveBeenCalled(); expect(studioMocks.create).not.toHaveBeenCalled();
  });
  it("可信回填覆盖旧cfg raw，metadata自报档案被移除；强制刷新和G1后跳过vendor重复审核", async () => {
    const value = prdFixture(); owned.push(value);
    const metadata = { ...value.metadata, _dataDossier: { name: "伪造档案" } };
    studioMocks.create.mockImplementation(async () => {
      expect(studioMocks.requirementScopes).toHaveLength(1);
      expect(studioMocks.requirementScopes[0]!.metadata).toMatchObject({ brief: value.metadata.brief });
      const options = requirementOptions();
      const production = prdOptions();
      expect(options.authority.marketing).toEqual(value.marketing);
      expect(options.authority.marketing).not.toBe(value.marketing);
      expect(options.authority.metadata.brief).toEqual(value.metadata.brief);
      expect(options.authority.metadata.brief).not.toBe(value.metadata.brief);
      expect(options.authority.profile).toEqual(value.authority.profile);
      expect(options.approvedTheme()).toBeUndefined();
      expect(production.approvedTheme!()).toBeUndefined();
      expect(() => options.validateAuthority()).not.toThrow();
      return { success: true, stages: {} };
    });
    await marketing({ projectId: "P1", rawJson, sha256, productQuery: { name: "本次商品" }, prdAuthority: value.marketing }, value.workDir)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata });
    const { _dataDossier, ...forwarded } = metadata;
    expect(studioMocks.create).toHaveBeenCalledWith("营销", { ...forwarded, dataMining: { name: "本次商品" } }, expect.objectContaining({ dataMiningRaw: JSON.parse(rawJson), dataMiningRefresh: true, skipDataMiningReview: true }));
    expect(metadata._dataDossier.name).toBe("伪造档案");
    expect(studioMocks.construct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ productionEngine: expect.objectContaining({ agentConfig: expect.objectContaining({ enableResume: false }) }) }));
    expect(studioMocks.installed).toContain("prd"); expect(studioMocks.installed.at(-1)).toBe("production");
    expect(studioMocks.installed.indexOf("production")).toBeGreaterThan(studioMocks.installed.indexOf("projection"));
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });
  it("浏览器metadata的同名authority不能替代cfg私有当前G1证明", async () => {
    const value = prdFixture(); owned.push(value);
    await expect(marketing({ projectId: "P1", rawJson, sha256, productQuery: { name: "本次商品" } }, value.workDir)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true,
        metadata: { ...value.metadata, prdAuthority: value.marketing, _workloomPrdAuthority: value.marketing } }))
      .rejects.toThrow("MARKETING_PRD_AUTHORITY_REQUIRED");
    expect(studioMocks.construct).not.toHaveBeenCalled(); expect(studioMocks.create).not.toHaveBeenCalled();
  });
  it("营销PRD桥安装失败发生在vendor构造前，逆序释放已取得的桥", async () => {
    const value = prdFixture(); owned.push(value); studioMocks.failInstall = "prd";
    await expect(marketing({ projectId: "P1", rawJson, sha256, productQuery: { name: "本次商品" }, prdAuthority: value.marketing }, value.workDir)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata: value.metadata })).rejects.toThrow("install failed: prd");
    expect(studioMocks.construct).not.toHaveBeenCalled(); expect(studioMocks.create).not.toHaveBeenCalled();
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });
  it("营销production桥安装失败发生在vendor构造前，逆序释放全部既有兼容桥", async () => {
    const value = prdFixture(); owned.push(value); studioMocks.failInstall = "production";
    await expect(marketing(privateProof(value), value.workDir)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata: value.metadata })).rejects.toThrow("install failed: production");
    expect(studioMocks.construct).not.toHaveBeenCalled(); expect(studioMocks.create).not.toHaveBeenCalled();
    expect(studioMocks.installed).toContain("prd"); expect(studioMocks.installed.at(-1)).toBe("projection");
    expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
    expect(studioMocks.prdScopes).toHaveLength(0);
  });
  it("营销production桥清理失败保留原始运行错误并继续逆序清理其他桥", async () => {
    const value = prdFixture(); owned.push(value); studioMocks.failDispose = "production";
    const failure = new Error("original marketing consumer failed"); studioMocks.create.mockRejectedValue(failure);
    await expect(marketing(privateProof(value), value.workDir)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata: value.metadata })).rejects.toMatchObject({
        name: "AggregateError", message: "video-studio-bridge-cleanup-failed", errors: [failure, expect.objectContaining({ message: "dispose failed: production" })]
      });
    expect(studioMocks.construct).toHaveBeenCalledOnce(); expect(studioMocks.create).toHaveBeenCalledOnce();
    expect(studioMocks.disposed[0]).toBe("production"); expect(studioMocks.disposed).toEqual([...studioMocks.installed].reverse());
  });
  it("G2 完整原文与长尾 advisories 独立克隆，原始批准和 suggestions 原样返回", async () => {
    const value = prdFixture(); owned.push(value);
    const contentMd = `# 本次完整 G2\n${"完整创作原文。".repeat(120)}`;
    const verdict = { approved: true, reason: "真实 G2 通过", suggestions: [] as string[],
      advisories: Array.from({ length: 9 }, (_, index) => `建议-${index}-${"保留完整的非阻断意见。".repeat(60)}`) };
    const originalVerdict = structuredClone(verdict);
    const onApproval = vi.fn(async () => {
      expect(requirementOptions().approvedTheme()).toBeUndefined();
      expect(prdOptions().approvedTheme!()).toBeUndefined();
      return verdict;
    });
    studioMocks.create.mockImplementation(async () => {
      const options = requirementOptions();
      const production = prdOptions();
      expect(options.approvedTheme()).toBeUndefined();
      expect(production.approvedTheme!()).toBeUndefined();
      const returned = await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "creative-theme", content: contentMd, runId: value.scope.runId });
      expect(returned).toBe(verdict);
      expect(returned.approved).toBe(true);
      expect(returned.suggestions).toBe(verdict.suggestions);
      expect(returned.suggestions).toEqual([]);
      expect(returned.advisories).toEqual(originalVerdict.advisories);
      const snapshot = options.approvedTheme()!;
      const expected = { scope: value.scope, contentMd,
        contentSha256: createHash("sha256").update(contentMd).digest("hex"), verdict: originalVerdict };
      expect(snapshot).toEqual(expected);
      const productionSnapshot = production.approvedTheme!()!;
      expect(productionSnapshot).toEqual(expected); expect(productionSnapshot).not.toBe(snapshot);
      expect(productionSnapshot.verdict).not.toBe(snapshot.verdict);
      productionSnapshot.verdict.advisories![8] = "制作侧读取副本不能回改私有主题";
      productionSnapshot.scope.projectId = "伪造项目";
      expect(snapshot.scope).not.toBe(value.scope);
      expect(snapshot.verdict).not.toBe(verdict);
      expect(snapshot.verdict.advisories).not.toBe(verdict.advisories);
      expect(snapshot.verdict.advisories).toHaveLength(9);
      expect(snapshot.verdict.advisories!.at(-1)).toBe(originalVerdict.advisories.at(-1));
      snapshot.scope.runId = "伪造其他运行";
      snapshot.verdict.advisories![0] = "修改读取副本";
      snapshot.verdict.suggestions!.push("不能改成重试指令");
      verdict.advisories[8] = "修改原始回调对象";
      verdict.suggestions.push("修改原始 suggestions");
      expect(options.approvedTheme()).toEqual(expected);
      expect(options.approvedTheme()).not.toBe(snapshot);
      expect(production.approvedTheme!()).toEqual(expected);
      expect(production.approvedTheme!()).not.toBe(productionSnapshot);
      return { success: true, stages: {} };
    });
    await marketing(privateProof(value), value.workDir, onApproval)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata: value.metadata });
    expect(onApproval).toHaveBeenCalledOnce();
    expect(studioMocks.create).toHaveBeenCalledOnce();
  });
  it("重新进入 G2 前清除旧批准，拒绝裁决与显式 suggestions 原样保留且不存主题", async () => {
    const value = prdFixture(); owned.push(value);
    const approved = { approved: true, advisories: ["第一版的非阻断建议"], suggestions: [] as string[] };
    const rejected = { approved: false, reason: "第二版被拒绝", suggestions: ["用户明确要求修改主题"], advisories: ["拒绝时仍保留原意见"] };
    let count = 0;
    const onApproval = vi.fn(async () => {
      expect(requirementOptions().approvedTheme()).toBeUndefined();
      expect(prdOptions().approvedTheme!()).toBeUndefined();
      return count++ === 0 ? approved : rejected;
    });
    studioMocks.create.mockImplementation(async () => {
      const options = requirementOptions();
      const production = prdOptions();
      const first = await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "creative-theme", content: "# 第一版", runId: value.scope.runId });
      expect(first).toBe(approved);
      expect(options.approvedTheme()?.contentMd).toBe("# 第一版");
      expect(production.approvedTheme!()?.contentMd).toBe("# 第一版");
      const second = await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "creative-theme", content: "# 第二版", runId: value.scope.runId });
      expect(second).toBe(rejected);
      expect(second.suggestions).toBe(rejected.suggestions);
      expect(second.advisories).toEqual(rejected.advisories);
      expect(options.approvedTheme()).toBeUndefined();
      expect(production.approvedTheme!()).toBeUndefined();
      return { success: false, stages: {} };
    });
    await expect(marketing(privateProof(value), value.workDir, onApproval)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata: value.metadata })).resolves.toMatchObject({ success: false });
    expect(onApproval).toHaveBeenCalledTimes(2);
  });
  it("两条营销运行交错批准 G2，私有 authority 与主题不串线", async () => {
    const fixtures = [prdFixture("project-A"), prdFixture("project-B")]; owned.push(...fixtures);
    const ready = [deferred(), deferred()], release = [deferred(), deferred()];
    const captured = [deferred(), deferred()], finish = [deferred(), deferred()];
    const approvals = [
      vi.fn(async () => ({ approved: true, suggestions: [] as string[], advisories: ["A 的完整意见"] })),
      vi.fn(async () => ({ approved: true, suggestions: [] as string[], advisories: ["B 的完整意见"] }))
    ];
    const scopes: ObservedRequirementAuthority[] = [];
    const productionScopes: ObservedPrdScope[] = [];
    studioMocks.create.mockImplementation(async (intent: string) => {
      const i = intent === "A" ? 0 : 1, value = fixtures[i]!, options = requirementOptions(value.scope.projectId);
      scopes[i] = options;
      const production = prdOptions(value.scope.projectId); productionScopes[i] = production;
      expect(options.authority.marketing.scope).toEqual(value.scope);
      expect(options.authority.metadata.brief).toEqual(value.metadata.brief);
      expect(options.approvedTheme()).toBeUndefined();
      expect(production.approvedTheme!()).toBeUndefined();
      ready[i]!.resolve();
      await release[i]!.promise;
      await globalThis.__HR_CONFIRMATION_HANDLER__!({ type: "creative-theme", content: `# ${intent} 的主题`, runId: value.scope.runId });
      expect(options.approvedTheme()).toMatchObject({ scope: value.scope, contentMd: `# ${intent} 的主题`,
        verdict: { approved: true, advisories: [`${intent} 的完整意见`] } });
      expect(production.approvedTheme!()).toEqual(options.approvedTheme());
      expect(production.approvedTheme!()).not.toBe(options.approvedTheme());
      captured[i]!.resolve();
      await finish[i]!.promise;
      expect(options.approvedTheme()?.contentMd).toBe(`# ${intent} 的主题`);
      expect(production.approvedTheme!()?.contentMd).toBe(`# ${intent} 的主题`);
      return { success: true, stages: {} };
    });
    const running = fixtures.map((value, i) => marketing(privateProof(value), value.workDir, approvals[i]!)
      .runPreproduction({ projectId: value.scope.projectId, intent: i === 0 ? "A" : "B", isMarketing: true, metadata: value.metadata }));
    await Promise.all(ready.map(item => item.promise));
    release[0]!.resolve(); await captured[0]!.promise;
    expect(scopes[1]!.approvedTheme()).toBeUndefined();
    expect(productionScopes[1]!.approvedTheme!()).toBeUndefined();
    release[1]!.resolve(); await captured[1]!.promise;
    expect(scopes[0]!.approvedTheme()?.scope).toEqual(fixtures[0]!.scope);
    expect(scopes[1]!.approvedTheme()?.scope).toEqual(fixtures[1]!.scope);
    expect(scopes[0]!.approvedTheme()).not.toBe(scopes[1]!.approvedTheme());
    expect(productionScopes[0]!.approvedTheme!()?.scope).toEqual(fixtures[0]!.scope);
    expect(productionScopes[1]!.approvedTheme!()?.scope).toEqual(fixtures[1]!.scope);
    finish[1]!.resolve(); await running[1];
    expect(scopes[0]!.approvedTheme()?.contentMd).toBe("# A 的主题");
    finish[0]!.resolve(); await running[0];
    for (const [i, value] of fixtures.entries()) {
      expect(approvals[i]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gate: "G2_THEME", runId: value.scope.runId }));
    }
  });
  it("运行期 G1 原件字节变化后 validateAuthority 拒绝继续", async () => {
    const value = prdFixture(); owned.push(value);
    studioMocks.create.mockImplementation(async () => {
      const options = requirementOptions();
      const production = prdOptions();
      expect(() => options.validateAuthority()).not.toThrow();
      expect(() => production.validateAuthority!()).not.toThrow();
      writeFileSync(value.file, `${value.content}\n`);
      expect(() => production.validateAuthority!()).toThrow("PRD_G1_CHANGED");
      options.validateAuthority();
      return { success: true, stages: {} };
    });
    await expect(marketing(privateProof(value), value.workDir)
      .runPreproduction({ projectId: "P1", intent: "营销", isMarketing: true, metadata: value.metadata })).rejects.toThrow("PRD_G1_CHANGED");
    expect(studioMocks.create).toHaveBeenCalledOnce();
  });
});
