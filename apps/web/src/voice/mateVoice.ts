/**
 * 织伴（LoomMate · 产品数字人）音色档案 —— 单一事实源。
 *
 * 《语音与数字员工交付契约》§1：织伴固定为柔和中文女声，音高只做轻微修饰；
 * 同一角色第一次选中系统 voice 后必须锁定，后续段落不得重新猜测。
 *
 * 谁在用：欢迎仪式（MateWelcome）与首日上岗引导（mate-guide）必须同音色——
 * 两者都是织伴在说话，不能一个偏男声一个偏女声（那会被当成两个角色）。
 */
import type { VoiceProfile } from "./VoiceEngine";

export const MATE_VOICE_PROFILE: VoiceProfile = {
  // 萝莉档（产品所有者 2026-09-20：织伴是二次元女生，固定女声，要甜一点）
  pitch: 1.28,
  rate: 1.04,
  female: true,
  /**
   * 中文名与本机实际音色名同列：macOS 的 zh-CN 音色在 Chromium 里叫「婷婷 / 美嘉 / 善怡 / 语舒」，
   * 只写英文名会匹配不到。顺序即优先级：先挑甜一点的少女音，再退到通用女声。
   * 纪律：female=true ⇒ VoiceEngine 不会回落到男声（见 selectVoice 的性别硬约束）。
   */
  preferredNames: ["Tingting", "婷婷", "Xiaoxiao", "晓晓", "Xiaoyi", "晓伊", "Meijia", "美嘉", "Sinji", "善怡", "Flo"],
};

/**
 * 织伴音色档位（设置面板的「甜 / 亮 / 柔 / 稳」）：**只改音高与语速，永远是女声**。
 * 甜 = 萝莉档（默认）；亮 = 更快的少女音；柔 = 收敛一点的温柔音；稳 = 播报腔的中音女声。
 */
export function mateVoiceProfileOf(key: string | undefined): VoiceProfile {
  switch (key) {
    case "bright": return { ...MATE_VOICE_PROFILE, pitch: 1.22, rate: 1.12 };
    case "soft": return { ...MATE_VOICE_PROFILE, pitch: 1.14, rate: 0.96 };
    case "calm": return { ...MATE_VOICE_PROFILE, pitch: 1.06, rate: 0.9 };
    default: return MATE_VOICE_PROFILE;
  }
}
