/**
 * tag.mjs —— 本地曲库打标（"把手上一批音乐变成可检索的曲库"）。
 *
 * 干什么：对给定目录里的音频逐首**实测**（时长/响度/真峰值/削波/拍速/结构/人声频段/
 * 频谱重心/静音占比/循环友好度）→ 硬过滤（不达标的如实剔除并记录原因）→ 多维标签
 * （风格族/题材/情绪/能量/BPM 档/配器/使用场景/循环友好度）→ 写 `tracks.json`
 * （与随仓精选曲库**同一契约** `workloom.bgm-library/v1`，运行时加载器零改动）+ 证据 sidecar。
 *
 * 三条纪律（与配乐工位既有口径一致）：
 * 1. **许可必须先声明**：本模块只记录 `license` / `licenseNote` / `licenseSource`，是否可商用由
 *    调用方（`core.mjs` 的 `bgmwrite.tag` + 围栏 G-BGM8）用许可白名单判定；未声明一律拒绝落库。
 * 2. **不许猜**：拍速拿不到稳定周期就 `bpm=null, confidence=low`；人声频段活动≠有人声，
 *    一律标注为"代理指标"；每个标签维度都带置信度，低置信如实标 low。
 * 3. **可复核**：每首曲目的原始量测都写进 `tag-evidence.json`，索引里的每个数字都能回溯到实测。
 *
 * 另外提供**精选（curation）**能力：从打标结果里按"质量分 + 风格多样性"挑 N 首，
 * 并用结构证据（段落/包络）自动定位每首的"最合适那一段"，转码进随仓曲库（见文件末尾）。
 *
 * 依赖：ffmpeg/ffprobe（工位自带引脚 `kit/ffmpeg-pin.json`，可用 env 覆盖二进制路径）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifySegments, decodePcm, detectVoiceBandSegments, energyEnvelope, estimateBpmFromOnsets,
  measureLoudness, onsetStrength, probeMedia, resolveBinaries, runBin, segmentSpectralStats,
} from "./measure.mjs";

export const TAG_SCHEMA = "workloom.bgm-tag/v1";
export const LIBRARY_SCHEMA = "workloom.bgm-library/v1";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif",
]);

/**
 * 风格族（与 `synth.mjs` 的 12 个风格包同名）——外部曲与自算曲用同一套名字，
 * 这样"在线/本地/自算"三级兜底之间可以互相替代，选段与混音参数也不用另立口径。
 */
export const STYLE_FAMILIES = {
  "modern-pop": { label: "现代流行（鼓组+副旋律）", bpm: [95, 125], energy: [0.55, 0.85], dynamics: [6, 15] },
  "electronic-pulse": { label: "电子脉冲（合成器+律动）", bpm: [118, 145], energy: [0.6, 0.95], dynamics: [4, 13] },
  "lo-fi-chill": { label: "Lo-Fi 松弛（暖底噪+轻鼓）", bpm: [68, 96], energy: [0.28, 0.55], dynamics: [3, 10] },
  "cinematic-build": { label: "电影推进（情绪爬升+编制加厚）", bpm: [58, 112], energy: [0.4, 0.92], dynamics: [10, 26] },
  "ambient-calm": { label: "氛围静谧（长音铺底）", bpm: [48, 82], energy: [0.08, 0.35], dynamics: [1, 8] },
  "corporate-clean": { label: "企业干净（明亮克制）", bpm: [92, 126], energy: [0.42, 0.72], dynamics: [4, 11] },
  "acoustic-warm": { label: "原声温暖（木吉他/钢琴）", bpm: [68, 112], energy: [0.32, 0.66], dynamics: [5, 13] },
  "tension-dark": { label: "张力暗色（低音压迫+悬念）", bpm: [58, 104], energy: [0.28, 0.72], dynamics: [6, 19] },
  "sports-hype": { label: "运动燃点（强节奏+冲击）", bpm: [120, 168], energy: [0.72, 1.0], dynamics: [6, 17] },
  "festive-bright": { label: "节日明亮（欢快上扬）", bpm: [102, 142], energy: [0.52, 0.9], dynamics: [5, 13] },
  "documentary-bed": { label: "纪实铺底（不抢话）", bpm: [56, 102], energy: [0.12, 0.42], dynamics: [1, 8] },
  "city-night": { label: "都市夜色（霓虹律动）", bpm: [76, 118], energy: [0.34, 0.72], dynamics: [5, 13] },
};

/** 使用场景（每个风格族的默认落点，可被提示词/题材覆盖）。 */
const STYLE_USE_CASES = {
  "modern-pop": ["产品广告", "品牌短片", "口播垫底"],
  "electronic-pulse": ["卡点剪辑", "科技产品", "游戏集锦"],
  "lo-fi-chill": ["生活方式", "咖啡馆", "学习陪伴"],
  "cinematic-build": ["预告片", "纪录片高潮", "品牌史诗"],
  "ambient-calm": ["冥想疗愈", "空镜", "睡眠白噪音"],
  "corporate-clean": ["企业宣传", "招商路演", "年会开场"],
  "acoustic-warm": ["旅拍", "家庭记录", "手作过程"],
  "tension-dark": ["悬疑剧情", "危机复盘", "安全警示"],
  "sports-hype": ["运动集锦", "燃点卡点", "开业热场"],
  "festive-bright": ["节日祝福", "促销活动", "欢乐合集"],
  "documentary-bed": ["纪录片", "教程讲解", "访谈垫底"],
  "city-night": ["城市夜景", "夜生活", "都市 Vlog"],
};

/**
 * 目录名提示：客户/素材包常见的中文分类目录 → 风格族先验。
 * 只是**先验**：最终风格由"目录先验 + 实测特征"共同裁决，冲突时以实测为准并把理由写进证据。
 */
export const FOLDER_HINTS = [
  { match: /冥想|治愈|睡眠/, style: "ambient-calm", genre: "冥想 / 疗愈", mood: "安静舒缓" },
  { match: /激情|战斗|动感|激进/, style: "sports-hype", genre: "运动 / 高燃", mood: "激昂有力" },
  { match: /电子游戏|游戏/, style: "electronic-pulse", genre: "游戏 / 电子", mood: "律动兴奋" },
  { match: /轻松愉快|欢快轻松|轻松/, style: "festive-bright", genre: "轻快 / 欢跃", mood: "明快愉悦" },
  { match: /趣味古怪|有趣幽默|幽默/, style: "festive-bright", genre: "趣味 / 幽默", mood: "俏皮诙谐" },
  { match: /企业|宣传/, style: "corporate-clean", genre: "企业 / 宣传", mood: "干净可信" },
  { match: /卡点|节奏/, style: "electronic-pulse", genre: "卡点 / 律动", mood: "节奏感强" },
  { match: /史诗|震撼/, style: "cinematic-build", genre: "史诗 / 震撼", mood: "宏大推进" },
  { match: /励志|明朗/, style: "modern-pop", genre: "励志 / 明朗", mood: "积极向上" },
  { match: /Vlog|旅拍|旅行/, style: "acoustic-warm", genre: "旅拍 / 生活", mood: "温暖自在" },
  { match: /悲伤|负面|忧伤/, style: "tension-dark", genre: "剧情 / 情绪低谷", mood: "忧伤压抑" },
  { match: /自然|特效|环境/, style: "documentary-bed", genre: "自然 / 环境", mood: "开阔纪实" },
  { match: /安静|舒缓/, style: "lo-fi-chill", genre: "安静 / 舒缓", mood: "松弛平和" },
];

/**
 * 硬过滤默认值：不达标的不进库，但**必须**在报告里说明为什么被剔除。
 *
 * 关于削波：`maxFlatFactor` 才是"真·削波"的证据（波形被削平）；
 * MP3（尤其 320kbps 的现代母带）真峰值到 +1 dBTP 属于编码交调过冲，正常现象——
 * 这类曲目**不剔除**，只标 `hot`（峰值贴顶，进混音按目标响度降增益即可）。
 */
export const DEFAULT_FILTERS = {
  minDurationSec: 30,
  maxDurationSec: 900,
  minIntegratedLufs: -30,
  maxFlatFactor: 0.02,
  maxTruePeakDbtp: 2.0,
  hotTruePeakDbtp: -0.5,
  maxSilenceRatio: 0.6,
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const inRange = (value, [min, max]) => Number.isFinite(value) && value >= min && value <= max;

/** 归一化到 [0,1]：value 落在 [min,max] 之外会被夹紧（用于把实测折算成分数）。 */
const norm = (value, min, max) => (Number.isFinite(value) ? clamp01((value - min) / (max - min)) : 0);

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 解析 ffmpeg astats 的 Overall 段（削波风险的关键证据：Peak level / Flat factor）。 */
export function parseAstatsOverall(stderr) {
  const lines = String(stderr ?? "").split("\n");
  let inOverall = false;
  let peakDb = null;
  let flatFactor = null;
  let peakCount = null;
  for (const line of lines) {
    if (/\]\s*Overall\s*$/.test(line)) { inOverall = true; continue; }
    if (!inOverall) continue;
    const peak = /Peak level dB:\s*(-?\d+(?:\.\d+)?|-?inf)/.exec(line);
    if (peak && peakDb === null) peakDb = peak[1].includes("inf") ? Number.NEGATIVE_INFINITY : Number(peak[1]);
    const flat = /Flat factor:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (flat && flatFactor === null) flatFactor = Number(flat[1]);
    const count = /Peak count:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (count && peakCount === null) peakCount = Number(count[1]);
  }
  return { peakDb, flatFactor, peakCount };
}

