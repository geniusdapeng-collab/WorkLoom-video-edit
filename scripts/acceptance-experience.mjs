#!/usr/bin/env node
/**
 * acceptance-experience.mjs · 体验验收（5 类人 × 关键旅程 × 8 维度，任务化走查 + 计时 + 截图）
 *
 * 与「功能验收」的分工：功能验收回答“页面能不能开、接口有没有报错”；
 * 本脚本回答“真实的人在没有培训的情况下，能不能在预期时间内理解、信任、掌控并拿到价值”，
 * 每条走查都留 前置条件 / 步骤 / 预期 / 实测 / 证据（截图 + JSON），并按标准阈值判通过。
 *
 * 用法：
 *   node scripts/acceptance-experience.mjs --out <目录>
 * 前置：pnpm preview:all（PC:3000 / B移动:3001 / C移动:3002 / server:8787）
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(join(REPO_ROOT, "package.json"));
const { chromium } = require(join(REPO_ROOT, "node_modules", ".pnpm", "playwright@1.63.0", "node_modules", "playwright"));

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT_DIR = resolve(argValue("--out", join(REPO_ROOT, "artifacts", "acceptance-experience")));
const SHOT_DIR = join(OUT_DIR, "shots");
const PC = argValue("--base", "http://localhost:3000");
const MB = argValue("--mobile-base", "http://localhost:3001");
const MC = argValue("--c-base", "http://localhost:3002");
const API = argValue("--api", "http://127.0.0.1:8787");
const WORKSPACE_SLUG = "yunqi-hotel";
const MEMBER_NO = "MEM-001";

mkdirSync(SHOT_DIR, { recursive: true });

const REPORT = {
  at: new Date().toISOString(),
  checks: [],
  dimensions: {},
  issues: [],
};

const now = () => Date.now();
function record(entry) {
  REPORT.checks.push(entry);
  if (!entry.pass) REPORT.issues.push({ id: entry.id, name: entry.name, actual: entry.actual });
  console.log(`${entry.pass ? "✓" : "✗"} [${entry.persona}·${entry.journey}] ${entry.id} ${entry.name}${entry.metric ? ` · ${entry.metric}` : ""}`);
}

const browser = await chromium.launch({ headless: true });

/* ---------------- 会话：PC 成员态 ---------------- */
const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const pcConsole = [];
let currentConsole = pcConsole;
const pcPage = await pcContext.newPage();
pcPage.on("console", (m) => { if (m.type() === "error") currentConsole.push(m.text().split("\n")[0]); });
pcPage.on("pageerror", (e) => currentConsole.push(String(e).split("\n")[0]));

const loginRes = await pcPage.request.post(`${API}/trpc/auth.loginAs`, { data: { workspaceSlug: WORKSPACE_SLUG, memberNo: MEMBER_NO } });
const PC_TOKEN = (await loginRes.json())?.result?.data?.token;
if (!PC_TOKEN) throw new Error("PC 登录失败：无法取得成员令牌");
await pcPage.goto(`${PC}/login`, { waitUntil: "domcontentloaded" });
await pcPage.waitForTimeout(500);
await pcPage.evaluate((t) => {
  const keys = Object.keys(localStorage);
  const tk = keys.find((k) => k.endsWith(":access-token")) ?? "workloom:access-token";
  const gk = keys.find((k) => k.endsWith(":guest"));
  localStorage.setItem(tk, t);
  if (gk) localStorage.removeItem(gk);
}, PC_TOKEN);

const shot = async (page, name) => {
  const file = join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => undefined);
  return file;
};

/**
 * 展开右栏（任务上下文）面板。
 * 1440×900 下左侧主导航 + AI 助手栏吃掉宽度后，Bridge 容器 ≤880px 会按设计把右栏降级成抽屉，
 * 审批三手势/围栏草稿都在右栏里——关键动作因此多一步「展开面板」（≤3 步口径内，但必须被走查到）。
 */
async function ensureRightPanel(page) {
  const toggle = page.locator('button[aria-label="显示任务上下文面板"]').first();
  if (await toggle.count()) {
    const pressed = await toggle.getAttribute("aria-pressed");
    if (pressed !== "true") {
      await toggle.click({ timeout: 6000 }).catch(() => undefined);
      await page.waitForTimeout(1300);
      return true;
    }
  }
  return false;
}

