#!/usr/bin/env tsx
/**
 * data-pipeline-run.mts —— 「不提交生产渲染」的完整数据管线跑批 + 逐环节产物落盘
 * （T-2026-0925-0002）
 *
 * 用途：把营销片/叙事片的**数据段**端到端跑一遍——意图分流 → 商品情报五站（营销路由）
 * → 创意主题 → 需求洞察 → PRD → 剧本 → 镜头卡 → 提示词 → 定妆照 → 渲染脚本，
 * **不向渲染服务提交任何作业**（`deferRender=true` 恒开，由宿主 render-operator 另走 G8）。
 *
 * 与其它工具的关系：
 *   · `full-chain-film.mts` 是"成片制片"（含渲染/后期，烧额度）；
 *   · 本工具只跑到预生产收口，产物目录与 `video.studio.start` 的运行目录同形
 *     （`result.json` / `shots.json` / `meta.json` / `route.json` / `gates.jsonl` / `events.jsonl`），
 *     因此可直接接 `pipeline-audit.mts` 与 `pipeline-agent-audit.mts` 做逐环节审计。
 *
 * 用法：
 *   tsx scripts/tools/data-pipeline-run.mts \
 *     --intent "给米家空气净化器 4 Lite 做一条抖音种草视频，突出静音" \
 *     [--product "米家空气净化器 4 Lite"] [--brand 米家] [--category 空气净化器] \
 *     [--route auto|marketing|narrative] [--producer review|auto] \
 *     [--project VID-AUDIT-01] [--work-dir .vm-work] [--out outputs/VID-AUDIT-01] \
 *     [--keys-file ~/.workloom/live.env] [--no-portraits] [--refresh-dossier] [--json]
 *
 * 退出码：0=跑通；2=缺 LLM 配置；3=分流判定为"需澄清"（这是**正确行为**，不是失败）；
 *        4=运行失败（vendor 抛错）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  VideoStudio,
  WorkloomLLMEngine,
  installVendorEngineBridge,
  reviewStage,
  routeVideoPipeline,
  applyRouteToMetadata,
  buildPipelineIntent,
  describeRouteDecision,
  type ApprovalCallback,
  type EventSink,
  type GateKey,
  type StudioConfig,
} from "../../packages/video-studio/src/index.js";
import {
  AUTO_GATES,
  GATE_PRODUCER_STAGE,
  GATE_RUBRIC,
  appliedApprovalFeedback,
  gateDeterministicChecks,
  isProducerRejection,
  type ProducerMode,
} from "../../apps/server/src/video/gate-policy.js";
import {
  createWebSearch,
  primeSearchCache,
  type ExecutorLlm,
  type SearchHit,
} from "../../apps/server/src/video/data-mining-executor.js";
import {
  applyBuiltinCharacters,
  appendBuiltinCharacterGuidance,
  resolveBuiltinCharacters,
} from "../../apps/server/src/video/builtin-character-selection.js";
import {
  finalizeMarketingFacts,
  prepareMarketingFacts,
  toJennyMarketingRaw,
  type PreparedMarketingFacts,
} from "../../apps/server/src/video/marketing-authority.js";
import { createMarketingGateEvidenceGuard } from "../../apps/server/src/video/marketing-gate-evidence.js";
import { canonicalRenderJson, renderSha256 } from "../../apps/server/src/video/gen/compiled-request.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const stamp = () => new Date().toISOString();
const log = (line: string): void => process.stdout.write(`[${stamp().slice(11, 19)}] ${line}\n`);

/* ================= 环境与密钥（不写盘；只从已有秘密文件读入进程内存） ================= */

function loadKeys(file: string): number {
  if (!existsSync(file)) return 0;
  let loaded = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!key || !value || process.env[key]) continue;
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

/* ================= 参数 ================= */

