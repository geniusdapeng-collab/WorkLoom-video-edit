/**
 * 音色库（Voice Library）· 数字员工与织伴共用的「声线名册」（单一事实源）
 *
 * 事实与纪律（2026-09-20 产品所有者反馈「织伴一会儿男声一会儿女声」后确立）：
 *  - 端侧只用系统中文音色（speechSynthesis，零网络零密钥），所以"音色"= 系统音色候选 + 音高/语速修饰；
 *  - **性别是硬约束**：声明 female 的条目，VoiceEngine 绝不会回落到男声（宁可退回统一女声；
 *    一个中文女声都没有时，才退回系统默认，且同一角色整场不换人）；
 *  - 每个角色（员工岗位 presetKey、织伴）按标识稳定散列到名册里的一条 —— **同一角色全程同一嗓音**，
 *    不做段落级随机，避免"同一屏出现两个说话人"。
 *
 * 谁在用：VoiceEngine.voiceProfileForRole（员工播报）、mateVoice.mateVoiceProfileOf（织伴）。
 */
import type { VoiceProfile } from "./VoiceEngine";

export interface LibraryVoice {
  id: string;
  /** 档案/验收展示用的中文名（编号 + 声音气质） */
  label: string;
  /** 一句话描述听感，给产品与验收同学对齐用 */
  tone: string;
  profile: VoiceProfile;
}

/** 系统中文女声常用名（macOS/Windows 实测，含中英文两种写法） */
const FEMALE_NAMES = [
  "Tingting", "婷婷", "Xiaoxiao", "晓晓", "Xiaoyi", "晓伊",
  "Meijia", "美嘉", "Sinji", "善怡", "Huihui", "慧慧", "Yaoyao", "瑶瑶", "Flo",
];
/** 系统中文男声常用名（female 条目的排除集） */
const MALE_NAMES = [
  "Li-mu", "李沐", "Yunxi", "云希", "Yunjian", "云健", "Yunyang", "云扬",
  "Xiaoyu", "晓宇", "Reed", "Eddy",
];

export const VOICE_LIBRARY: readonly LibraryVoice[] = [
  { id: "lolita", label: "V01 · 甜豆萝莉", tone: "高音、语速轻快，甜而不刺耳", profile: { pitch: 1.32, rate: 1.06, female: true, preferredNames: FEMALE_NAMES } },
  { id: "bright", label: "V02 · 元气少女", tone: "中高音、节奏利落", profile: { pitch: 1.2, rate: 1.1, female: true, preferredNames: FEMALE_NAMES } },
  { id: "warm", label: "V03 · 温柔女声", tone: "中音、语速平稳，适合汇报", profile: { pitch: 1.08, rate: 0.96, female: true, preferredNames: FEMALE_NAMES } },
  { id: "calm", label: "V04 · 沉稳女声", tone: "中低音、语速偏慢，适合复盘", profile: { pitch: 0.98, rate: 0.9, female: true, preferredNames: FEMALE_NAMES } },
  { id: "clear", label: "V05 · 清亮女声", tone: "清亮、略快，适合播报", profile: { pitch: 1.14, rate: 1.02, female: true, preferredNames: FEMALE_NAMES } },
  { id: "steady", label: "V06 · 稳重男声", tone: "中低音、语速平稳", profile: { pitch: 0.92, rate: 0.95, female: false, preferredNames: MALE_NAMES } },
  { id: "deep", label: "V07 · 低沉男声", tone: "低音、语速偏慢", profile: { pitch: 0.82, rate: 0.9, female: false, preferredNames: MALE_NAMES } },
  { id: "youth", label: "V08 · 青年男声", tone: "中音、语速轻快", profile: { pitch: 1.0, rate: 1.05, female: false, preferredNames: MALE_NAMES } },
];

/** 岗位/角色 → 音色条目（稳定散列：同一角色永远同一条，不随页面与会话变化） */
export function libraryVoiceFor(role: string): LibraryVoice {
  const key = (role ?? "").trim();
  if (!key) return VOICE_LIBRARY[2]!;
  let hash = 2166136261;
  for (const ch of key) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return VOICE_LIBRARY[(hash >>> 0) % VOICE_LIBRARY.length]!;
}