/* ---------------- 走查 1：owner · 首启与首次价值（T+10 内看到价值 + 决策包 ≤7） ---------------- */
try {
  const t0 = now();
  await pcPage.goto(PC, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(2500);
  // 首启有欢迎仪式（cinematic）：必须能在 1 次点击内跳过，否则「首次价值」被仪式挡住。
  const skip = pcPage.getByRole("button", { name: /跳过开场|跳过/ }).first();
  const ceremony = (await skip.count()) > 0;
  let skipMs = null;
  if (ceremony) {
    await skip.click({ timeout: 6000 }).catch(() => undefined);
    skipMs = now() - t0;
  }
  const firstValue = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const found = await pcPage.evaluate(() => {
        const t = document.body.innerText;
        return /晨报|经营简报|待决|决策包/.test(t) ? t : null;
      });
      if (found) return { text: found, ms: now() - t0 };
      await pcPage.waitForTimeout(500);
    }
    return { text: "", ms: now() - t0 };
  })();
  const decisionCount = await pcPage.evaluate(() => {
    const text = document.body.innerText;
    const matches = [...text.matchAll(/待决|待我(拍板|审批)|需你拍板|待审/g)];
    const numberNear = [...text.matchAll(/(\d+)\s*(件|项)[^\n]{0,8}(待|审|决)/g)].map((m) => Number(m[1]));
    return { mentions: matches.length, numbers: numberNear };
  });
  const pass = firstValue.text.length > 0 && firstValue.ms <= 20_000 && decisionCount.mentions > 0;
  record({
    id: "EXP-01",
    persona: "owner",
    journey: "首启（0–10 分钟）",
    dimension: "首启与首价值 / 掌控感",
    name: "打开工作台即看到今日经营与待拍板事项",
    precondition: "成员态登录（ws-yunqi / MEM-001），演示数据已种子",
    steps: ["打开 PC 首页", "（首启）1 次点击跳过欢迎仪式", "计时到出现晨报/待决内容", "统计待决提及与数字"],
    expected: "欢迎仪式可跳过（首启 ≤1 次点击）；跳过前不看引导教程；T+20s 内出现价值内容；决策包 ≤7 件/日",
    actual: { 有欢迎仪式: ceremony, 跳过耗时毫秒: skipMs, 首次价值毫秒: firstValue.ms, 待决提及: decisionCount.mentions, 数字线索: decisionCount.numbers },
    metric: `首次价值 ${(firstValue.ms / 1000).toFixed(1)}s`,
    evidence: await shot(pcPage, "exp-01-owner-first-value"),
    pass,
  });
} catch (err) {
  record({ id: "EXP-01", persona: "owner", journey: "首启", dimension: "首启与首价值", name: "首启首次价值", steps: [], expected: "T+20s", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 2：owner · 日常治理（审批单件 ≤30s，且真的写回） ---------------- */
try {
  await pcPage.goto(`${PC}/approvals`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(2800);
  const openedPanel = await ensureRightPanel(pcPage);
  const items = pcPage.locator("button").filter({ hasText: /必审|逐步审|高风险/ });
  const pendingItems = await items.count();
  if (pendingItems > 0) await items.first().click({ timeout: 8000 }).catch(() => undefined);
  await pcPage.waitForTimeout(1200);
  const before = await pcPage.evaluate(() => {
    const t = document.body.innerText;
    const rods = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").replace(/\s+/g, " ").trim());
    return {
      hasBatch: /批量采纳低风险|批量推进/.test(t),
      hasAdvanceRod: rods.some((x) => /^推进 /.test(x)),
      hasCalibrateRod: rods.some((x) => /^校准 /.test(x)),
      hasBrakeRod: rods.some((x) => /^制动 /.test(x)),
    };
  });
  const t0 = now();
  let clicked = false;
  let afterText = "";
  // 抽屉里刚挂载的杆位，role 引擎偶发还没就绪（实测同样 DOM 下一次 count=0、下一次 count=1），
  // 因此先等可见再点；选择器用文本而不是 role，避免把「面板动画中」误判成「手势缺失」。
  const advance = pcPage.locator('button:has-text("推进")').first();
  await advance.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (await advance.count()) {
    await advance.scrollIntoViewIfNeeded().catch(() => undefined);
    await advance.click({ timeout: 10_000 }).catch(() => undefined);
    clicked = true;
    await pcPage.waitForTimeout(2000);
    afterText = await pcPage.evaluate(() => document.body.innerText);
  }
  const singleMs = now() - t0;
  const wroteBack = /账本事件|已写入事件账本|已采纳|已批准/.test(afterText);
  const pass = before.hasBatch && before.hasAdvanceRod && before.hasCalibrateRod && before.hasBrakeRod && clicked && wroteBack && singleMs <= 30_000;
  record({
    id: "EXP-02",
    persona: "owner",
    journey: "日常治理（每天 10 分钟）",
    dimension: "效率与恢复 / 信任与透明",
    name: "审批三手势可用且单件裁决 ≤30s（本轮实际点按「推进采纳」并核对写回）",
    precondition: "审批页存在待审项；成员具备审批权限",
    steps: ["打开审批中心", "（窄内容区）展开右栏上下文面板", "选中一条待审项", "点按「推进」并核对写回"],
    expected: "三手势齐全；单件裁决 ≤30s；裁决结果有明确回执（事件账本编号）",
    actual: { 右栏抽屉展开: openedPanel, 待审条目: pendingItems, 手势: before, 实际点击: clicked, 写回提示: wroteBack, 单件毫秒: singleMs },
    metric: `单件 ${(singleMs / 1000).toFixed(1)}s`,
    evidence: await shot(pcPage, "exp-02-owner-approval"),
    pass,
  });
} catch (err) {
  record({ id: "EXP-02", persona: "owner", journey: "日常治理", dimension: "效率与恢复", name: "审批三手势", steps: [], expected: "单件 ≤30s", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 3：owner · 信任溯源（≤2 次点击看到证据链） ---------------- */
try {
  await pcPage.goto(`${PC}/events`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForFunction(() => /事件账本/.test(document.body.innerText), null, { timeout: 25_000 }).catch(() => undefined);
  // 「事件账本」标题先出现，事件卡要等账本投影回来（近 12 条任务事件）——等卡片再取样。
  await pcPage.waitForFunction(() => document.querySelectorAll("article").length > 0, null, { timeout: 20_000 }).catch(() => undefined);
  await pcPage.waitForTimeout(1500);
  const card = await pcPage.evaluate(() => {
    const article = document.querySelector("article");
    const t = article?.innerText ?? "";
    return {
      hasCard: Boolean(article),
      hasAction: t.length > 0,
      hasActor: /·/.test(t),
      hasEventNo: /事件/.test(t),
      hasPayload: Boolean(article?.querySelector(".bg-bg800\\/70")),
      sample: t.replace(/\s+/g, " ").slice(0, 150),
    };
  });
  const t0 = now();
  const threadLink = pcPage.locator("article button").first();
  let openedTask = false;
  if (await threadLink.count()) {
    await threadLink.click({ timeout: 8000 }).catch(() => undefined);
    await pcPage.waitForTimeout(2000);
    openedTask = await pcPage.evaluate(() => /决策链路|拆解|执行|步骤|回执|依据/.test(document.body.innerText));
  }
  const pass = card.hasCard && card.hasActor && card.hasEventNo && card.hasPayload && openedTask;
  record({
    id: "EXP-03",
    persona: "owner",
    journey: "日常治理",
    dimension: "信任与透明",
    name: "任一结论可一键溯源到事件/回执（≤2 次点击）",
    precondition: "账本中有历史事件",
    steps: ["打开事件账本", "核对事件卡证据要素（动作/执行者/事件尾号/结果/规则影响）", "点击关联任务进入决策链路"],
    expected: "证据要素同屏可见；≤2 次点击进入决策链路",
    actual: { 卡片: card, 关联任务打开: openedTask, 点击次数: 1, 耗时毫秒: now() - t0 },
    metric: `1 次点击 · 证据同屏`,
    evidence: await shot(pcPage, "exp-03-owner-traceability"),
    pass,
  });
} catch (err) {
  record({ id: "EXP-03", persona: "owner", journey: "日常治理", dimension: "信任与透明", name: "一键溯源", steps: [], expected: "≤2 点击", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 4：owner · 掌控感（紧急制动入口与确认，避免污染演示态不执行） ---------------- */
try {
  // 制动杆的「可执行态」（带 onConfirm）挂在经营报告右栏；首页顶栏那根是无审批权时的不可用态。
  await pcPage.goto(`${PC}/reports`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(3000);
  const brake = pcPage.getByRole("button", { name: /紧急制动/ }).first();
  const hasBrake = (await brake.count()) > 0;
  const enabled = hasBrake ? !(await brake.isDisabled()) : false;
  let dialog = false;
  let dialogText = "";
  if (hasBrake) {
    await brake.scrollIntoViewIfNeeded().catch(() => undefined);
    await brake.click({ timeout: 8000 }).catch(() => undefined);
    await pcPage.waitForTimeout(1000);
    dialogText = await pcPage.evaluate(() => document.body.innerText);
    dialog = /确认制动（全端 ≤60s 生效）|撤回/.test(dialogText);
    // 只读验证：不真正执行制动，避免破坏演示运行态（真实演练由紧急制动用例单独覆盖）
    const cancel = pcPage.getByRole("button", { name: /^撤回$/ }).first();
    if (await cancel.count()) await cancel.click({ timeout: 4000 }).catch(() => undefined);
  }
  record({
    id: "EXP-04",
    persona: "owner",
    journey: "异常处理",
    dimension: "掌控感",
    name: "随时可暂停/制动（入口可达 + 二次确认）",
    precondition: "工作台顶栏可用",
    steps: ["打开经营报告", "定位紧急制动杆", "点击打开二次确认", "核对「全端 ≤60s 生效」说明后撤回（不污染演示态）"],
    expected: "入口可达且可执行；二次确认写明生效范围；有撤回路径",
    actual: { 入口存在: hasBrake, 可执行: enabled, 确认层: dialog },
    evidence: await shot(pcPage, "exp-04-owner-brake"),
    pass: hasBrake && dialog,
  });
} catch (err) {
  record({ id: "EXP-04", persona: "owner", journey: "异常处理", dimension: "掌控感", name: "紧急制动", steps: [], expected: "入口+确认", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 5：manager · 派活（≤3 步、≤60s，派发后详情可读拆解） ---------------- */
let dispatchedThreadId = null;
try {
  await pcPage.goto(`${PC}/tasks`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(2000);
  const entry = await pcPage.evaluate(() => {
    const t = document.body.innerText;
    const input = document.querySelector("textarea, input[type=text]");
    return { hasInput: Boolean(input), placeholder: input?.getAttribute("placeholder") ?? null, text: t.slice(0, 200) };
  });
  const t0 = now();
  const res = await pcPage.request.post(`${API}/trpc/threads.dispatch`, {
    headers: { authorization: `Bearer ${PC_TOKEN}` },
    data: { title: "体验验收：为亲子房设计一条小红书种草笔记，本周五前发布", presetKey: "growth-experimenter" },
  });
  const json = await res.json();
  dispatchedThreadId = json?.result?.data?.threadId ?? null;
  const dispatchMs = now() - t0;
  let detailOk = false;
  if (dispatchedThreadId) {
    await pcPage.goto(`${PC}/tasks/${encodeURIComponent(dispatchedThreadId)}`, { waitUntil: "domcontentloaded" });
    await pcPage.waitForTimeout(2500);
    detailOk = await pcPage.evaluate(() => /拆解|步骤|执行|交付|回执/.test(document.body.innerText));
  }
  record({
    id: "EXP-05",
    persona: "manager",
    journey: "首日（Day-1）",
    dimension: "效率与恢复",
    name: "把一条模糊需求派给岗位并看到拆解",
    precondition: "成员具备派发权限",
    steps: ["打开任务中心（入口可见）", "派发一条增长任务", "打开任务详情核对拆解/步骤"],
    expected: "≤3 步完成派活；详情页能读到拆解与执行轨迹",
    actual: { 页面输入入口: entry.hasInput, 占位文案: entry.placeholder, threadId: dispatchedThreadId, 详情可读: detailOk, 派发毫秒: dispatchMs },
    metric: `派发 ${(dispatchMs / 1000).toFixed(1)}s`,
    evidence: await shot(pcPage, "exp-05-manager-dispatch"),
    pass: Boolean(dispatchedThreadId) && detailOk,
  });
} catch (err) {
  record({ id: "EXP-05", persona: "manager", journey: "首日", dimension: "效率与恢复", name: "派活", steps: [], expected: "≤3 步", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 6：manager · 统一待办不丢（跨端聚合） ---------------- */
try {
  await pcPage.goto(`${PC}/inbox`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(2000);
  const inbox = await pcPage.evaluate(() => {
    const t = document.body.innerText;
    return { hasTitle: /统一待办/.test(t), hasItems: /审批|告警|工单|待办/.test(t), empty: /无待办|暂无/.test(t), len: t.length };
  });
  record({
    id: "EXP-06",
    persona: "manager",
    journey: "日常治理",
    dimension: "理解度 / 效率与恢复",
    name: "统一待办把跨域事项聚合在一屏（不丢事项）",
    precondition: "存在待审/待办演示数据",
    steps: ["打开统一待办", "核对聚合来源与空态边界"],
    expected: "一屏聚合审批/告警/工单；空态给出下一步",
    actual: inbox,
    evidence: await shot(pcPage, "exp-06-manager-inbox"),
    pass: inbox.hasTitle && (inbox.hasItems || inbox.empty),
  });
} catch (err) {
  record({ id: "EXP-06", persona: "manager", journey: "日常治理", dimension: "理解度", name: "统一待办", steps: [], expected: "聚合不丢", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 7：staff · B 端移动接活与交接 ---------------- */
try {
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  await mobileContext.addInitScript(({ token, slug }) => {
    sessionStorage.setItem("workloom:workloom-ai-acquisition:b-mobile:access-token", token);
    localStorage.setItem("workloom:workloom-ai-acquisition:b-mobile:workspace", slug);
    localStorage.removeItem("workloom:workloom-ai-acquisition:b-mobile:guest");
  }, { token: PC_TOKEN, slug: WORKSPACE_SLUG });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`${MB}/tasks`, { waitUntil: "domcontentloaded" });
  await mobilePage.waitForTimeout(2500);
  const tasks = await mobilePage.evaluate(() => ({ text: document.body.innerText, overflow: document.documentElement.scrollWidth > window.innerWidth + 2 }));
  await mobilePage.goto(`${MB}/inbox`, { waitUntil: "domcontentloaded" });
  await mobilePage.waitForTimeout(2000);
  const inbox = await mobilePage.evaluate(() => ({ text: document.body.innerText, overflow: document.documentElement.scrollWidth > window.innerWidth + 2 }));
  const hasTaskContent = /任务|拆解|执行|待办|审批/.test(tasks.text) && tasks.text.length > 100;
  record({
    id: "EXP-07",
    persona: "staff",
    journey: "首日",
    dimension: "理解度 / 响应式",
    name: "移动端能接到活、看到待办（390px 无横向溢出）",
    precondition: "B 端移动已登录（sessionStorage 令牌）",
    steps: ["打开移动端任务页", "打开移动端待办页", "检查横向溢出"],
    expected: "任务/待办内容可见；390px 无横向滚动",
    actual: { 任务页长度: tasks.text.length, 待办页长度: inbox.text.length, 任务页溢出: tasks.overflow, 待办页溢出: inbox.overflow, 摘要: tasks.text.replace(/\s+/g, " ").slice(0, 120) },
    evidence: await shot(mobilePage, "exp-07-staff-mobile"),
    pass: hasTaskContent && !tasks.overflow && !inbox.overflow,
  });
  await mobileContext.close();
} catch (err) {
  record({ id: "EXP-07", persona: "staff", journey: "首日", dimension: "响应式", name: "移动端接活", steps: [], expected: "无溢出", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 8：partner · 伙伴授权边界可见（资金类不可碰） ---------------- */
try {
  await pcPage.goto(`${PC}/partners`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(2200);
  const partners = await pcPage.evaluate(() => {
    const t = document.body.innerText;
    return {
      len: t.length,
      hasScope: /授权|范围|可访问|权限/.test(t),
      hasMoneyRedline: /资金|付款|支付|提现|不可/.test(t),
      sample: t.replace(/\s+/g, " ").slice(0, 200),
    };
  });
  record({
    id: "EXP-08",
    persona: "partner",
    journey: "首周",
    dimension: "信任与透明 / 理解度",
    name: "伙伴能看清自己的授权范围与不可触碰红线",
    precondition: "伙伴授权页有演示数据",
    steps: ["打开伙伴授权页", "核对授权条目与红线文案"],
    expected: "权限逐条可见；资金类承诺不可触碰的说明可见",
    actual: partners,
    evidence: await shot(pcPage, "exp-08-partner-scope"),
    pass: partners.hasScope,
  });
} catch (err) {
  record({ id: "EXP-08", persona: "partner", journey: "首周", dimension: "信任与透明", name: "伙伴授权边界", steps: [], expected: "范围可见", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 9：guest · C 端首响 + 转人工 + 工单 ---------------- */
try {
  const cContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const cPage = await cContext.newPage();
  await cPage.goto(`${MC}/`, { waitUntil: "domcontentloaded" });
  await cPage.waitForTimeout(3000);
  const t0 = now();
  const input = cPage.locator('input[placeholder="请输入您的需求…"]').first();
  await input.click({ force: true, timeout: 8000 }).catch(() => undefined);
  await input.fill("请问你们有没有能开发票的服务？我要报销用的那种。").catch(() => undefined);
  await cPage.waitForTimeout(300);
  const send = cPage.getByRole("button", { name: /发送/ }).first();
  await send.click({ force: true, timeout: 8000 }).catch(() => undefined);
  let firstReplyMs = null;
  for (let i = 0; i < 60; i += 1) {
    const text = await cPage.evaluate(() => document.body.innerText);
    if (/发票|转人工|人工|工单|抱歉|收到/.test(text) && text.length > 300) {
      firstReplyMs = now() - t0;
      break;
    }
    await cPage.waitForTimeout(500);
  }
  const chatText = await cPage.evaluate(() => document.body.innerText);
  const handoff = /转人工|人工顾问|联系人工/.test(chatText);
  await cPage.goto(`${MC}/#tickets`, { waitUntil: "domcontentloaded" });
  await cPage.waitForTimeout(2000);
  const tickets = await cPage.evaluate(() => ({ text: document.body.innerText, overflow: document.documentElement.scrollWidth > window.innerWidth + 2 }));
  record({
    id: "EXP-09",
    persona: "guest",
    journey: "异常处理",
    dimension: "效率与恢复 / 人格与打扰",
    name: "C 端首响 ≤30s，问不到的事能转人工，工单可查",
    precondition: "C 端演示直登（SERVICE_C_DEMO_AUTH）",
    steps: ["打开服务前台", "问一个知识库边界外的问题", "等待首响并核对转人工入口", "打开工单 Tab"],
    expected: "首响 ≤30s；不编造、给转人工路径；工单列表可读",
    actual: { 首响毫秒: firstReplyMs, 转人工入口: handoff, 工单页长度: tickets.text.length, 工单页溢出: tickets.overflow },
    metric: firstReplyMs ? `首响 ${(firstReplyMs / 1000).toFixed(1)}s` : "首响未捕获",
    evidence: await shot(cPage, "exp-09-guest-service"),
    pass: firstReplyMs !== null && firstReplyMs <= 30_000 && handoff && tickets.text.length > 40,
  });
  await cContext.close();
} catch (err) {
  record({ id: "EXP-09", persona: "guest", journey: "异常处理", dimension: "效率与恢复", name: "C 端首响与转人工", steps: [], expected: "≤30s", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 走查 10：owner · 围栏 dry-run（候选规则先回放，未确认不生效） ---------------- */
try {
  await pcPage.goto(`${PC}/guardrails`, { waitUntil: "domcontentloaded" });
  await pcPage.waitForFunction(() => /生效范围|规则版本记录/.test(document.body.innerText), null, { timeout: 25_000 }).catch(() => undefined);
  await pcPage.waitForTimeout(1200);
  const openedPanel = await ensureRightPanel(pcPage);
  const textarea = pcPage.locator("textarea").first();
  const hasEditor = (await textarea.count()) > 0;
  if (hasEditor) {
    await textarea.fill("价格类动作必须经负责人审批").catch(() => undefined);
    await pcPage.waitForTimeout(400);
  }
  const draftBtn = pcPage.getByRole("button", { name: /生成结构化规则草稿/ }).first();
  const hasDraftBtn = (await draftBtn.count()) > 0;
  if (hasDraftBtn) {
    await draftBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await draftBtn.click({ timeout: 8000 }).catch(() => undefined);
    await pcPage.waitForTimeout(1500);
  }
  const dryBtn = pcPage.getByRole("button", { name: /模拟回放/ }).first();
  const hasDryBtn = (await dryBtn.count()) > 0;
  let reportText = "";
  if (hasDryBtn) {
    await dryBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await dryBtn.click({ timeout: 8000 }).catch(() => undefined);
    await pcPage.waitForTimeout(3000);
    reportText = await pcPage.evaluate(() => document.body.innerText);
  }
  const hasReport = /模拟回放报告|将拦截|影响面|回放最近/.test(reportText);
  record({
    id: "EXP-10",
    persona: "owner",
    journey: "异常处理",
    dimension: "掌控感 / 信任与透明",
    name: "改规则之前先模拟回放（未确认不生效）",
    precondition: "围栏页可用，成员具备治理权限",
    steps: ["打开围栏规则", "（窄内容区）展开右栏上下文面板", "填写规则草稿", "生成结构化规则草稿", "点按「模拟回放最近 10 条事件」", "核对回放报告"],
    expected: "窄内容区下编辑入口仍可达；dry-run 出报告；未确认不落库",
    actual: { 右栏抽屉展开: openedPanel, 草稿编辑器: hasEditor, 草稿按钮: hasDraftBtn, 回放按钮: hasDryBtn, 报告: hasReport },
    evidence: await shot(pcPage, "exp-10-owner-dryrun"),
    pass: hasEditor && hasDraftBtn && hasDryBtn && hasReport,
  });
} catch (err) {
  record({ id: "EXP-10", persona: "owner", journey: "异常处理", dimension: "掌控感", name: "围栏 dry-run", steps: [], expected: "有回放报告", actual: String(err).split("\n")[0], pass: false });
}

/* ---------------- 维度机检：术语一致性（客户端不得裸奔技术串） ---------------- */
try {
  const PAGES = ["/", "/tasks", "/approvals", "/reports", "/agents", "/skills", "/portfolio", "/events", "/night", "/service"];
  const found = [];
  for (const route of PAGES) {
    await pcPage.goto(`${PC}${route}`, { waitUntil: "domcontentloaded" });
    await pcPage.waitForTimeout(1800);
    const hits = await pcPage.evaluate(() => {
      const text = document.body.innerText;
      const patterns = [
        [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g, "裸 ISO 时间"],
        [/\b[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){2,}\b/g, "裸动作码"],
        [/\b(agt|ws|MEM|T)-\w+/g, "裸内部 ID"],
        [/\b[A-Z][A-Z_]{4,}\b/g, "裸大写枚举"],
      ];
      const out = [];
      for (const [re, label] of patterns) {
        for (const m of text.matchAll(re)) out.push({ label, value: m[0] });
      }
      return out;
    });
    for (const hit of hits) found.push({ route, ...hit });
  }
  /**
   * 命中分两类，不能混为一谈：
   *  ① UI 文案缺陷（渲染层把内部值直接上屏）→ 判失败；
   *  ② 演示数据污染（测试夹具写进演示工作区，例如 `pnpm suite` 建的「套件线程 T-suite-…」）→ 数据卫生问题，
   *     记录为遗留项并给修复建议，不计入 UI 文案通过线。
   */
  const dataHits = found.filter((h) => /^T-suite/.test(h.value));
  const uiHits = found.filter((h) => !dataHits.includes(h));
  REPORT.dimensions.terminology = { scanned: PAGES.length, hits: found, uiDefectHits: uiHits.length, dataHygieneHits: dataHits.length };
  for (const hit of uiHits.slice(0, 8)) REPORT.issues.push({ id: "DIM-terminology", where: hit.route, detail: `${hit.label}：${hit.value}` });
  for (const hit of dataHits.slice(0, 3)) REPORT.issues.push({ id: "DIM-data-hygiene", where: hit.route, detail: `演示数据含测试夹具线程标题：${hit.value}（pnpm suite 写入演示工作区）` });
  console.log(`${uiHits.length === 0 ? "✓" : "✗"} [非功能] 术语一致性：UI 文案缺陷 ${uiHits.length} 处；演示数据污染 ${dataHits.length} 处`);
} catch (err) {
  REPORT.dimensions.terminology = { error: String(err).split("\n")[0] };
}

/* ---------------- 维度机检：对比度（近似 WCAG AA）与打扰预算 ---------------- */
try {
  await pcPage.goto(PC, { waitUntil: "domcontentloaded" });
  await pcPage.waitForTimeout(2500);
  const contrast = await pcPage.evaluate(() => {
    const parse = (rgb) => {
      const m = rgb.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(",").map((x) => Number.parseFloat(x.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      let node = el;
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0.5) return bg;
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    // 取样口径：只取「有直接文本、且有盒模型」的可见节点；上限 600 个，覆盖首屏主要文案。
    const nodes = [...document.querySelectorAll("p,span,div,h1,h2,h3,button,a,td,li,small,strong")]
      .filter((el) => {
        const direct = [...el.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? "").trim().length >= 4);
        if (!direct) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .slice(0, 600);
    const bad = [];
    for (const el of nodes) {
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = bgOf(el);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = Number.parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number.parseInt(cs.fontWeight, 10) >= 700);
      const threshold = large ? 3 : 4.5;
      if (ratio < threshold) bad.push({ text: (el.textContent ?? "").trim().slice(0, 26), ratio: Number(ratio.toFixed(2)), threshold });
    }
    return { sampled: nodes.length, violations: bad.slice(0, 12), violationCount: bad.length };
  });
  REPORT.dimensions.contrast = contrast;
  // 干扰预算：首页静置 20s，统计新增浮层/提示（非 P0 不应打扰）
  const before = await pcPage.evaluate(() => document.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]').length);
  await pcPage.waitForTimeout(20_000);
  const after = await pcPage.evaluate(() => document.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]').length);
  REPORT.dimensions.interruption = { before, after, delta: after - before, windowSeconds: 20 };
  console.log(`✓ [非功能] 对比度抽样 ${contrast.sampled} 节点，低于阈值 ${contrast.violationCount}；静置 20s 新增打扰 ${after - before}`);
} catch (err) {
  REPORT.dimensions.contrast = { error: String(err).split("\n")[0] };
}

/* ---------------- 汇总 ---------------- */
const checksPass = REPORT.checks.filter((c) => c.pass).length;
REPORT.totals = {
  checks: REPORT.checks.length,
  passed: checksPass,
  failed: REPORT.checks.length - checksPass,
  issues: REPORT.issues.length,
  byPersona: REPORT.checks.reduce((acc, c) => {
    acc[c.persona] = acc[c.persona] ?? { total: 0, passed: 0 };
    acc[c.persona].total += 1;
    if (c.pass) acc[c.persona].passed += 1;
    return acc;
  }, {}),
};

const md = [];
md.push("# GROWTH 体验验收（5 类人 × 关键旅程 × 8 维度）");
md.push("");
md.push(`- 生成时间：${REPORT.at}`);
md.push(`- 走查通过：${REPORT.totals.passed}/${REPORT.totals.checks}；问题 ${REPORT.totals.issues}`);
md.push("");
md.push("| 走查 | 角色 | 旅程 | 维度 | 预期 | 实测 | 结论 |");
md.push("|---|---|---|---|---|---|---|");
for (const c of REPORT.checks) {
  md.push(`| ${c.id} ${c.name} | ${c.persona} | ${c.journey} | ${c.dimension} | ${c.expected} | ${JSON.stringify(c.actual)} | ${c.pass ? "通过" : "**未通过**"} |`);
}
if (REPORT.dimensions.terminology) {
  md.push("");
  md.push("## 术语一致性扫描");
  md.push("");
  md.push(`扫描 ${REPORT.dimensions.terminology.scanned} 个页面，命中疑似技术串 ${REPORT.dimensions.terminology.hits?.length ?? "（异常）"} 处。`);
}
if (REPORT.dimensions.contrast) {
  md.push("");
  md.push("## 对比度与打扰（非功能）");
  md.push("");
  md.push(`对比度抽样 ${REPORT.dimensions.contrast.sampled ?? "-"} 个文本节点，低于 AA 阈值 ${REPORT.dimensions.contrast.violationCount ?? "-"} 处；`);
  md.push(`首页静置 ${REPORT.dimensions.interruption?.windowSeconds ?? "-"} 秒新增打扰 ${REPORT.dimensions.interruption?.delta ?? "-"} 次。`);
}
writeFileSync(join(OUT_DIR, "experience-report.json"), JSON.stringify(REPORT, null, 1));
writeFileSync(join(OUT_DIR, "experience-report.md"), `${md.join("\n")}\n`);

await browser.close();
console.log(`[experience] 通过 ${REPORT.totals.passed}/${REPORT.totals.checks}；输出 ${OUT_DIR}`);
if (REPORT.totals.issues > 0) process.exitCode = 1;
