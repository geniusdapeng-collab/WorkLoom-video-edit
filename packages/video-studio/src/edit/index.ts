/**
 * edit —— 视频AI剪辑（video-edit bundle）参考实现入口。
 *
 * 导出三层纯函数：
 *   · timecode：帧级时间码换算（秒 ↔ HH:MM:SS.mmm ↔ 帧号）；
 *   · probe-parse：ffmpeg/ffprobe 原始输出 → 信号层结构（确定性，零模型成本）；
 *   · highlight：多信号高光打分 + 三类关键帧筛选（可复算）；
 *   · timeline：剪辑时间轴校验 + 本地合成计划（纯事实判定，不含审美口径）。
 *
 * 执行入口在 `scripts/tools/edit-{probe,assemble,verify}.mts`，它们只负责 IO 与 ffmpeg 调用，
 * 判定逻辑全部留在本模块，保证"同输入 → 同结论"。
 */
export * from "./timecode.js";
export * from "./probe-parse.js";
export * from "./highlight.js";
export * from "./timeline.js";
export * from "./audio.js";
export * from "./caption.js";
export * from "./post-auto.js";