const INTENT = arg("--intent");
if (!INTENT.trim()) {
  console.error("需要 --intent <非空创作意图原文>");
  process.exit(2);
}
if (Array.from(INTENT).length > 2_000) {
  console.error(`--intent 过长：${Array.from(INTENT).length} 个 Unicode 字符，正式 Studio 上限为 2000`);
  process.exit(2);
}
if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u.test(INTENT)) {
  console.error("--intent 含不允许的控制字符；请保留单行或普通换行文本");
  process.exit(2);
}
const DURATION_RAW = arg("--duration", "30").trim();
const DURATION_SECONDS = Number(DURATION_RAW);
if (!/^\d+(?:\.\d+)?$/.test(DURATION_RAW) || !Number.isFinite(DURATION_SECONDS)
  || DURATION_SECONDS < 5 || DURATION_SECONDS > 180) {
  console.error(`--duration 必须是 5–180 秒的有限数值，收到：${DURATION_RAW || "(空)"}`);
  process.exit(2);
}
const ASPECT_RATIO = arg("--aspect", "9:16").trim();
if (!["16:9", "9:16", "1:1", "4:3"].includes(ASPECT_RATIO)) {
  console.error(`--aspect 只支持 16:9 / 9:16 / 1:1 / 4:3，收到：${ASPECT_RATIO || "(空)"}`);
  process.exit(2);
}
const PROJECT = arg("--project", `VID-AUDIT-${new Date().toISOString().slice(5, 10).replace("-", "")}`);
for (const name of ["--route", "--duration", "--aspect", "--platform", "--project", "--producer", "--intent"]) {
  if (process.argv.filter((token) => token === name).length > 1) {
    console.error(`重复参数 ${name}；每次运行只能声明一次`);
    process.exit(2);
  }
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(PROJECT) || PROJECT === "." || PROJECT === "..") {
  console.error(`--project 仅允许字母、数字、点、下划线和连字符，且不能越界：${PROJECT || "(空)"}`);
  process.exit(2);
}
const PLATFORM_INPUT = arg("--platform", "douyin").trim();
const PLATFORM_ALIASES: Record<string, string> = {
  douyin: "抖音",
  "抖音": "抖音",
  shipinhao: "视频号",
  wechat_channels: "视频号",
  "视频号": "视频号",
  xiaohongshu: "小红书",
  "小红书": "小红书",
  bilibili: "B站",
  "b站": "B站",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  "通用": "通用",
};
const PLATFORM = PLATFORM_ALIASES[PLATFORM_INPUT.toLowerCase()] ?? PLATFORM_ALIASES[PLATFORM_INPUT];
if (!PLATFORM) {
  console.error(`--platform 不受支持：${PLATFORM_INPUT || "(空)"}`);
  process.exit(2);
}
const WORK_DIR = resolve(REPO_ROOT, arg("--work-dir", ".vm-work"));
const OUT_DIR = resolve(REPO_ROOT, arg("--out", join("outputs", PROJECT)));
const KEYS_FILE = resolve(arg("--keys-file", join(homedir(), ".workloom", "live.env")).replace(/^~/, homedir()));
const ROUTE_ARG = arg("--route", "auto").trim().toLowerCase();
if (!["auto", "marketing", "narrative"].includes(ROUTE_ARG)) {
  console.error(`--route 只支持 auto / marketing / narrative，收到：${ROUTE_ARG || "(空)"}`);
  process.exit(2);
}
const PRODUCER_RAW = arg("--producer", "review").trim().toLowerCase();
if (!["review", "auto"].includes(PRODUCER_RAW)) {
  console.error(`--producer 只支持 review / auto，收到：${PRODUCER_RAW || "(空)"}`);
  process.exit(2);
}
const PRODUCER = PRODUCER_RAW as ProducerMode;
const PORTRAITS_ENABLED = !flag("--no-portraits") && (process.env.HR_PORTRAIT_ENABLED ?? "1") !== "0";

const loadedKeys = loadKeys(KEYS_FILE);
log(`密钥装载：${loadedKeys} 项（来自 ${KEYS_FILE.replace(homedir(), "~")}；已在环境里的不覆盖）`);

/**
 * 模型名兜底：本机秘密文件（~/.workloom/live*.env）登记的是 `DEEPSEEK_MODEL`，
 * 而 `WorkloomLLMEngine.fromEnv()` 只认 `LLM_MODEL`。两者同源（OpenAI 兼容端点），
 * 这里做一次显式映射并打印，避免"以为配了模型其实没配"。
 */
