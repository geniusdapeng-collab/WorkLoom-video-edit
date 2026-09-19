#!/usr/bin/env node
/**
 * acceptance-ui-probe.mjs · 员工/技能验收矩阵的**页面层**探针（B 运行层的真机证据）
 *
 * 与 acceptance-matrix.mts（契约层 + 数据库层）配对使用：
 *   matrix 已证明"数据对"，本脚本证明"人看得见、点得开、没有悬空标红"。
 *   ① PC /agents：70 个岗位逐个点开档案页，核对身份/围栏/技能三卡渲染（无"声明悬空"、无"未安装"）；
 *   ② PC /skills：官方技能卡逐个核对中文展示名（不允许"未命名/技能能力"回落）；
 *   ③ 关键路由：视频域 4 条待复验路由 + B 端移动子页 + C 端服务前台入口。
 *
 * 用法：
 *   node scripts/acceptance-ui-probe.mjs --out <目录> [--skip-agents] [--base http://localhost:3000]
 * 前置：pnpm preview:all 已拉起（PC:3000 / B移动:3001 / C移动:3002 / server:8787）
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(join(REPO_ROOT, "package.json"));
const { chromium } = require(join(REPO_ROOT, "node_modules", ".pnpm", "playwright@1.63.0", "node_modules", "playwright"));

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT_DIR = resolve(argValue("--out", join(REPO_ROOT, "artifacts", "acceptance-ui")));
const PC = argValue("--base", "http://localhost:3000");
const MB = argValue("--mobile-base", "http://localhost:3001");
const MC = argValue("--c-base", "http://localhost:3002");
const API = argValue("--api", "http://127.0.0.1:8787");
const WORKSPACE_SLUG = argValue("--workspace-slug", "yunqi-hotel");
const MEMBER_NO = argValue("--member", "MEM-001");
const SKIP_AGENTS = argv.includes("--skip-agents");

/* ------------------------------ 事实源：数据库 ------------------------------ */

function readEnvValue(key) {
  const text = readFileSync(join(REPO_ROOT, ".env"), "utf-8");
  const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

/**
 * 与 apps/web/src/lib/display.ts 的 skillDisplayName 同口径（description 首句即中文名；
 * 首句夹带拉丁技术记号时剔除后再取中文）。验收口径是「技能中心不得出现裸英文技能 id」，
 * 所以下面同时校验：① 清洗后的中文名出现；② 裸 id 不出现。
 */
function stripTechnicalTokens(value) {
  return value.replace(/[A-Za-z][A-Za-z0-9._+/-]*/g, " ").replace(/[\s·—–-]+/g, " ").trim();
}
/**
 * 与 apps/web/src/lib/display.ts 的 skillDisplayName 同口径取值（客户端词典无法在探针里复现，
 * 因此探针只做「两种可能都接受」的宽松断言）：
 *   候选名（原串）或清洗后的候选名任一出现在卡片上即算通过；裸 id 出现则直接判失败。
 */
function skillDisplayCandidates(name, description) {
  const m = /^([^（(。：:—]{2,40})[（(。：:—]/.exec((description ?? "").trim());
  const candidate = m?.[1]?.trim();
  const cleaned = candidate ? stripTechnicalTokens(candidate) : "";
  const list = [candidate, cleaned].filter((x) => x && x.length >= 2);
  return list.length ? list : [name];
}

const client = new pg.Client({ connectionString: readEnvValue("DATABASE_URL") });
await client.connect();
const agentRows = (await client.query(
  `SELECT id, preset_key, name, version, fence_bindings, skills, meta FROM agents WHERE workspace_id=$1 ORDER BY preset_key`,
  ["ws-yunqi"],
)).rows;
const skillRows = (await client.query(
  `SELECT s.id, s.name, s.description, s.version, s.bundle, s.level
   FROM skill_installs si JOIN skills s ON s.id = si.skill_id
   WHERE si.workspace_id=$1 AND s.level='official' ORDER BY s.bundle NULLS FIRST, s.name`,
  ["ws-yunqi"],
)).rows;
await client.end();

/* ------------------------------ 页面探针 ------------------------------ */

const report = {
  at: new Date().toISOString(),
  expected: { agents: agentRows.length, officialSkills: skillRows.length },
  agents: {},
  skills: {},
  routes: {},
  totals: {},
  issues: [],
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0]);
});
page.on("pageerror", (e) => consoleErrors.push(String(e).split("\n")[0]));

