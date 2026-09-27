/**
 * producer-gate —— AI 监制（制片人）门：把"人工确认"换成"机器评审 + 打回重跑"
 *
 * 背景（T-2026-0924-0001）：
 *   视频链路上原有 G1–G7 七个确认门。早先实现是两道极端：要么挂人工审批卡等人点（停线），
 *   要么用 `HR_AUTO_GATES` 一律 `approved:true`（等于没有质量门，坏产物直接往下流）。
 *   产品口径是**全自动预生产 + 人类只在花钱/对外时介入**，所以中间门需要的是"AI 监制"：
 *   看产物、按纪律打分、不合格就打回重跑，并把裁决写进日志与事件。
 *
 * 本模块提供三件事：
 *   1. `PRODUCER_RUBRICS` —— 逐环节评审要点（与 bundles/ai-video/skills 的纪律同源）；
 *   2. 确定性硬闸（调用方传入 ffprobe/文件校验结果）—— 硬失败直接打回，不消耗模型额度；
 *   3. 可选的 LLM 评审（含图像）—— 打分 + 问题清单 + 修改建议；模型不可用时**如实降级**并标注。
 *
 * 纪律：默认 fail-closed —— 硬闸失败必打回；LLM 不可用且无硬闸结论时**不放行**（返回 rerun），
 * 模型/证据不可用时保持 unverified；旧 allowFallbackApprove 参数不再授予正式通过资格。
 */

export type ProducerStage =
  | "script"
  | "continuity"
  | "micromotion"
  | "prompt"
  | "keyframe"
  | "shot"
  | "compose"
  | "color"
  | "subtitle"
  | "mux"
  | "danmaku"
  | "bgm"
  | "cover"
  | "master";