if (!process.env.LLM_MODEL && process.env.DEEPSEEK_MODEL) {
  process.env.LLM_MODEL = process.env.DEEPSEEK_MODEL;
  log(`LLM_MODEL 未设置 → 采用 DEEPSEEK_MODEL=${process.env.DEEPSEEK_MODEL}`);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(WORK_DIR, "logs"), { recursive: true });
const gatesFile = join(OUT_DIR, "gates.jsonl");
const eventsFile = join(OUT_DIR, "events.jsonl");
/** 检索缓存：跨站/跨次复用同一批真实结果，避免重复轰击公开检索端点（被反爬时仍可复现） */
const SEARCH_CACHE_FILE = resolve(REPO_ROOT, arg("--search-cache", join(WORK_DIR, "search-cache.json")));

/**
 * `--prime-search <fixture.json>`：把平台检索/人工回填的真实结果预置进缓存。
 * fixture 形如 { "queries": { "米家空气净化器 4 Lite 参数": [{title,url,snippet}, ...] } }。
 * 预置结果与线上结果同权（同样过 URL 白名单与相关性过滤），只替代 HTTP 传输通道。
 */
const PRIME_FILE = arg("--prime-search");
if (PRIME_FILE) {
  const fixturePath = resolve(REPO_ROOT, PRIME_FILE);
  try {
    if (!existsSync(fixturePath)) throw new Error(`文件不存在：${fixturePath}`);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { queries?: Record<string, SearchHit[]> };
    if (!fixture.queries || typeof fixture.queries !== "object" || Array.isArray(fixture.queries)) {
      throw new Error("root.queries 必须是对象");
    }
    const primed = primeSearchCache(SEARCH_CACHE_FILE, fixture.queries);
    log(`检索预置完成：${primed.queries} 条查询 / ${primed.written} 条结果 → ${SEARCH_CACHE_FILE.replace(REPO_ROOT + "/", "")}`);
  } catch (error) {
    console.error(`--prime-search 加载失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

/* ================= LLM 引擎（缺配置即拒跑，禁止静默降级） ================= */

const llm = WorkloomLLMEngine.fromEnv();
if (!llm) {
  log("❌ 缺 LLM 配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），拒绝启动（vendor 纪律：禁止静默降级）");
  process.exit(2);
}
log(`LLM 引擎就绪：model=${llm.model}`);

/* ================= ① 意图分流 ================= */

const routeExplicit = ROUTE_ARG === "marketing" || ROUTE_ARG === "narrative" ? ROUTE_ARG : undefined;
const decision = await routeVideoPipeline(
  {
    text: INTENT,
    metadata: arg("--product") ? { dataMining: { name: arg("--product"), brand: arg("--brand"), category: arg("--category") } } : undefined,
    explicit: routeExplicit,
  },
  { llmCall: async (prompt: string) => (await llm.reason(prompt, { forceJson: true, temperature: 0.1, maxTokens: 512 })).content ?? "" },
);
log(`分流结论：${describeRouteDecision(decision)}`);
writeFileSync(join(OUT_DIR, "route.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");

if (decision.route === "clarify") {
  log("→ 分流判定需要澄清（正确行为：宁可不跑，也不按错误管线花钱）");
  process.stdout.write(`${decision.clarify?.question ?? ""}\n`);
  process.exit(3);
}

/* ================= ② 装配 metadata（营销路由激活情报层 / 叙事路由显式关闭） ================= */

/** 需求口径：叙事线没有商品转化目标，不得继承营销线的 seeding 默认值。 */
const PROFILE = {
  durationSec: DURATION_SECONDS,
  aspectRatio: ASPECT_RATIO,
  platform: PLATFORM,
  goal: arg("--goal", decision.route === "marketing" ? "seeding" : "awareness"),
};
const brief: Record<string, unknown> = {
  duration: PROFILE.durationSec,
  aspectRatio: PROFILE.aspectRatio,
  platform: PROFILE.platform,
  goal: PROFILE.goal,
};
let seeded = applyRouteToMetadata({ brief }, decision);
if (arg("--product") && decision.product) {
  // CLI 显式给出的商品信息优先（用户口径 > 抽取结果）
  seeded.dataMining = {
    ...(seeded.dataMining as Record<string, unknown>),
    name: arg("--product"),
    ...(arg("--brand") ? { brand: arg("--brand") } : {}),
    ...(arg("--category") ? { category: arg("--category") } : {}),
    ...(arg("--model") ? { model: arg("--model") } : {}),
  };
  (seeded.brief as Record<string, unknown>).product = arg("--product");
}
if (arg("--selling-points")) {
  const points = arg("--selling-points").split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
  if (points.length > 0) {
    (seeded.dataMining as Record<string, unknown>).sellingPointCandidates = points;
    (seeded.brief as Record<string, unknown>).sellingPoints = points.slice(0, 3);
  }
}

/**
 * The production worker resolves the host-selected cast before Studio. This CLI
 * must use the same exact contract; otherwise requirement discovery correctly
 * aborts because it has no authority to invent an on-screen person.
 */
let selectedCharacters: ReturnType<typeof resolveBuiltinCharacters>;
try {
  selectedCharacters = resolveBuiltinCharacters(INTENT, seeded);
  seeded = applyBuiltinCharacters(seeded, selectedCharacters);
  seeded.customerOriginalIntent = INTENT;
} catch (error) {
  log(`❌ 选角合同失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

/** 创作意图：清掉分流行指令 + 写入需求口径与本次真实选角合同。 */
const PIPELINE_INTENT = appendBuiltinCharacterGuidance(
  buildPipelineIntent(INTENT, PROFILE),
  selectedCharacters,
);

/** `--dry-run`：只做分流、metadata、选角与前置装配（不跑管线、不花钱）。 */
if (flag("--dry-run")) {
  const preflight = {
    pipelineRoute: decision.route,
    themeInputMode: decision.route === "marketing" ? "marketing" : "narrative",
    decision,
    characterResolution: selectedCharacters.decision,
    metadata: seeded,
    pipelineIntent: PIPELINE_INTENT,
  };
  writeFileSync(join(OUT_DIR, "route-dry-run.json"), `${JSON.stringify({ decision, seeded }, null, 2)}\n`, "utf8");
  writeFileSync(join(OUT_DIR, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`, "utf8");
  log("--dry-run：已完成分流、metadata、选角与前置装配，未启动管线");
  process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
  process.exit(0);
}

/* ================= ③ 门策略（与生产同一份定义） ================= */

const gateRecords: Array<Record<string, unknown>> = [];
const RUN_ATTEMPT = 1;
const RUN_ID = arg("--run-id", `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`);
const marketingScope = {
  tenantId: "tenant-video-stress",
  workspaceId: "workspace-video-stress",
  projectId: PROJECT,
  runId: RUN_ID,
  attempt: RUN_ATTEMPT,
};
let marketingEvidence: ReturnType<typeof createMarketingGateEvidenceGuard> | undefined;

function gateArtifact(gate: GateKey, contentMd: string): { path: string; chars: number; sha256: string } {
  const path = join(WORK_DIR, "gates", PROJECT, `attempt-${RUN_ATTEMPT}`, `${gate}.md`);
  mkdirSync(join(WORK_DIR, "gates", PROJECT, `attempt-${RUN_ATTEMPT}`), { recursive: true });
  writeFileSync(path, contentMd, "utf8");
  return { path, chars: contentMd.length, sha256: renderSha256(contentMd) };
}

function recordGate(input: {
  gate: GateKey;
  vendorType: string;
  approved: boolean;
  verdict: Awaited<ReturnType<typeof reviewStage>> | null;
  deterministic: ReturnType<typeof gateDeterministicChecks>;
}): void {
  gateRecords.push({
    at: stamp(),
    gate: input.gate,
    vendorType: input.vendorType,
    approved: input.approved,
    via: input.verdict?.via ?? (PRODUCER === "auto" ? "auto" : "none"),
    score: input.verdict?.score ?? null,
    deterministic: input.deterministic,
    reason: input.verdict?.reason ?? (PRODUCER === "auto" ? "auto 模式：仅跑确定性硬闸" : ""),
    issues: input.verdict?.issues?.slice(0, 5) ?? [],
  });
  appendFileSync(gatesFile, `${JSON.stringify(gateRecords[gateRecords.length - 1])}\n`, "utf8");
}

async function reviewGate(input: {
  gate: GateKey;
  vendorType: string;
  title: string;
  contentMd: string;
}): Promise<{ approved: boolean; verdict: Awaited<ReturnType<typeof reviewStage>> | null }> {
  const deterministic = gateDeterministicChecks(input.gate, input.contentMd);
  const artifact = gateArtifact(input.gate, input.contentMd);
  let verdict: Awaited<ReturnType<typeof reviewStage>> | null = null;

  if (input.gate === "G5_PORTRAIT" && !PORTRAITS_ENABLED) {
    const approved = !deterministic.some((check) => check.hard && !check.pass);
    recordGate({ ...input, approved, verdict, deterministic });
    log("  [gate G5_PORTRAIT] preproduction-only：未请求定妆照出图，仅记录 not_applicable");
    return { approved, verdict };
  }

  if (PRODUCER === "review" && AUTO_GATES.has(input.gate)) {
    const marketingReview = marketingEvidence && input.gate !== "G1_DOSSIER"
      ? marketingEvidence.forReview(input.gate, {
          path: artifact.path,
          kind: input.gate === "G1_DOSSIER" ? "json" : "text",
          expectedSha256: artifact.sha256,
          note: input.title,
        })
      : undefined;
    verdict = await reviewStage({
      stage: GATE_PRODUCER_STAGE[input.gate] ?? "script",
      projectId: PROJECT,
      artifacts: [
        { path: artifact.path, kind: input.gate === "G1_DOSSIER" ? "json" : "text", expectedSha256: artifact.sha256, note: input.title },
        ...(marketingReview?.artifacts ?? []),
      ],
      deterministic: [...deterministic, ...(marketingReview?.deterministic ?? [])],
      ...(marketingReview?.requiredCheckIds?.length ? { requiredCheckIds: marketingReview.requiredCheckIds } : {}),
      rubric: [
        ...(GATE_RUBRIC[input.gate] ?? []),
        ...(marketingReview?.rubric ?? []),
        `门内容全长 ${artifact.chars} 字，已随附件送审；摘录（供定位）：${input.contentMd.slice(0, 600)}`,
      ],
      context: {
        gate: input.gate,
        vendorType: input.vendorType,
        contentChars: input.contentMd.length,
        ...(marketingReview?.context ?? {}),
      },
      allowFallbackApprove: false,
      log: (line) => console.log(line),
    });
    if (marketingReview) verdict = marketingEvidence!.verifyReview(marketingReview, verdict);
  }
  const approved = PRODUCER === "auto" ? !deterministic.some((check) => check.hard && !check.pass) : Boolean(verdict?.approved);
  recordGate({ ...input, approved, verdict, deterministic });
  log(`  [gate ${input.gate}] ${approved ? "放行" : "打回"}（${verdict ? `监制 ${verdict.score} 分 / via=${verdict.via}` : PRODUCER === "auto" ? "auto" : "无监制"}）`);
  return { approved, verdict };
}

const onApproval: ApprovalCallback = async (req) => {
  const gate = req.gate as GateKey;
  const reviewed = await reviewGate({
    gate,
    vendorType: req.vendorType,
    title: req.title,
    contentMd: req.contentMd ?? "",
  });
  const { approved, verdict } = reviewed;
  const suggestions = appliedApprovalFeedback(approved, verdict?.suggestions);
  return {
    approved,
    reason: verdict ? `${approved ? "producer-approved" : "producer-rejected"}(${gate} · score=${verdict.score})` : `auto(${gate})`,
    ...(suggestions.length ? { suggestions } : {}),
    ...(approved ? {} : { fatal: "producer_rejected" }),
  };
};

const onEvent: EventSink = (e) => {
  appendFileSync(eventsFile, `${JSON.stringify({ at: stamp(), ...e })}\n`, "utf8");
};

/* ================= ④ 跑批（不提交渲染） ================= */

let preparedMarketing: PreparedMarketingFacts | undefined;
let marketingFactsArtifact: { ref: string; sha256: string } | undefined;
let dataMining: StudioConfig["dataMining"];

if (decision.route === "marketing") {
  if (PRODUCER !== "review") {
    log("❌ 营销线的 G1 必须由真实 LLM 监制形成完整通过凭据；--producer auto 不可用于营销预生产");
    process.exit(2);
  }
  try {
    preparedMarketing = await prepareMarketingFacts({
      scope: marketingScope,
      root: WORK_DIR,
      metadata: seeded,
      intent: PIPELINE_INTENT,
      llm: llm as unknown as ExecutorLlm,
      dependencies: {
        search: createWebSearch({
          log,
          cacheFile: SEARCH_CACHE_FILE,
          paceMs: Number(arg("--search-pace-ms", "1200")) || 1_200,
          fixtureOnly: Boolean(PRIME_FILE),
        }),
      },
    });
    const g1 = await reviewGate({
      gate: "G1_DOSSIER",
      vendorType: "host-source-dossier",
      title: "本次营销来源正文与逐主张事实审核",
      contentMd: preparedMarketing.g1Content,
    });
    const proof = g1.verdict ? { ...g1.verdict, gate: "G1_DOSSIER" as const } : null;
    if (!g1.approved || !proof || proof.status !== "passed" || proof.via !== "llm"
      || proof.degraded !== false || !proof.model?.trim()) {
      throw new Error(`MARKETING_G1_REJECTED：${proof?.reason ?? "缺少真实非降级 LLM 裁决"}`);
    }
    marketingEvidence = createMarketingGateEvidenceGuard({
      workDir: WORK_DIR,
      scope: {
        tenantId: marketingScope.tenantId,
        workspaceId: marketingScope.workspaceId,
        projectId: marketingScope.projectId,
        runId: marketingScope.runId,
      },
    });
    marketingEvidence.reset(RUN_ATTEMPT);
    marketingEvidence.acceptG1({
      scope: preparedMarketing.bundle.scope,
      content: preparedMarketing.g1Content,
      proof,
    });
    const verifiedRawJson = canonicalRenderJson(toJennyMarketingRaw(
      preparedMarketing.raw,
      preparedMarketing.bundle,
    ));
    dataMining = {
      mode: "api",
      storeRoot: preparedMarketing.storeRoot,
      refresh: true,
      verifiedRaw: {
        projectId: PROJECT,
        rawJson: verifiedRawJson,
        sha256: renderSha256(verifiedRawJson),
        productQuery: preparedMarketing.bundle.productQuery,
        prdAuthority: marketingEvidence.forPrd(),
      },
    };
    log(
      `营销事实前置通过：证据 ${preparedMarketing.bundle.sources.length} 条 / `
      + `G1 ${preparedMarketing.g1Content.length} 字 / SHA ${preparedMarketing.bundle.g1ContentSha256.slice(0, 12)}…`,
    );
  } catch (error) {
    log(`❌ 营销来源/G1 前置失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(4);
  }
}

const portraits: StudioConfig["portraits"] = PORTRAITS_ENABLED && process.env.VOLCENGINE_ARK_API_KEY
  ? {
      enabled: true,
      apiKey: process.env.VOLCENGINE_ARK_API_KEY,
      model: process.env.SEEDREAM_MODEL ?? "doubao-seedream-4-0-250828",
      baseUrl: process.env.ARK_BASE_URL?.trim(),
      timeoutMs: Number(process.env.HR_PORTRAIT_TIMEOUT_MS ?? 240_000),
      maxReferenceImages: 4,
      referenceImages: [],
      characterAnchorImages: (process.env.HR_PORTRAIT_ANCHORS ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean)
        .map((p) => (isAbsolute(p) ? p : join(REPO_ROOT, p))),
      requireCharacterDescription: true,
    }
  : { enabled: false };

log(`创作意图（下行）：${PIPELINE_INTENT.replace(/\n/g, " ")}`);

installVendorEngineBridge(llm);
const studio = new VideoStudio({
  llm,
  workDir: WORK_DIR,
  onApproval,
  onEvent,
  totalDeadlineMs: Number(process.env.VM_TOTAL_DEADLINE_MS ?? 3_600_000),
  deferRender: true, // 本工具的铁律：不提交生产渲染
  portraits,
  dataMining,
  log: (line) => console.log(line),
});

log(`启动数据管线：project=${PROJECT} | 管线=${decision.route} | 定妆照=${portraits?.enabled ? "开" : "关"} | 提交渲染=否`);
const startedAt = Date.now();
let result: Awaited<ReturnType<VideoStudio["runPreproduction"]>>;
try {
  const maxAttempts = Math.max(1, Number(arg("--producer-retry", "1")) + 1);
  result = await studio.runPreproduction({
    projectId: PROJECT,
    intent: PIPELINE_INTENT,
    metadata: seeded,
    isMarketing: decision.route === "marketing",
  });
  let attempts = 1;
  while (attempts < maxAttempts && isProducerRejection(result)) {
    attempts += 1;
    log(`AI 监制打回 → 自动重跑第 ${attempts}/${maxAttempts} 次（打回理由见 gates.jsonl）`);
    result = await studio.runPreproduction({
      projectId: PROJECT,
      intent: PIPELINE_INTENT,
      metadata: seeded,
      isMarketing: decision.route === "marketing",
    });
  }
  (result as Record<string, unknown>).producerAttempts = attempts;
} catch (err) {
  log(`❌ 运行失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(4);
}
const elapsedMs = Date.now() - startedAt;

/* ================= ⑤ 产物落盘（与 video.studio.start 运行目录同形） ================= */

const stagesRaw = (result.stages ?? {}) as Record<string, unknown>;
const production = (stagesRaw.productionEngine ?? {}) as { shots?: Array<Record<string, unknown>>; prompts?: Array<Record<string, unknown>> };
const shots = Array.isArray(production.shots) ? production.shots : [];
const prompts = Array.isArray(production.prompts) ? production.prompts : [];

if (result.success && preparedMarketing) {
  try {
    marketingFactsArtifact = await finalizeMarketingFacts(
      preparedMarketing,
      shots.map((shot) => ({
        shotId: String(shot.shot_id ?? shot.shotId ?? ""),
        prompt: String(shot.prompt ?? ""),
        fields: shot.fields,
      })),
      process.env,
    );
    log(
      `营销最终镜头事实复核通过：${shots.length} 镜 / `
      + `${marketingFactsArtifact.ref} / ${marketingFactsArtifact.sha256.slice(0, 12)}…`,
    );
  } catch (error) {
    result.success = false;
    (result as Record<string, unknown>).errors = [
      ...(((result as Record<string, unknown>).errors as unknown[] | undefined) ?? []),
      {
        stage: "marketing-final-facts",
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      },
    ];
    log(`❌ 营销最终镜头事实复核失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

const dataMiningStage = (stagesRaw.dataMining ?? null) as
  | { status?: string; product_id?: string; timing?: number; data?: { ok?: boolean; reused?: boolean; saved?: unknown; envelopes?: unknown[]; chain?: { ok?: boolean }; dossier?: Record<string, unknown>; cards?: Record<string, unknown>; errors?: unknown[]; verification_report?: Record<string, unknown> } }
  | null;

writeFileSync(join(OUT_DIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
writeFileSync(join(OUT_DIR, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`, "utf8");
writeFileSync(join(OUT_DIR, "meta.json"), `${JSON.stringify({
  projectId: PROJECT,
  intent: PIPELINE_INTENT,
  intentRaw: INTENT,
  pipeline: decision.route,
  routeDecision: decision,
  runId: RUN_ID,
  producerMode: PRODUCER,
  portraitsEnabled: Boolean(portraits?.enabled),
  characterSelection: selectedCharacters.decision,
  marketingFacts: preparedMarketing ? {
    g1Path: join(WORK_DIR, "gates", PROJECT, `attempt-${RUN_ATTEMPT}`, "G1_DOSSIER.md"),
    g1Sha256: preparedMarketing.bundle.g1ContentSha256,
    sourceCount: preparedMarketing.bundle.sources.length,
    storeRoot: preparedMarketing.storeRoot,
    finalFacts: marketingFactsArtifact ?? null,
  } : null,
  renderSubmitted: false,
  renderSubmissionDisabledBy: "VideoStudio.deferRender=true",
  startedAt: new Date(Date.now() - elapsedMs).toISOString(),
  finishedAt: stamp(),
  elapsedMs,
  stages: Object.keys(stagesRaw),
}, null, 2)}\n`, "utf8");

/* ================= ⑥ 逐环节摘要（人读 + --json 机读） ================= */

const dossier = dataMiningStage?.data?.dossier as Record<string, unknown> | undefined;
const provenance = Array.isArray(dossier?.provenance) ? dossier!.provenance as unknown[] : [];
const gaps = Array.isArray(dossier?.gaps) ? dossier!.gaps as unknown[] : [];
const images = ((dossier?.visual_assets as { images?: unknown[] } | undefined)?.images ?? []) as unknown[];
const summary = {
  projectId: PROJECT,
  pipeline: decision.route,
  success: result.success,
  renderSubmitted: false,
  characterSelection: selectedCharacters.decision,
  marketingFacts: preparedMarketing ? {
    sourceCount: preparedMarketing.bundle.sources.length,
    g1Sha256: preparedMarketing.bundle.g1ContentSha256,
    finalFactsSha256: marketingFactsArtifact?.sha256 ?? null,
    restrictions: preparedMarketing.bundle.restrictions,
  } : null,
  elapsedMs,
  stages: Object.entries(stagesRaw).map(([name, value]) => ({
    name,
    present: value !== undefined && value !== null,
    timingMs: typeof (value as { timing?: unknown })?.timing === "number" ? (value as { timing: number }).timing : null,
  })),
  dataMining: dataMiningStage
    ? {
        status: dataMiningStage.status ?? null,
        productId: dataMiningStage.product_id ?? null,
        ok: dataMiningStage.data?.ok ?? null,
        reused: dataMiningStage.data?.reused ?? null,
        chainOk: dataMiningStage.data?.chain?.ok ?? null,
        evidenceCount: provenance.length,
        gapCount: gaps.length,
        imageCount: images.length,
        heroImageId: (dossier?.visual_assets as { hero_image_id?: string } | undefined)?.hero_image_id ?? null,
        sellingPoints: ((dataMiningStage.data?.cards as { brief_card?: { sellingPoints?: string[] } } | undefined)?.brief_card?.sellingPoints) ?? [],
        errors: dataMiningStage.data?.errors ?? [],
      }
    : null,
  shots: shots.length,
  prompts: prompts.length,
  gates: gateRecords.map((g) => ({ gate: g.gate, approved: g.approved, score: g.score })),
  errors: Array.isArray((result as Record<string, unknown>).errors)
    ? ((result as Record<string, unknown>).errors as unknown[])
    : [],
};

writeFileSync(join(OUT_DIR, "data-pipeline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
const exitCode = result.success ? 0 : 4;
if (!result.success) {
  log(`❌ 数据管线未完成，退出码 ${exitCode}；未提交任何渲染请求。失败项：${summary.errors.length}`);
}
if (flag("--json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, () => process.exit(exitCode));
} else {
  log("—— 逐环节摘要 ——");
  for (const stage of summary.stages) log(`  ${stage.present ? "✓" : "×"} ${stage.name}${stage.timingMs ? `（${stage.timingMs}ms）` : ""}`);
  if (summary.dataMining) {
    log(`  情报档案：status=${summary.dataMining.status} ok=${summary.dataMining.ok} 证据=${summary.dataMining.evidenceCount} 缺口=${summary.dataMining.gapCount} 图=${summary.dataMining.imageCount} 链=${summary.dataMining.chainOk}`);
  }
  log(`  镜头卡 ${summary.shots} 张 / 提示词 ${summary.prompts} 条 / 门记录 ${summary.gates.length} 条`);
  log(`产物目录：${OUT_DIR.replace(REPO_ROOT + "/", "")}（result.json / shots.json / meta.json / gates.jsonl / events.jsonl）`);
  process.stdout.write("", () => process.exit(exitCode));
}