async function loginPc() {
  const res = await page.request.post(`${API}/trpc/auth.loginAs`, { data: { workspaceSlug: WORKSPACE_SLUG, memberNo: MEMBER_NO } });
  const json = await res.json();
  const token = json?.result?.data?.token;
  if (!token) throw new Error(`登录失败：${JSON.stringify(json).slice(0, 200)}`);
  await page.goto(`${PC}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate((t) => {
    const keys = Object.keys(localStorage);
    const tk = keys.find((k) => k.endsWith(":access-token")) ?? "workloom:access-token";
    const gk = keys.find((k) => k.endsWith(":guest"));
    localStorage.setItem(tk, t);
    if (gk) localStorage.removeItem(gk);
  }, token);
  return token;
}

await loginPc();

/* ① 岗位档案逐个渲染核对 */
/** 与 apps/web/src/lib/display.ts 的 versionText 同口径：v1.0 → 第 1.0 版 */
function versionLabel(version) {
  const m = String(version ?? "").match(/(?:^|[\/_-])v?(\d+(?:\.\d+)*)$/i) ?? String(version ?? "").match(/^v?(\d+(?:\.\d+)*)$/i);
  return m?.[1] ? `第 ${m[1]} 版` : "版本待确认";
}

if (!SKIP_AGENTS) {
  for (const agent of agentRows) {
    consoleErrors.length = 0;
    const expectedSkills = Array.isArray(agent.skills) ? agent.skills : [];
    const expectedFences = (agent.fence_bindings ?? []).length;
    const row = { name: agent.name, bundle: agent.meta?.sourceBundleId ?? null, fences: expectedFences, skills: expectedSkills.length, ok: false };
    try {
      await page.goto(`${PC}/agents/${encodeURIComponent(agent.id)}`, { waitUntil: "domcontentloaded" });
      // 70 个档案页在同一浏览器上下文里连续跑，后段页面首屏会变慢（实测需 5–12s），
      // 超时给足 20s：超时本身也要区分「慢」和「打不开」，不能把小机器抖动当成页面缺陷。
      await page.waitForFunction(() => document.body.innerText.includes("身份与归属"), null, { timeout: 20000 });
      const dom = await page.evaluate(() => {
        const text = document.body.innerText;
        const section = (title) => {
          const idx = text.indexOf(title);
          return idx < 0 ? "" : text.slice(idx, idx + 900);
        };
        return {
          text,
          identity: section("身份与归属"),
          fences: section("规则许可"),
          skills: section("装备 · 技能包"),
          equipped: (text.match(/已装备 · /g) ?? []).length,
          declared: (text.match(/已声明 · /g) ?? []).length,
          uninstalled: /未安装/.test(text),
          dangling: text.includes("声明悬空") || text.includes("标红"),
          notFound: text.includes("成员不存在或已停用"),
          hasHeader: /成员档案 · \S/.test(text),
        };
      });
      const identityOk = dom.hasHeader && dom.identity.includes(versionLabel(agent.version)) && dom.identity.includes("来源行业包");
      const fenceOk = !dom.dangling && (expectedFences === 0 || dom.declared >= expectedFences);
      const skillsOk = expectedSkills.length === 0
        ? !dom.uninstalled
        : dom.equipped >= expectedSkills.length && !dom.uninstalled;
      row.ok = identityOk && fenceOk && skillsOk && !dom.notFound;
      row.detail = {
        identityOk, fenceOk, skillsOk,
        declared: dom.declared, expectedFences,
        equipped: dom.equipped, expectedSkills: expectedSkills.length,
        errors: consoleErrors.slice(0, 2),
      };
      if (!row.ok) report.issues.push({ where: `agent:${agent.preset_key}`, detail: row.detail });
    } catch (err) {
      row.ok = false;
      row.detail = { error: String(err).split("\n")[0], errors: consoleErrors.slice(0, 3) };
      report.issues.push({ where: `agent:${agent.preset_key}`, detail: row.detail });
    }
    report.agents[agent.preset_key] = row;
  }
}

/* ② 技能中心：官方技能中文名与安装态 */
try {
  consoleErrors.length = 0;
  await page.goto(`${PC}/skills`, { waitUntil: "domcontentloaded" });
  // 技能中心的分区标题是静态骨架，catalog 投影（skills.list，含全部技能正文）回来才出卡片。
  // 判据必须落在「计数 > 0」上：实测 2–10s；只等标题会把加载中误判成「技能卡缺失」。
  await page.waitForFunction(
    () => {
      const m = document.body.innerText.match(/官方技能[^\d]{0,12}(\d+)/);
      return Boolean(m && Number(m[1]) > 0);
    },
    null,
    { timeout: 40000 },
  ).catch(() => undefined);
  await page.waitForTimeout(1500);
  const dom = await page.evaluate(() => ({
    text: document.body.innerText,
    uninstallButtons: (document.body.innerText.match(/卸载/g) ?? []).length,
    rawFallbacks: (document.body.innerText.match(/未命名|技能能力/g) ?? []).length,
  }));
  for (const skill of skillRows) {
    const candidates = skillDisplayCandidates(skill.name, skill.description);
    const display = candidates[0];
    const shown = candidates.some((candidate) => dom.text.includes(candidate));
    const rawIdShown = new RegExp(`(^|[^a-z0-9-])${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`).test(dom.text);
    report.skills[skill.name] = { display, candidates, bundle: skill.bundle, ok: shown && !rawIdShown, rawIdShown };
    if (!shown) report.issues.push({ where: `skill:${skill.name}`, detail: `技能中心未见展示名「${candidates.join(" / ")}」` });
    if (rawIdShown) report.issues.push({ where: `skill:${skill.name}`, detail: `技能中心裸奔技术 id「${skill.name}」` });
  }
  report.skillsSummary = {
    listed: Object.values(report.skills).filter((s) => s.ok).length,
    expected: skillRows.length,
    rawFallbackHits: dom.rawFallbacks,
    uninstallButtons: dom.uninstallButtons,
  };
  if (dom.rawFallbacks > 0) report.issues.push({ where: "skills-page", detail: `出现未命名/技能能力回落 ×${dom.rawFallbacks}` });
} catch (err) {
  report.issues.push({ where: "skills-page", detail: String(err).split("\n")[0] });
}

/* ③ 关键路由复验（视频域 4 条待复验 + PC 重点页） */
async function probeRoutes(pages, routes) {
  for (const [key, url, waitMs] of routes) {
    consoleErrors.length = 0;
    try {
      await pages.goto(url, { waitUntil: "domcontentloaded" });
      await pages.waitForTimeout(waitMs ?? 1800);
      const dom = await pages.evaluate(() => {
        const text = document.body.innerText || "";
        return {
          len: text.length,
          blank: text.trim().length === 0,
          internalError: /Internal Server Error|加载失败|出错了/.test(text),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          sample: text.replace(/\s+/g, " ").slice(0, 90),
        };
      });
      report.routes[key] = { ...dom, errors: consoleErrors.slice(0, 2), ok: !dom.blank && !dom.internalError && !dom.overflowX };
    } catch (err) {
      report.routes[key] = { ok: false, error: String(err).split("\n")[0] };
    }
    if (!report.routes[key].ok) report.issues.push({ where: key, detail: report.routes[key] });
  }
}

await probeRoutes(page, [
  ["pc:/ai-video/activity", `${PC}/ai-video/activity`],
  ["pc:/ai-video/review-guide", `${PC}/ai-video/review-guide`],
  ["pc:/ai-video/skills", `${PC}/ai-video/skills`],
  ["pc:/ai-video/team-performance", `${PC}/ai-video/team-performance`],
  ["pc:/assembly", `${PC}/assembly`],
  ["pc:/portfolio", `${PC}/portfolio`],
]);

/* ④ B 端移动：17 条语义路由（token 存 sessionStorage，必须注入后才能看到真实页面而不是登录页） */
{
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  await mobileContext.addInitScript(({ token, workspaceSlug }) => {
    sessionStorage.setItem("workloom:workloom-ai-acquisition:b-mobile:access-token", token);
    localStorage.setItem("workloom:workloom-ai-acquisition:b-mobile:workspace", workspaceSlug);
    localStorage.removeItem("workloom:workloom-ai-acquisition:b-mobile:guest");
  }, { token: report.token = await (async () => {
    const res = await page.request.post(`${API}/trpc/auth.loginAs`, { data: { workspaceSlug: WORKSPACE_SLUG, memberNo: MEMBER_NO } });
    return (await res.json())?.result?.data?.token;
  })(), workspaceSlug: WORKSPACE_SLUG });
  const mobilePage = await mobileContext.newPage();
  const mobileConsole = [];
  mobilePage.on("console", (m) => { if (m.type() === "error") mobileConsole.push(m.text().split("\n")[0]); });
  mobilePage.on("pageerror", (e) => mobileConsole.push(String(e).split("\n")[0]));
  const B_ROUTES = ["/", "/inbox", "/approvals", "/tasks", "/operations", "/reports", "/executive", "/events", "/exams", "/memory", "/night", "/models", "/guardrails", "/skills", "/agents", "/members", "/account"];
  for (const route of B_ROUTES) {
    mobileConsole.length = 0;
    try {
      await mobilePage.goto(`${MB}${route}`, { waitUntil: "domcontentloaded" });
      // 移动端首屏是会话恢复态（「正在恢复工作区」→「正在确认身份/访问范围」→ 业务页）：
      // 三等态都要等完，别把加载中误判成页面缺陷（实测完整渲染约 4–6s）。
      await mobilePage.waitForFunction(
        () => {
          const t = document.body.innerText;
          return t.length > 500 && !/正在恢复工作区|正在确认身份|正在确认访问范围/.test(t);
        },
        null,
        { timeout: 20000 },
      ).catch(() => undefined);
      await mobilePage.waitForTimeout(800);
      const dom = await mobilePage.evaluate(() => {
        const text = document.body.innerText || "";
        return {
          len: text.length,
          authPage: text.includes("B 端移动工作台") && text.includes("验证码"),
          restoring: /正在恢复工作区/.test(text),
          internalError: /加载失败|出错了|Internal Server Error/.test(text),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          sample: text.replace(/\s+/g, " ").slice(0, 80),
        };
      });
      report.routes[`mobile:${route}`] = { ...dom, errors: mobileConsole.slice(0, 2), ok: !dom.authPage && !dom.restoring && !dom.internalError && !dom.overflowX && dom.len > 40 };
    } catch (err) {
      report.routes[`mobile:${route}`] = { ok: false, error: String(err).split("\n")[0] };
    }
    if (!report.routes[`mobile:${route}`].ok) report.issues.push({ where: `mobile:${route}`, detail: report.routes[`mobile:${route}`] });
  }
  await mobileContext.close();
}

/* ⑤ C 端服务前台：哈希式 5 Tab（对话/服务/工单/消息/我的） */
{
  const cContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const cPage = await cContext.newPage();
  const cConsole = [];
  cPage.on("console", (m) => { if (m.type() === "error") cConsole.push(m.text().split("\n")[0]); });
  cPage.on("pageerror", (e) => cConsole.push(String(e).split("\n")[0]));
  for (const hash of ["chat", "service", "tickets", "messages", "me"]) {
    cConsole.length = 0;
    try {
      await cPage.goto(`${MC}/#${hash}`, { waitUntil: "domcontentloaded" });
      await cPage.waitForTimeout(1800);
      const dom = await cPage.evaluate(() => {
        const text = document.body.innerText || "";
        return {
          len: text.length,
          internalError: /加载失败|出错了|Internal Server Error/.test(text),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          sample: text.replace(/\s+/g, " ").slice(0, 80),
        };
      });
      report.routes[`c:#${hash}`] = { ...dom, errors: cConsole.slice(0, 2), ok: !dom.internalError && !dom.overflowX && dom.len > 40 };
    } catch (err) {
      report.routes[`c:#${hash}`] = { ok: false, error: String(err).split("\n")[0] };
    }
    if (!report.routes[`c:#${hash}`].ok) report.issues.push({ where: `c:#${hash}`, detail: report.routes[`c:#${hash}`] });
  }
  await cContext.close();
}

await browser.close();

report.totals = {
  agentsChecked: Object.keys(report.agents).length,
  agentsOk: Object.values(report.agents).filter((a) => a.ok).length,
  skillsChecked: Object.keys(report.skills).length,
  skillsOk: Object.values(report.skills).filter((s) => s.ok).length,
  routesChecked: Object.keys(report.routes).length,
  routesOk: Object.values(report.routes).filter((r) => r.ok).length,
  issues: report.issues.length,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "ui-matrix.json"), JSON.stringify(report, null, 1));
console.log(`[acceptance-ui] 岗位档案 ${report.totals.agentsOk}/${report.totals.agentsChecked}；技能卡 ${report.totals.skillsOk}/${report.totals.skillsChecked}；路由 ${report.totals.routesOk}/${report.totals.routesChecked}；问题 ${report.totals.issues}`);
for (const issue of report.issues.slice(0, 15)) console.log(`  ✗ ${issue.where}：${JSON.stringify(issue.detail).slice(0, 220)}`);
console.log(`[acceptance-ui] 输出：${OUT_DIR}/ui-matrix.json`);
if (report.totals.issues > 0) process.exitCode = 1;
