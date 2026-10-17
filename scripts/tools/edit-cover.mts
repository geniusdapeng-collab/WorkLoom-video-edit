#!/usr/bin/env tsx
/**
 * edit-cover —— 封面 agent 链路执行器（封面设计师岗位 + Compositor 视觉工位）。
 *
 * 链路（与 `presets/cover-designer.yml` / `skills/compositor-designer` / `connectors/visual-bridge` 同口径）：
 *   ① 画幅：**跟随成片**（横版片出横版封面，竖版片出竖版封面）——封面与首帧一致才不会在平台上被裁；
 *   ② 规格与知识库：平台安全区/标题带取 `cover-platforms.ts`（唯一事实源），经验注入取 `cover-kb`（带 trace）；
 *   ③ 视觉锤：可选账号档案（字体/色板/版式偏好/系列角标）；
 *   ④ 设计稿：三风格独立封面（每份 CoverPlan：主标题/副标题/角标/主视觉镜头与取帧秒/字级/配色/版式/设计理由）；
 *   ⑤ 合成：**Compositor 视觉工位**（visual-bridge：配方 → .comp → PNG，带回执）；工位不可用时显式降级到本机 ffmpeg 并如实标注；
 *   ⑥ 机检：画幅/字节数/标题带 PSNR/人物位 PSNR/安全区/底图血缘 + 工位 `visualread.verify` 回执；
 *   ⑦ 烧封：把封面作为片头**烧进视频**（默认 1.6s，**封面段静音**），产出 `*-cover.mp4`。
 *      —— 2026-10-11 产品所有者反馈修复：旧实现让封面段复用成片前 1.6s 音轨，正片又从 0 起播，
 *      听感上 BGM"起两次"（封面一次、第一个镜头又一次）。封面段改静音后，BGM 只在正片开始处起播一次，
 *      剪辑点与 BGM 的对齐（cut-driven 混音）保持不变；封面仍是平台首帧展示图。
 *
 * 用法：
 *   pnpm edit:cover -- --input <交付目录/master/master-clean.mp4> --out-dir <交付目录>
 *     [--timeline <film.timeline.json>] [--variants warm-story,clean-tech,bold-promo]
 *     [--platform 微信视频号] [--title "回家是为了确认"] [--hook "十一回山东"]
 *     [--variant-copy <copy.json>]（逐版本主/副标题覆盖：{"warm-story":{"subline":"…"}}）
 *     [--hero-sec 35.5] [--account <账号档案>] [--burn-intro 1.6] [--renderer auto|compositor|ffmpeg] [--json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  COVER_FONTS, COVER_DIFF_PSNR_DB, validateCoverPlan, type CoverPlan,
} from "../../packages/video-studio/src/cover-design.js";
import { getCoverSpec } from "../../packages/video-studio/src/cover-platforms.js";
import { deriveCoverTheme, planCoverMoment, planCoverMoments, type PostAnalysisDoc, type EditTimeline } from "../../packages/video-studio/src/edit/index.js";
import { scanBestFrame } from "./lib/frame-scan.mts";
import { DANMAKU_PUBLISH_NOTE, PUBLISH_NOTE, recommendedDanmakuFile, recommendedPublishFile } from "./lib/delivery-forms.mts";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const KB_DIR = join(REPO_ROOT, "bundles/ai-video/library/cover-kb");
const FONT_DIR = join(REPO_ROOT, "bundles/ai-video/library/fonts");
const ACCOUNT_DIR = join(REPO_ROOT, "bundles/ai-video/library/account-profiles");
const BRIDGE_TOKEN_FILE = join(homedir(), "Library/Application Support/WorkLoomVisualBridge/token");
const BRIDGE_TENANT = process.env.WORKLOOM_VISUAL_BRIDGE_TENANT ?? "ws-geo";
// 工位的租户根目录 = work_dir/tenants/<tenant>（路径监狱按此判定；写错会得到 path_not_allowed）
const BRIDGE_VAR = join(homedir(), "Library/Application Support/WorkLoomVisualBridge/var", "tenants", BRIDGE_TENANT);

const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

/**
 * 封面文案机检（2026-10-11 升级，与 CRAFT-002 §10 / HOOK-001 §10 同口径）：
 * 主标题必须含数字/动作/可指认物之一、禁抽象文艺腔与虚词开头；副标题必须信息增量、禁"时间+地名"白开水。
 * 是启发式护栏（拦明显废稿），不是审美裁判；弱稿给出 reasons 与改写指引。
 */
function evaluateCoverCopy({ title, subline }: { title: string; subline?: string }): {
  ok: boolean;
  title: { visualLength: number; hasAnchor: boolean; abstractLead: boolean };
  subline: { present: boolean; visualLength: number; isBareTimePlace: boolean; repeatsTitle: boolean };
  reasons: string[];
} {
  const visualLength = (text: string): number => {
    let total = 0;
    for (const ch of text) {
      if (/[\u4e00-\u9fff]/u.test(ch)) total += 1;
      else if (/[0-9A-Za-z]/u.test(ch)) total += 0.5;
    }
    return total;
  };
  /** 强动作 = 具体物理动作（"回/来/走"这类泛位移不算锚点）；具体物 = 可指认的名词。 */
  const ACTION_STRONG = /(开车|摘|吃|喝|煮|炖|夹|抱|背|爬|赶|抢|收|捡|装|买|做|拍|尝|烤|涮|端|剁|擀|包|晒|种|浇)/u;
  const CONCRETE = /(羊汤|面|苹果园|果园|苹果|饺|馍|饼|汤|院|集市|老家|爸妈|院|锅|碗|树|山坡|车|路|店|旅|果园)/u;
  const ABSTRACT_MARKERS = /(为了|意义|答案|真相|确认|治愈|美好|震撼|圆满|仪式感|情绪价值|所谓|证明|寻找|诠释)/u;
  const ABSTRACT_LEAD = /^(为了|关于|其实|所谓|致|写|论|说|寻|问)/u;
  const BARE_TIME_PLACE = /^[一二三四五六七八九十0-9两]*[年月日]?[·、,\s]*(国庆|五一|春节|元旦|周末|假期|十一)?[·、,\s]*[去回到往在至]?[\u4e00-\u9fa5]{2,6}(省|市|县|镇|村|山|岛|湖|区)?$/u;
  const titleText = String(title ?? "").trim();
  const subText = String(subline ?? "").trim();
  const titleAnchored = /[0-9]/u.test(titleText) || ACTION_STRONG.test(titleText) || CONCRETE.test(titleText);
  const abstractLead = ABSTRACT_LEAD.test(titleText);
  const abstractMarker = ABSTRACT_MARKERS.test(titleText);
  const bare = subText.length > 0 && BARE_TIME_PLACE.test(subText) && !/[0-9]/u.test(subText) && !ACTION_STRONG.test(subText) && !CONCRETE.test(subText);
  const repeats = subText.length > 0 && (subText.includes(titleText) || titleText.includes(subText));
  const reasons: string[] = [];
  if (visualLength(titleText) > 12.5) reasons.push(`主标题 ${visualLength(titleText)} 视觉字 >12：砍字或改断行（CRAFT-002 §一）`);
  if (!titleAnchored) reasons.push("主标题缺具体锚点（数字/动作/可指认物）：抽象感受词不算钩子，反例「回家是为了确认」→ 改「开10小时车，就为这口羊汤」");
  if (abstractLead) reasons.push("主标题以虚词/文艺词开头（为了/关于/其实…）：一律重写");
  if (abstractMarker) reasons.push("主标题含抽象文艺词（为了/确认/意义/治愈…）：换成数字/动作/可指认物（CRAFT-002 §10.4）");
  if (subText) {
    if (visualLength(subText) > 24.5) reasons.push(`副标题 ${visualLength(subText)} 视觉字 >24：收敛到一句`);
    if (bare) reasons.push("副标题是「时间+地名」式白开水（反例「十一回山东」）：换成清单式/数字锚点式/情绪峰值式（CRAFT-002 §10.3）");
    if (repeats) reasons.push("副标题与主标题语义重复：副标题必须提供增量信息（或留空）");
  }
  return {
    ok: reasons.length === 0,
    title: { visualLength: visualLength(titleText), hasAnchor: titleAnchored, abstractLead },
    subline: { present: subText.length > 0, visualLength: visualLength(subText), isBareTimePlace: bare, repeatsTitle: repeats },
    reasons,
  };
}

