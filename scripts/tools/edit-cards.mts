#!/usr/bin/env tsx
/**
 * edit-cards —— 知识卡生成器：卡片计划（JSON）→ 1080×1920 PNG（可多阶段揭晓）。
 *
 * 为什么要"卡片"：口播单机位素材的视觉上限靠**信息层**抬（清单/数字/抽象名词/长铺垫四处上卡），
 * 行业口径里"模板化文字层可替代 60–70% 的 B-roll"。本执行器只做确定性排版：
 *   · 渲染器用系统自带的 headless Chrome（`--headless=new --screenshot`），零新增依赖；
 *   · 字体走系统/仓内字体栈（Source Han Sans / PingFang / Hiragino），不下载字库；
 *   · `stages > 1` 时同一张卡按阶段渲染多张 PNG（逐条点亮），供 ffmpeg 定时叠加做"逐项揭晓"。
 *
 * 支持的模板（v1）：
 *   · `matrix`  网格（12 个维度这类"逐个亮"）
 *   · `list`    标题 + 条目（清单式知识卡）
 *   · `steps`   三段链路（带序号与箭头）
 *   · `price`   大数字 + 对比（一条 1–2 块钱 / 一杯奶茶）
 *   · `quote`   全屏字卡（金句，全片只允许 1 次）
 *   · `panel`   终端/回执面板（真实命令输出、清单行）
 *
 * 用法：
 *   pnpm edit:cards -- --plan <cards-plan.json> --out-dir <卡片目录> [--chrome <路径>] [--json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FONT_STACK = "'Source Han Sans CN','Source Han Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO_STACK = "'SF Mono','JetBrains Mono','Menlo',monospace";

interface CardSpec {
  id: string;
  template: "matrix" | "list" | "steps" | "price" | "quote" | "panel";
  width?: number;
  height?: number;
  theme?: { accent?: string; accent2?: string; ink?: string; bg?: string; style?: "solid" | "glass" | "terminal" };
  title?: string;
  subtitle?: string;
  kicker?: string;
  bullets?: string[];
  cells?: string[];
  columns?: number;
  steps?: Array<{ label: string; text: string }>;
  big?: string;
  unit?: string;
  compare?: Array<{ label: string; value: string }>;
  lines?: string[];
  footer?: string;
  /** 阶段揭晓：>1 时渲染 `{id}-s1.png … {id}-sN.png`（CSS 用 body[data-stage] 控制显隐） */
  stages?: number;
}