/**
 * 削波风险判定：
 * - `clipped`（硬拒）：astats 平坦因子超标（波形削平）或真峰值离谱地高（>+2 dBTP）；
 * - `hot`（只标注）：真峰值贴顶（>-0.5 dBTP 但未越硬上限）——混音时降增益即可，不影响可用性。
 */
export function clipRiskOf({ truePeakDbtp, flatFactor, peakDb }, filters = DEFAULT_FILTERS) {
  const reasons = [];
  if (Number.isFinite(flatFactor) && flatFactor > filters.maxFlatFactor) {
    reasons.push(`astats 平坦因子 ${round(flatFactor, 4)} 超过 ${filters.maxFlatFactor}（波形被削平）`);
  }
  if (Number.isFinite(truePeakDbtp) && truePeakDbtp > filters.maxTruePeakDbtp) {
    reasons.push(`真峰值 ${round(truePeakDbtp)} dBTP 超过硬上限 ${filters.maxTruePeakDbtp}（异常素材）`);
  }
  const flags = [];
  if (!reasons.length && Number.isFinite(truePeakDbtp) && truePeakDbtp > filters.hotTruePeakDbtp) {
    flags.push(`峰值贴顶（真峰值 ${round(truePeakDbtp)} dBTP，采样峰值 ${round(peakDb)} dB）：进混音前按目标响度降增益，非缺陷`);
  }
  return { clipped: reasons.length > 0, reasons, flags };
}

/**
 * 由实测特征折算 0..1 的能量分。
 *
 * 刻意**以起音密度为主、整体响度为辅**：素材包里的曲目普遍是现代母带（-9 ~ -16 LUFS），
 * 响度本身几乎没有区分度；真正决定"这曲子燃不燃"的是节奏密度（起音/s）。
 * 该分数是**绝对刻度**；包内相对高低另由 `energyBucket`（三分位）给出。
 */
export function energyScoreOf({ integratedLufs, onsetRatePerSec }) {
  const densityPart = norm(onsetRatePerSec, 0.5, 8);
  const loudnessPart = norm(integratedLufs, -26, -8);
  return round(clamp01(densityPart * 0.65 + loudnessPart * 0.35), 2);
}

/**
 * 拍速八度折叠：自相关估出的 BPM 常见 2 倍/0.5 倍歧义（240 = 120 的双拍）。
 * 折叠到 [55,165] 这个"人耳拍速"区间后再入索引；原始值留在证据里，不做隐瞒。
 */
export function canonicalBpm(bpm, { min = 55, max = 165 } = {}) {
  if (!Number.isFinite(bpm) || bpm <= 0) return { bpm: null, raw: null, foldFactor: null };
  let value = bpm;
  let factor = 1;
  while (value > max && factor < 8) { value /= 2; factor *= 2; }
  while (value < min && factor > 1 / 8) { value *= 2; factor /= 2; }
  return {
    bpm: Math.round(value * 10) / 10,
    raw: Math.round(bpm * 10) / 10,
    foldFactor: factor === 1 ? null : Math.round(factor * 1000) / 1000,
  };
}

/** BPM 档（只在拍速可信时给档位；拿不到就给 null，不硬编）。 */
export function bpmBucketOf(bpm, confidence) {
  if (!Number.isFinite(bpm) || confidence === "low") return null;
  if (bpm < 80) return "slow";
  if (bpm < 110) return "mid";
  if (bpm < 135) return "up";
  return "fast";
}

/** 频谱重心/平坦度 → 配器倾向（启发式，标签里如实标注 heuristic）。 */
export function instrumentationOf({ centroidHz, flatness, onsetRatePerSec }) {
  const tags = [];
  if (Number.isFinite(centroidHz)) {
    if (centroidHz < 900) tags.push("低频厚（bass-heavy）");
    else if (centroidHz < 2200) tags.push("中频暖（warm-mid）");
    else tags.push("高频亮（bright）");
  }
  if (Number.isFinite(flatness) && flatness > 0.35) tags.push("噪声质感（noise-texture）");
  if (Number.isFinite(onsetRatePerSec) && onsetRatePerSec >= 3) tags.push("打击感强（percussive）");
  if (Number.isFinite(onsetRatePerSec) && onsetRatePerSec < 0.6) tags.push("无鼓/铺底（beatless）");
  return tags;
}

/**
 * 风格族裁决：目录先验给加分，实测特征（BPM/能量/动态）做主判。
 * 返回带置信度的候选排名（低置信不会被藏起来——它会进索引并触发人审复核）。
 */
