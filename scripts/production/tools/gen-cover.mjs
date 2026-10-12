#!/usr/bin/env node
/**
 * gen-cover —— 竖屏"炸裂"封面生成器：一张成片帧 + 超大数字标题 → 1080×1920 或 2×（2160×3840）PNG。
 *
 * 设计口径（来自产品反馈"封面不够炸裂，影响点击率"）：
 *   · 一个视觉锤：**超大数字**占屏宽 ~60%，红黄撞色 + 黑描边；
 *   · 一个对比钩子：黄色黑边贴条（如「一杯奶茶 = 十条片」）；
 *   · 一行身份背书：底部黑带（如「十几年拍剪功力 → AI 数字员工」）；
 *   · 人脸不被压：文字集中在下半部，底图取开口说话的帧，深色渐变让文字跳出来。
 *
 * 注意：多变体交付请保持**每个变体封面不同**（仓库 `edit:cover` 自带逐变体取帧 + 两两 MAD 机检）；
 * 本工具用于"定制主封面"，生成后交给 `edit:cover --variant-copy` / `--cover-at` 复用。
 *
 * 用法：
 *   node gen-cover.mjs --frame <成片截图.png> --out <封面.png> [--scale 2]
 *     [--title "1–2" --unit "元/条" --compare "一杯奶茶 = 十条片" --kicker "AI 剪片实测" --footer "十几年拍剪功力 → AI 数字员工"]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const frame = resolve(arg("--frame"));
const out = resolve(arg("--out"));
const chrome = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
if (!frame || !arg("--frame") || !existsSync(frame)) throw new Error(`底图不存在：${frame || "(未提供 --frame)"}`);
if (!existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}（可用 --chrome 指定）`);
const scale = Math.max(1, Number(arg("--scale", "1")) || 1);

const title = arg("--title", "1–2");
const unit = arg("--unit", "元/条");
const compare = arg("--compare", "一杯奶茶 = 十条片");
const kicker = arg("--kicker", "AI 剪片实测");
const footer = arg("--footer", "十几年拍剪功力 → AI 数字员工");
const frameUrl = `file://${frame}`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1080px; height:1920px; overflow:hidden; }
  body { font-family:'Source Han Sans CN','PingFang SC','Hiragino Sans GB',sans-serif; }
  .stage { position:relative; width:1080px; height:1920px; background:#0b1220; }
  .bg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; filter:saturate(1.06) contrast(1.04); }
  .scrim-top { position:absolute; inset:0 0 auto 0; height:38%; background:linear-gradient(180deg, rgba(6,10,20,.55), rgba(6,10,20,0)); }
  .scrim-bottom { position:absolute; inset:auto 0 0 0; height:70%; background:linear-gradient(0deg, rgba(5,8,16,.96) 30%, rgba(5,8,16,.82) 52%, rgba(5,8,16,0) 100%); }
  .kicker { position:absolute; top:64px; left:64px; background:#FF2D2D; color:#fff; font-size:44px; font-weight:800;
            padding:16px 30px; border-radius:999px; letter-spacing:.04em; box-shadow:0 10px 30px rgba(255,45,45,.45); transform:rotate(-2deg); }
  .block { position:absolute; left:64px; right:64px; bottom:330px; }
  .lead { color:#fff; font-size:68px; font-weight:800; letter-spacing:.02em; text-shadow:0 6px 22px rgba(0,0,0,.85); }
  .price { display:flex; align-items:flex-end; gap:18px; margin-top:4px; }
  .num { font-size:258px; font-weight:900; line-height:.86; color:#FFE14D; letter-spacing:-.03em;
         -webkit-text-stroke:13px #101010; paint-order:stroke fill; text-shadow:0 18px 40px rgba(0,0,0,.6); }
  .unit { font-size:78px; font-weight:900; color:#fff; -webkit-text-stroke:9px #101010; paint-order:stroke fill; padding-bottom:38px; }
  .compare { display:inline-block; margin-top:18px; background:#FFE14D; color:#141414; font-size:56px; font-weight:900;
             padding:18px 34px; border-radius:18px; border:8px solid #101010; box-shadow:0 14px 34px rgba(0,0,0,.5); transform:rotate(-1.2deg); }
  .footer { position:absolute; left:0; right:0; bottom:0; background:#0A0A0A; color:#fff; font-size:50px; font-weight:700;
            padding:38px 64px; letter-spacing:.01em; border-top:10px solid #FFE14D; }
  .footer b { color:#FFE14D; }
  .swipe { position:absolute; left:56px; right:56px; bottom:300px; height:26px; background:#FF2D2D; border-radius:999px; opacity:.92; }
</style></head>
<body>
  <div class="stage">
    <img class="bg" src="${frameUrl}" />
    <div class="scrim-top"></div>
    <div class="scrim-bottom"></div>
    <div class="kicker">${kicker}</div>
    <div class="block">
      <div class="lead">一条片子</div>
      <div class="price"><span class="num">${title}</span><span class="unit">${unit}</span></div>
      <div class="compare">${compare}</div>
    </div>
    <div class="swipe"></div>
    <div class="footer">${footer.replace(/→/gu, "<b>→</b>")}</div>
  </div>
</body></html>`;

const tmpHtml = resolve(dirname(out), ".cover-src.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(tmpHtml, html, "utf8");
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${scale}`,
  "--window-size=1080,1920", `--screenshot=${out}`, "--virtual-time-budget=2000",
  "--run-all-compositor-stages-before-draw", `file://${tmpHtml}`,
], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
const bytes = statSync(out).size;
if (bytes < 20_000) throw new Error(`封面渲染异常（${bytes}B）`);
/** PNG IHDR：宽高在固定偏移（8 字节签名 + 4 字节长度 + "IHDR"） */
const png = readFileSync(out);
const outWidth = png.readUInt32BE(16);
const outHeight = png.readUInt32BE(20);
if (outWidth !== 1080 * scale || outHeight !== 1920 * scale) {
  throw new Error(`封面尺寸异常：期望 ${1080 * scale}×${1920 * scale}（scale=${scale}），实得 ${outWidth}×${outHeight}`);
}
const receipt = {
  schemaVersion: "workloom.video-edit/cover-design-receipt/v1",
  design: { kicker, title, unit, compare, footer },
  scale,
  frame: { path: frame, sha256: createHash("sha256").update(readFileSync(frame)).digest("hex") },
  output: { path: out, bytes, width: outWidth, height: outHeight, sha256: createHash("sha256").update(png).digest("hex") },
  renderer: "headless-chrome",
  generatedAt: new Date().toISOString(),
};
writeFileSync(resolve(dirname(out), "cover-design-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, out, width: outWidth, height: outHeight, sha256: receipt.output.sha256 }, null, 1));
