/**
 * edit —— 视频AI剪辑（video-edit bundle）参考实现入口。
 *
 * 导出三层纯函数：
 *   · timecode：帧级时间码换算（秒 ↔ HH:MM:SS.mmm ↔ 帧号）；
 *   · probe-parse：ffmpeg/ffprobe 原始输出 → 信号层结构（确定性，零模型成本）；
 *   · highlight：多信号高光打分 + 三类关键帧筛选（可复算）；
 *   · timeline：剪辑时间轴校验 + 本地合成计划（纯事实判定，不含审美口径）。
 *   · transitions：转场计划（编辑意图 → 引擎转场；声明优先、场景切换自动补、时长安全降级）。
 *   · attention：注意力层（视觉事件排期 + 覆盖率/密度/安全区体检；密度类咨询、遮挡类硬项）。
 *
 * 执行入口在 `scripts/tools/edit-{probe,assemble,verify}.mts`，它们只负责 IO 与 ffmpeg 调用，
 * 判定逻辑全部留在本模块，保证"同输入 → 同结论"。
 */
export * from "./timecode.js";
export * from "./probe-parse.js";
export * from "./highlight.js";
export * from "./timeline.js";
export * from "./transitions.js";
export * from "./reframe.js";
export * from "./audio.js";
export * from "./caption.js";
export * from "./post-auto.js";
export * from "./creative-check.js";
export * from "./intent.js";
export * from "./auto-plan.js";
export * from "./talk.js";
export * from "./attention.js";
export * from "./output-resolution.js";
export * from "./naming.js";
export * from "./entity-color.js";
export * from "./copy-style.js";
export * from "./rhythm-director.js";
export * from "./rhythm-auto.js";
export * from "./delivery-plan.js";