interface CardsPlan {
  cards: CardSpec[];
  theme?: CardSpec["theme"];
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

/** 卡片 HTML：所有模板共用一个"底 + 标题区 + 内容区 + 页脚"骨架，避免每个模板各写一套 CSS */
function cardHtml(card: CardSpec, globalTheme: CardSpec["theme"] = {}): string {
  const width = card.width ?? 1080;
  const height = card.height ?? 1920;
  const theme = { ...globalTheme, ...(card.theme ?? {}) };
  const accent = theme.accent ?? "#7DD3FC";
  const accent2 = theme.accent2 ?? "#FFD166";
  const ink = theme.ink ?? "#FFFFFF";
  const style = theme.style ?? "glass";
  const bg = style === "solid"
    ? `linear-gradient(160deg, ${theme.bg ?? "#0B1220"} 0%, #101C33 60%, #0B1220 100%)`
    : style === "terminal"
      ? "linear-gradient(180deg, rgba(8,14,26,.96) 0%, rgba(10,18,32,.96) 100%)"
      : "linear-gradient(180deg, rgba(9,15,28,.92) 0%, rgba(9,15,28,.86) 100%)";
  const bodyClass = style === "terminal" ? "terminal" : style === "solid" ? "solid" : "glass";
  const bulletList = (card.bullets ?? []).map((bullet, index) =>
    `<li class="b b${index + 1}"><span class="dot"></span><span>${escapeHtml(bullet)}</span></li>`).join("\n");
  const cells = card.cells ?? [];
  const cellHtml = cells.map((cell, index) =>
    `<div class="cell c${index + 1}">${escapeHtml(cell)}</div>`).join("\n");
  const stepsHtml = (card.steps ?? []).map((step, index) =>
    `<div class="step s${index + 1}"><div class="idx">${escapeHtml(step.label)}</div><div class="stext">${escapeHtml(step.text)}</div></div>`).join("\n");
  const compareHtml = (card.compare ?? []).map((item, index) =>
    `<div class="cmp m${index + 1}"><div class="cl">${escapeHtml(item.label)}</div><div class="cv">${escapeHtml(item.value)}</div></div>`).join("\n");
  const linesHtml = (card.lines ?? []).map((line, index) =>
    `<div class="ln l${index + 1}">${escapeHtml(line)}</div>`).join("\n");
  const content = (() => {
    switch (card.template) {
      case "matrix": {
        const columns = card.columns ?? 3;
        return `<div class="matrix" style="grid-template-columns:repeat(${columns},1fr)">${cellHtml}</div>`;
      }
      case "list": return `<ul class="list">${bulletList}</ul>`;
      case "steps": return `<div class="steps">${stepsHtml}</div>`;
      case "price": return `<div class="price"><div class="big">${escapeHtml(card.big ?? "")}<span class="unit">${escapeHtml(card.unit ?? "")}</span></div><div class="cmps">${compareHtml}</div></div>`;
      case "quote": return `<div class="quote">${escapeHtml(card.big ?? card.title ?? "")}</div>`;
      case "panel": return `<div class="panel"><div class="bar"><i></i><i></i><i></i><span>${escapeHtml(card.kicker ?? "workloom · 本地管线回执")}</span></div><div class="lines">${linesHtml}</div></div>`;
      default: return "";
    }
  })();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  :root { --accent:${accent}; --accent2:${accent2}; --ink:${ink}; --dim:rgba(255,255,255,.62); }
  * { box-sizing:border-box; margin:0; padding:0; }
  html,body { width:${width}px; height:${height}px; background:${style === "solid" ? "transparent" : "transparent"}; }
  body { font-family:${FONT_STACK}; color:var(--ink); display:flex; align-items:center; justify-content:center; }
  .root { width:${width}px; height:${height}px; background:${bg}; backdrop-filter:blur(14px); position:relative; display:flex; flex-direction:column;
          padding:${Math.round(height * 0.045)}px ${Math.round(width * 0.06)}px; border-radius:${style === "solid" ? 0 : 28}px; overflow:hidden; }
  .root::after { content:""; position:absolute; inset:0; border:2px solid rgba(255,255,255,.10); border-radius:inherit; pointer-events:none; }
  .root::before { content:""; position:absolute; top:-30%; right:-20%; width:70%; height:50%; background:radial-gradient(closest-side, color-mix(in srgb, var(--accent) 26%, transparent), transparent); filter:blur(10px); }
  .head { position:relative; z-index:1; margin-bottom:${Math.round(height * 0.03)}px; }
  .kicker { display:inline-block; font-size:${Math.round(width * 0.03)}px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); border:1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius:999px; padding:${Math.round(width * 0.008)}px ${Math.round(width * 0.026)}px; }
  h1 { margin-top:${Math.round(height * 0.018)}px; font-size:${Math.round(width * 0.075)}px; line-height:1.16; font-weight:800; letter-spacing:.01em; }
  .sub { margin-top:${Math.round(height * 0.012)}px; font-size:${Math.round(width * 0.034)}px; color:var(--dim); line-height:1.4; }
  .content { position:relative; z-index:1; flex:1; display:flex; align-items:center; }
  .matrix { display:grid; gap:${Math.round(width * 0.024)}px; width:100%; }
  .cell { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); border-radius:${Math.round(width * 0.02)}px; padding:${Math.round(width * 0.03)}px ${Math.round(width * 0.02)}px; text-align:center; font-size:${Math.round(width * 0.037)}px; font-weight:700; line-height:1.3; }
  .cell:nth-child(-n+3) { border-color:color-mix(in srgb, var(--accent) 60%, transparent); }
  .list { list-style:none; width:100%; display:flex; flex-direction:column; gap:${Math.round(height * 0.022)}px; }
  .b { display:flex; align-items:flex-start; gap:${Math.round(width * 0.024)}px; font-size:${Math.round(width * 0.042)}px; line-height:1.35; font-weight:650; }
  .dot { flex:0 0 auto; width:${Math.round(width * 0.018)}px; height:${Math.round(width * 0.018)}px; margin-top:${Math.round(width * 0.014)}px; border-radius:50%; background:var(--accent); box-shadow:0 0 18px color-mix(in srgb, var(--accent) 70%, transparent); }
  .steps { display:flex; flex-direction:column; gap:${Math.round(height * 0.02)}px; width:100%; }
  .step { display:flex; gap:${Math.round(width * 0.028)}px; align-items:center; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:${Math.round(width * 0.02)}px; padding:${Math.round(height * 0.018)}px ${Math.round(width * 0.03)}px; }
  .idx { font-family:${MONO_STACK}; font-size:${Math.round(width * 0.04)}px; color:var(--accent); font-weight:700; }
  .stext { font-size:${Math.round(width * 0.04)}px; font-weight:650; line-height:1.3; }
  .price { width:100%; text-align:center; }
  .big { font-size:${Math.round(width * 0.16)}px; font-weight:900; color:var(--accent2); line-height:1; letter-spacing:-.02em; }
  .unit { font-size:${Math.round(width * 0.05)}px; margin-left:${Math.round(width * 0.012)}px; color:var(--ink); }
  .cmps { margin-top:${Math.round(height * 0.035)}px; display:flex; gap:${Math.round(width * 0.026)}px; justify-content:center; }
  .cmp { flex:1; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); border-radius:${Math.round(width * 0.02)}px; padding:${Math.round(width * 0.026)}px; }
  .cl { font-size:${Math.round(width * 0.03)}px; color:var(--dim); }
  .cv { margin-top:${Math.round(width * 0.01)}px; font-size:${Math.round(width * 0.05)}px; font-weight:800; }
  .quote { font-size:${Math.round(width * 0.1)}px; font-weight:900; line-height:1.25; text-align:left; }
  .quote::before { content:"“"; color:var(--accent); font-size:${Math.round(width * 0.13)}px; line-height:0; margin-right:${Math.round(width * 0.01)}px; }
  .panel { width:100%; background:rgba(3,7,14,.72); border:1px solid rgba(255,255,255,.14); border-radius:${Math.round(width * 0.022)}px; overflow:hidden; }
  .bar { display:flex; align-items:center; gap:${Math.round(width * 0.012)}px; padding:${Math.round(height * 0.012)}px ${Math.round(width * 0.026)}px; background:rgba(255,255,255,.05); border-bottom:1px solid rgba(255,255,255,.10); }
  .bar i { width:${Math.round(width * 0.016)}px; height:${Math.round(width * 0.016)}px; border-radius:50%; background:rgba(255,255,255,.22); }
  .bar i:first-child { background:#FF5F57; } .bar i:nth-child(2) { background:#FEBC2E; } .bar i:nth-child(3) { background:#28C840; }
  .bar span { margin-left:${Math.round(width * 0.014)}px; font-family:${MONO_STACK}; font-size:${Math.round(width * 0.024)}px; color:var(--dim); }
  .lines { padding:${Math.round(height * 0.02)}px ${Math.round(width * 0.028)}px; display:flex; flex-direction:column; gap:${Math.round(height * 0.012)}px; font-family:${MONO_STACK}; font-size:${Math.round(width * 0.028)}px; line-height:1.45; color:#D7E3F4; }
  .ln::before { content:""; }
  .foot { position:relative; z-index:1; margin-top:${Math.round(height * 0.02)}px; font-size:${Math.round(width * 0.028)}px; color:var(--dim); }
  /* 阶段揭晓：stage-1 只显示第 1 条，stage-2 显示前 2 条……（未显示的整块 hidden 保证不被读出） */
${Array.from({ length: 12 }, (_, index) => {
  const stage = index + 1;
  const hidden = [".b", ".cell", ".step", ".cmp", ".ln"].map((selector) =>
    `body[data-stage="${stage}"] ${selector}:nth-child(n+${stage + 1})`).join(",");
  return `  ${hidden} { visibility:hidden; }`;
}).join("\n")}
</style></head>
<body class="${bodyClass}" data-stage="__STAGE__">
  <div class="root">
    <div class="head">
      ${card.kicker ? `<span class="kicker">${escapeHtml(card.kicker)}</span>` : ""}
      ${card.title ? `<h1>${escapeHtml(card.title)}</h1>` : ""}
      ${card.subtitle ? `<div class="sub">${escapeHtml(card.subtitle)}</div>` : ""}
    </div>
    <div class="content">${content}</div>
    ${card.footer ? `<div class="foot">${escapeHtml(card.footer)}</div>` : ""}
  </div>
</body></html>`;
}

function renderWithChrome(chrome: string, htmlPath: string, pngPath: string, width: number, height: number, transparent: boolean): void {
  const args = [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--window-size=${width},${height}`, `--screenshot=${pngPath}`,
    "--virtual-time-budget=1500", "--run-all-compositor-stages-before-draw",
    ...(transparent ? ["--default-background-color=00000000"] : []),
    `file://${htmlPath}`,
  ];
  execFileSync(chrome, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

try {
  const planPath = abs(arg("--plan"));
  const outDir = abs(arg("--out-dir"));
  const chrome = arg("--chrome", DEFAULT_CHROME);
  if (!planPath || !outDir) throw new Error("用法：pnpm edit:cards -- --plan <cards-plan.json> --out-dir <目录>");
  if (!existsSync(planPath)) throw new Error(`卡片计划不存在：${planPath}`);
  if (!existsSync(chrome)) throw new Error(`找不到 headless Chrome：${chrome}（可用 --chrome 指定）`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as CardsPlan;
  if (!Array.isArray(plan.cards) || plan.cards.length === 0) throw new Error("卡片计划为空");
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "workloom-cards-"));
  const rendered: Array<Record<string, unknown>> = [];
  for (const card of plan.cards) {
    if (!card.id || !card.template) throw new Error(`卡片缺 id/template：${JSON.stringify(card).slice(0, 120)}`);
    const width = card.width ?? 1080;
    const height = card.height ?? 1920;
    const stages = Math.max(1, Math.min(12, Number(card.stages ?? 1)));
    const html = cardHtml(card, plan.theme);
    const htmlPath = join(work, `${card.id}.html`);
    writeFileSync(htmlPath, html, "utf8");
    const outputs: string[] = [];
    for (let stage = 1; stage <= stages; stage += 1) {
      const pngPath = stages === 1 ? join(outDir, `${card.id}.png`) : join(outDir, `${card.id}-s${stage}.png`);
      /** 单阶段卡：data-stage=12 = 全部显示（否则 CSS 的"逐条揭晓"会把第 2 条起全藏起来） */
      const stageValue = stages === 1 ? 12 : stage;
      const staged = html.replace('data-stage="__STAGE__"', `data-stage="${stageValue}"`);
      const stagedHtml = join(work, `${card.id}-s${stage}.html`);
      writeFileSync(stagedHtml, staged, "utf8");
      renderWithChrome(chrome, stagedHtml, pngPath, width, height, card.template !== "quote");
      const bytes = statSync(pngPath).size;
      if (bytes < 2000) throw new Error(`卡片渲染失败（产物过小 ${bytes}B）：${pngPath}`);
      outputs.push(pngPath);
      rendered.push({
        id: stages === 1 ? card.id : `${card.id}-s${stage}`,
        template: card.template, stage, width, height, bytes,
        sha256: createHash("sha256").update(readFileSync(pngPath)).digest("hex"),
        path: pngPath,
      });
    }
    if (outputs.length === 0) throw new Error(`卡片没有产出：${card.id}`);
  }
  const receipt = {
    schemaVersion: "workloom.video-edit/cards-receipt/v1",
    plan: planPath, outDir, renderer: { engine: "headless-chrome", chrome }, cards: rendered,
    generatedAt: new Date().toISOString(),
  };
  const receiptPath = join(outDir, "cards-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (flag("--json")) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`✓ 知识卡渲染完成：${rendered.length} 张（${plan.cards.length} 个卡片定义）`);
    console.log(`  产物目录：${outDir}｜回执：${receiptPath}`);
  }
} catch (error) {
  console.error(`✗ edit-cards 失败：${(error as Error).message}`);
  process.exit(1);
}
