import { describe, expect, it } from "vitest";
import {
  PLAUSIBILITY_POLICY_VERSION, PLAUSIBILITY_RUBRIC, applyPromptPatches, buildPlausibilityContext,
  parsePlausibilityAnswer, reviewPlausibility,
} from "./plausibility-review.js";

const baseContext = {
  projectId: "VID-TEST",
  reviewId: "VID-TEST:pre-render:run-1:1",
  platform: "TikTok",
  locale: "en",
  aspect: "9:16",
  resolution: "1080p",
  durationSeconds: 30,
  character: { name: "陈卓", appearance: "身高约 166cm" },
  products: [{
    id: "demo-product", displayName: "演示商品", category: "vehicle",
    appearanceMode: "rights-safe-conceptual-silhouette", exactAppearanceRequired: false,
    allowedClaims: ["演示商品"], forbiddenClaims: ["不得要求未授权外观精确还原"],
    dimensions: { lengthMm: 2050, seatHeightMm: 825 }, photoAngles: ["three-quarter", "side"],
  }],
  shots: [{
    shotId: "SC-01", durationSec: 5, scene: "赛道", action: "赛车弹射起步冲出画面",
    props: "赛车", dialogue: [{ speaker: "陈卓", text: "Track only." }], promptText: "【约束】9:16…",
  }],
  stage: "pre-render" as const,
};

const jsonResponse = (payload: unknown, ok = true, status = 200) =>
  new Response(JSON.stringify(ok ? {
    id: "plausibility-response",
    model: "deepseek-flash",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  } : payload), { status });

const llmEnv = { LLM_PROVIDER: "deepseek", LLM_API_KEY: "test-key", LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL: "deepseek-flash" };

/**
 * 通用性验收（T-2026-1011-0001）：
 * 常识判断由**模型的世界模型**给出，引擎不包含任何品类规则；新增品类不需要改代码。
 */
