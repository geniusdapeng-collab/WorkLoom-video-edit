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
  pitch: 1.04,
  rate: 0.94,
  female: true,
  // 中文名与本机实际音色名同列：macOS 的 zh-CN 音色在 Chromium 里叫「婷婷 / 美嘉 / 善怡 / 语舒」，
  // 只写英文名会匹配不到；VoiceEngine 还会把不发 boundary 的 Eddy/Flo 一族降级兜底。
  preferredNames: ["Flo", "Tingting", "Xiaoxiao", "Xiaoyi", "Meijia", "Sinji", "婷婷", "美嘉", "善怡", "语舒"],
};