import { existsSync, readFileSync, rmSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { QualityStatus } from "./quality-evidence.js";

export interface DeterministicCheck {
  status?: QualityStatus;
  id: string;
  pass: boolean;
  detail: string;
  /** 硬闸：失败即打回（LLM 无权推翻）。缺省 = 软信号（只进问题清单，不影响放行判定） */
  hard?: boolean;
}

export interface ProducerArtifact {
  path: string;
  kind: "image" | "video" | "audio" | "text" | "json";
  bytes?: number;
  /** ffprobe 摘要（video/audio）：width/height/duration/loudness 等 */
  probe?: Record<string, unknown>;
  note?: string;
}

export interface ProducerVerdict {
  status: QualityStatus;
  evidence?: Array<{ path: string; sha256: string; scope: string }>;
  stage: ProducerStage;
  approved: boolean;
  /** 0–100；硬闸失败为 0 */
  score: number;
  hardFailures: string[];
  issues: string[];
  suggestions: string[];
  /** 建议重跑本环节（approved=false 时恒为 true） */
  rerun: boolean;
  via: "deterministic" | "llm" | "fallback";
  model?: string;
  ms: number;
  reason: string;
  /** 证据或模型不可用；degraded 不具备放行资格。 */
  degraded: boolean;
}

/**
 * 逐环节评审要点（与 bundles/ai-video/skills 的纪律同源；中文，便于直接落日志/审批卡）。
 * 注意：这里是"监制看什么"，不是确定性断言——确定性断言由调用方按产物实测传入。
 */
export const PRODUCER_RUBRICS: Record<ProducerStage, string[]> = {
  script: [
    "台词速率 ≤ 3.6 字/秒（按镜头时长硬算），不出现念不完的长句",
    "每镜有明确的动作与情绪变化，不是静态摆拍",
    "镜头时长合计等于目标总时长，节奏有起伏（开场/推进/收尾）"
  ],
  prompt: [
    "25/30 字段齐备且非模板默认值（字段是生成的，不是下游补的）",
    "提示词长度达到交付口径（≥1200 字），含【约束】实际画幅分辨率",
    "不含红线词（科幻/微观等与 brief 无关的意象），无 [object Object]",
    "场景与人物解耦：定妆照只描述人，场景只由镜头提示词给"
  ],
  /**
   * 连贯性导演评审（2026-09-24 接入）：跨镜头看"还是不是同一支片子"。
   * 6 问 + 5 维与 `packages/video-studio/src/continuity.ts` 的确定性检查同源，
   * LLM 只负责"机检查不出来的语义跳变"（例如同一场景里空间关系讲不通）。
   */
  continuity: [
    "人物同一性：六镜是同一个人、同一套造型（服装/妆造/发型无可解释变化）",
    "空间连续性：同一场所的空间锚点（河道/桥/船/建筑/巷道）连续，转场有交代",
    "时间与光线推进：时段单向推进或显式闪回，不出现时间错乱",
    "动作与视线连续：相邻镜的运动方向与视线读得通，没有来回折返",
    "道具状态连续：关键道具（碗/勺/船/灯笼/伞）的出现与消失都有动作交代",
    "节奏与情绪：总时长对齐目标，情绪曲线有起承转收，结尾收得住"
  ],
  /**
   * 微动作增强（2026-09-24 接入）：5 路（面部/身体/眼神/呼吸/融合）是否真的落到提示词里。
   */
  micromotion: [
    "五路微动作齐备：面部（眉/嘴角）、眼神（注视点与眨眼）、身体（重心/肩线）、呼吸（与时长对齐）、融合（与台词节拍对齐）",
    "微动作是**画面语言**（可被摄影机拍到），不是情绪形容词堆砌",
    "微动作与宏观动作不冲突（不出现'站在原地走两步'这类互斥描述）",
    "增量有界：微动作补充不把提示词撑到影响交付闸（增量 ≤200 字）"
  ],
  keyframe: [
    /**
     * 桥/栈道类结构（2026-09-24 真机二次事故命名化）：
     * 交付成片里出现过"桥面两侧直接临水、看不到任何一端连接"的悬空步道（观众读作「从水里走上来的一座桥」）。
     * 这类结构问题在旧 rubric 里只能靠"空间与物理自洽（通用）"间接覆盖，评审时容易被人物/画质项盖过；
     * 现在单独点名，且给出可判定的判据。
     */
    "桥/栈道类结构（场景含桥、栈道时必判）：桥体可辨（拱形或梁式）、两端各有桥头并与岸线/地面真实相接、栏杆沿桥面连续；不出现「桥面两侧直接临水且看不到任何一端连接」的悬空步道（无头之桥）、不出现桥体与水面之间无驳岸/桥台过渡",
    "画面里的人物与角色档案/定妆照是同一张脸、同一发型与服装",
    "是纯写实影像（非插画/3D/CG），皮肤有真实质感不塑料",
    "构图符合镜头卡（景别/朝向/留白），主体完整入画无裁切事故",
    /**
     * 景深档位（2026-09-25 知识注入四轮审计 · A12 提示词/评审一致性）：
     * 关键帧提示词从本轮起带上知识库（OPTICS-001 光圈顾问）给出的景深裁决，评审侧必须有同名类目，
     * 否则"风光镜被拍成整体虚化""人像特写背景全清"这类**参数与题材错配**在关键帧阶段无人拦。
     * 判据与 OPTICS-001 第二/三节同源：风光/建筑/合影/车轨长曝/微距要求前后景清晰；
     * 单人特写/夜景人像要求主体分离、背景柔和；两者不得互换。
     */
    "景深/清晰范围符合题材与镜头卡：风光/建筑/多人合影/车轨长曝/微距必须前后景清晰可辨；单人特写/夜景人像要求主体锐利、背景柔和分离；不得出现深景深题材整体发虚或浅景深题材背景抢戏",
    "无文字、无水印、无多余手指/肢体，无第二张脸",
    "场景与镜头卡一致（地点/时段/道具），且没有出现定妆照里的中性背景",
    /**
     * 通用空间/物理自洽（2026-09-24 机制化）：
     * 这条**不对场景做任何枚举**，而是给出"任何画面都必须成立"的物理不变量——
     * 起因：「无头之桥」（水面上一条看不到桥头、看不出通往何处的桥面）能通过关键帧与视频两道门，
     * 因为当时 rubric 只查人物一致性/肢体/构图，没有"结构是否成立"这一类目。
     * 穷举场景（桥/栈道/台阶…）永远有漏网，唯一可扩展的做法是把**物理不变量**写进评审层。
     */
    "空间与物理自洽（通用，任何场景都要判）：① 结构完整性——画面里的建筑/地形/器物都是有来由、有落点、有支撑的完整结构，不出现悬空构件、断裂结构、无来由的延伸；② 尺度关系——人物与环境元素的尺度比合理（门高于人、栏杆到腰、路宽于步幅、器物可被手持）；③ 透视一致——同一场景内线性元素共享地平线与消失点，不出现两套透视；④ 光影一致——光向/色温/阴影方向与时段相符，物体与地面有接触阴影；⑤ 接触与承重——脚踩地、手有支撑、道具被真实承重，无穿模与漂浮",
    /**
     * 环境真实性（2026-09-27 真机事故命名化）：
     * 8 镜**全部通过监制**、但产品所有者一眼看出"空间布景不像实拍"。取证结论是必然的：
     * 旧 rubric 只有"场景与镜头卡一致"——**镜头卡本身写的就是空词**（"现代简约商务空间"），
     * 于是"一致"与"真实"之间没有任何判据。模型拿空词只能落回训练分布的**平均办公室**。
     * 这一类目把"像实拍"拆成可判的四件事：空间实指 / 材质工艺与使用状态 / 场景内实用光源 / 使用痕迹。
     * 与 `packages/video-studio/src/scene-bible.ts#environmentDefects` 同源（那里是确定性规则，这里是视觉复核）。
     */
    "环境真实性（必判）：空间是**可指认的真实场所**而不是平均样板间——能读出空间类型与实指（年代/地段/建筑性质/朝向/时段），材质带**工艺与使用状态**（如「胡桃木哑光打蜡 + 中央咖啡杯痕」「微水泥批刀痕 + 两处细裂纹」），灯光含**场景内实用光源**（窗光/筒灯/台灯/屏幕光，方向与色温可读），画面存在**使用痕迹**（指纹/水渍/卷边/划痕/薄灰/旧钉眼）。判红：无任何使用痕迹的样板间、一眼影棚（柔光箱/反光板做主光）、材质只停留在一级名词（「原木」「浅色墙」）而无工艺与状态、空间空旷到与人物活动不符",
    /**
     * 道具-人体交互逻辑（2026-09-27 badcase 命名化）：
     * 真机成片里出现「手机屏幕朝向观众」——观众读到的是"主播把手机举给你看"，而剧本里明明是主播自己在看。
     * 这类错误的共性是**道具与人的物理关系没被声明也没被复核**：谁拿、怎么拿、朝向谁、挡住什么。
     * 判据与 `scene-bible.ts#propInteraction` 同源（prop/orientation/operatedBy/contact/occlusion）。
     */
    "道具-人体交互逻辑（必判）：被手持或被操作的器物（手机/平板/遥控器/键盘/鼠标/相机/麦克风/笔记本）必须有成立的物理关系——**屏幕朝向它的使用者**（观众只见机身背面或侧缘，不出现屏幕内容正对镜头）、有承重与接触（立于支架、置于桌面、手指遮挡范围合理）、操作者有明确操作姿态（手指落点与界面一致）。判红：屏幕内容朝观众、道具漂浮或穿模、手指数量/长度异常、操作姿态与道具位置矛盾、道具在镜内凭空出现或消失"
    ,
    /**
     * 设备口径（2026-09-27 产品所有者硬约束）：场景里的电子设备**全部使用 2024 年之后的 Apple 设备**。
     * 判据与 `device-policy.ts#DEVICE_ALLOWLIST` 同源（清单是唯一事实源，扩展清单即扩展评审）。
     * 为什么必须在关键帧就判：机型外观（机身比例/材质/颜色/接口）是"一眼可辨"的品牌线索，
     * 一旦关键帧长成杂牌或旧机型，视频段只会把它拍得更清楚。
     */
    "设备口径（必判）：画面里的电子设备（笔记本/台式机/手机/平板/显示器/耳机/键鼠）全部是 2024 年后世代的 Apple 在售机型，且与镜头卡声明的机型一致（机身比例、材质、颜色、接口、键盘布局可辨为该机型）；无其他品牌标识或贴纸、无旧世代或已停产机型外观、无无品牌的通用设备。判红：出现非 Apple 品牌设备、机型与卡片不符、旧世代外观（如厚边框旧笔记本、老式大块头显示器）、同一画面两台外观不一致的「同型号」设备"
  ],
  shot: [
    "桥/栈道类结构（场景含桥、栈道时必判）：整镜内桥体与两端连接保持一致，不出现结构凭空出现/消失、桥面变成悬空步道、桥体与水面的接触关系翻转",
    "肢体语言自然：重心、步态、手部动作有真实物理感，无肢体畸变",
    "表情丰富且与台词情绪一致（眉眼/嘴角有变化，不是面无表情）",
    "口型与台词时长匹配，动作连贯无跳帧感",
    "与前后镜人物形象一致（同脸同服装），无跨镜漂移",
    "空间与物理自洽（通用）：镜头内的场景结构、尺度、透视、光影、接触关系在时间上保持一致，不出现结构凭空出现/消失、物体漂浮或穿模",
    /**
     * 环境真实性与道具交互在**时间维**上的复核（关键帧是一张图，镜头是连续帧）：
     * 真机教训——关键帧看着对，但整镜里材质/光源方向翻转、道具朝向在镜内改变（例如手机屏幕从朝内变成朝镜头），
     * 这类问题只在视频段才暴露，因此 shot 环节必须有同名类目。
     */
    "环境真实性在时间上保持：同一空间的空间锚点、材质工艺、光源方向与色温、使用痕迹跨帧一致，不出现墙面/地面材质在镜内改变、窗光方向翻转、布景道具凭空增减",
    "道具-人体交互逻辑在时间上保持：手机/平板/键盘等被操作道具的朝向、承重与遮挡关系在整镜内保持一致，屏幕始终朝向它的使用者（观众只见背面或侧缘）；不出现道具朝向在镜内改变、从手里跳到桌上、屏幕内容正对镜头",
    /**
     * 设备口径在**时间维**上的复核：机型外观在镜内不能跳变（一半是 MacBook 一半是杂牌），
     * 也不能出现"屏幕从刘海屏变成打孔屏"这类世代混用。
     */
    "设备口径在时间上保持：镜内电子设备均为 2024 年后世代的 Apple 在售机型，机型外观（机身比例/边框/颜色/接口/键盘布局）跨帧一致，不出现品牌标识闪烁、机型在镜内变化、屏幕形态在世代之间跳变"
  ],
  compose: [
    "拼接处无花屏/丢帧/音画不同步，转场自然",
    "总时长与目标一致（±0.5s），分辨率/帧率/像素格式全片统一"
  ],
  color: [
    "肤色不偏色（不蜡黄不发青），暗部不死黑、高光不溢出",
    "影调统一且符合题材（江南水乡：低饱和、月白黛青、暖灯不过饱和）",
    "调色后画质不劣于原片（择优机制：拿不到提升就不调）"
  ],
  subtitle: [
    "字幕在安全区内（避开平台 UI 遮挡区与画面主体面部）",
    "字体/字号/描边与题材匹配，可现度达标（Δ 超过阈值）",
    "时间轴与台词逐条对齐，无错字与断句事故"
  ],
  /**
   * 软字幕轨收口（2026-09-24 补登记）。这个环节一直是**默认阶段**（`mux`），
   * 但因为一直没人跑到它就没人发现 rubric 缺失——真机第一次跑到即 TypeError，
   * 把整条交付链打断在最后一步。补上判据。
   */
  mux: [
    "软字幕轨版可播放，字幕轨可开关（画面与声音轨逐帧 copy、零改动）",
    "时长与母版一致（±0.05s），无重新编码导致的画质劣化",
    "旁挂字幕文件（srt/ass/vtt + 清单）随交付目录齐备，语言标注正确",
    "字幕轨内容与旁挂文件一致（不是两份各说各话）"
  ],
  danmaku: [
    "弹幕不遮挡主体面部与字幕带，密度不过载（并发未超上限）",
    "弹幕内容与画面语境相符，不出现与题材无关的评论",
    "滚动/固定弹幕分层清晰，透明度不淹没画面"
  ],
  bgm: [
    "整片响度达标（−14 LUFS 附近）且真峰值不超 −1 dBTP",
    "人声/环境声时刻 BGM 让位（ducking），不盖台词",
    /**
     * 曲风判据必须**跟着 brief 走**（2026-09-25 真机）：早先写死"江南水乡：温润、中慢、器乐为主"，
     * 于是给城市地标片挑的电子律动曲被按上一部片子的题材打回，点评理由与 brief 直接冲突。
     * 现在只要求"与 brief/平台调性一致"，并把 brief 里的 tone/editingStyle 作为事实依据传进来。
     */
    "曲风与 brief 的题材、平台与剪辑风格一致（城市地标/快剪可走电子律动；抒情纪实走温润器乐），无人声唱歌抢戏",
    "卡点与画面切换点对齐（误差在片长容忍内；快剪片以硬切点为基准）"
  ],
  cover: [
    "钩子文案与成片内容一致（不标题党），主标题 ≤ 9 字/行、最多两行",
    "主体面部不被文字压住，底部平台 UI 遮挡区不放大字",
    "封面与视频首帧风格统一，色彩与调色后母版一致"
  ],
  master: [
    "整片可播放、时长/分辨率/帧率/音轨符合交付规格",
    "五项后期能力（调色/字幕/弹幕/配乐/封面）都在成片里可见",
    "无黑帧、无静音段事故、无编码错误",
    "全片空间与物理自洽（通用）复核：抽检各镜的场景结构完整性、尺度与透视一致性，未出现悬空/断裂结构、漂浮物体或与人物尺度冲突的元素",
    /**
     * 全片环境真实性复核（2026-09-27）：单镜各自的"像实拍"不等于**同一支片子**像实拍——
     * 旧管线每镜独立出关键帧，很容易变成"每镜一个样板间"（同一场戏的会议室换了三次装修）。
     * 终审必须跨镜看三件事：空间是不是同一处、光源方向/时段是否单调推进、材质与使用痕迹是否连续。
     */
    "全片环境一致性与真实性复核：各镜属于同一真实空间（空间实指、材质工艺、光源方向与时段跨镜连续，不是每镜一个样板间）；全片无「屏幕内容朝观众」这类道具-人体物理关系错误；使用痕迹与材质在镜间可辩认为同一空间",
    /**
     * 全片设备口径复核（2026-09-27 产品所有者硬约束）：跨镜看"设备是不是同一批 2024+ Apple 机型"——
     * 单镜各自合规、跨镜却换了机型/品牌，是终端观众最容易一眼识破的破绽。
     */
    "全片设备口径复核：所有镜头里的电子设备均为 2024 年后世代的 Apple 在售机型；同一台设备跨镜外观一致（同机型同颜色同接口），不出现品牌标识、旧世代机型或杂牌设备；设备外观与镜头卡声明一致"
  ]
};

export interface ProducerGateOptions {
  stage: ProducerStage;
  projectId: string;
  artifacts: ProducerArtifact[];
  deterministic: DeterministicCheck[];
  /** Required measured checks cannot be omitted or represented by a soft score. */
  requiredCheckIds?: string[];
  minScore?: number;
  /** 覆盖默认评审要点 */
  rubric?: string[];
  /** 画面类环节可附视觉基准（如定妆照）做一致性比对 */
  referenceImages?: string[];
  context?: Record<string, unknown>;
  /** @deprecated 仅为旧调用方保留；不会授予正式通过资格。 */
  allowFallbackApprove?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /**
   * 评审图压缩器（2026-09-24 三轮审计）：送审图大于预算时调用，返回压缩后的图片路径（失败返回 null）。
   * 默认实现用 ffmpeg 缩到 720 宽 JPEG；测试注入替身，避免单测依赖 ffmpeg。
   */
  shrinkImage?: (path: string) => string | null;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 解析评审模型（与 model-router 的 LLM_* 口径一致，兼容 DEEPSEEK_* 秘密文件） */
export function resolveProducerLlm(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const baseUrl = env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "";
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? "";
  const model = env.LLM_MODEL ?? env.DEEPSEEK_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

function summarizeArtifacts(artifacts: ProducerArtifact[]): string {
  return artifacts.map((a) => {
    const probe = a.probe ? ` ${JSON.stringify(a.probe)}` : "";
    const bytes = typeof a.bytes === "number" ? ` ${(a.bytes / 1024).toFixed(0)}KB` : "";
    return `- [${a.kind}] ${a.path}${bytes}${probe}${a.note ? ` — ${a.note}` : ""}`;
  }).join("\n");
}

/**
 * 单张送审图预算（2026-09-24 三轮审计，真机事故复现）：
 * 视频抽帧是 1080×1920 的 PNG，单张 ≈10MB；4 张产物帧 + 2 张基准图一起 base64 后 **≈53MB**，
 * 评审模型的网关直接返回 `HTTP 413 Request Entity Too Large` → 监制判为"不可用"、镜头悬空（既没通过也没真打回）。
 * 超预算先缩到720宽JPEG；压缩不可用或仍超预算时返回未验证，不静默丢图或赌超大请求。
 */
const JUDGE_IMAGE_BUDGET_BYTES = 900_000;

/** 默认压缩器：ffmpeg 缩到 720 宽 JPEG（失败返回 null，由调用方如实降级） */
function shrinkImageWithFfmpeg(path: string): string | null {
  const bin = process.env.WL_FFMPEG ?? "ffmpeg";
  const out = join(tmpdir(), `producer-judge-${randomUUID()}.jpg`);
  const res = spawnSync(bin, [
    "-hide_banner", "-v", "error", "-y", "-i", path,
    "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", out
  ], { timeout: 30_000 });
  if (res.status !== 0 || !existsSync(out) || statSync(out).size >= statSync(path).size) {
    rmSync(out, { force: true });
    return null;
  }
  return out;
}

/**
 * 解析评审模型输出的 JSON：
 *   ① 直接解析（剥掉可能的 ``` 包裹）；
 *   ② 取第一个 `{` 到最后一个 `}` 的片段再解析（裁掉解释性前后缀）；
 *   ③ 仍失败 → 让模型"只重发合法 JSON"自修复一次；
 *   ④ 还失败 → 抛错（调用方按"评审不可用"fail-closed 处理）。
 */
async function parseJudgeJson(
  raw: string,
  llm: LlmConfig,
  fetchImpl: typeof fetch,
  log: (line: string) => void,
  stage: ProducerStage
): Promise<Record<string, unknown>> {
  const stripped = raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stripped);
  if (direct) return direct;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(stripped.slice(start, end + 1));
    if (sliced) return sliced;
  }
  log(`[producer][${stage}] 评审输出不是合法 JSON，要求模型自修复一次`);
  const repair = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "user", content: "把下面这段内容整理成**严格合法**的 JSON（只输出 JSON，不要任何解释、不要 markdown）：\n\n" + raw.slice(0, 4000) }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const repairText = await repair.text();
  if (!repair.ok) throw new Error(`评审 JSON 修复失败：HTTP ${repair.status} ${repairText.slice(0, 160)}`);
  const repaired = (JSON.parse(repairText) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  const fixed = tryParse(repaired.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim());
  if (!fixed) throw new Error(`评审 JSON 修复后仍非法：${repaired.slice(0, 160)}`);
  return fixed;
}

/**
 * 评审一个环节。返回裁决；调用方按 `approved` 决定放行或重跑。
 */
export async function reviewStage(options: ProducerGateOptions): Promise<ProducerVerdict> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const stage = options.stage;
  const rubric = options.rubric ?? PRODUCER_RUBRICS[stage];
  const hardFailures = options.deterministic.filter((c) => c.hard === true && (c.status === "failed" || (c.status === undefined && c.pass === false))).map((c) => `${c.id}：${c.detail}`);
  const softFailures = options.deterministic.filter((c) => c.pass === false).map((c) => `${c.id}：${c.detail}`);

  /** ① 硬闸：任一失败直接打回 */
  if (hardFailures.length > 0) {
    log(`[producer][${stage}] 硬闸失败，打回重跑：${hardFailures.join("；")}`);
    return {
      stage,
      status: "failed",
      approved: false,
      score: 0,
      hardFailures,
      issues: softFailures,
      suggestions: [`按硬闸失败项修复后重跑本环节：${hardFailures[0]}`],
      rerun: true,
      via: "deterministic",
      ms: Date.now() - started,
      reason: `确定性硬闸未通过（${hardFailures.length} 项）`,
      degraded: false
    };
  }

  const evidence: NonNullable<ProducerVerdict["evidence"]> = [];
  const reject = (reason: string, via: ProducerVerdict["via"] = "deterministic", model?: string): ProducerVerdict => ({
    stage, status: "unverified", approved: false, score: 0, hardFailures: [],
    issues: [...softFailures, reason], suggestions: ["补齐有效证据或修复评审组件后重跑本环节"],
    rerun: true, via, model, ms: Date.now() - started, reason, degraded: true, evidence
  });
  const required = new Set(options.requiredCheckIds ?? []);
  // This visual/text adapter cannot listen. Acoustic quality requires a component receipt.
  if (stage === "bgm" || stage === "master") required.add("audio-review");
  for (const id of required) {
    const checks = options.deterministic.filter((c) => c.id === id);
    if (checks.length !== 1 || (checks[0]?.status !== undefined && checks[0]?.status !== "passed") || checks[0]?.pass !== true) return reject(`缺少已通过的必需证据：${id}`);
  }
  if (options.deterministic.some((c) => c.hard && (c.status === "unverified" || (c.status !== "not_applicable" && c.pass !== true)))) return reject("必需质量检查未验证");
  const llm = resolveProducerLlm(options.env ?? process.env);
  if (!llm) return reject("无可用评审模型；降级只能预览，不能作为合格交付", "fallback");
  const minScore = options.minScore ?? 70;
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) return reject("评审分数阈值非法");
  const tempPaths: string[] = [];
  const textContent: Array<Record<string, unknown>> = [];
  const images: Array<{ path: string; label: string }> = [];
  let totalText = 0;
  try {
    if (options.artifacts.length === 0) throw new Error("缺少待评审产物");
    for (const artifact of options.artifacts) {
      const stat = statSync(artifact.path);
      if (!stat.isFile() || stat.size === 0) throw new Error(`产物为空或不是文件：${artifact.path}`);
      if (stat.size > 1_000_000_000) throw new Error(`产物超过单次评审资源上限：${artifact.path}`);
      const bytes = readFileSync(artifact.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (artifact.kind === "audio") throw new Error(`当前评审适配器不支持音频内容：${artifact.path}；需要音频评审组件`);
      if (artifact.kind === "text" || artifact.kind === "json") {
        const raw = bytes.toString("utf8");
        if (artifact.kind === "json") JSON.parse(raw);
        totalText += raw.length;
        if (totalText > 100_000) throw new Error("文本证据超出本次完整评审预算；需拆分评审，禁止截断后通过");
        textContent.push({ type: "text", text: `以下是产物正文（完整）：${artifact.path}\n${raw}` });
        evidence.push({ path: artifact.path, sha256, scope: "complete-text" });
      } else if (artifact.kind === "image") {
        images.push({ path: artifact.path, label: "待评审产物" });
        evidence.push({ path: artifact.path, sha256, scope: "image" });
      } else if (artifact.kind === "video") {
        const probe = spawnSync(process.env.WL_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", artifact.path], { encoding: "utf8", timeout: 30_000 });
        if (probe.status !== 0) throw new Error(`视频探测失败：${artifact.path}`);
        const duration = Number(JSON.parse(probe.stdout).format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error(`视频时长无效：${artifact.path}`);
        const dir = mkdtempSync(join(tmpdir(), "producer-frames-")); tempPaths.push(dir);
        const timestamps = [0, 0.2, 0.4, 0.6, 0.8].map((r) => duration * r);
        for (const [index, at] of timestamps.entries()) {
          const path = join(dir, `${index}.jpg`);
          const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", artifact.path, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", path], { timeout: 30_000 });
          if (result.status !== 0 || !existsSync(path)) throw new Error(`视频时序抽帧失败：${artifact.path}@${at}`);
          images.push({ path, label: `视频 ${artifact.path} 时间 ${at.toFixed(3)}s，按序比较` });
        }
        evidence.push({ path: artifact.path, sha256, scope: `temporal-sample:${timestamps.map((t) => t.toFixed(3)).join(",")}; audio-not-reviewed` });
      }
    }
    const artifactImages = images.length;
    if ((options.referenceImages?.length ?? 0) > 6) throw new Error("基准图超过单次对比预算，需按角色拆分评审");
    for (const path of options.referenceImages ?? []) {
      const bytes = readFileSync(path);
      evidence.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), scope: "reference-image" });
      images.push({ path, label: "基准图" });
    }
    if (images.length > 60) throw new Error("图像证据超过完整评审预算，需按镜头拆分；禁止静默丢图");
    const visualStages = ["keyframe", "shot", "compose", "color", "subtitle", "mux", "danmaku", "cover", "master"];
    if (visualStages.includes(stage) && !artifactImages) throw new Error("画面评审缺少实际图像或可抽帧视频");
    const encoded: Array<Record<string, unknown>[]> = [];
    for (const image of images) {
      let path = image.path;
      let bytes = readFileSync(path);
      if (bytes.length > JUDGE_IMAGE_BUDGET_BYTES) {
        const shrunk = (options.shrinkImage ?? shrinkImageWithFfmpeg)(path);
        if (!shrunk) throw new Error(`送审图压缩失败：${path}`);
        if (shrunk !== path) tempPaths.push(shrunk);
        path = shrunk; bytes = readFileSync(path);
      }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      if (!(png || jpeg || webp) || bytes.length > JUDGE_IMAGE_BUDGET_BYTES) throw new Error(`图像内容无效或仍超预算：${image.path}`);
      encoded.push([{ type: "text", text: image.label }, { type: "image_url", image_url: { url: `data:${png ? "image/png" : jpeg ? "image/jpeg" : "image/webp"};base64,${bytes.toString("base64")}` } }]);
    }
    const context = options.context ? JSON.stringify(options.context) : "";
    if (context.length > 30_000) throw new Error("评审上下文超预算，禁止截断事实");
    const batches = Math.max(1, Math.ceil(artifactImages / 6));
    const answers: Array<{ approved: boolean; score: number; issues: string[]; suggestions: string[]; reason: string }> = [];
    for (let batch = 0; batch < batches; batch += 1) {
      const content = [{ type: "text", text: [
        `你是视频监制。项目 ${options.projectId}，环节 ${stage}，证据批次 ${batch + 1}/${batches}。`,
        ...rubric.map((r, i) => `${i + 1}. ${r}`),
        "只评审实际收到的证据，视频为带时间戳抽帧，不代表逐帧、口型或听音验证。缺证据必须拒绝，不能猜测。",
        summarizeArtifacts(options.artifacts),
        "确定性检查（含失败与不适用）：", ...options.deterministic.map((c) => `${c.id}: ${c.status ?? (c.pass ? "passed" : "failed")} ${c.detail}`),
        context,
        '只输出 JSON: {"approved":true|false,"score":0-100,"issues":[],"suggestions":[],"reason":"结论"}'
      ].join("\n") }, ...textContent, ...encoded.slice(batch * 6, Math.min(artifactImages, (batch + 1) * 6)).flat(), ...encoded.slice(artifactImages).flat()];
      const res = await (options.fetchImpl ?? fetch)(`${llm.baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({ model: llm.model, messages: [{ role: "user", content }], temperature: 0.2, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(180_000)
      });
      const rawBody = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${rawBody.slice(0, 160)}`);
      const raw = JSON.parse(rawBody).choices?.[0]?.message?.content;
      if (typeof raw !== "string") throw new Error("评审模型缺少文本结果");
      const json = await parseJudgeJson(raw, llm, options.fetchImpl ?? fetch, log, stage);
      if (typeof json.approved !== "boolean" || typeof json.score !== "number" || !Number.isFinite(json.score) || json.score < 0 || json.score > 100
        || !Array.isArray(json.issues) || !json.issues.every((x) => typeof x === "string")
        || !Array.isArray(json.suggestions) || !json.suggestions.every((x) => typeof x === "string") || typeof json.reason !== "string") throw new Error("评审结果结构非法");
      answers.push(json as typeof answers[number]);
    }
    for (const item of evidence) {
      const currentHash = createHash("sha256").update(readFileSync(item.path)).digest("hex");
      if (currentHash !== item.sha256) throw new Error(`评审期间产物发生变化：${item.path}`);
    }
    const approved = answers.every((a) => a.approved && a.score >= minScore);
    return { stage, status: approved ? "passed" : "failed", approved, score: Math.min(...answers.map((a) => a.score)),
      hardFailures: [], issues: [...softFailures, ...answers.flatMap((a) => a.issues)], suggestions: answers.flatMap((a) => a.suggestions),
      rerun: !approved, via: "llm", model: llm.model, ms: Date.now() - started,
      reason: answers.map((a) => a.reason).join("；") + (approved ? "" : `（所有证据批次需通过且评分≥${minScore}）`), degraded: false, evidence };
  } catch (err) {
    return reject(err instanceof Error ? err.message : String(err), "fallback", llm.model);
  } finally {
    for (const path of tempPaths) {
      try { rmSync(path, { recursive: true, force: true }); }
      catch (err) { log(`[producer] 临时证据清理失败：${path}：${String(err)}`); }
    }
  }
}