describe("实体与物理常识审核 agent", () => {
  it("rubric 是品类无关的通用问题，并显式要求模型使用自己的世界知识", () => {
    const rubric = PLAUSIBILITY_RUBRIC.join("\n");
    expect(rubric).toContain("真实世界里由谁使用");
    expect(rubric).toContain("用你自己的常识判断");
    expect(rubric).toContain("玩具比例");
    expect(rubric).toContain("CG/游戏过场");
    // 不得把某一种品类的规则写进 rubric（世界知识不枚举）
    expect(rubric).not.toMatch(/头盔|安全带|饺子|相机/);
  });

  it("送审上下文完整携带事实，不做字符截断", () => {
    const context = buildPlausibilityContext(baseContext);
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("lengthMm");
    expect(serialized).toContain("three-quarter");
    expect(serialized).toContain("Track only.");
    expect(serialized).toContain("身高约 166cm");
    expect(serialized).toContain("rights-safe-conceptual-silhouette");
    expect(serialized).toContain("VID-TEST:pre-render:run-1:1");
    expect((context.products as Array<Record<string, unknown>>)[0]).toMatchObject({ exactAppearanceRequired: false });
    const large = buildPlausibilityContext({
      ...baseContext,
      shots: Array.from({ length: 40 }, (_, index) => ({ shotId: `S-${index}`, scene: "长".repeat(2000) })),
    });
    expect(JSON.stringify(large)).toContain("长".repeat(2_000));
  });

  it("多服装角色把默认服装和逐镜选择同时交给审核，避免把默认装当全片硬约束", () => {
    const context = buildPlausibilityContext({
      ...baseContext,
      character: {
        name: "李英子",
        appearance: "成年虚构女性，黑色马尾",
        activeWardrobeId: "w1",
        wardrobes: [
          { id: "w1", name: "日常夹克", detail: "无头盔" },
          { id: "w2", name: "赛道装备", detail: "全盔与全覆赛车服" },
        ],
      },
      shots: [{ ...baseContext.shots[0]!, wardrobeId: "w2", costume: "本镜启用 w2 赛道装备" }],
    });
    const typed = context as {
      character?: { activeWardrobeId?: string | null; wardrobes?: unknown[] };
      shots: Array<Record<string, unknown>>;
    };
    expect(typed.character).toMatchObject({ activeWardrobeId: "w1" });
    expect(typed.character?.wardrobes).toHaveLength(2);
    expect(typed.shots[0]).toMatchObject({ wardrobeId: "w2", costume: "本镜启用 w2 赛道装备" });
  });

  it("下游物理复核保留上游已批准的创意与权利边界", () => {
    const context = buildPlausibilityContext({
      ...baseContext,
      reviewScope: "physical-execution",
      approvedCreativeDirection: {
        productAppearanceMode: "rights-safe-conceptual-silhouette",
        fictionalCompetition: true,
        mandatoryStoryBeats: ["领奖台纪念奖杯"],
        disclosure: "广告创意演绎，非真实赛事成绩",
      },
    });
    expect(context.project).toMatchObject({
      reviewScope: "physical-execution",
      approvedCreativeDirection: {
        fictionalCompetition: true,
        productAppearanceMode: "rights-safe-conceptual-silhouette",
      },
    });
  });

  it("解析模型输出：blocker/warning 与提示词补丁；结构非法即抛错（上层 fail-closed）", () => {
    const parsed = parsePlausibilityAnswer(JSON.stringify({
      verdict: "block",
      findings: [{ id: "subject-motion-without-operator", severity: "blocker", shotId: "SC-01", issue: "车辆自行起步", why: "画面没有骑手", fix: "补骑手并写明全盔" }],
      promptPatches: [{ shotId: "SC-01", clauses: ["本镜摩托车的运动必须由画面内戴全盔的骑手操控"] }],
      reason: "运动缺少操作者",
    }));
    expect(parsed.verdict).toBe("block");
    expect(parsed.findings[0]!.severity).toBe("blocker");
    expect(parsed.promptPatches[0]!.clauses[0]).toContain("骑手");
    expect(() => parsePlausibilityAnswer(JSON.stringify({ verdict: "block", findings: [] }))).toThrow(/PLAUSIBILITY/);
    expect(() => parsePlausibilityAnswer(JSON.stringify({ verdict: "pass", findings: [{ severity: "bad", issue: "x" }] }))).toThrow(/PLAUSIBILITY/);
  });

  it("模型给出 blocker → block；给出 pass → pass（同一条代码路径适配任意品类）", async () => {
    const blocked = await reviewPlausibility(baseContext, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "block",
        findings: [{ id: "plausibility-x", severity: "blocker", shotId: "SC-01", issue: "无人驾驶", why: "无操作者", fix: "补骑手" }],
        promptPatches: [], reason: "逻辑不成立",
      })) as unknown as typeof fetch,
    });
    expect(blocked.verdict).toBe("block");
    expect(blocked.findings.filter((finding) => finding.severity === "blocker")).toHaveLength(1);
    expect(blocked.model).toBe("deepseek-flash");
    expect(blocked.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 10,
      finishReason: "stop",
    });

    const passed = await reviewPlausibility(baseContext, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "pass",
        findings: [{ id: "plausibility-w", severity: "warning", shotId: "SC-02", issue: "建议补一个使用动作", why: "当前是静态展示但未写明", fix: "写明静置展示" }],
        promptPatches: [], reason: "仅提示项",
      })) as unknown as typeof fetch,
    });
    expect(passed.verdict).toBe("pass");
    expect(passed.findings).toHaveLength(1);
  });

  it("Flash 文本评审锁定官方模型、JSON 输出与 high thinking", async () => {
    let body: Record<string, unknown> | null = null;
    const result = await reviewPlausibility({
      ...baseContext,
      shots: [{ ...baseContext.shots[0]!, promptText: "上一镜后已完成停车、支侧撑与下车；本镜起幅为既定静止状态。" }],
    }, {
      env: {
        LLM_BASE_URL: "https://api.deepseek.com",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
        DEEPSEEK_API_KEY: "test-only",
        DEEPSEEK_MODEL: "deepseek-flash",
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ verdict: "pass", findings: [], promptPatches: [], reason: "通过" });
      }) as typeof fetch,
    });
    expect(result.verdict).toBe("pass");
    expect(body).toMatchObject({
      model: "deepseek-flash",
      response_format: { type: "json_object" },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("预生产构图稿明确标注为非实际视频帧时不作为提交画面送审", async () => {
    let body: Record<string, unknown> | null = null;
    const result = await reviewPlausibility({
      ...baseContext,
      stage: "pre-submit",
      images: [{
        label: "镜头 SC-01 预生产构图稿（不表示实际视频首帧）",
        path: "/path/that/must/not/be/read.png",
      }],
    }, {
      env: llmEnv,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ verdict: "pass", findings: [], promptPatches: [], reason: "提示词与提交输入通过" });
      }) as typeof fetch,
    });
    expect(result.verdict).toBe("pass");
    const captured = body as Record<string, unknown> | null;
    const content = (captured?.messages as Array<{ content: unknown }>)?.[0]?.content;
    expect(JSON.stringify(content)).not.toContain("image_url");
    expect(JSON.stringify(content)).toContain("不消费标注为非实际画面的预生产构图稿");
  });

  it("只保留当前送审镜头范围内的提示词补丁", async () => {
    const result = await reviewPlausibility(baseContext, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "pass",
        findings: [],
        promptPatches: [
          { shotId: "SC-01", clauses: ["当前镜头补丁"] },
          { shotId: "SC-DONE", clauses: ["已完成镜头不得被改写"] },
        ],
        reason: "通过并附建议",
      })) as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("pass");
    expect(result.promptPatches).toEqual([{ shotId: "SC-01", clauses: ["当前镜头补丁"] }]);
  });

  it("有明确摘除动作时，头盔不得仍戴在头上的终态否定降为 warning", async () => {
    const result = await reviewPlausibility({
      ...baseContext,
      stage: "pre-submit",
      shots: [{
        ...baseContext.shots[0]!,
        promptText: "【动作】她解开扣带并摘下头盔，收在左腰。【负面约束】no helmet left on head。",
      }],
    }, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "block",
        findings: [{
          id: "temporal-helmet", severity: "blocker", shotId: "SC-01",
          issue: "头盔不得仍戴在头上与动作中的头盔位于头上矛盾",
          why: "未按时间轴读取", fix: "按时序说明",
        }],
        promptPatches: [], reason: "终态否定被误读",
      })) as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("pass");
    expect(result.findings[0]).toMatchObject({ id: "temporal-helmet", severity: "warning" });
  });

  it("非物理性的措辞、补充装备、局部范围、代词附着与路缘措辞降为 warning，穿模或支撑失效仍保持 blocker", async () => {
    const result = await reviewPlausibility({
      ...baseContext,
      shots: [{ ...baseContext.shots[0]!, promptText: "上一镜后已完成停车、支侧撑与下车；本镜起幅为既定静止状态。" }],
    }, {
      env: llmEnv,
      fetchImpl: (async () => jsonResponse({
        verdict: "block",
        findings: [
          { id: "position-copy", severity: "blocker", shotId: "SC-01", issue: "动作写左侧，构图写右侧", why: "措辞不一致", fix: "统一方位" },
          { id: "sequence-copy", severity: "blocker", shotId: "SC-01", issue: "摘盔被写成两次离头", why: "重复动作措辞", fix: "合并一次" },
          { id: "hair-override", severity: "blocker", shotId: "SC-01", issue: "角色档案写高马尾，逐镜发型写后颈低束马尾", why: "档案与镜头覆盖不一致", fix: "以逐镜为准" },
          { id: "declared-jump", severity: "blocker", shotId: "SC-01", issue: "相邻镜 scene-3 到 scene-4 的侧撑与下车未在上一镜呈现", why: "跨镜状态跳跃", fix: "已在下一镜声明画外完成" },
          { id: "opponent-gear-detail", severity: "blocker", shotId: "SC-01", issue: "匿名对手骑手缺赛车服、手套与赛车靴细节", why: "装备描述不足", fix: "补齐具体装备" },
          { id: "partial-scope", severity: "blocker", shotId: "SC-01", issue: "已批准的必拍领奖台节拍未出现在当前分镜", why: "当前只复核未完成镜头", fix: "已完成镜头不在本轮范围" },
          { id: "helmet-attachment-copy", severity: "blocker", shotId: "SC-01", issue: "头盔随车稳定后仍在鞍座，与骑手未摘盔矛盾", why: "代词附着歧义", fix: "改写为骑手仍在鞍座" },
          { id: "road-edge-copy", severity: "blocker", shotId: "SC-01", issue: "路缘缺口弹起颗粒，但另一字段写路肩齐平", why: "路缘措辞不一致", fix: "统一齐平路肩" },
          { id: "physical", severity: "blocker", shotId: "SC-01", issue: "右肩悬空且穿模", why: "支撑失效", fix: "重做姿态" },
        ],
        promptPatches: [], reason: "混合问题",
      })) as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("block");
    expect(result.findings.find((finding) => finding.id === "position-copy")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "sequence-copy")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "hair-override")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "declared-jump")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "opponent-gear-detail")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "partial-scope")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "helmet-attachment-copy")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "road-edge-copy")).toMatchObject({ severity: "warning" });
    expect(result.findings.find((finding) => finding.id === "physical")).toMatchObject({ severity: "blocker" });
  });

  it("无模型 / HTTP 失败 / 输出不可解析 → unverified（调用方 fail-closed）", async () => {
    const noModel = await reviewPlausibility(baseContext, { env: {}, fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    expect(noModel.verdict).toBe("unverified");
    const httpFail = await reviewPlausibility(baseContext, {
      env: llmEnv, fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    expect(httpFail.verdict).toBe("unverified");
    const badJson = await reviewPlausibility(baseContext, {
      env: llmEnv, fetchImpl: (async () => jsonResponse({ verdict: "也许吧" })) as unknown as typeof fetch,
    });
    expect(badJson.verdict).toBe("unverified");
  });

  it("提示词补丁：追加即止，重复应用不叠加", () => {
    const patches = [{ shotId: "SC-01", clauses: ["本镜必须有戴全盔的骑手操控"] }];
    const first = applyPromptPatches(patches, new Map([["SC-01", "【约束】9:16"]]));
    const text = first.get("SC-01")!;
    expect(text).toContain("【常识审核补丁】");
    const second = applyPromptPatches(patches, first);
    expect(second.get("SC-01")).toBe(text);
    expect(PLAUSIBILITY_POLICY_VERSION).toBe("workloom.plausibility-review/v1");
  });
});