function run(bin: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${bin} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").split("\n").slice(-4).join(" | ");
    throw new Error(`${bin} 失败（退出码 ${String(result.status)}）：${detail}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function probeMedia(file: string): { width: number; height: number; duration: number; fps: number } {
  const out = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-show_entries", "format=duration", "-of", "json", file]).stdout;
  const doc = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>; format?: { duration?: string } };
  return {
    width: Number(doc.streams?.[0]?.width ?? 0),
    height: Number(doc.streams?.[0]?.height ?? 0),
    duration: Number(doc.format?.duration ?? 0),
    fps: (() => { const [a, b] = (doc.streams?.[0]?.r_frame_rate ?? "0/1").split("/").map(Number); return b ? a / b : 0; })(),
  };
}

/** 流清单：封面差异化（逐变体取帧）与软字幕轨修复共用——探测容器里的音/视频与字幕流。 */
function probeStreams(file: string): Array<{ codec_type?: string; codec_name?: string }> {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file]).stdout;
  return (JSON.parse(out) as { streams?: Array<{ codec_type?: string; codec_name?: string }> }).streams ?? [];
}

/**
 * 是否带字幕流（软字幕轨形态）。
 *
 * 为什么需要单独探测（2026-10-12 客户实测事故）：封面烧封用 `-f concat -c copy` 拼
 * 「封面片头 + 正片」，而 concat 只保留**两段都存在的流**——软字幕轨形态的字幕流
 * 在片头里不存在，于是被整体丢掉，交付文件名叫「软字幕轨·封面烧封」却没有字幕轨。
 * 修复：concat 之后把源文件的字幕流以 `+burnIntro` 偏移重新封进成片，并复核确实挂上了。
 */
function hasSubtitleStream(file: string): boolean {
  return probeStreams(file).some((stream) => stream.codec_type === "subtitle");
}

/** 标题带 / 人物位 PSNR：合成图 vs 无字底图（差异越大 = 越可能真的画了东西） */
function bandPsnr(composed: string, base: string, box: { x: number; y: number; w: number; h: number }): number | null {
  const crop = `crop=${box.w}:${box.h}:${box.x}:${box.y}`;
  const out = run(FFMPEG, [
    "-hide_banner", "-i", composed, "-i", base,
    "-lavfi", `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]psnr`, "-f", "null", "-",
  ]).stderr;
  const matched = /average:([0-9.]+|inf)/u.exec(out);
  if (!matched) return null;
  return matched[1] === "inf" ? Number.POSITIVE_INFINITY : Number(matched[1]);
}

/**
 * 两张封面图的感知差异：缩到 64×36 灰度后求平均绝对差（MAD，0–255）。
 * 为什么需要：客户反馈"几个版本的封面都还是用的同一个封面"——而当时的机检只查"单张封面是否合格"，
 * 没有任何一项能发现"两张封面一模一样"。差异判定口径：
 *   identical（sha 相同）/ near-duplicate（MAD < 2）/ similar（MAD < 6，提示）/ distinct。
 */
function imageDivergence(a: string, b: string): { meanAbsDiff: number; verdict: "identical" | "near-duplicate" | "similar" | "distinct" } {
  if (sha256(a) === sha256(b)) return { meanAbsDiff: 0, verdict: "identical" };
  const result = spawnSync(FFMPEG, [
    "-v", "error", "-i", a, "-i", b,
    "-lavfi", "[0:v]scale=64:36,format=gray[a];[1:v]scale=64:36,format=gray[b];[a][b]blend=all_mode=difference",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) {
    return { meanAbsDiff: Number.NaN, verdict: "similar" };
  }
  let total = 0;
  for (const value of result.stdout) total += value;
  const meanAbsDiff = Number((total / result.stdout.length).toFixed(2));
  if (meanAbsDiff < 2) return { meanAbsDiff, verdict: "near-duplicate" };
  if (meanAbsDiff < 6) return { meanAbsDiff, verdict: "similar" };
  return { meanAbsDiff, verdict: "distinct" };
}

interface StyleSpec {
  id: string;
  fontId: keyof typeof COVER_FONTS;
  fontFamily: string;
  archetype: "person-led" | "subject-led";
  layout: CoverPlan["layout"];
  headlineSize: number;
  colors: { title: string; sub: string; badge: string; accent: string };
  accentBar: boolean;
  reason: string;
  /** 该版本的默认副标题（信息增量）；缺省用 --hook */
  subline?: string;
  /**
   * 双帧分段版式：**左右**两块主视觉（左暖右冷），中间冷暖分割线。
   * 为什么是左右而不是上下（2026-10-11 客户反馈"这个封面太奇怪了"）：
   * 16:9 画幅切上下两块后每块约 3.4:1，人像帧必然被裁掉头顶、标题被迫压在接缝上；
   * 左右分屏每块约 0.89:1（竖构图），人像与城楼都放得下，文字压底部渐变带即可。
   */
  split?: { leftSec: number; rightSec: number };
}

/**
 * 字体族名（CoreText 实测，2026-10-10）：随包字体已安装到 `~/Library/Fonts/`。
 * 注意 `SourceHanSansCN-Heavy.otf` 的**家族名是 "Source Han Sans CN"**（Heavy 是字重/全名的一部分），
 * 用 "Source Han Sans CN Heavy" 当族名会静默回退系统字体——这正是上一版封面字体没落地的原因。
 */
const FONT_FAMILY: Record<string, string> = {
  "smiley-sans": "Smiley Sans",
  "source-han-heavy": "Source Han Sans CN",
  "zcool-qingke": "ZCOOL QingKe HuangYou",
  "noto-serif": "Noto Serif SC",
};

const STYLES: Record<string, StyleSpec> = {
  "warm-story": {
    id: "warm-story", fontId: "zcool-qingke", fontFamily: FONT_FAMILY["zcool-qingke"]!,
    archetype: "person-led", layout: "person-left", headlineSize: 124,
    colors: { title: "#FFFFFF", sub: "#FFE7B3", badge: "#FFD166", accent: "#FFD166" },
    accentBar: true,
    reason: "暖心版：圆润字体 + 暖色题签，适合情感/生活/文旅题材（人物为主）",
  },
  "clean-tech": {
    id: "clean-tech", fontId: "source-han-heavy", fontFamily: FONT_FAMILY["source-han-heavy"]!,
    archetype: "subject-led", layout: "person-right", headlineSize: 112,
    colors: { title: "#FFFFFF", sub: "#CFE8FF", badge: "#7DD3FC", accent: "#7DD3FC" },
    accentBar: true,
    subline: "果园里第一颗红苹果",
    reason: "冷净版：最稳的重标题 + 冷色题签，强调画面质感，适合产品/科技/知识（物体为主）",
  },
  "bold-promo": {
    id: "bold-promo", fontId: "smiley-sans", fontFamily: FONT_FAMILY["smiley-sans"]!,
    archetype: "person-led", layout: "person-right", headlineSize: 128,
    colors: { title: "#FFFFFF", sub: "#FFE1E1", badge: "#FF4D4F", accent: "#FF4D4F" },
    accentBar: true,
    subline: "先吃热的 再摘苹果",
    reason: "高对比版：大字抓眼 + 强色题签，适合信息流首屏（带货/促销/强钩子）",
  },
  /**
   * 分段调色版（2026-10-11 修复）：必须与暖心版**设计不同**。
   * 旧实现的坑：STYLES 里没有这个 id → 回退到 warm-story 的同款版式与同帧 → 两张封面逐字节相同
   * （客户反馈"几个版本的封面都还是用的同一个封面"）。
   * 独立设计：**左右双帧**（左暖果园人物 / 右冷古城）+ 竖分割线 + 底部渐变压字 + 独立副标题，
   * 一眼看出"同一趟路，两种颜色"；左右分屏（各约 0.89:1）不会像上下分屏那样把人物头顶裁掉。
   */
  "segmented-story": {
    id: "segmented-story", fontId: "source-han-heavy", fontFamily: FONT_FAMILY["source-han-heavy"]!,
    /**
     * `layout` 只允许 person-left / person-right（设计稿契约）；双帧分段由图层实现（recipe 里上下两张主视觉），
     * 不靠 layout 表达——写成旧值会让 validateCoverPlan 直接判"版式不在可选范围"。
     */
    archetype: "subject-led", layout: "person-right", headlineSize: 118,
    colors: { title: "#FFFFFF", sub: "#FFE9C7", badge: "#FFFFFF", accent: "#FFD166" },
    accentBar: true,
    /** 左：果园人物（33.6s，人与苹果都在画面里）；右：古城城楼（44.5s，冷净）。 */
    split: { leftSec: 33.6, rightSec: 44.5 },
    subline: "果园是暖的 古城是冷的",
    reason: "分段调色版：左半暖果园（人物完整）+ 右半冷古城，竖分割线直接表达『同一趟路两种颜色』；文字压底部渐变带保证可读",
  },
};

interface BridgeClient { available: boolean; reason?: string; call: (name: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> }

async function connectBridge(url: string): Promise<BridgeClient> {
  let token = "";
  try {
    token = readFileSync(BRIDGE_TOKEN_FILE, "utf8").trim();
  } catch {
    return { available: false, reason: `工位令牌不可读：${BRIDGE_TOKEN_FILE}`, call: async () => { throw new Error("bridge unavailable"); } };
  }
  try {
    /**
     * 工位健康检查必须带超时（T-2026-1017 修复）：旧实现是裸 fetch，
     * 本机 9773 端口有进程监听但 /health 不回包时，edit:cover 会无限挂起
     * （实测 0% CPU 挂 30+ 分钟），既不走 ffmpeg 降级也不报错。
     */
    const health = await fetch(`${url.replace(/\/$/u, "")}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    if (!health.ok) return { available: false, reason: `工位健康检查失败 HTTP ${health.status}`, call: async () => { throw new Error("bridge unavailable"); } };
  } catch (err) {
    return { available: false, reason: `工位不可达：${err instanceof Error ? err.message : String(err)}`, call: async () => { throw new Error("bridge unavailable"); } };
  }
  const call = async (name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${url.replace(/\/$/u, "")}/action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // 视觉工位的请求体约定是 `{tool, params}`（不是 {name, params}——写错会得到 unknown tool None 并静默降级）
      body: JSON.stringify({ tool: name, params: { ...params, tenant_id: BRIDGE_TENANT, idempotency_key: `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } }),
      // 合成动作可能很慢，给 10 分钟硬上限，避免无限等待
      signal: AbortSignal.timeout(600_000),
    });
    const doc = await response.json() as Record<string, unknown>;
    if (!response.ok || doc.ok === false) throw new Error(`工位调用失败 ${name}：${JSON.stringify(doc).slice(0, 300)}`);
    return doc;
  };
  return { available: true, call };
}

async function main(): Promise<void> {
  const input = arg("--input");
  const outDirArg = arg("--out-dir");
  if (!input || !outDirArg) throw new Error("用法：pnpm edit:cover -- --input <master-clean.mp4> --out-dir <交付目录>");
  const master = abs(input);
  if (!existsSync(master)) throw new Error(`干净母版不存在：${master}`);
  const outDir = abs(outDirArg);
  const variants = arg("--variants", "warm-story,clean-tech,bold-promo").split(",").map((v) => v.trim()).filter(Boolean);
  if (!variants.length || new Set(variants).size !== variants.length || variants.some((id) => !/^[a-z0-9][a-z0-9-]*$/u.test(id))) {
    throw new Error("--variants 必须是互不重复的变体标识（小写字母、数字与连字符）");
  }
  const manifestFile = join(outDir, "delivery-manifest.json");
  const originalManifestHash = existsSync(manifestFile) ? sha256(manifestFile) : null;
  const projectFile = join(outDir, "film-project.json");
  const originalProjectBytes = existsSync(projectFile) ? readFileSync(projectFile) : null;
  const originalProjectHash = originalProjectBytes ? sha256(projectFile) : null;
  const masterHash = sha256(master);
  // Candidate files keep every previously accepted cover and intro intact until QC accepts the new manifest.
  const attemptId = randomUUID();
  const versionRoot = join(outDir, "work", "cover-versions", attemptId);
  mkdirSync(versionRoot, { recursive: true });
  const platformInput = arg("--platform", "微信视频号");
  const title = arg("--title", "");
  const hook = arg("--hook", "");
  const account = arg("--account");
  if (!title) throw new Error("--title 必填（封面主标题 ≤12 字）");
  const copyCheck = evaluateCoverCopy({ title, subline: hook || undefined });
  if (!copyCheck.ok) {
    console.warn(`⚠ 封面文案机检未过（启发式护栏，CRAFT-002 §10）：\n  - ${copyCheck.reasons.join("\n  - ")}`);
    if (flag("--strict-copy")) throw new Error("封面文案机检未过且指定了 --strict-copy：按 reasons 重写后再交付");
  }
  /** 可选：agent 候选表（`--copies <copy-deck.json>`）连同自检一起进设计稿，供复盘与 A/B。 */
  const copiesPath = arg("--copies");
  const copyDeck = copiesPath && existsSync(abs(copiesPath))
    ? JSON.parse(readFileSync(abs(copiesPath), "utf8")) as Record<string, unknown>
    : null;
  const rendererMode = arg("--renderer", "auto");
  const timelinePath = arg("--timeline");
  const declaredTimeline = timelinePath ? JSON.parse(readFileSync(abs(timelinePath), "utf8")) as EditTimeline : null;
  const burnIntro = Number(arg("--burn-intro", declaredTimeline?.pacing?.profile === "fast_cut" ? "0" : "1.6"));
  if (!Number.isFinite(burnIntro) || burnIntro < 0 || burnIntro > 5) throw new Error("--burn-intro 需要 0–5 秒");
  const bridgeUrl = arg("--bridge-url", process.env.WORKLOOM_VISUAL_BRIDGE_URL ?? "http://127.0.0.1:9773");

  // ① 画幅跟随成片（横版片→横版封面）
  const media = probeMedia(master);
  if (!(media.width > 0 && media.height > 0)) throw new Error("无法读取母版画幅");
  const landscape = media.width >= media.height;
  const spec = getCoverSpec(platformInput);
  const canvas = { width: media.width, height: media.height };
  const canvasNote = landscape
    ? `跟随成片横版画幅 ${canvas.width}×${canvas.height}；平台（${platformInput}）安全区按代码规格 ${spec.id} 的顶/底比例换算`
    : `跟随成片竖版画幅 ${canvas.width}×${canvas.height}；平台（${platformInput}）规格 ${spec.id}`;

  // ② 知识库 + ③ 账号视觉锤
  const kbModule = abs("bundles/ai-video/connectors/cover-kb-bridge/core.mjs");
  const { loadKb, recipe, enrichCoverHints, normalizeAccountProfile } = await import(`file://${kbModule}`) as {
    loadKb: (dir: string) => unknown;
    recipe: (kb: unknown, options: Record<string, unknown>) => Record<string, unknown>;
    enrichCoverHints: (kb: unknown, options: Record<string, unknown>) => Record<string, unknown>;
    normalizeAccountProfile: (raw: unknown) => Record<string, unknown> | null;
  };
  const kb = loadKb(KB_DIR);
  /**
   * 主题：显式 --theme 优先；否则从素材理解产物派生（内容驱动），
   * 替代旧默认值「旅行」（那是某一支演示片的主题，换片子就全错）。
   */
  const analyses: PostAnalysisDoc[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--analysis" && process.argv[index + 1]) {
      const file = abs(process.argv[index + 1]!);
      if (!existsSync(file)) throw new Error(`解析结果不存在：${file}`);
      analyses.push(JSON.parse(readFileSync(file, "utf8")) as PostAnalysisDoc);
    }
  }
  const themePlan = deriveCoverTheme({ analyses });
  const theme = arg("--theme", themePlan.theme);
  const accountProfile = (() => {
    if (!account) return null;
    const file = join(ACCOUNT_DIR, `${account}.yml`);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const pick = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(raw)?.[1]?.trim();
    return normalizeAccountProfile({
      account_id: account,
      display_name: pick("display_name") ?? account,
      account_type: pick("account_type") ?? null,
      visual_hammer: {
        fontId: /fontId:\s*([a-z0-9-]+)/u.exec(raw)?.[1] ?? null,
        palette: [...raw.matchAll(/"#([0-9A-Fa-f]{6})"/gu)].map((m) => `#${m[1]}`).slice(0, 2),
        archetype_bias: /archetype_bias:\s*([a-z-]+)/u.exec(raw)?.[1] ?? null,
        badge_series: /badge_series:\s*"([^"]+)"/u.exec(raw)?.[1] ?? null,
      },
    });
  })();
  const recipeDoc = recipe(kb, { platform: platformInput, theme, accountType: accountProfile?.account_type ?? null });
  const hints = enrichCoverHints(kb, { platform: platformInput, theme, accountProfile: accountProfile ?? undefined });

  // 镜头表（主视觉与人物卡镜头必须真实存在）
  interface ShotRow { shotId: string; scene?: string; duration?: number; sourceIn?: number; masterIn?: number }
  const shots: ShotRow[] = [];
  const timeline: EditTimeline = declaredTimeline ?? {
    schemaVersion: "workloom.edit-timeline/v2", timelineId: "cover-master", target: { durationSeconds: media.duration,
      aspectRatio: `${media.width}:${media.height}`, fps: media.fps, platform: platformInput },
    sources: [{ sourceId: "master", sha256: sha256(master), path: master, fps: media.fps, durationSeconds: media.duration }],
    segments: [{ seq: 1, segmentId: "hero", sourceId: "master", sourceIn: 0, sourceOut: media.duration, durationSeconds: media.duration }],
    audioDesign: { originalAudioPolicy: "keep" },
  };
  let filmDuration = media.duration;
  if (timelinePath) {
    let cursor = 0;
    for (const segment of timeline.segments) {
      shots.push({ shotId: segment.segmentId, scene: segment.groupId ?? undefined, duration: segment.durationSeconds, sourceIn: segment.sourceIn, masterIn: Number(cursor.toFixed(3)) });
      cursor += segment.durationSeconds;
    }
    filmDuration = Number(cursor.toFixed(3));
  } else {
    shots.push({ shotId: "hero", scene: "film", duration: filmDuration, sourceIn: 0, masterIn: 0 });
  }

  const bridge = rendererMode === "ffmpeg" ? { available: false, reason: "--renderer=ffmpeg（显式降级）", call: async () => { throw new Error("ffmpeg mode"); } } : await connectBridge(bridgeUrl);
  const workRoot = bridge.available ? join(BRIDGE_VAR, `edit-cover-${attemptId}`) : join(versionRoot, "renderer");
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(join(outDir, "covers"), { recursive: true });

  /**
   * 封面取帧决策（2026-10-11：去掉"演示片写死秒数"）：
   *   ① 显式 `--hero-sec`（人指定）最高优先；
   *   ② 有 `--timeline + --analysis` 时用关键帧候选（composition_best → emotion_peak，带安全/清晰门槛）；
   *   ③ 否则对干净母版做本地最佳帧扫描（清晰度×0.6 + 曝光×0.4）；
   *   ④ 扫描也不可用时回退 35% 比例，并在设计稿里如实标注。
   */
  const timelineJsonPath = arg("--timeline") ? abs(arg("--timeline")) : null;
  const keyframePlan = timelineJsonPath && analyses.length > 0
    ? planCoverMoment({
      timeline: JSON.parse(readFileSync(timelineJsonPath, "utf8")) as import("../../packages/video-studio/src/edit/index.js").EditTimeline,
      analyses,
      fallbackRatio: 0.35,
    })
    : null;
  const scannedFrame = keyframePlan && keyframePlan.basis !== "fallback"
    ? null
    : scanBestFrame({ file: master, workDir: join(versionRoot, "frame-scan"), ffmpeg: FFMPEG });

  /**
   * 逐变体封面时刻（2026-10-11 客户反馈"几个版本同一个封面"）：关键帧候选按"同一镜头只用一次"分配，
   * 候选不足时用分散兜底比例补齐；这样四个版本的主视觉天然不同帧（而不是共用同一个 heroSec）。
   */
  const baseRatio = keyframePlan && keyframePlan.basis !== "fallback"
    ? Number((keyframePlan.masterSeconds / Math.max(0.001, filmDuration)).toFixed(4))
    : scannedFrame
      ? scannedFrame.ratio
      : 0.35;
  const variantMoments = arg("--hero-sec")
    ? null
    : planCoverMoments({ timeline, analyses, count: variants.length, fallbackRatio: baseRatio });

  const covers: Array<Record<string, unknown>> = [];
  const checksAll: Array<Record<string, unknown>> = [];
  /**
   * 字号随画幅缩放（2026-10-11 修复）：STYLES 里的 124/112/128px 与副题 52px 是 **1080p 参考值**；
   * 4K 成片封面若不缩放，字会相对变小 4 倍——封面排版必须按 `canvas.height / 1080` 等比放大。
   *
   * 本机生产补丁（2026-10-11 晚）：基准改为**短边**。旧口径按高算，在竖屏 1080×1920 上等于放大 1.78×，
   * 标题直接溢出画布（实测"一条片子1-2块钱"被裁成"一条片子1-"）。这与仓内字幕/弹幕字号规则
   * （短边 × 基准比）也不一致——封面必须同一口径。
   */
  const fontScale = Math.min(canvas.width, canvas.height) / 1080;
  /** 逐版本文案覆盖（`--variant-copy`）：允许每个版本的封面有独立主/副标题（信息增量不重复）。 */
  const variantCopyPath = arg("--variant-copy");
  const variantCopy = variantCopyPath && existsSync(abs(variantCopyPath))
    ? JSON.parse(readFileSync(abs(variantCopyPath), "utf8")) as Record<string, { headline?: string; subline?: string }>
    : {};
  for (const [variantIndex, variantId] of variants.entries()) {
    const style = STYLES[variantId] ?? STYLES["warm-story"]!;
    const variantMoment = variantMoments?.[variantIndex] ?? null;
    const overrides = variantCopy[variantId] ?? {};
    const headline = String(overrides.headline ?? title);
    const subline = String(overrides.subline ?? style.subline ?? hook ?? "");
    const headlinePx = Math.round(style.headlineSize * fontScale);
    const sublinePx = Math.round(52 * fontScale);
    const explicitHero = arg("--hero-sec");
    if (explicitHero && (!Number.isFinite(Number(explicitHero)) || Number(explicitHero) < 0)) throw new Error("--hero-sec 需要非负秒数");
    /** 分段调色版式（左右分屏）只在没有显式 --hero-sec 时启用：显式指定时退回单帧主视觉。 */
    const split = style.split && !explicitHero ? style.split : null;
    const heroSec = explicitHero
      ? Number(explicitHero)
      : split
        ? split.leftSec
        : variantMoment
          ? variantMoment.masterSeconds
          : keyframePlan && keyframePlan.basis !== "fallback"
            ? keyframePlan.masterSeconds
            : scannedFrame
              ? scannedFrame.seconds
              : Number((filmDuration * 0.35).toFixed(3));
    const heroBasis = explicitHero
      ? "explicit（--hero-sec）"
      : keyframePlan && keyframePlan.basis !== "fallback"
        ? `keyframe（${keyframePlan.basis}${keyframePlan.keyframeId ? ` · ${keyframePlan.keyframeId}` : ""}）：${keyframePlan.note}`
        : scannedFrame
          ? `scan-best-frame：${scannedFrame.note}`
          : "fallback：35%（无关键帧候选且本地扫描不可用）";
    const heroShot = shots.find((shot) => (shot.masterIn ?? 0) <= heroSec && heroSec < (shot.masterIn ?? 0) + (shot.duration ?? 0)) ?? shots[0]!;
    const heroSourceSec = Number(((heroShot.sourceIn ?? 0) + Math.max(0, heroSec - (heroShot.masterIn ?? 0))).toFixed(3));

    const plan: CoverPlan = {
      headline,
      subline: subline || undefined,
      /** 角标只来自账号视觉锤档案：没有档案就不编造系列角标（旧默认值"十一 · 回山东"是演示片专属）。 */
      badge: (accountProfile?.visual_hammer as { badge_series?: string } | undefined)?.badge_series ?? "",
      layout: style.layout,
      background: { shotId: heroShot.shotId, atSec: heroSourceSec, treatment: "scrim" },
      person: style.archetype === "person-led" ? { enabled: true, shotId: heroShot.shotId, atSec: heroSourceSec, widthRatio: 0.42 } : { enabled: false, widthRatio: 0.42 },
      typography: {
        fontId: style.fontId,
        headlineSizeRatio: Number((headlinePx / canvas.height).toFixed(4)),
        sublineSizeRatio: Number((sublinePx / canvas.height).toFixed(4)),
        color: style.colors.title,
        accentColor: style.colors.accent,
        align: "left",
      },
      rationale: style.reason,
      source: "requested",
      archetype: style.archetype,
    } as CoverPlan;
    const validated = validateCoverPlan(plan, {
      shots, platform: platformInput, archetype: style.archetype,
      character: style.archetype === "person-led" ? { name: "片中人" } : null,
      kbHints: (Array.isArray((hints as { hints?: unknown }).hints) ? (hints as { hints: string[] }).hints : []).slice(0, 3),
    });

    // 主视觉取帧（干净母版）→ 交给工位做底图；分段版式取左右两帧（左暖右冷）
    const frame = join(workRoot, `${variantId}-hero.png`);
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(heroSec), "-i", master, "-frames:v", "1", frame]);
    const splitLeftFrame = split ? join(workRoot, `${variantId}-hero-left.png`) : null;
    const splitRightFrame = split ? join(workRoot, `${variantId}-hero-right.png`) : null;
    if (split) {
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(split.leftSec), "-i", master, "-frames:v", "1", splitLeftFrame!]);
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(split.rightSec), "-i", master, "-frames:v", "1", splitRightFrame!]);
    }

    const scrimLayers = Array.from({ length: 7 }, (_, i) => ({
      type: "solid", name: `scrim-${i}`, color: "#000000",
      x: 0, y: 0, width: canvas.width, height: Math.round(canvas.height * 0.09),
      opacity: Number((0.06 + i * 0.02).toFixed(3)),
    }));
    // 逐层下移的压暗带（Compositor 的 solid 用 y 定位）
    scrimLayers.forEach((layer, index) => { layer.y = Math.round(canvas.height * (0.42 + index * 0.085)); });
    const titleY = Math.round(canvas.height * (landscape ? 0.63 : 0.7));
    const badgeY = Math.round(canvas.height * 0.08);
    const subtitleY = titleY + Math.round(headlinePx * 1.25);
    const splitX = Math.round(canvas.width * 0.5);
    /**
     * 分段版式的底部渐变压暗带：标题压在下三分之一，逐层加深（0.10→0.46），
     * 保证"亮果园"和"暗城楼"两侧的文字都有对比（旧版只有固定的 7 条带，亮部那半读不清）。
     */
    const bottomBands = Array.from({ length: 6 }, (_, i) => ({
      type: "solid", name: `bottom-shade-${i}`, color: "#000000",
      x: 0, y: Math.round(canvas.height * (0.60 + i * 0.065)), width: canvas.width,
      height: Math.round(canvas.height * 0.065),
      opacity: Number((0.10 + i * 0.072).toFixed(3)),
    }));
    const recipeBody = {
      recipe_version: 1,
      name: `cover-${variantId}`,
      canvas: { width: canvas.width, height: canvas.height, resolution: 72 },
      layers: [
        ...(split
          ? [
            { type: "image", name: "hero-left", source: splitLeftFrame!, x: 0, y: 0, width: splitX, height: canvas.height, opacity: 1 },
            { type: "image", name: "hero-right", source: splitRightFrame!, x: splitX, y: 0, width: canvas.width - splitX, height: canvas.height, opacity: 1 },
            { type: "solid", name: "split-divider", color: "#FFFFFF", x: splitX - Math.round(canvas.width * 0.002), y: 0, width: Math.round(canvas.width * 0.004), height: canvas.height, opacity: 0.92 },
            ...bottomBands,
          ]
          : [{ type: "image", name: "hero", source: frame, x: 0, y: 0, width: canvas.width, height: canvas.height, opacity: 1 }]),
        ...scrimLayers,
        ...(style.accentBar ? [{ type: "solid", name: "accent-bar", color: style.colors.accent, x: Math.round(canvas.width * 0.08), y: titleY - Math.round(canvas.height * 0.08), width: Math.round(canvas.width * 0.1), height: Math.round(canvas.height * 0.012), opacity: 1 }] : []),
        ...(String(plan.badge ?? "")
          ? [{ type: "text", name: "badge", text: String(plan.badge ?? ""), font: style.fontFamily, size: Math.round(canvas.height * 0.038), weight: "bold", color: style.colors.badge, align: "right", x: Math.round(canvas.width * 0.62), y: badgeY, width: Math.round(canvas.width * 0.3) }]
          : []),
        { type: "text", name: "headline", text: headline, font: style.fontFamily, size: headlinePx, weight: "bold", color: style.colors.title, align: "left", x: Math.round(canvas.width * 0.08), y: titleY, width: Math.round(canvas.width * 0.84) },
        ...(plan.subline ? [{ type: "text", name: "subline", text: plan.subline, font: style.fontFamily, size: sublinePx, weight: "regular", color: style.colors.sub, align: "left", x: Math.round(canvas.width * 0.08), y: subtitleY, width: Math.round(canvas.width * 0.84) }] : []),
      ],
      exports: [{ format: "png", path: `cover-${variantId}.png` }],
    };

    const target = join(versionRoot, variantId, "cover.png");
    mkdirSync(dirname(target), { recursive: true });
    let renderer = "ffmpeg-fallback";
    let bridgeReceipt: Record<string, unknown> | null = null;
    if (bridge.available) {
      try {
        const composed = await bridge.call("visualwrite.compose", { recipe: recipeBody, out_dir: workRoot });
        const result = (composed.result ?? {}) as { outputs?: Array<{ path?: string }>; output?: string };
        const produced = result.outputs?.[0]?.path ?? result.output ?? join(workRoot, `cover-${variantId}.png`);
        if (!existsSync(produced)) throw new Error(`工位未产出封面：${produced}`);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(produced, target);
        renderer = "compositor-visual-bridge";
        bridgeReceipt = (composed.receipt as Record<string, unknown>) ?? null;
      } catch (err) {
        bridge.available = false;
        bridge.reason = `工位合成失败，降级本机 ffmpeg：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    let baseImage = frame;
    if (renderer === "ffmpeg-fallback") {
      // 降级路径：本机 ffmpeg 渲染（如实标注 renderer，不冒充工位产物）
      const fontFile = join(FONT_DIR, COVER_FONTS[style.fontId].file);
      baseImage = join(workRoot, `${variantId}-base.png`);
      /** 双帧分段版式：先把左右两帧横拼成一帧，再走同一套压暗/排版。 */
      let fallbackSource = frame;
      if (split) {
        const splitBase = join(workRoot, `${variantId}-split.png`);
        run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", splitLeftFrame!, "-i", splitRightFrame!,
          "-filter_complex",
          `[0:v]scale=${splitX}:${canvas.height}:force_original_aspect_ratio=increase,crop=${splitX}:${canvas.height}[left];`
          + `[1:v]scale=${canvas.width - splitX}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width - splitX}:${canvas.height}[right];`
          + "[left][right]hstack=inputs=2[out]",
          "-map", "[out]", "-frames:v", "1", "-update", "1", splitBase]);
        fallbackSource = splitBase;
      }
      const baseFilters = [
        `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase`, `crop=${canvas.width}:${canvas.height}`,
        "eq=contrast=1.04:saturation=1.06:brightness=0.01", "vignette=PI/5",
        ...scrimLayers.map((layer) => `drawbox=x=0:y=${layer.y}:w=${canvas.width}:h=${layer.height}:color=black@${layer.opacity}:t=fill`),
        ...(split ? bottomBands.map((layer) => `drawbox=x=0:y=${layer.y}:w=${canvas.width}:h=${layer.height}:color=black@${layer.opacity}:t=fill`) : []),
        ...(split ? [`drawbox=x=${splitX - Math.round(canvas.width * 0.002)}:y=0:w=${Math.round(canvas.width * 0.004)}:h=${canvas.height}:color=white@0.92:t=fill`] : []),
      ];
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", fallbackSource, "-vf", baseFilters.join(","), "-frames:v", "1", "-update", "1", baseImage]);
      const textFilters = [
        ...(style.accentBar ? [`drawbox=x=${Math.round(canvas.width * 0.08)}:y=${titleY - Math.round(canvas.height * 0.08)}:w=${Math.round(canvas.width * 0.1)}:h=${Math.round(canvas.height * 0.012)}:color=${style.colors.accent}@1:t=fill`] : []),
        ...(String(plan.badge ?? "")
          ? [`drawtext=fontfile='${fontFile}':text='${String(plan.badge ?? "").replace(/'/gu, "")}':fontcolor=${style.colors.badge}:fontsize=${Math.round(canvas.height * 0.038)}:borderw=4:bordercolor=black@0.5:x=w-text_w-${Math.round(canvas.width * 0.08)}:y=${badgeY}`]
          : []),
        `drawtext=fontfile='${fontFile}':text='${headline.replace(/'/gu, "")}':fontcolor=${style.colors.title}:fontsize=${headlinePx}:borderw=${Math.round(6 * fontScale)}:bordercolor=black@0.55:x=${Math.round(canvas.width * 0.08)}:y=${titleY}`,
        ...(plan.subline ? [`drawtext=fontfile='${fontFile}':text='${plan.subline.replace(/'/gu, "")}':fontcolor=${style.colors.sub}:fontsize=${sublinePx}:borderw=${Math.round(4 * fontScale)}:bordercolor=black@0.5:x=${Math.round(canvas.width * 0.08)}:y=${subtitleY}`] : []),
      ];
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", baseImage, "-vf", textFilters.join(","), "-frames:v", "1", "-update", "1", target]);
    }
    if (!existsSync(target)) throw new Error(`封面未产出：${target}`);

    const probed = probeMedia(target);
    const bytes = statSync(target).size;
    const titleBand = { x: 0, y: Math.max(0, titleY - Math.round(20 * fontScale)), w: canvas.width, h: Math.min(canvas.height - titleY, headlinePx + Math.round(90 * fontScale)) };
    const personBox = { x: 0, y: Math.round(canvas.height * 0.3), w: Math.round(canvas.width * 0.5), h: Math.round(canvas.height * 0.4) };
    const titlePsnr = bandPsnr(target, baseImage, titleBand);
    const personPsnr = plan.person?.enabled ? bandPsnr(target, baseImage, personBox) : null;
    const checks = [
      { id: "cover-produced", pass: probed.width === canvas.width && probed.height === canvas.height && bytes > 0, detail: `${probed.width}x${probed.height} · ${(bytes / 1024).toFixed(0)}KB（期望 ${canvas.width}x${canvas.height}）` },
      { id: "title-rendered", hard: false, pass: titlePsnr !== null && titlePsnr < COVER_DIFF_PSNR_DB, detail: `标题带 PSNR ${titlePsnr === null ? "未测" : `${titlePsnr.toFixed(2)}dB`}（启发式阈值 <${COVER_DIFF_PSNR_DB}；不认证文字可读性）` },
      { id: "person-rendered", hard: false, pass: !plan.person?.enabled || (personPsnr !== null && personPsnr < COVER_DIFF_PSNR_DB), detail: plan.person?.enabled ? `人物位 PSNR ${personPsnr === null ? "未测" : `${personPsnr.toFixed(2)}dB`}（启发式建议；不认证实体语义）` : "本版式不放人物层" },
      { id: "canvas-matches-film", pass: landscape ? probed.width >= probed.height : probed.height > probed.width, detail: `封面画幅与成片同向（成片 ${media.width}×${media.height}）` },
      { id: "base-lineage", pass: true, detail: `主视觉取自未烧字干净母版（sha256 ${sha256(master).slice(0, 12)}…，取帧 ${heroSec}s）` },
      { id: "bridge-receipt", pass: renderer === "compositor-visual-bridge" ? Boolean(bridgeReceipt) : true, detail: renderer === "compositor-visual-bridge" ? `工位回执 sha256 ${String((bridgeReceipt?.sha256 as string) ?? "").slice(0, 12)}…` : `降级渲染（${bridge.reason ?? "工位不可用"}）` },
    ];
    covers.push({
      variantId, renderer, canvas, platform: platformInput, specId: spec.id,
      heroShot: heroShot.shotId, heroSec, heroSourceSec, heroBasis,
      theme, themeBasis: themePlan.basis,
      scanCandidates: scannedFrame?.candidates ?? null,
      plan: validated, file: target, sha256: sha256(target), checks, recipe: recipeBody,
    });
    checksAll.push({ variantId, ok: checks.every((c) => c.hard === false || c.pass), checks });
  }

  /**
   * 变体间封面差异化机检（硬门）：任意两张封面 identical / near-duplicate 直接判不通过。
   * 这条检查就是为了防止"回退到同一套版式/同一帧"的回归（2026-10-11 客户反馈根因）。
   */
  const coverDivergence: Array<{ a: string; b: string; meanAbsDiff: number; verdict: string }> = [];
  for (let i = 0; i < covers.length; i += 1) {
    for (let j = i + 1; j < covers.length; j += 1) {
      const a = covers[i]!;
      const b = covers[j]!;
      const diff = imageDivergence(String(a.file), String(b.file));
      coverDivergence.push({ a: String(a.variantId), b: String(b.variantId), ...diff });
    }
  }
  const duplicatePairs = coverDivergence.filter((row) => row.verdict === "identical" || row.verdict === "near-duplicate");
  checksAll.push({
    variantId: "all",
    ok: duplicatePairs.length === 0,
    checks: [{
      id: "cover-distinct",
      pass: duplicatePairs.length === 0,
      detail: {
        basis: "变体封面两两 64×36 灰度平均绝对差（MAD）；identical/near-duplicate(<2) 判失败，similar(<6) 提示",
        pairs: coverDivergence,
        duplicates: duplicatePairs,
      },
    }],
  });

  // ⑦ 烧封：封面作为片头烧进每条变体（干净/软字幕/烧字三种形态）
  const introReceipts: Array<Record<string, unknown>> = [];
  const introSources: Array<{ path: string; sha256: string }> = [];
  if (burnIntro > 0) {
    for (const variantId of variants) {
      const cover = covers.find((entry) => entry.variantId === variantId)?.file as string | undefined;
      if (!cover) continue;
      /** 形态顺序：干净 → 软字幕轨 → 烧字 →（有弹幕层时）烧字+弹幕 → 仅弹幕。 */
      for (const form of ["", ".softsub", ".burned", ".burned.danmaku", ".danmaku"]) {
        const source = join(outDir, "variants", variantId, `${variantId}${form}.mp4`);
        if (!existsSync(source)) continue;
        const sourceHash = sha256(source);
        introSources.push({ path: source, sha256: sourceHash });
        const output = join(versionRoot, variantId, `${variantId}${form}.cover.mp4`);
        const intro = join(workRoot, `${variantId}${form}-intro.mp4`);
        /** 片头编码档跟成片分辨率对齐（T-2026-1017）：4K 用 medium/crf16，1080P 用 veryfast/crf18。 */
        const introEncoder = media.height >= 1600
          ? ["-c:v", "libx264", "-preset", "medium", "-crf", "16"]
          : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"];
        run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", cover,
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-filter_complex", `[0:v]scale=${media.width}:${media.height},fps=${arg("--fps", String(media.fps))},format=yuv420p[v];[1:a]atrim=0:${burnIntro},asetpts=PTS-STARTPTS[a]`,
          "-map", "[v]", "-map", "[a]", ...introEncoder, "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", String(burnIntro), "-movflags", "+faststart", intro]);
        // 用文本清单做 concat（/dev/stdin 在部分 ffmpeg 构建下不可用）
        const listFile = join(workRoot, `${variantId}${form}-list.txt`);
        writeFileSync(listFile, `file '${intro.replace(/'/gu, "'\\''")}'\nfile '${source.replace(/'/gu, "'\\''")}'\n`, "utf8");
        run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", output]);
        /**
         * 软字幕轨形态：concat 会丢掉片头里不存在的字幕流（2026-10-11/10-12 两次实测）——
         * 这里把源字幕流按 `+burnIntro` 整体后移后重新封装，并保持 default/chi 标记；
         * 之后**事实复核**：重挂后必须真的还有字幕流，否则硬失败（不靠"声明"当成"已修"）。
         */
        let subtitleTracks = 0;
        if (hasSubtitleStream(source)) {
          const fixed = join(workRoot, `${variantId}${form}-cover-fixed.mp4`);
          run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
            "-i", output,
            "-itsoffset", String(burnIntro), "-i", source,
            "-map", "0:v:0", "-map", "0:a:0", "-map", "1:s",
            "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
            "-metadata:s:s:0", "language=chi", "-disposition:s:0", "default",
            "-movflags", "+faststart", fixed]);
          renameSync(fixed, output);
          subtitleTracks = probeStreams(output).filter((stream) => stream.codec_type === "subtitle").length;
          const expectedTracks = probeStreams(source).filter((stream) => stream.codec_type === "subtitle").length;
          if (subtitleTracks !== expectedTracks) {
            throw new Error(`${variantId}${form} 在烧封片头后字幕轨数量不符（期望 ${expectedTracks}，实际 ${subtitleTracks}）`);
          }
        }
        if (sha256(source) !== sourceHash) throw new Error(`${variantId}${form} 烧封期间原成片发生变化`);
        introReceipts.push({ variantId, form: form || "clean", source: relative(outDir, source), sourceSha256: sourceHash,
          output, introSeconds: burnIntro, introAudio: "silent", subtitleTracks, sha256: sha256(output), duration: probeMedia(output).duration });
      }
    }
  }

  const planFile = join(versionRoot, "cover-plan.json");
  const reportFile = join(versionRoot, "cover-report.json");
  /**
   * 推荐发布件（2026-10-12 客户实测口径）：分享/上传首选「烧字 + 封面烧封」——
   * 字幕与封面都已烧录进画面，任何播放器/预览器直接可见；软字幕轨形态在多数预览器
   * 默认不显示字幕（AVFoundation 自动选择实测为「无」），只适合剪辑或平台字幕轨。
   */
  const publishRecommendations = variants
    .map((variantId) => {
      const produced = introReceipts.find((row) => row.variantId === variantId && row.form === ".burned");
      const file = burnIntro > 0 ? String(produced?.output ?? "") : join(outDir, recommendedPublishFile(variantId, false));
      return existsSync(file)
        ? {
          variantId,
          file: relative(outDir, file),
          forms: burnIntro > 0 ? "burned+cover" : "burned",
          note: PUBLISH_NOTE,
        }
        : null;
    })
    .filter((entry): entry is { variantId: string; file: string; forms: string; note: string } => entry !== null)
    .concat(variants.map((variantId) => {
      /** 弹幕版推荐件（`edit:post --danmaku` 产出的形态在这里再叠封面）。 */
      const produced = introReceipts.find((row) => row.variantId === variantId && row.form === ".burned.danmaku");
      const file = burnIntro > 0 ? String(produced?.output ?? "") : join(outDir, recommendedDanmakuFile(variantId, false));
      return existsSync(file)
        ? {
          variantId,
          file: relative(outDir, file),
          forms: burnIntro > 0 ? "burned+danmaku+cover" : "burned+danmaku",
          note: DANMAKU_PUBLISH_NOTE,
        }
        : null;
    }).filter((entry): entry is { variantId: string; file: string; forms: string; note: string } => entry !== null));
  writeFileSync(planFile, `${JSON.stringify({
    schema: "workloom.video-edit/cover-plan/v1",
    chain: "cover-designer（Compositor 视觉工位 → 设计稿 → 合成 → 机检 → 烧封）",
    platform: platformInput, specId: spec.id, canvas, canvasNote,
    renderer: { mode: rendererMode, used: covers[0]?.renderer ?? null, bridgeUrl, bridgeAvailable: bridge.available, note: bridge.reason ?? null },
    account: accountProfile ? { account_id: accountProfile.account_id, visual_hammer: accountProfile.visual_hammer } : null,
    theme: { value: theme, basis: themePlan.basis, keywords: themePlan.keywords, explicit: Boolean(arg("--theme")) },
    frameSource: keyframePlan && keyframePlan.basis !== "fallback"
      ? { kind: "keyframe", plan: keyframePlan }
      : scannedFrame
        ? { kind: "scan-best-frame", scan: scannedFrame }
        : { kind: "fallback-ratio", ratio: 0.35 },
    kb: { dir: KB_DIR, recipe: recipeDoc, hints },
    copyCheck,
    copyDeck,
    covers,
  }, null, 2)}\n`, "utf8");
  writeFileSync(reportFile, `${JSON.stringify({
    schema: "workloom.video-edit/cover-report/v1",
    ok: checksAll.every((entry) => entry.ok),
    covers: checksAll,
    coverDivergence,
    duplicatePairs,
    introBurned: introReceipts,
    publish: publishRecommendations,
    publishNote: PUBLISH_NOTE,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  /**
   * 本机生产补丁（2026-10-11 晚）：封面重出后同步交付清单。
   * 事故：post 先写 delivery-manifest.json（含它自己那版封面的 sha256），封面链路随后覆盖 cover.png 并烧封，
   * 清单里的封面指纹就与文件不一致——"清单说 A、文件是 B"。这里按实际产物回写 cover 字段，保证清单可核对。
   */
  if (existsSync(manifestFile)) {
    if (sha256(manifestFile) !== originalManifestHash) throw new Error("封面处理期间交付清单发生变化，请基于当前版本重试");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      variants?: Array<{ id?: string; cover?: Record<string, unknown> | null }>;
      [key: string]: unknown;
    };
    let updated = 0;
    for (const entry of manifest.variants ?? []) {
      const produced = covers.find((cover) => cover.variantId === entry.id);
      if (!produced) continue;
      const checks = checksAll.find((item) => item.variantId === entry.id)?.checks ?? [];
      entry.cover = {
        ...(entry.cover ?? {}),
        path: relative(outDir, String(produced.file)),
        sha256: sha256(String(produced.file)),
        text: `${title} / ${hook}`.trim(),
        title, hook,
        heroSec: arg("--hero-sec", "") ? Number(arg("--hero-sec")) : null,
        checks,
        renderer: produced.renderer,
        coverReport: relative(outDir, reportFile),
        updatedBy: "edit:cover（回写：封面在 post 之后重出）",
      };
      updated += 1;
    }
    if (updated > 0) {
      // The previous Chinese display set still exists on disk, but must be repackaged against this version.
      if (manifest.displaySet) {
        manifest.displaySetNeedsRefresh = { reason: "封面产物版本已更新", at: new Date().toISOString() };
        delete manifest.displaySet;
      }
      manifest.coverIntro = { forms: introReceipts.map((form) => ({ ...form, output: relative(outDir, String(form.output)) })) };
      manifest.coverDivergence = coverDivergence;
      manifest.coverSync = { updated, at: new Date().toISOString(), report: relative(outDir, reportFile) };
      if (publishRecommendations.length) {
        manifest.publish = {
          recommended: publishRecommendations,
          note: PUBLISH_NOTE,
          updatedBy: "edit:cover（推荐发布件＝烧字+封面烧封）",
        };
      }
      /**
       * 节奏复验回执必须覆盖"当前交付形态"（T-2026-1017 修复）。
       * edit:post 在 post 阶段写 `manifest.rhythmDirection`（回执只含 master + 变体三形态），
       * 封面在这里追加 `coverIntro.forms`（新的视频形态）；若不按当前 manifest 重算回执，
       * release 闸（quality-gate.mjs#chain:rhythm-direction）会报
       * "当前交付形态未被首尾节奏复验覆盖"——即"回执早于封面形态"的流程漏洞。
       * 这里用同一套 inspectRhythmOutputs 重新复验并回写 binding，不手写 passed。
       */
      if (declaredTimeline) {
        const { inspectRhythmOutputs } = await import("./lib/edit-rhythm-media.mts") as typeof import("./lib/edit-rhythm-media.mts");
        const reinspection = await inspectRhythmOutputs({ timeline: declaredTimeline, outDir, manifest, ffmpeg: FFMPEG, ffprobe: FFPROBE, subtitlePath: null, overwrite: true });
        if (!reinspection.report.passed) throw new Error("RHYTHM_OUTPUT_MISMATCH: " + reinspection.report.failures.join("；"));
        manifest.rhythmDirection = reinspection.binding;
      }
      const qa = await import("../../bundles/ai-video/connectors/post-bridge/quality-gate.mjs") as {
        inspectDeliveryManifest: (options: Record<string, unknown>) => Promise<{ passed: boolean }>;
        assertPostQuality: (report: unknown) => void;
        writePostQuality: (root: string, report: unknown) => Promise<Record<string, unknown>>;
      };
      const finalQuality = await qa.inspectDeliveryManifest({ root: outDir, manifest, phase: "cover",
        bins: { ffmpeg: FFMPEG, ffprobe: FFPROBE }, extraChecks: [{ kind: "cover-distinct", hard: true, ok: duplicatePairs.length === 0 }] });
      manifest.postQuality = await qa.writePostQuality(outDir, finalQuality);
      qa.assertPostQuality(finalQuality);
      if (sha256(master) !== masterHash || introSources.some((source) => sha256(source.path) !== source.sha256)) {
        throw new Error("封面验收后原片或原成片摘要发生变化");
      }
      if (sha256(manifestFile) !== originalManifestHash) throw new Error("封面验收期间交付清单发生变化，请基于当前版本重试");
      if (originalProjectHash && sha256(projectFile) !== originalProjectHash) throw new Error("封面处理期间工程版本发生变化，请基于当前版本重试");
      const pending = `${manifestFile}.${attemptId}.pending`;
      const projectPending = `${projectFile}.${attemptId}.pending`;
      let projectPublished = false;
      let publishedProjectHash: string | null = null;
      try {
        writeFileSync(pending, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        if (originalProjectBytes) {
          const project = JSON.parse(originalProjectBytes.toString("utf8")) as {
            layers?: { variants?: Array<{ id: string; artifacts?: Record<string, unknown>; style?: Record<string, unknown> }> };
            [key: string]: unknown;
          };
          for (const variant of project.layers?.variants ?? []) {
            const cover = manifest.variants?.find((entry) => entry.id === variant.id)?.cover;
            if (!cover) continue;
            variant.artifacts = { ...variant.artifacts, cover };
            variant.style = { ...variant.style, cover: { ...(variant.style?.cover as Record<string, unknown> ?? {}), title, hook } };
          }
          project.coverSync = manifest.coverSync;
          project.postQuality = manifest.postQuality;
          writeFileSync(projectPending, `${JSON.stringify(project, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
          if (sha256(projectFile) !== originalProjectHash) throw new Error("发布封面前工程版本发生变化");
          publishedProjectHash = sha256(projectPending);
          renameSync(projectPending, projectFile);
          projectPublished = true;
        }
        renameSync(pending, manifestFile);
      } catch (error) {
        if (projectPublished && originalProjectBytes) {
          if (sha256(projectFile) !== publishedProjectHash) throw new Error("封面发布失败且工程已被并发更新；保留当前工程，拒绝回滚覆盖新版本", { cause: error });
          writeFileSync(projectPending, originalProjectBytes, { flag: "wx" });
          renameSync(projectPending, projectFile);
        }
        throw error;
      } finally { rmSync(pending, { force: true }); rmSync(projectPending, { force: true }); }
      console.log(`  清单同步：delivery-manifest.json 回写 ${updated} 条封面指纹`);
    }
  }

  const ok = checksAll.every((entry) => entry.ok) && introReceipts.every((entry) => Number(entry.duration) > burnIntro);
  const summary = {
    ok,
    covers: covers.map((entry) => ({ variantId: entry.variantId, renderer: entry.renderer, file: entry.file, heroSec: entry.heroSec })),
    coverDivergence,
    introBurned: introReceipts.map((entry) => entry.output),
    publish: publishRecommendations,
    planFile,
    reportFile,
  };
  if (flag("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`✓ 封面链路完成：${covers.length} 张（画幅 ${canvas.width}×${canvas.height} / 渲染 ${covers[0]?.renderer ?? "?"}）`);
    for (const entry of covers) console.log(`  ${(checksAll.find((c) => c.variantId === entry.variantId)?.ok) ? "✓" : "✗"} ${entry.variantId} → ${entry.file}`);
    for (const row of coverDivergence) console.log(`  差异 ${row.a} ↔ ${row.b}：MAD ${row.meanAbsDiff}（${row.verdict}）`);
    if (duplicatePairs.length) console.warn(`⚠ 有 ${duplicatePairs.length} 对封面重复：${duplicatePairs.map((row) => `${row.a}↔${row.b}`).join("、")}`);
    if (introReceipts.length) console.log(`  烧封片头：${introReceipts.length} 个文件（每条变体 +${burnIntro}s）`);
    if (publishRecommendations.length) {
      console.log("  推荐发布件（字幕+封面已烧录，任何播放器直接可见）：");
      for (const entry of publishRecommendations) console.log(`    - ${entry.variantId} → ${entry.file}`);
    }
    console.log(`  设计稿：${planFile}｜机检：${reportFile}`);
  }
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(`✗ edit-cover 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