export function classifyStyle({ bpm, tempoConfidence, energyScore, dynamicsDb, folderHint = null }) {
  const scored = Object.entries(STYLE_FAMILIES).map(([style, profile]) => {
    let score = 0;
    const reasons = [];
    if (Number.isFinite(bpm) && tempoConfidence !== "low") {
      const hit = inRange(bpm, profile.bpm);
      score += hit ? 26 : Math.max(0, 18 - Math.min(18, Math.abs(bpm - (profile.bpm[0] + profile.bpm[1]) / 2) / 3));
      reasons.push(hit ? `BPM ${bpm} 落在 ${profile.bpm[0]}-${profile.bpm[1]}` : `BPM ${bpm} 偏离 ${profile.bpm[0]}-${profile.bpm[1]}`);
    } else {
      score += 6;
      reasons.push("拍速不可信：只用能量/动态判断");
    }
    const energyHit = inRange(energyScore, profile.energy);
    score += energyHit ? 24 : Math.max(0, 16 - Math.abs(energyScore - (profile.energy[0] + profile.energy[1]) / 2) * 40);
    reasons.push(energyHit ? `能量 ${energyScore} 落在 ${profile.energy[0]}-${profile.energy[1]}` : `能量 ${energyScore} 偏离 ${profile.energy[0]}-${profile.energy[1]}`);
    const dynHit = inRange(dynamicsDb, profile.dynamics);
    score += dynHit ? 16 : Math.max(0, 10 - Math.abs(dynamicsDb - (profile.dynamics[0] + profile.dynamics[1]) / 2) * 1.5);
    reasons.push(dynHit ? `动态 ${round(dynamicsDb)} dB 落在 ${profile.dynamics[0]}-${profile.dynamics[1]}` : `动态 ${round(dynamicsDb)} dB 偏离 ${profile.dynamics[0]}-${profile.dynamics[1]}`);
    if (folderHint?.style === style) { score += 45; reasons.push(`目录先验命中「${folderHint.match}」`); }
    return { style, score: round(score, 2), reasons };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const margin = best.score - (second?.score ?? 0);
  const hintAgrees = Boolean(folderHint?.style && folderHint.style === best.style);
  /**
   * 目录先验是素材包**人工分类**的结果，权重高于特征推断：
   * 特征要推翻它，必须领先第二名 12 分以上，否则保留目录风格并降一档置信度（冲突写进候选里，可复核）。
   */
  if (folderHint?.style && !hintAgrees && margin < 12) {
    const hinted = scored.find((entry) => entry.style === folderHint.style);
    if (hinted) {
      return {
        style: hinted.style,
        styleLabel: STYLE_FAMILIES[hinted.style].label,
        confidence: "medium",
        margin: round(margin, 2),
        candidates: scored.slice(0, 3),
        conflict: `特征更倾向 ${best.style}（领先 ${round(margin, 2)} 分，未达推翻先验所需的 12 分）→ 保留目录风格 ${hinted.style}`,
      };
    }
  }
  const tempoOk = Number.isFinite(bpm) && tempoConfidence !== "low";
  /**
   * 置信度看**证据强度**，不是只看"有没有目录先验"：
   * - high：先验与特征一致且拍速可信，或特征领先幅度 ≥14 分且拍速可信；
   * - medium：领先 ≥10 分，或先验小胜（≥4 分），或拍速可信且领先 ≥5 分；
   * - low：其余（拿不准就如实标 low，进人审队列）。
   */
  const confidence = (hintAgrees && tempoOk) || (margin >= 14 && tempoOk)
    ? "high"
    : margin >= 7 || (hintAgrees && margin >= 4) || (tempoOk && margin >= 5)
      ? "medium"
      : "low";
  return { style: best.style, styleLabel: STYLE_FAMILIES[best.style].label, confidence, margin: round(margin, 2), candidates: scored.slice(0, 3) };
}

/** 循环友好度：首尾能量接近 + 尾部无长静音（拼短视频循环时不会"啪"一下）。 */
export function loopFriendlyOf({ envelopeDb, trailingSilenceSec = 0 }) {
  if (!Array.isArray(envelopeDb) || envelopeDb.length < 16) {
    return { loopFriendly: null, startEndDeltaDb: null, reason: "包络太短，无法判断首尾一致性" };
  }
  const head = envelopeDb.slice(0, Math.max(4, Math.round(envelopeDb.length * 0.05)));
  const tail = envelopeDb.slice(-Math.max(4, Math.round(envelopeDb.length * 0.05)));
  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const delta = Math.abs(avg(head) - avg(tail));
  const loopFriendly = delta <= 3 && trailingSilenceSec <= 1.5;
  return {
    loopFriendly,
    startEndDeltaDb: round(delta, 2),
    reason: loopFriendly ? `首尾能量差 ${round(delta, 2)} dB、尾部静音 ${round(trailingSilenceSec, 2)}s → 可循环` : `首尾能量差 ${round(delta, 2)} dB、尾部静音 ${round(trailingSilenceSec, 2)}s → 循环需交叉淡化`,
  };
}

/** 单曲硬过滤：不达标就剔除，并给出可复核的原因（绝不静默丢）。 */
export function applyHardFilters(measurement, filters = DEFAULT_FILTERS) {
  const rejections = [];
  const { durationSec, loudness, silenceRatio, clip } = measurement;
  if (Number.isFinite(durationSec) && durationSec < filters.minDurationSec) {
    rejections.push(`时长 ${round(durationSec, 1)}s 短于下限 ${filters.minDurationSec}s`);
  }
  if (Number.isFinite(durationSec) && durationSec > filters.maxDurationSec) {
    rejections.push(`时长 ${round(durationSec, 1)}s 超过上限 ${filters.maxDurationSec}s`);
  }
  if (Number.isFinite(loudness?.integratedLufs) && loudness.integratedLufs < filters.minIntegratedLufs) {
    rejections.push(`整体响度 ${round(loudness.integratedLufs)} LUFS 低于 ${filters.minIntegratedLufs}（近乎无声/素材异常）`);
  }
  if (clip?.clipped) rejections.push(...clip.reasons.map((reason) => `削波（硬拒）：${reason}`));
  if (Number.isFinite(silenceRatio) && silenceRatio > filters.maxSilenceRatio) {
    rejections.push(`静音占比 ${round(silenceRatio * 100, 1)}% 超过 ${round(filters.maxSilenceRatio * 100, 1)}%`);
  }
  return { keep: rejections.length === 0, rejections };
}

/** 目录遍历：只收音频扩展名，跳过隐藏文件与 .DS_Store。 */
export function listAudioFiles(root, { recursive = true } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      // 符号链接按"指向文件"处理：素材包常见的软链不必先复制一份再打标
      if (entry.isSymbolicLink()) {
        try {
          if (!fs.statSync(full).isFile()) continue;
        } catch {
          continue; // 悬空软链：跳过（不计入扫描数）
        }
      } else if (!entry.isFile()) {
        continue;
      }
      if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 逐首实测。任何一步失败都如实抛出（由调用方决定记入 report 还是中断），不吞异常。
 */
export async function measureTrack({
  input, bins = resolveBinaries(), maxSeconds = 180, spectralWindowSec = 30,
}) {
  const probe = await probeMedia(input, { bins });
  const durationFull = probe.duration;
  const analyzedSec = Math.min(durationFull, maxSeconds);

  const [loudness, pcm] = await Promise.all([
    measureLoudness(input, { bins, maxSeconds }),
    decodePcm({ input, maxSeconds, bins }),
  ]);

  const { pcm: samples, sampleRate } = pcm;
  const envelope = energyEnvelope({ pcm: samples, sampleRate, windowSec: 0.25 });
  const onsets = onsetStrength(envelope.db);
  const tempo = estimateBpmFromOnsets(onsets, { windowSec: 0.25 });
  const structure = classifySegments({ envelope, onsets, minSegmentSec: 3 });
  const onsetRatePerSec = round(onsets.reduce((sum, value) => sum + value, 0) / Math.max(1, envelope.durationSec), 3);

  const astatsArgs = ["-hide_banner", "-nostats", "-v", "info"];
  if (analyzedSec > 0) astatsArgs.push("-t", String(analyzedSec));
  astatsArgs.push("-i", input, "-vn", "-sn", "-dn", "-map", "0:a:0", "-af", "astats=metadata=1:reset=0", "-f", "null", "-");
  const astats = parseAstatsOverall((await runBin(bins.ffmpeg, astatsArgs, { label: "ffmpeg(astats)", timeoutMs: 600_000 })).stderr);

  const spectral = await segmentSpectralStats({
    input,
    start: Math.max(0, Math.min(durationFull - spectralWindowSec, durationFull * 0.35)),
    duration: Math.min(spectralWindowSec, durationFull),
    bins,
  });

  const voice = await detectVoiceBandSegments({ input, duration: analyzedSec, bins });
  const silenceInfo = silenceStatsOf(envelope.db);
  const clip = clipRiskOf({ truePeakDbtp: loudness.truePeakDbtp, flatFactor: astats.flatFactor, peakDb: astats.peakDb });
  const energyScore = energyScoreOf({ integratedLufs: loudness.integratedLufs, onsetRatePerSec });
  const dynamicsDb = round((envelope.quantiles.p90 ?? 0) - (envelope.quantiles.p10 ?? 0), 2);

  return {
    input,
    bytes: probe.sizeBytes ?? (fs.existsSync(input) ? fs.statSync(input).size : null),
    sha256: sha256File(input),
    format: {
      codec: probe.audio?.codec ?? null,
      container: probe.formatName ?? null,
      bitrateKbps: probe.audio?.bitRate ? Math.round(probe.audio.bitRate / 1000) : null,
      sampleRate: probe.audio?.sampleRate ?? null,
      channels: probe.audio?.channels ?? null,
    },
    durationSec: round(durationFull, 3),
    analyzedSec: round(analyzedSec, 3),
    loudness,
    peak: astats,
    clip,
    envelope: {
      windows: envelope.windows,
      avgDb: envelope.avgDb,
      peakDb: envelope.peakDb,
      quantiles: envelope.quantiles,
      dynamicsDb,
      // 索引/证据只留抽稀后的包络轮廓（60 点）：够判断首尾一致性与能量走向，又不会让索引爆体积
      outlineDb: downsample(envelope.db, 60),
    },
    tempo,
    structure: {
      method: structure.method,
      dynamicsDb: round(structure.dynamicsDb, 2),
      segments: structure.segments,
      hasDrop: structure.segments.some((segment) => segment.type === "drop"),
    },
    voice: {
      activeRatio: round(voice.activeRatio ?? 0, 3),
      method: voice.method ?? "人声频段（200-4kHz）活动代理指标",
    },
    silence: silenceInfo,
    spectral,
    onsetRatePerSec,
    energyScore,
    analyzedNote: durationFull > maxSeconds
      ? `只分析前 ${maxSeconds}s（共 ${round(durationFull, 1)}s）：长曲的响度/结构与整曲一致时用前段代表，避免逐曲全解码`
      : "整曲分析",
  };
}

/** 把长数组等距抽稀到 target 点（用于把包络轮廓写进索引/证据）。 */
export function downsample(list, target = 60) {
  const values = Array.isArray(list) ? list : [];
  if (values.length <= target) return values.map((value) => round(value, 2));
  const step = values.length / target;
  const out = [];
  for (let index = 0; index < target; index += 1) out.push(round(values[Math.min(values.length - 1, Math.floor(index * step))], 2));
  return out;
}

/** 静音统计：首尾静音 + 静音窗口占比（用于剔除"半首是空的"素材）。 */
export function silenceStatsOf(envelopeDb, floorDb = -55) {
  const windows = Array.isArray(envelopeDb) ? envelopeDb : [];
  if (!windows.length) return { leadingSec: 0, trailingSec: 0, ratio: 0, windowSec: 0.25 };
  const windowSec = 0.25;
  let leading = 0;
  while (leading < windows.length && windows[leading] <= floorDb) leading += 1;
  let trailing = 0;
  while (trailing < windows.length && windows[windows.length - 1 - trailing] <= floorDb) trailing += 1;
  const quiet = windows.filter((value) => value <= floorDb).length;
  return {
    leadingSec: round(leading * windowSec, 2),
    trailingSec: round(trailing * windowSec, 2),
    ratio: round(quiet / windows.length, 3),
    windowSec,
  };
}

/** 目录先验匹配（路径里出现关键词即命中；多个命中取最靠前的一条）。 */
export function folderHintFor(relativePath) {
  const text = String(relativePath ?? "");
  for (const hint of FOLDER_HINTS) {
    if (hint.match.test(text)) return { ...hint, match: text.split(path.sep).slice(0, -1).join("/") || text };
  }
  return null;
}

/** 由文件名推标题/作者（素材包常见 `作者-标题.mp3`）。 */
export function titleArtistFromFile(file) {
  const base = path.basename(file, path.extname(file)).replace(/[_]+/g, " ").trim();
  const parts = base.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(" - ") };
  return { artist: null, title: base };
}

/**
 * 读内嵌元数据（ID3/MP4 tags）：作者、标题、专辑、版权、注释、年份。
 *
 * 为什么值得单独读一遍：素材包的**文件名常常是简写**（`Roa-Tiny Love.mp3`），
 * 而 ID3 里往往有更完整的 title/artist/album，甚至版权与来源线索——
 * 这对"许可可追溯"和"署名"都有价值，所以不能只靠文件名。
 *
 * 解析失败一律返回空对象（不抛）：元数据缺失不该让整首曲子打不了标。
 */
export async function readMediaTags(input, { bins = resolveBinaries() } = {}) {
  try {
    const { stdout } = await runBin(bins.ffprobe, [
      "-v", "error",
      "-show_entries", "format_tags",
      "-of", "json",
      input,
    ], { label: "ffprobe(tags)", timeoutMs: 60_000 });
    const parsed = JSON.parse(stdout.toString("utf8"));
    const raw = parsed?.format?.tags ?? {};
    const pick = (...names) => {
      for (const name of names) {
        for (const [key, value] of Object.entries(raw)) {
          if (key.toLowerCase() === name && String(value ?? "").trim()) return String(value).trim();
        }
      }
      return null;
    };
    return {
      title: pick("title"),
      artist: pick("artist", "album_artist", "albumartist"),
      album: pick("album"),
      comment: pick("comment", "description"),
      copyright: pick("copyright", "license", "rights"),
      date: pick("date", "year"),
      raw,
    };
  } catch {
    return { title: null, artist: null, album: null, comment: null, copyright: null, date: null, raw: {} };
  }
}

/**
 * 标题/作者归属：**内嵌元数据优先于文件名**（文件名常常是简写），
 * 两者都缺时如实留空（由 `buildIndexEntry` 填 `(未标注作者)`），不编造。
 */
export function titleArtistOf({ tags = null, relativePath }) {
  const fromFile = titleArtistFromFile(relativePath);
  return {
    title: tags?.title ?? fromFile.title ?? null,
    artist: tags?.artist ?? fromFile.artist ?? null,
    titleSource: tags?.title ? "embedded-tag" : "file-name",
    artistSource: tags?.artist ? "embedded-tag" : fromFile.artist ? "file-name" : "missing",
    album: tags?.album ?? null,
    copyright: tags?.copyright ?? null,
    date: tags?.date ?? null,
  };
}

/**
 * 分类：把实测 + 目录先验折算成多维标签（每个维度都带置信度）。
 */
export function classifyTrack({ measurement, relativePath, mediaTags = null }) {
  const hint = folderHintFor(relativePath);
  const tempo = canonicalBpm(measurement.tempo?.bpm ?? null);
  const style = classifyStyle({
    bpm: tempo.bpm,
    tempoConfidence: measurement.tempo?.confidence ?? "low",
    energyScore: measurement.energyScore,
    dynamicsDb: measurement.envelope?.dynamicsDb ?? 0,
    folderHint: hint,
  });
  const loop = loopFriendlyOf({
    envelopeDb: measurement.envelope?.outlineDb ?? null,
    trailingSilenceSec: measurement.silence?.trailingSec ?? 0,
  });
  const identity = titleArtistOf({ tags: mediaTags, relativePath: relativePath ?? measurement.input });
  return {
    style: style.style,
    styleLabel: style.styleLabel,
    styleConfidence: style.confidence,
    styleCandidates: style.candidates,
    styleConflict: style.conflict ?? null,
    genre: hint?.genre ?? STYLE_FAMILIES[style.style].label,
    mood: hint?.mood ?? null,
    useCases: STYLE_USE_CASES[style.style] ?? [],
    bpm: tempo.bpm,
    bpmRaw: tempo.raw,
    bpmFoldFactor: tempo.foldFactor,
    bpmBucket: bpmBucketOf(tempo.bpm, measurement.tempo?.confidence ?? "low"),
    instrumentation: instrumentationOf({
      centroidHz: measurement.spectral?.centroidHz ?? null,
      flatness: measurement.spectral?.flatness ?? null,
      onsetRatePerSec: measurement.onsetRatePerSec,
    }),
    loop: {
      ...loop,
      startEndDeltaDb: measurement.envelope?.startEndDeltaDb ?? null,
    },
    vocalPresence: {
      value: (measurement.voice?.activeRatio ?? 0) >= 0.35 ? "有持续中频活动（可能是主奏/人声）" : "无明显中频主奏",
      confidence: "low",
      note: "人声频段活动是**代理指标**：弦乐/主音吉他同样落在这个频段，如需确认请人耳复核",
    },
    hint: hint ? { match: hint.match, style: hint.style, genre: hint.genre, mood: hint.mood } : null,
    title: identity.title,
    artist: identity.artist,
    album: identity.album,
    titleSource: identity.titleSource,
    artistSource: identity.artistSource,
    sourceCopyright: identity.copyright,
    sourceDate: identity.date,
  };
}

/** 组装与运行时契约一致的索引条目（字段名与随仓精选曲库完全相同）。 */
export function buildIndexEntry({ measurement, tags, root, relativePath, license, licenseNote, licenseSource, index, energyBucket = null }) {
  const id = `${tags.style}-${path.basename(relativePath, path.extname(relativePath)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "track"}-${index}`;
  return {
    id,
    title: tags.title || id,
    artist: tags.artist ?? "(未标注作者)",
    ...(tags.album ? { album: tags.album } : {}),
    titleSource: tags.titleSource ?? null,
    artistSource: tags.artistSource ?? null,
    ...(tags.sourceCopyright ? { sourceCopyright: tags.sourceCopyright } : {}),
    ...(tags.sourceDate ? { sourceDate: tags.sourceDate } : {}),
    genre: tags.genre,
    mood: tags.mood,
    style: tags.style,
    styleLabel: tags.styleLabel,
    tags: [...new Set([
      tags.style, tags.styleLabel, tags.genre, tags.mood, tags.bpmBucket,
      energyBucket ? `能量-${energyBucket}` : null,
      ...(tags.useCases ?? []), ...(tags.instrumentation ?? []),
      ...(tags.loop?.loopFriendly ? ["循环友好"] : []),
    ].filter(Boolean))],
    useCases: tags.useCases ?? [],
    instrumentation: tags.instrumentation ?? [],
    bpm: tags.bpm ?? null,
    bpmRaw: tags.bpmRaw ?? null,
    bpmFoldFactor: tags.bpmFoldFactor ?? null,
    bpmConfidence: measurement.tempo?.confidence ?? "low",
    bpmBucket: tags.bpmBucket,
    energyBucket,
    durationSec: measurement.durationSec,
    license,
    licenseNote,
    ...(licenseSource ? { licenseSource } : {}),
    file: relativePath.split(path.sep).join("/"),
    sourcePath: measurement.input,
    sha256: measurement.sha256,
    bytes: measurement.bytes,
    format: `${measurement.format?.codec ?? "unknown"}/${(measurement.format?.container ?? "").replace(/^\./, "") || "unknown"}`,
    loudness: measurement.loudness,
    peak: { samplePeakDb: measurement.peak?.peakDb ?? null, flatFactor: measurement.peak?.flatFactor ?? null },
    qualityFlags: measurement.clip?.flags ?? [],
    energyScore: measurement.energyScore,
    dynamicsDb: measurement.envelope?.dynamicsDb ?? null,
    structure: {
      method: measurement.structure?.method ?? null,
      hasDrop: measurement.structure?.hasDrop ?? null,
      segments: measurement.structure?.segments ?? [],
    },
    voiceBandActivity: measurement.voice?.activeRatio ?? null,
    vocalPresence: tags.vocalPresence,
    loop: tags.loop,
    spectral: { centroidHz: measurement.spectral?.centroidHz ?? null, flatness: measurement.spectral?.flatness ?? null },
    confidence: {
      style: tags.styleConfidence,
      bpm: measurement.tempo?.confidence ?? "low",
      note: tags.styleConfidence === "low" ? "风格判定低置信：建议人耳复核后再用于客户交付" : "风格判定 ≥ medium",
    },
    curatedFrom: path.relative(root, measurement.input).split(path.sep).join("/"),
  };
}

/** 并发跑任务（简单就够：固定并发度 + 出错如实抛）。 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 对整个目录打标：量测 → 分类 → 硬过滤 → 索引 + 证据 + 报告。
 *
 * 返回结构里 `rejected` 保留被剔除的曲目与原因（这是"如实"的一部分：
 * 客户看到 1200 首里有 12 首被剔除，能知道为什么，而不是数字对不上）。
 */
export async function tagLibrary({
  root,
  license,
  licenseNote = null,
  licenseSource = null,
  recursive = true,
  maxSeconds = 180,
  spectralWindowSec = 30,
  concurrency = 4,
  filters = DEFAULT_FILTERS,
  bins = resolveBinaries(),
  env = process.env,
  onProgress = null,
}) {
  const files = listAudioFiles(root, { recursive });
  let done = 0;
  const measured = await runPool(files, concurrency, async (file) => {
    const relativePath = path.relative(root, file);
    try {
      const measurement = await measureTrack({ input: file, bins, maxSeconds, spectralWindowSec, env });
      done += 1;
      onProgress?.({ file: relativePath, index: done, total: files.length });
      return { file, relativePath, measurement };
    } catch (error) {
      done += 1;
      onProgress?.({ file: relativePath, index: done, total: files.length, failed: true });
      return { file, relativePath, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const tracks = [];
  const rejected = [];
  const errors = [];
  const evidence = [];
  const seenHashes = new Map();
  let index = 0;
  for (const item of measured) {
    if (item.error) {
      errors.push({ file: item.relativePath, error: item.error });
      continue;
    }
    const { measurement, relativePath } = item;
    const mediaTags = await readMediaTags(measurement.input, { bins });
    const duplicateOf = seenHashes.get(measurement.sha256);
    const verdict = duplicateOf
      ? { keep: false, rejections: [`内容与 ${duplicateOf} 完全相同（sha256 去重）`] }
      : applyHardFilters(measurement, filters);
    if (!verdict.keep) {
      rejected.push({
        file: relativePath, sha256: measurement.sha256, durationSec: measurement.durationSec,
        integratedLufs: measurement.loudness?.integratedLufs ?? null, reasons: verdict.rejections,
      });
      continue;
    }
    seenHashes.set(measurement.sha256, relativePath);
    index += 1;
    const tags = classifyTrack({ measurement, relativePath, mediaTags });
    tracks.push(buildIndexEntry({ measurement, tags, root, relativePath, license, licenseNote, licenseSource, index }));
    evidence.push({
      id: tracks[tracks.length - 1].id,
      file: relativePath,
      sha256: measurement.sha256,
      sourceTags: {
        title: mediaTags.title, artist: mediaTags.artist, album: mediaTags.album,
        copyright: mediaTags.copyright, date: mediaTags.date, comment: mediaTags.comment,
      },
      durationSec: measurement.durationSec,
      analyzedSec: measurement.analyzedSec,
      analyzedNote: measurement.analyzedNote,
      loudness: measurement.loudness,
      peak: measurement.peak,
      clip: measurement.clip,
      envelope: measurement.envelope,
      tempo: {
        ...measurement.tempo,
        canonicalBpm: tags.bpm,
        bpmRaw: tags.bpmRaw,
        foldFactor: tags.bpmFoldFactor,
        canonNote: tags.bpmFoldFactor ? `自相关原始值 ${tags.bpmRaw} BPM 存在八度歧义，已折叠 ×${tags.bpmFoldFactor} 到 ${tags.bpm}` : "未做八度折叠",
      },
      structure: measurement.structure,
      voice: measurement.voice,
      silence: measurement.silence,
      spectral: measurement.spectral,
      onsetRatePerSec: measurement.onsetRatePerSec,
      energyScore: measurement.energyScore,
      tags: {
        style: tags.style, styleConfidence: tags.styleConfidence, styleCandidates: tags.styleCandidates,
        genre: tags.genre, mood: tags.mood, useCases: tags.useCases,
        bpmBucket: tags.bpmBucket, instrumentation: tags.instrumentation, loop: tags.loop,
        vocalPresence: tags.vocalPresence, hint: tags.hint,
      },
    });
  }
  /**
   * 包内相对能量分档：素材包里的响度差异远小于听感差异，
   * 因此除了绝对 `energyScore`，再按本批素材的三分位给 `energyBucket`（low/mid/high）——
   * 这是"相对这批货"的口径，写进 tags 里方便检索，也便于选曲时保证能量分布均匀。
   */
  const sortedEnergy = tracks.map((track) => track.energyScore).sort((a, b) => a - b);
  const tertile = (q) => sortedEnergy[Math.min(sortedEnergy.length - 1, Math.max(0, Math.round((sortedEnergy.length - 1) * q)))] ?? null;
  const lowCut = tertile(1 / 3);
  const highCut = tertile(2 / 3);
  for (const track of tracks) {
    const bucket = track.energyScore <= lowCut ? "low" : track.energyScore >= highCut ? "high" : "mid";
    track.energyBucket = bucket;
    if (bucket) track.tags = [...new Set([...(track.tags ?? []), `能量-${bucket}`])];
  }
  const byStyle = {};
  const byEnergyBucket = { low: 0, mid: 0, high: 0 };
  for (const track of tracks) {
    byStyle[track.style] = (byStyle[track.style] ?? 0) + 1;
    if (track.energyBucket) byEnergyBucket[track.energyBucket] += 1;
  }
  return {
    schemaVersion: TAG_SCHEMA,
    root,
    license,
    licenseNote,
    licenseSource,
    filters,
    generatedAt: new Date().toISOString(),
    counts: {
      scanned: files.length, tagged: tracks.length, rejected: rejected.length, failed: errors.length,
      byStyle, byEnergyBucket,
      lowStyleConfidence: tracks.filter((track) => track.confidence?.style === "low").length,
      energyRange: [sortedEnergy[0] ?? null, sortedEnergy[sortedEnergy.length - 1] ?? null],
      energyTertiles: [lowCut, highCut],
    },
    tracks,
    rejected,
    errors,
    evidence,
  };
}

/**
 * 把打标结果写成曲库目录：tracks.json（运行时契约）+ tag-evidence.json + tag-report.json。
 *
 * `fileMode`：
 * - `absolute`（默认）：`file` 记绝对路径——**就地打标不搬文件**，客户把素材包放在哪就指哪；
 * - `relative`：`file` 记相对曲库目录的路径——用于"把精选曲目复制/转码进曲库目录"的分发形态。
 * 运行时 `loadAllLocalTracks` 两种都能解析（`path.resolve` 遇绝对路径直接采用）。
 */
export function writeLibrary({ outDir, result, libraryName, provider = "owner-provided-pack", fileMode = "absolute" }) {
  fs.mkdirSync(outDir, { recursive: true });
  const tracks = result.tracks.map((track) => ({
    ...track,
    file: fileMode === "absolute" ? path.resolve(result.root, track.file) : track.file,
  }));
  const doc = {
    schemaVersion: LIBRARY_SCHEMA,
    library: {
      name: libraryName ?? `本地曲库（${tracks.length} 首）`,
      provider,
      licensePolicy: result.licenseNote ?? `许可：${result.license}`,
      generatedAt: result.generatedAt,
      generator: "bundles/ai-video/connectors/bgm-bridge/tag.mjs",
      tracks: tracks.length,
      sourceRoot: result.root,
      fileMode,
      counts: result.counts,
      note: "打标索引：每条都来自实测（响度/真峰值/拍速/结构/频谱/静音），证据见 tag-evidence.json",
    },
    tracks,
  };
  fs.writeFileSync(path.join(outDir, "tracks.json"), `${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "tag-evidence.json"), `${JSON.stringify({
    schemaVersion: TAG_SCHEMA,
    generatedAt: result.generatedAt,
    root: result.root,
    license: result.license,
    licenseNote: result.licenseNote,
    filters: result.filters,
    counts: result.counts,
    evidence: result.evidence,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "tag-report.json"), `${JSON.stringify({
    schemaVersion: TAG_SCHEMA,
    generatedAt: result.generatedAt,
    root: result.root,
    license: result.license,
    licenseNote: result.licenseNote,
    licenseSource: result.licenseSource,
    filters: result.filters,
    counts: result.counts,
    rejected: result.rejected,
    errors: result.errors,
    lowConfidenceTracks: result.tracks
      .filter((track) => track.confidence?.style === "low" || track.bpmConfidence === "low")
      .map((track) => ({ id: track.id, file: track.file, style: track.style, styleConfidence: track.confidence?.style, bpmConfidence: track.bpmConfidence })),
  }, null, 2)}\n`);
  return {
    outDir,
    files: ["tracks.json", "tag-evidence.json", "tag-report.json"],
    tracks: tracks.length,
  };
}

/* ============================ 精选（curation） ============================ */

/* ---------------------------- 曲库搬迁与自动关联 ---------------------------- */

/** 默认扫描根：用户下载/解压素材最常落到的地方（外部盘也扫，便于"插上盘就能用"）。 */
export function defaultScanRoots(env = process.env) {
  const override = String(env.WORKLOOM_BGM_SCAN_ROOTS ?? "").trim();
  if (override) return override.split(":").map((entry) => entry.trim()).filter(Boolean);
  const home = env.HOME || os.homedir();
  const roots = [path.join(home, "Downloads"), path.join(home, "Documents"), path.join(home, "Desktop")];
  try {
    for (const entry of fs.readdirSync("/Volumes", { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) roots.push(path.join("/Volumes", entry.name));
    }
  } catch {
    /* 没有 /Volumes（非 macOS）就跳过 */
  }
  return roots.filter((dir) => fs.existsSync(dir));
}

/** 索引里的曲目路径基准：优先 `library.sourceRoot`，其次索引所在目录。 */
export function indexBaseDir(doc, indexDir) {
  const root = doc?.library?.sourceRoot;
  return typeof root === "string" && root.trim() ? root : indexDir;
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".cache", "Library", "Applications", ".Trash", ".workloom-bgm"]);

/**
 * 自动发现"曲库目录"：在给定扫描根下（默认深度 2）找 `tracks.json`，并**抽样核验**音频是否在位。
 *
 * 为什么要抽样而不是全量核验：素材包动辄上千首 5GB，逐个 sha256 会让"打开工位"变成分钟级等待。
 * 抽样 5 首 + `stat` 就能可靠区分"索引在这儿、音频也在"（→ 可直接用）与"索引在、音频没了"（→ 提示 rebind）。
 */
export function discoverLibraries({
  scanRoots = defaultScanRoots(), maxDepth = 2, maxCandidates = 60, sampleSize = 5,
} = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= maxCandidates || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "tracks.json")) {
      const candidate = inspectLibraryDir(dir, sampleSize);
      if (candidate) found.push(candidate);
      return; // 一个目录已经是曲库，不再往下钻
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of scanRoots) {
    if (found.length >= maxCandidates) break;
    // depth 语义：扫描根本身是 0，其子目录是 1……默认 maxDepth=2 → 能认到"下载/某素材包/tracks.json"
    if (fs.existsSync(root)) walk(path.resolve(root), 0);
  }
  return found.sort((a, b) => b.sample.present - a.sample.present);
}

/** 检查某个目录是不是可用曲库（返回可用性统计 + 是否需要 rebind 修复）。 */
export function inspectLibraryDir(dir, sampleSize = 5) {
  const manifestPath = path.join(dir, "tracks.json");
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  if (!tracks.length) return null;
  const base = indexBaseDir(doc, dir);
  const sample = tracks.slice(0, Math.max(1, sampleSize));
  let present = 0;
  for (const track of sample) {
    const file = typeof track.file === "string" ? track.file : "";
    if (!file) continue;
    const candidates = path.isAbsolute(file) ? [file] : [path.resolve(dir, file), path.resolve(base, file)];
    if (candidates.some((candidate) => fs.existsSync(candidate))) present += 1;
  }
  const scanned = sample.filter((track) => typeof track.file === "string" && track.file).length;
  return {
    dir,
    fileMode: doc?.library?.fileMode ?? (path.isAbsolute(tracks[0].file ?? "") ? "absolute" : "relative"),
    libraryName: doc?.library?.name ?? path.basename(dir),
    license: tracks[0]?.license ?? null,
    licenseSource: tracks[0]?.licenseSource ?? null,
    tracks: tracks.length,
    baseDir: base,
    sample: { scanned, present, missing: scanned - present },
    usable: scanned > 0 && present === scanned,
    needsRebind: scanned > 0 && present === 0,
    note: scanned === 0
      ? "索引里没有可用路径"
      : present === scanned
        ? `抽样 ${present}/${scanned} 首在位，可直接使用`
        : present === 0
          ? `抽样 ${scanned} 首全部找不到（素材疑似被移动）→ 用 bgmwrite.library rebind 重新绑定`
          : `抽样 ${present}/${scanned} 首在位（部分缺失）`,
  };
}

/** 收集一个目录下的音频文件（用于 rebind 匹配；跳过隐藏文件与非音频）。 */
function collectAudioFiles(root, { maxDepth = 6 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(full).isFile()) out.push(full);
        } catch { /* 悬空软链忽略 */ }
        continue;
      }
      if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 重新绑定曲库路径（"我把素材文件夹挪走了，能不能照样用"）。
 *
 * 匹配策略（从快到准，`verify` 决定核验强度）：
 * 1. 按**文件名**（basename）在素材目录里找候选；同名多个时优先大小一致者；
 * 2. `verify="size"`（默认）：只比对文件大小 —— 移动/重命名目录的场景够用，1252 首约 1-2 秒；
 * 3. `verify="sha256"`：逐首算哈希与索引里的 sha256 对齐 —— 更严格（同名不同内容不会错绑），代价是读全量文件。
 *
 * 结果如实回报：`matched`（重新绑定成功）/ `missing`（新目录里找不到）/ `ambiguous`（同名多候选且无法判定）。
 */
export async function rebindLibrary({
  indexDir, newRoot, verify = "size", onProgress = null, dryRun = false,
}) {
  const manifestPath = path.join(indexDir, "tracks.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`索引不存在：${manifestPath}`);
  if (!fs.existsSync(newRoot)) throw new Error(`新素材目录不存在：${newRoot}`);
  const doc = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const oldBase = indexBaseDir(doc, indexDir);
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const files = collectAudioFiles(newRoot);

  const byName = new Map();
  for (const file of files) {
    const key = path.basename(file);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(file);
  }

  const report = { indexDir, oldBase, newRoot, verify, matched: 0, missing: 0, ambiguous: 0, details: [] };
  let index = 0;
  for (const track of tracks) {
    index += 1;
    onProgress?.({ index, total: tracks.length, id: track.id });
    const oldFile = typeof track.file === "string" ? track.file : "";
    const oldAbs = oldFile ? (path.isAbsolute(oldFile) ? oldFile : path.resolve(oldBase, oldFile)) : "";
    const candidates = byName.get(path.basename(oldAbs)) ?? [];
    if (!candidates.length) {
      report.missing += 1;
      report.details.push({ id: track.id, status: "missing", oldPath: oldAbs });
      continue;
    }
    let resolved = null;
    if (candidates.length === 1) {
      resolved = candidates[0];
    } else {
      // 同名多候选：先按大小缩，再（可选）按 sha256 定
      const oldSize = Number(track.bytes);
      const sameSize = Number.isFinite(oldSize)
        ? candidates.filter((candidate) => {
          try {
            return fs.statSync(candidate).size === oldSize;
          } catch {
            return false;
          }
        })
        : [];
      const pool = sameSize.length ? sameSize : candidates;
      if (pool.length === 1) {
        resolved = pool[0];
      } else if (track.sha256) {
        resolved = pool.find((candidate) => {
          try {
            return createHash("sha256").update(fs.readFileSync(candidate)).digest("hex") === track.sha256;
          } catch {
            return false;
          }
        }) ?? null;
      }
      if (!resolved) {
        report.ambiguous += 1;
        report.details.push({ id: track.id, status: "ambiguous", oldPath: oldAbs, candidates: pool.slice(0, 5) });
        continue;
      }
    }
    if (verify === "sha256" && track.sha256) {
      const actual = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
      if (actual !== track.sha256) {
        report.missing += 1;
        report.details.push({ id: track.id, status: "hash_mismatch", oldPath: oldAbs, candidate: resolved });
        continue;
      }
    } else if (Number.isFinite(Number(track.bytes))) {
      const size = fs.statSync(resolved).size;
      if (size !== Number(track.bytes)) {
        report.ambiguous += 1;
        report.details.push({ id: track.id, status: "size_mismatch", oldPath: oldAbs, candidate: resolved, expectedBytes: track.bytes, actualBytes: size });
        continue;
      }
    }
    if (!dryRun) {
      track.file = resolved;
      track.relocatedFrom = oldAbs || null;
    }
    report.matched += 1;
    report.details.push({ id: track.id, status: "matched", oldPath: oldAbs, newPath: resolved });
  }

  if (!dryRun) {
    doc.library = {
      ...(doc.library ?? {}),
      sourceRoot: newRoot,
      fileMode: "absolute",
      relocatedAt: new Date().toISOString(),
      rebind: { verify, matched: report.matched, missing: report.missing, ambiguous: report.ambiguous, previousRoot: oldBase },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return report;
}

/**
 * 打包索引进素材目录（让"文件夹自己带着索引走"）：把 tracks.json / tag-evidence.json / tag-report.json
 * 以**相对路径**写进素材目录，这样客户把整个文件夹拷走/解压到任何位置，系统都能直接认出来（配合自动发现）。
 */
export function packLibrary({ indexDir, destDir = null, overwrite = false }) {
  const manifestPath = path.join(indexDir, "tracks.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`索引不存在：${manifestPath}`);
  const doc = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const base = indexBaseDir(doc, indexDir);
  const target = path.resolve(destDir ?? base);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  const targetManifest = path.join(target, "tracks.json");
  if (fs.existsSync(targetManifest) && !overwrite && path.resolve(indexDir) !== target) {
    throw new Error(`目标目录已有 tracks.json：${targetManifest}（覆盖需显式 overwrite=true）`);
  }
  const rel = (file) => {
    const abs = path.isAbsolute(file) ? file : path.resolve(base, file);
    const relative = path.relative(target, abs);
    return relative.startsWith("..") ? abs : relative.split(path.sep).join("/");
  };
  const packed = {
    ...doc,
    library: {
      ...(doc.library ?? {}),
      sourceRoot: target,
      fileMode: "relative",
      packedAt: new Date().toISOString(),
    },
    tracks: (doc.tracks ?? []).map((track) => ({ ...track, file: rel(track.file) })),
  };
  fs.writeFileSync(targetManifest, `${JSON.stringify(packed, null, 2)}\n`);
  const copied = ["tracks.json"];
  for (const name of ["tag-evidence.json", "tag-report.json"]) {
    const source = path.join(indexDir, name);
    if (!fs.existsSync(source)) continue;
    const evidence = JSON.parse(fs.readFileSync(source, "utf8"));
    if (Array.isArray(evidence.evidence)) {
      evidence.evidence = evidence.evidence.map((entry) => ({
        ...entry,
        file: typeof entry.file === "string" ? rel(entry.file) : entry.file,
      }));
    }
    fs.writeFileSync(path.join(target, name), `${JSON.stringify(evidence, null, 2)}\n`);
    copied.push(name);
  }
  return { destDir: target, files: copied, tracks: packed.tracks.length, fileMode: "relative" };
}

/**
 * 合并**外部模型标签**（可选接入点，例如 CLAP / MTG-Jamendo / Essentia 打标模型的输出）。
 *
 * 设计原则（避免"模型说啥就是啥"）：
 * - **不覆盖**本地实测：模型标签进 `externalTags`，与实测标签并列保存，谁也不能抹掉谁；
 * - 只在本地风格判定**不是 high** 时，才把模型风格记为 `styleExternal` 并标注 `styleSource="external-model"`，
 *   便于下游按需取用（默认仍用本地判定，冲突一眼可见）；
 * - 概率/置信度原样登记，不做二次包装；来源写 `source`。
 *
 * 输入形状（`--external-tags` 读的 JSON）：
 *   { "tracks": { "<sha256 或 id>": { "style": "...", "mood": "...", "genres": ["..."],
 *                                    "instrumentation": ["..."], "confidence": 0.83, "source": "clap-v2" } } }
 */
export function mergeExternalTags({ tracks, external, defaultSource = "external-model" }) {
  const map = external?.tracks ?? external ?? {};
  let merged = 0;
  let styleAdopted = 0;
  for (const track of tracks) {
    const hit = map[track.sha256] ?? map[track.id] ?? map[track.file];
    if (!hit) continue;
    merged += 1;
    track.externalTags = {
      source: hit.source ?? defaultSource,
      style: hit.style ?? null,
      mood: hit.mood ?? null,
      genres: Array.isArray(hit.genres) ? hit.genres : null,
      instrumentation: Array.isArray(hit.instrumentation) ? hit.instrumentation : null,
      valence: Number.isFinite(hit.valence) ? hit.valence : null,
      arousal: Number.isFinite(hit.arousal) ? hit.arousal : null,
      confidence: Number.isFinite(hit.confidence) ? hit.confidence : null,
      mergedAt: new Date().toISOString(),
    };
    const localConfidence = track.confidence?.style;
    if (hit.style && localConfidence !== "high") {
      track.styleExternal = hit.style;
      track.styleSource = "external-model";
      styleAdopted += 1;
    }
  }
  return { merged, styleAdopted, total: tracks.length };
}

/**
 * 精选质量分（0..100）：只用手上有的**实测证据**打分，不假装听过。
 *
 * 打分项与理由都返回，便于在报告里逐首解释"为什么入选"：
 * - 响度贴近 -14 LUFS（混音目标）、真峰值不过冲、无削波痕迹；
 * - 有结构（多段/有 drop）、动态适中（6-18 dB 不糊也不忽大忽小）；
 * - 拍速可信、频谱不极端、循环友好、风格判定置信度高。
 */
export function scoreForCurated(track) {
  const reasons = [];
  let score = 0;
  const lufs = Number(track.loudness?.integratedLufs);
  if (Number.isFinite(lufs)) {
    const closeness = Math.max(0, 26 - Math.abs(lufs + 14) * 3.2);
    score += closeness;
    reasons.push(`响度 ${round(lufs)} LUFS（距 -14 目标 ${round(Math.abs(lufs + 14))}）→ +${round(closeness, 1)}`);
  }
  const truePeak = Number(track.loudness?.truePeakDbtp);
  if (Number.isFinite(truePeak)) {
    const peakScore = truePeak <= -0.5 ? 8 : truePeak <= 1.0 ? 5 : 2;
    score += peakScore;
    reasons.push(`真峰值 ${round(truePeak)} dBTP → +${peakScore}`);
  }
  const flat = Number(track.peak?.flatFactor);
  if (Number.isFinite(flat)) {
    const flatScore = flat <= 0.001 ? 8 : flat <= 0.005 ? 4 : 0;
    score += flatScore;
    reasons.push(`平坦因子 ${round(flat, 4)}（削波证据）→ +${flatScore}`);
  }
  const segments = Array.isArray(track.structure?.segments) ? track.structure.segments : [];
  const structureScore = (segments.length >= 4 ? 6 : segments.length >= 2 ? 3 : 0) + (track.structure?.hasDrop ? 6 : 0);
  score += structureScore;
  reasons.push(`结构 ${segments.length} 段${track.structure?.hasDrop ? "（含 drop）" : ""} → +${structureScore}`);
  const dynamics = Number(track.dynamicsDb);
  if (Number.isFinite(dynamics)) {
    const dynScore = dynamics >= 6 && dynamics <= 20 ? 10 : dynamics >= 4 && dynamics <= 26 ? 5 : 0;
    score += dynScore;
    reasons.push(`动态 ${round(dynamics)} dB → +${dynScore}`);
  }
  const bpmConfidence = String(track.bpmConfidence ?? "low");
  const bpmScore = bpmConfidence === "high" ? 10 : bpmConfidence === "medium" ? 8 : 2;
  score += bpmScore;
  reasons.push(`拍速置信度 ${bpmConfidence} → +${bpmScore}`);
  const centroid = Number(track.spectral?.centroidHz);
  if (Number.isFinite(centroid)) {
    const spectralScore = centroid >= 700 && centroid <= 3600 ? 8 : 3;
    score += spectralScore;
    reasons.push(`频谱重心 ${centroid} Hz → +${spectralScore}`);
  }
  if (track.loop?.loopFriendly === true) {
    score += 6;
    reasons.push(`循环友好（首尾差 ${round(track.loop.startEndDeltaDb)} dB）→ +6`);
  }
  const styleConfidence = String(track.confidence?.style ?? "low");
  const styleScore = styleConfidence === "high" ? 8 : styleConfidence === "medium" ? 5 : 1;
  score += styleScore;
  reasons.push(`风格置信度 ${styleConfidence} → +${styleScore}`);
  if (Number(track.durationSec) >= 90) {
    score += 4;
    reasons.push(`时长 ${round(track.durationSec)}s（≥90s，选段余地大）→ +4`);
  }
  return { score: round(Math.min(100, score), 2), reasons };
}

/**
 * 精选挑选：先按风格族分组，组内按质量分排序，再**轮转**取曲——
 * 保证"不同风格"真的落到库里，而不是被高分风格霸占。
 *
 * 规则（都可调，但默认值即产品口径）：
 * - 每个风格族先取 1 首（若该族有货），保证覆盖面；
 * - 然后按"当前已选数量最少、分数最高"的顺序继续补，直到 `count`；
 * - `maxPerStyle` 默认 `ceil(count / 风格数 * 1.5)`，防止单一风格塞满；
 * - 同一风格内部再避免连续选到同一能量档（low/mid/high 轮换）。
 */
export function selectCuratedTracks({ tracks, count = 50, maxPerStyle = null }) {
  const scored = tracks
    .map((track) => ({ track, ...scoreForCurated(track) }))
    .sort((a, b) => b.score - a.score);
  const styles = [...new Set(scored.map((entry) => entry.track.style))];
  const cap = maxPerStyle ?? Math.max(2, Math.ceil((count / Math.max(1, styles.length)) * 1.5));
  const buckets = new Map(styles.map((style) => [style, scored.filter((entry) => entry.track.style === style)]));
  const picked = [];
  const perStyle = new Map();
  const energyUsage = new Map();

  const take = (entry) => {
    picked.push({ ...entry, pickedAt: picked.length + 1 });
    perStyle.set(entry.track.style, (perStyle.get(entry.track.style) ?? 0) + 1);
    const key = `${entry.track.style}:${entry.track.energyBucket ?? "mid"}`;
    energyUsage.set(key, (energyUsage.get(key) ?? 0) + 1);
  };

  // 第一轮：每个风格族各取 1 首（能量档优先取本族里未被用过的档）
  for (const style of styles) {
    if (picked.length >= count) break;
    const list = buckets.get(style) ?? [];
    const candidate = list.find((entry) => !entry.track.energyBucket || (energyUsage.get(`${style}:${entry.track.energyBucket}`) ?? 0) === 0) ?? list[0];
    if (candidate) take(candidate);
  }
  // 后续轮转：谁的已用量最少谁先补，同数量比质量分
  for (;;) {
    if (picked.length >= count) break;
    const candidates = scored.filter((entry) => {
      if (picked.some((item) => item.track.id === entry.track.id)) return false;
      return (perStyle.get(entry.track.style) ?? 0) < cap;
    });
    if (!candidates.length) break;
    candidates.sort((a, b) => {
      const usedDiff = (perStyle.get(a.track.style) ?? 0) - (perStyle.get(b.track.style) ?? 0);
      if (usedDiff !== 0) return usedDiff;
      return b.score - a.score;
    });
    take(candidates[0]);
  }
  return {
    count: picked.length,
    maxPerStyle: cap,
    byStyle: Object.fromEntries([...perStyle.entries()].sort((a, b) => b[1] - a[1])),
    byEnergyBucket: picked.reduce((accumulator, entry) => {
      const key = entry.track.energyBucket ?? "mid";
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {}),
    picks: picked.map((entry) => ({
      id: entry.track.id, file: entry.track.file, style: entry.track.style,
      energyBucket: entry.track.energyBucket, bpm: entry.track.bpm,
      score: entry.score, reasons: entry.reasons,
    })),
    tracksById: new Map(picked.map((entry) => [entry.track.id, entry])),
  };
}

/**
 * 选段：给精选用曲挑出"最合适那一段"。
 *
 * 规则（顺序即优先级，理由会写进报告）：
 * 1. 有 `drop` 段且够长 → 取该段中间对齐的窗口（BGM 要的是能量最饱满处，不是开头）；
 * 2. 没有 drop → 用抽稀包络找能量最高的窗口（滑窗平均最大）；
 * 3. 证据不足（老索引没有包络）→ 从整曲 35% 处取（避开 intro 铺底，又不至于贴尾淡出）。
 */
export function planExcerpt({ track, targetSec = 60, outlineDb = null }) {
  const sourceDuration = Number(track.durationSec) || 0;
  const durationSec = Math.min(targetSec, Math.max(10, sourceDuration));
  const segments = Array.isArray(track.structure?.segments) ? track.structure.segments : [];
  const drops = segments.filter((segment) => segment.type === "drop" && Number.isFinite(segment.startSec));
  if (drops.length) {
    const best = drops.sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec))[0];
    const segLength = Math.max(1, Number(best.endSec) - Number(best.startSec));
    const start = Number(best.startSec) + Math.max(0, (segLength - durationSec) / 2);
    return {
      startSec: round(clampStart(start, sourceDuration, durationSec), 2),
      durationSec: round(durationSec, 2),
      reason: `取最长 drop 段（${round(best.startSec, 1)}s→${round(best.endSec, 1)}s）中心对齐的 ${round(durationSec, 1)}s 窗口`,
    };
  }
  const outline = Array.isArray(outlineDb)
    ? outlineDb
    : (Array.isArray(track.loop?.outlineDb) ? track.loop.outlineDb : null);
  if (outline && outline.length >= 8) {
    const windowPoints = Math.max(2, Math.round((outline.length * durationSec) / Math.max(1, sourceDuration)));
    let bestIndex = 0;
    let bestAvg = -Infinity;
    for (let index = 0; index + windowPoints <= outline.length; index += 1) {
      const slice = outline.slice(index, index + windowPoints);
      const average = slice.reduce((sum, value) => sum + value, 0) / slice.length;
      if (average > bestAvg) { bestAvg = average; bestIndex = index; }
    }
    const start = (bestIndex / outline.length) * sourceDuration;
    return {
      startSec: round(clampStart(start, sourceDuration, durationSec), 2),
      durationSec: round(durationSec, 2),
      reason: `无 drop 段：按包络滑窗取能量最高的一段（平均 ${round(bestAvg, 1)} dB）`,
    };
  }
  return {
    startSec: round(clampStart(sourceDuration * 0.35, sourceDuration, durationSec), 2),
    durationSec: round(durationSec, 2),
    reason: "证据不足（无结构/包络）：从整曲 35% 处取，避开开头铺底与结尾淡出",
  };
}

function clampStart(start, sourceDuration, durationSec) {
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.min(Math.max(0, sourceDuration - durationSec), start));
}

/**
 * 选段增益：以**选段自身**的实测响度为基准做线性增益（不压动态）。
 *
 * 两个硬约束：
 * ① 响度对齐 `targetLufs`（线性增益，不做动态压缩，保住本来就不多的动态）；
 * ② 增益后真峰值不得超过 `truePeakDbtp`——超了就以峰值保护优先，牺牲一点响度目标
 *    （宁可略轻也不能削波：曲库是要反复进混音的素材）。
 */
export function computeExcerptGain({ integratedLufs, truePeakDbtp }, { targetLufs = -14, truePeakDbtp: peakCeiling = -1.0 } = {}) {
  if (!Number.isFinite(integratedLufs)) return { gainDb: 0, reason: "响度未测到，按原样输出（不猜增益）", peakProtected: false };
  const loudnessGain = targetLufs - integratedLufs;
  const peakGain = Number.isFinite(truePeakDbtp) ? peakCeiling - truePeakDbtp : Infinity;
  const gainDb = Math.max(-12, Math.min(12, Math.min(loudnessGain, peakGain)));
  const peakProtected = peakGain < loudnessGain;
  return {
    gainDb: round(gainDb, 2),
    peakProtected,
    reason: peakProtected
      ? `峰值保护优先：选段真峰值 ${round(truePeakDbtp)} dBTP，只加 ${round(gainDb, 2)} dB（响度目标本可加 ${round(loudnessGain, 2)} dB）`
      : `线性增益到 ${targetLufs} LUFS（选段实测 ${round(integratedLufs)} LUFS → ${round(gainDb, 2)} dB）`,
  };
}

/**
 * 转码选段进曲库：先量**选段自身**响度 → 线性增益到目标（超峰值则峰值保护优先）→
 * 首尾短淡入淡出（避免入库片段带"啪"声）→ 转码后复测一遍，把实测值写回报告。
 */
export async function encodeExcerpt({
  input, output, startSec, durationSec, targetLufs = -14, truePeakDbtp = -1.0,
  bitrate = "112k", bins = resolveBinaries(), fadeInSec = 0.5, fadeOutSec = 0.8,
}) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const segmentLoudness = await measureLoudness(input, { bins, startSec, maxSeconds: durationSec, targetLufs, truePeak: truePeakDbtp });
  const fadeOutStart = Math.max(0, durationSec - fadeOutSec);
  let limiterHeadroomDb = 0.5;
  /**
   * 增益策略：**线性增益**（不压动态）。
   *
   * 为什么不用 loudnorm 单遍替代：实测（`自然-特效/雨声和雨林.mp3`）这类"整体很轻但峰值贴顶"
   * 的环境音，loudnorm 的目标真峰值限制器会直接拒绝任何提升 → 输出与输入几乎等响（白跑一遍编码）。
   * 这种曲目的正确做法是**峰值保护优先**：宁可低于 -14 LUFS，也不为了响度数字去压动态或冒削波风险；
   * 索引里用 `excerpt.peakProtected=true` 与 `loudness` 实测值如实登记，混音环节本来就会按目标响度重新定增益。
   */
  let gain = computeExcerptGain(segmentLoudness, { targetLufs, truePeakDbtp: truePeakDbtp - 0.5 });
  const lastArgv = () => [
    ...(Math.abs(gain.gainDb) >= 0.1 ? [`volume=${gain.gainDb}dB`] : []),
    /**
     * 限制器用**线性** limit，并留 0.5 dB 余量：alimiter 管的是"采样峰值"，
     * 真峰值（inter-sample）会高出 0.5-1.5 dB——按 -1 dBFS 限幅仍有片段测到 -0.03 dBTP，
     * 故按 `truePeakDbtp - 0.5` 限幅，配合后面的复测修正，确保交付口径尽量贴近 ≤ -1 dBTP。
     *
     * **必须显式 `level=0`**：alimiter 默认开启 auto level（自动把峰值顶到 limit），
     * 会把我们算好的降增益又抬回去（实测：volume=-6dB + 默认 alimiter → 输出只降了 3dB）。
     */
    `alimiter=limit=${round(Math.pow(10, (truePeakDbtp - limiterHeadroomDb) / 20), 4)}:attack=1:release=50:level=0`,
    `afade=t=in:st=0:d=${fadeInSec}`,
    `afade=t=out:st=${round(fadeOutStart, 2)}:d=${fadeOutSec}`,
  ].join(",");
  const encode = async () => runBin(bins.ffmpeg, [
    "-hide_banner", "-nostats", "-v", "error", "-y",
    "-ss", String(startSec), "-t", String(durationSec), "-i", input,
    "-vn", "-af", lastArgv(),
    "-c:a", "aac", "-b:a", String(bitrate), "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart", output,
  ], { label: "ffmpeg(excerpt-encode)", timeoutMs: 600_000 });

  // 先按"峰值上限留 0.5 dB 编码余量"算增益；编码后复测，明显越线才修正一次（不无限重试）。
  await encode();
  let loudness = await measureLoudness(output, { bins });
  let retried = false;
  let corrections = 0;
  // 只对"明显越界"（超过上限 0.3 dB 以上）做一次修正：AAC 交调过冲常在 0.5-1.5 dB，
  // 把 -1 dBTP 当硬线反复重编只会白跑编码；真正越线（>-0.7 dBTP）才收一次。
  while (Number.isFinite(loudness.truePeakDbtp) && loudness.truePeakDbtp > truePeakDbtp + 0.3 && corrections < 1) {
    const correction = round(truePeakDbtp - 0.15 - loudness.truePeakDbtp, 2);
    limiterHeadroomDb = Math.min(2.5, limiterHeadroomDb + 0.75); // 交调过冲比预期大：限制器逐轮收紧
    gain = {
      ...gain,
      gainDb: round(gain.gainDb + correction, 2),
      reason: `${gain.reason}；编码实测真峰值 ${round(loudness.truePeakDbtp)} dBTP 越线 → 第 ${corrections + 1} 轮再降 ${correction} dB 复编`,
    };
    await encode();
    loudness = await measureLoudness(output, { bins });
    corrections += 1;
    retried = true;
  }
  return {
    output,
    bytes: fs.statSync(output).size,
    sha256: sha256File(output),
    gainAppliedDb: gain.gainDb,
    gainReason: gain.reason,
    gainMode: gain.peakProtected ? "linear-gain-peak-protected" : "linear-gain",
    peakProtected: gain.peakProtected,
    peakOverrunDb: Number.isFinite(loudness.truePeakDbtp) && loudness.truePeakDbtp > truePeakDbtp
      ? round(loudness.truePeakDbtp - truePeakDbtp, 2)
      : 0,
    loudnessDeltaDb: Number.isFinite(loudness.integratedLufs) ? round(loudness.integratedLufs - targetLufs, 2) : null,
    retried,
    segmentLoudness,
    loudness,
    bitrate,
    fades: { inSec: fadeInSec, outSec: fadeOutSec },
  };
}
