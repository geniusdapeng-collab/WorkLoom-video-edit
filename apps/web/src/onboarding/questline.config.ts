/**
 * questline.config · 「懂汇报的狐狸先生」首日上岗内容包（酒店获客口径）
 *
 * 结构上刻意与行业包对齐：NPC 人设 / 员工卡 / 目标模板 / 首单任务卡 / 成就 / 价值口径 / 下一步。
 * 员工卡与首单卡引用的 presetKey 必须是本仓 `bundles/hotel/presets/*.yml` 里真实存在的岗位
 * （questline.test.ts 有门禁断言），台账口径与酒店基线围栏 R1/R2/R6 逐字对齐。
 * 生产化方向（本次不做）：迁到 `bundles/<industry>/onboarding/*.yml`，由
 * `industry-contract` 的 Bundle 投影提供，基座只保留 `questline.ts` 的机制。
 *
 * 内容纪律：
 *  - 员工卡里的岗位、职责、航道（围栏）必须与 `bundles/hotel/presets/*.yml` 一致，不自造岗位；
 *  - 任何"示例数字"必须带 `sample: true` 标注，界面按演示数据处理；
 *  - 台词每关至少 3 句（进场/等待/过关），单句控制在 42 字以内（"三句话汇报"节奏）。
 */
import type { VoiceProfile } from "../voice/VoiceEngine";
import type { QuestStageId } from "./questline";

export interface QuestScript {
  enter: string;
  hint: string;
  success: string;
}

export interface QuestStageDef {
  id: QuestStageId;
  badge: string;
  title: string;
  objective: string;
  primaryLabel: string;
  script: QuestScript;
}

export interface EmployeeCardDef {
  id: string;
  presetKey: string;
  title: string;
  duty: string;
  /** 航道许可（围栏）——直接引用行业包规则名 */
  fences: string[];
  tasks: string[];
  /** 示例产出（演示数据，界面必须标注） */
  sample: string;
  sampleIsDemo: boolean;
}

export interface GoalTemplateDef {
  id: string;
  title: string;
  metric: string;
  ownerPresetKey: string;
  ownerTitle: string;
  artifact: string;
  steps: number;
  approvals: number;
}

export interface TaskCardDef {
  id: string;
  title: string;
  ownerPresetKey: string;
  ownerTitle: string;
  steps: number;
  eta: string;
  artifact: string;
  approvals: number;
  credits: number;
  /** 派单时给数字员工的指令原文（走真实 threads.dispatch 通道） */
  dispatchTitle: string;
}

export interface AchievementDef {
  id: string;
  title: string;
  hint: string;
  icon: "rocket" | "team" | "tasks" | "approval" | "celebrate";
  /** 解锁来源关卡，便于 HUD 展示"在哪一关拿到" */
  stage: QuestStageId;
}

export interface ValueMetricDef {
  id: string;
  label: string;
  unit: string;
  /** 数据来源说明（禁止编数） */
  source: string;
}

export interface NextStepDef {
  id: "night_shift" | "real_data" | "customize";
  title: string;
  desc: string;
  to: string;
}

/**
 * 驳回原因（受控枚举）。必须来自当前 Bundle 装配的反馈枚举表
 * （`bundles/<industry>/feedback-enums.yml`，服务端会校验 code 是否登记）；
 * 未装配枚举表的行业包不校验 code，但标签仍须说人话。
 */
export interface RejectReasonDef {
  code: string;
  label: string;
}

export interface QuestlineConfig {
  journeyName: string;
  mateName: string;
  mateRole: string;
  ownerTitle: string;
  mateVoice: VoiceProfile;
  stages: QuestStageDef[];
  employees: EmployeeCardDef[];
  goals: GoalTemplateDef[];
  tasks: TaskCardDef[];
  achievements: AchievementDef[];
  values: ValueMetricDef[];
  nextSteps: NextStepDef[];
  rejectReasons: RejectReasonDef[];
}

/* ================= 跨行业共用件（机制与行业内容分离） ================= */

/**
 * 成就墙与关卡一一对应，语义与行业无关，因此三套内容包共用同一份定义。
 * 纪律：成就只由真实事实或客户操作解锁（见 questline.ts 的 unlockAchievements 调用点）。
 */
export const QUEST_ACHIEVEMENTS: AchievementDef[] = [
  { id: "aboard", title: "首航就绪", hint: "完成首次欢迎仪式", icon: "rocket", stage: "meet" },
  { id: "three-keepers", title: "三位当家人", hint: "认识业务、对外、账目的负责人", icon: "team", stage: "meet" },
  { id: "first-dispatch", title: "第一次派活", hint: "把第一件活交给数字员工", icon: "tasks", stage: "dispatch" },
  { id: "first-decision", title: "第一次拍板", hint: "完成一次真实审批", icon: "approval", stage: "approve" },
  { id: "first-close", title: "首次闭环", hint: "首单产出被验收", icon: "celebrate", stage: "review" },
];

/** 价值计数口径：三项都标明数据来源，界面不得出现无出处的数字 */
export const QUEST_VALUES: ValueMetricDef[] = [
  { id: "auto-work", label: "已自主完成", unit: "项作业", source: "工作区事件账本（真实计数）" },
  { id: "pending", label: "待您拍板", unit: "项", source: "审批队列（真实计数）" },
  { id: "on-duty", label: "团队在岗", unit: "人", source: "当前 Bundle 编制（真实计数）" },
];

/** 完成页的三个通用出口（页面路由与行业无关） */
export const QUEST_NEXT_STEPS: NextStepDef[] = [
  { id: "night_shift", title: "开启夜班", desc: "您睡觉的时候，他们接着干；明早 8:30 给您战报。", to: "/executive" },
  { id: "real_data", title: "接入真实数据与大模型", desc: "把演示数据换成您自己的经营数据与内容资产。", to: "/onboarding" },
  { id: "customize", title: "定制我的行业版", desc: "隔离编制 + 上岗考，换一批适合您业态的人。", to: "/onboarding?mode=customize" },
];

/**
 * 行业无关的五关文案（不含任何行业词）。
 * 行业包若要自己的口吻，整段覆盖 stages 即可（酒店包就是这样做的人话版）。
 */
export function genericStages(): QuestStageDef[] {
  return [
    {
      id: "meet",
      badge: "认人",
      title: "第 1 关 · 认识三位当家人",
      objective: "知道谁在替您管业务、谁对外发声、谁盯账目，以及他们什么时候必须来问您。",
      primaryLabel: "都认识了",
      script: {
        enter: "董事长，三句话向您汇报：班组已经全部在岗，今天就能干活，但先认识三位当家人。",
        hint: "点一下卡片就算认识了。也可以换一批，或者先跳过。",
        success: "认全了。以后有事，您直接找他们三个就行。",
      },
    },
    {
      id: "goal",
      badge: "定目标",
      title: "第 2 关 · 今天最想解决的一件事",
      objective: "给团队一个明确方向；系统会告诉您谁负责、几步做完、什么时候来问您。",
      primaryLabel: "就按这个来",
      script: {
        enter: "团队干活得先知道您要什么。选一个，或者直接跟我说一句。",
        hint: "三个选项都是本行业最常操心的事；也可以直接说您自己的目标。",
        success: "收到。我把它拆成任务，派给该负责的人。",
      },
    },
    {
      id: "dispatch",
      badge: "派活",
      title: "第 3 关 · 把第一件活交出去",
      objective: "亲手派一单，看着它被执行——这是您第一次当「甩手掌柜」。",
      primaryLabel: "派给他",
      script: {
        enter: "光看不算数，得派一单试试。看中哪张卡，拖到人身上也行。",
        hint: "每张卡都写清了：谁做、几步、多久、产出什么、要您拍板几次。",
        success: "活已经派出去了，进度我帮您盯着。",
      },
    },
    {
      id: "approve",
      badge: "拍板",
      title: "第 4 关 · 第一次行使拍板权",
      objective: "在高风险动作上做一次真实决策——AI 永远不替您拍板。",
      primaryLabel: "就这样定",
      script: {
        enter: "这事按您定的航道必须您拍板。改前改后和依据都在这儿。",
        hint: "批准、修改、驳回都行；驳回想写原因就写一句。",
        success: "记下了，全链留痕。以后这种事只找您一次。",
      },
    },
    {
      id: "review",
      badge: "验收",
      title: "第 5 关 · 看看今天赚了什么",
      objective: "验收产出、看到价值计数，并决定下一步往哪走。",
      primaryLabel: "我看到了",
      script: {
        enter: "活干完了。您花了几分钟，团队替您跑了这些事——我念给您听。",
        hint: "没有回执的事我不会说「已完成」，这几项都是账本里查得到的。",
        success: "首日上岗完成。从今晚开始，夜班也能交给他们。",
      },
    },
  ];
}

/** 狐狸先生音色：沉稳、比织伴略低略慢，避免两个角色在字幕条上被认成同一个人 */
export const FOX_MATE_VOICE: VoiceProfile = {
  // 与织伴（pitch 1.04 / rate 0.94）拉开辨识度：汇报官更低更慢，客户盲听能分清两个人。
  // 本机实测 zh-CN 可用男声只有 Li-Mu（Eddy/Reed/Flo 一族无 boundary，已由 VoiceEngine 降级兜底）。
  pitch: 0.86,
  rate: 0.94,
  // Eddy/Reed/Flo 一族在 zh-CN 下不出 boundary（口型不同步），由 VoiceEngine 降级兜底；
  // 这里显式登记本机可用男声（Li-Mu / 云希 / 云健），保证狐狸先生与织伴在音色上分得开。
  preferredNames: ["Eddy", "Reed", "Yunxi", "Yunjian", "云希", "云健", "李沐", "Li-Mu"],
};

export const QUESTLINE: QuestlineConfig = {
  journeyName: "首日上岗",
  mateName: "狐狸先生",
  mateRole: "汇报官 · 带玩向导",
  ownerTitle: "董事长",
  mateVoice: FOX_MATE_VOICE,

  stages: [
    {
      id: "meet",
      badge: "认人",
      title: "第 1 关 · 认识三位当家人",
      objective: "知道谁在替您管房价、口碑和账目，以及他们什么时候必须来问您。",
      primaryLabel: "都认识了",
      script: {
        enter: "董事长，三句话向您汇报：班组已经全部在岗，今天就能干活，但先认识三位当家人。",
        hint: "点一下卡片就算认识了。也可以换一批，或者先跳过。",
        success: "认全了。以后有事，您直接找他们三个就行。",
      },
    },
    {
      id: "goal",
      badge: "定目标",
      title: "第 2 关 · 今天最想解决的一件事",
      objective: "给团队一个明确方向；系统会告诉您谁负责、几步做完、什么时候来问您。",
      primaryLabel: "就按这个来",
      script: {
        enter: "团队干活得先知道您要什么。选一个，或者直接跟我说一句。",
        hint: "三个选项都是酒店最常操心的：差评、房价、账目。",
        success: "收到。我把它拆成任务，派给该负责的人。",
      },
    },
    {
      id: "dispatch",
      badge: "派活",
      title: "第 3 关 · 把第一件活交出去",
      objective: "亲手派一单，看着它被执行——这是您第一次当「甩手掌柜」。",
      primaryLabel: "派给他",
      script: {
        enter: "光看不算数，得派一单试试。看中哪张卡，拖到人身上也行。",
        hint: "每张卡都写清了：谁做、几步、多久、产出什么、要您拍板几次。",
        success: "活已经派出去了，进度我帮您盯着。",
      },
    },
    {
      id: "approve",
      badge: "拍板",
      title: "第 4 关 · 第一次行使董事长权力",
      objective: "在高风险动作上做一次真实决策——AI 永远不替您拍板。",
      primaryLabel: "就这样定",
      script: {
        enter: "这事按您定的航道必须您拍板。改前改后和依据都在这儿。",
        hint: "批准、修改、驳回都行；驳回想写原因就写一句。",
        success: "记下了，全链留痕。以后这种事只找您一次。",
      },
    },
    {
      id: "review",
      badge: "验收",
      title: "第 5 关 · 看看今天赚了什么",
      objective: "验收产出、看到价值计数，并决定下一步往哪走。",
      primaryLabel: "我看到了",
      script: {
        enter: "活干完了。您花了几分钟，团队替您跑了这些事——我念给您听。",
        hint: "没有回执的事我不会说「已完成」，这几项都是账本里查得到的。",
        success: "首日上岗完成。从今晚开始，夜班也能交给他们。",
      },
    },
  ],

  employees: [
    {
      id: "pricing",
      presetKey: "pricing-agent",
      title: "收益定价官",
      duty: "盯着竞对、房态和历史曲线，给出该涨该降的建议，并在授权范围内直接改价。",
      fences: ["R1 · 涨幅 ≤8% 自动执行", "R2 · 不低于保底价 ¥380"],
      tasks: ["复核今日房价建议", "盘点今日订单", "查看房态异常"],
      sample: "今天竞对三家的均价、您的房态缺口、建议调整的三个房型",
      sampleIsDemo: true,
    },
    {
      id: "review",
      presetKey: "review-agent",
      title: "口碑公关官",
      duty: "值守各渠道新评价，差评先写回复草稿，外发前一定请您过目。",
      fences: ["3 分以下差评必审挂起", "对外回复未经批准不外发"],
      tasks: ["处理今日住客诉求", "回复差评草稿", "复盘口碑走势"],
      sample: "今天 2 条差评的回复草稿 + 命中原因（卫生、噪音）",
      sampleIsDemo: true,
    },
    {
      id: "reconcile",
      presetKey: "reconcile-agent",
      title: "财务司库官",
      duty: "夜里把订单、结算、担保逐笔核对；大额退款和异常账单一定请您拍板。",
      fences: ["大额退款必审", "担保异常必须人工介入"],
      tasks: ["检查夜班交接", "复核订单对账", "查看异常账单"],
      sample: "昨夜 3 笔差异订单 + 建议处置方式（补登、退款、挂账）",
      sampleIsDemo: true,
    },
    {
      id: "inspection",
      presetKey: "inspection-agent",
      title: "品质巡检官",
      duty: "每天 07:00 只读巡检：价格、房态、评价、违规；异常分级推送，一键派单。",
      fences: ["只读巡检，不改任何渠道数据", "异常只推送与派单"],
      tasks: ["查看今日房态异常", "检查渠道价格", "复查评价违规"],
      sample: "今晨巡检发现的 2 处价格倒挂、1 处超售风险",
      sampleIsDemo: true,
    },
    {
      id: "frontdesk",
      presetKey: "frontdesk-agent",
      title: "前台接待官",
      duty: "入住退房辅助、订单处理、电话呼入记录与交接班清单，夜审协同。",
      fences: ["订单改价需审批", "住客隐私不外发"],
      tasks: ["处理今日住客诉求", "生成交接班清单", "跟进待入住订单"],
      sample: "今日 12 张待入住订单 + 3 条住客特殊需求",
      sampleIsDemo: true,
    },
  ],

  goals: [
    {
      id: "review-fast",
      title: "差评不过夜",
      metric: "差评 2 小时内响应率 100%",
      ownerPresetKey: "review-agent",
      ownerTitle: "口碑公关官",
      artifact: "今日差评处置清单（含回复草稿）",
      steps: 3,
      approvals: 1,
    },
    {
      id: "price-safe",
      title: "房价不踏空",
      metric: "未来 7 天不空房、也不跌破保底价",
      ownerPresetKey: "pricing-agent",
      ownerTitle: "收益定价官",
      artifact: "未来 7 天价格建议表",
      steps: 4,
      approvals: 2,
    },
    {
      id: "books-clear",
      title: "账目不过夜",
      metric: "昨日订单 100% 对平",
      ownerPresetKey: "reconcile-agent",
      ownerTitle: "财务司库官",
      artifact: "昨日对账差异单",
      steps: 3,
      approvals: 1,
    },
  ],

  tasks: [
    {
      id: "inspect-today",
      title: "查一遍今天的房态与价格异常",
      ownerPresetKey: "inspection-agent",
      ownerTitle: "品质巡检官",
      steps: 3,
      eta: "约 2 分钟",
      artifact: "异常清单（价格倒挂 / 超售 / 渠道违规）",
      approvals: 0,
      credits: 12,
      dispatchTitle: "巡检今天的房态与渠道价格，产出异常清单与处置建议",
    },
    {
      id: "guest-request",
      title: "处理今天住客的诉求",
      ownerPresetKey: "frontdesk-agent",
      ownerTitle: "前台接待官",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "诉求处置记录 + 需要您拍板的补偿方案",
      approvals: 1,
      credits: 18,
      dispatchTitle: "处理今天住客的诉求，输出处置记录与需要董事长拍板的方案",
    },
    {
      id: "price-review",
      title: "复核今天的房价建议",
      ownerPresetKey: "pricing-agent",
      ownerTitle: "收益定价官",
      steps: 4,
      eta: "约 4 分钟",
      artifact: "调价建议表（含依据与保底价校验）",
      approvals: 1,
      credits: 24,
      dispatchTitle: "复核今天的房价建议，给出调价依据与保底价校验，越线部分提请审批",
    },
  ],

  achievements: QUEST_ACHIEVEMENTS,

  values: QUEST_VALUES,

  nextSteps: QUEST_NEXT_STEPS,

  // 酒店包枚举表（bundles/hotel/feedback-enums.yml）：服务端会校验 code 已登记
  rejectReasons: [
    { code: "price.too_high", label: "涨幅过大" },
    { code: "data.stale", label: "依据不足" },
    { code: "other", label: "其他（我补一句）" },
  ],
};

/* ================= GEO 获客内容包（geo-growth Bundle） ================= */

/**
 * GEO 双域获客内容包：员工卡只引用 `bundles/geo-growth/presets/*.yml` 里真实存在的岗位，
 * 围栏口径与 `geo-growth-baseline` 逐条对齐（G-GEO1/G-GEO2/G12/G9a/G10b…）。
 * 派单指令写的是「可交付的活」——必须能被意图路由判成 quest，否则首单没有产出可验收。
 */
export const QUESTLINE_GEO: QuestlineConfig = {
  journeyName: "首日上岗",
  mateName: "狐狸先生",
  mateRole: "汇报官 · 带玩向导",
  ownerTitle: "董事长",
  mateVoice: FOX_MATE_VOICE,

  stages: genericStages(),

  employees: [
    {
      id: "content",
      presetKey: "geo-content-planner",
      title: "GEO 内容策划",
      duty: "把选题写成 AI 搜索与短视频都能用的内容；对外发布一律先过审。",
      fences: ["G-GEO1 · 内容外发必审", "G-GEO2 · 事实红线一票否决"],
      tasks: ["生成本周双域内容", "整理引用源清单", "改写短视频脚本"],
      sample: "本周 5 条选题的双域版本 + 每条引用的来源链",
      sampleIsDemo: true,
    },
    {
      id: "ads",
      presetKey: "ads-optimizer",
      title: "投放优化师",
      duty: "盯投放成本与转化，给出加投/停投建议；加投必须您点头才执行。",
      fences: ["G12 · 投放加投必审", "G9b · 单账号日发布超限熔断"],
      tasks: ["复核今日加投建议", "核对投放成本", "排查停投异常"],
      sample: "两个渠道的加投建议 + ROI 与成本依据",
      sampleIsDemo: true,
    },
    {
      id: "attribution",
      presetKey: "review-analyst",
      title: "复盘分析师",
      duty: "把曝光、询盘、成交和内容对上账，回答哪条内容真的带来了生意。",
      fences: ["只读复盘，不改任何渠道数据"],
      tasks: ["生成本周归因复盘", "核对归因链", "查转化异常波动"],
      sample: "上周归因成交额 + 三条高转化内容的来源链",
      sampleIsDemo: true,
    },
    {
      id: "visibility",
      presetKey: "visibility-watcher",
      title: "AI 能见度监测官",
      duty: "盯品牌词在 AI 搜索里的引用与排名变化，掉榜先告警不猜测原因。",
      fences: ["只读监测，异常只推送与派单"],
      tasks: ["查看今日能见度", "核对引用源变化", "派单处理掉榜"],
      sample: "今晨品牌词引用数变化 + 新增/丢失的引用源",
      sampleIsDemo: true,
    },
    {
      id: "intake",
      presetKey: "private-domain-operator",
      title: "私域承接专员",
      duty: "接住评论、私信与落地页的询盘，30 秒首响；报价与承诺必过人审。",
      fences: ["G10b · 咨询/售后回复必审", "G-GEO1 · 对外内容外发必审"],
      tasks: ["处理今日询盘", "核对首响时长", "整理待拍板方案"],
      sample: "今日 6 条询盘的处置记录 + 1 条待拍板的报价方案",
      sampleIsDemo: true,
    },
  ],

  goals: [
    {
      id: "geo-visible",
      title: "AI 搜索里找得到",
      metric: "品牌词被 AI 回答引用的次数周环比上升",
      ownerPresetKey: "geo-content-planner",
      ownerTitle: "GEO 内容策划",
      artifact: "能见度周报（含引用源清单）",
      steps: 4,
      approvals: 1,
    },
    {
      id: "ads-safe",
      title: "投放不失控",
      metric: "加投全部经审，单账号日发布不超限",
      ownerPresetKey: "ads-optimizer",
      ownerTitle: "投放优化师",
      artifact: "加投审批清单（含 ROI 依据）",
      steps: 3,
      approvals: 1,
    },
    {
      id: "lead-fast",
      title: "询盘不过夜",
      metric: "私域询盘 30 秒首响率 100%",
      ownerPresetKey: "private-domain-operator",
      ownerTitle: "私域承接专员",
      artifact: "询盘处置记录",
      steps: 3,
      approvals: 1,
    },
  ],

  tasks: [
    {
      id: "geo-content",
      title: "把本周选题做成双域内容",
      ownerPresetKey: "geo-content-planner",
      ownerTitle: "GEO 内容策划",
      steps: 4,
      eta: "约 4 分钟",
      artifact: "短视频脚本 + GEO 图文 + 引用源清单",
      approvals: 1,
      credits: 24,
      dispatchTitle: "生成本周双域内容（短视频脚本与 GEO 图文），整理引用源清单，发布前提请审批",
    },
    {
      id: "ads-review",
      title: "复核今天的投放加投建议",
      ownerPresetKey: "ads-optimizer",
      ownerTitle: "投放优化师",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "加投建议 + ROI 依据（加投部分提请审批）",
      approvals: 1,
      credits: 18,
      dispatchTitle: "复核今天的投放数据，整理加投建议与 ROI 依据，加投部分提请审批",
    },
    {
      id: "intake-clear",
      title: "处理今天的询盘与评论",
      ownerPresetKey: "private-domain-operator",
      ownerTitle: "私域承接专员",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "询盘处置记录 + 需要拍板的话术方案",
      approvals: 1,
      credits: 12,
      dispatchTitle: "处理今天各渠道的询盘与评论，输出处置记录与需要拍板的话术方案",
    },
  ],

  achievements: QUEST_ACHIEVEMENTS,
  values: QUEST_VALUES,
  nextSteps: QUEST_NEXT_STEPS,

  /**
   * geo-growth 目前**没有** feedback-enums.yml（第⑧槽未装配），服务端因此不校验 code。
   * 这里只取跨行业通用码（data.stale / fact.risk / other），不新造行业私有码，
   * 免得将来补上枚举表时历史归因链对不上。
   */
  rejectReasons: [
    { code: "data.stale", label: "依据不足" },
    { code: "fact.risk", label: "事实红线风险" },
    { code: "other", label: "其他（我补一句）" },
  ],
};

/* ================= ai-video 内容包（ai-video Bundle） ================= */

export const QUESTLINE_VIDEO: QuestlineConfig = {
  journeyName: "首日上岗",
  mateName: "狐狸先生",
  mateRole: "汇报官 · 带玩向导",
  ownerTitle: "董事长",
  mateVoice: FOX_MATE_VOICE,

  stages: genericStages(),

  employees: [
    {
      id: "director",
      presetKey: "director",
      title: "总导演",
      duty: "把选题拆成剧本、分镜与镜头单，盯住整片节奏与验收。",
      fences: ["G8 · 渲染提交必审（烧算力）", "G11 · 预算超限自动暂停提交"],
      tasks: ["生成一集剧本与分镜", "验收成片镜头", "核对预算消耗"],
      sample: "一集 60 秒短剧的剧本 + 18 个镜头的分镜表",
      sampleIsDemo: true,
    },
    {
      id: "render",
      presetKey: "render-operator",
      title: "渲染师",
      duty: "按镜头单提交渲染；每一步都吃算力，所以提交前一定来问您。",
      fences: ["G8 · 渲染提交必审", "G11 · 单项目算力超预算暂停"],
      tasks: ["提交渲染批次", "检查渲染回执", "处理渲染失败重试"],
      sample: "昨晚 3 个批次的渲染回执 + 2 个失败镜头的重试方案",
      sampleIsDemo: true,
    },
    {
      id: "publish",
      presetKey: "publish-operator",
      title: "发布专员",
      duty: "把成片分发到各平台；公网发布与版权风险都由人审兜底。",
      fences: ["G9 · 公网发布必审", "G16 · 矩阵账号防关联"],
      tasks: ["排期多平台发布", "核对版权与授权", "回查发布结果"],
      sample: "本周 4 条的发布排期 + 版权核验结果",
      sampleIsDemo: true,
    },
    {
      id: "compliance",
      presetKey: "compliance-officer",
      title: "合规审核员",
      duty: "在成片出厂前检查事实、版权与平台规则，发现红线直接拦下。",
      fences: ["事实红线一票否决", "版权缺失不得发布"],
      tasks: ["审核待发布成片", "核对素材授权", "记录拦截原因"],
      sample: "本周拦截的 2 条风险片段 + 修改建议",
      sampleIsDemo: true,
    },
    {
      id: "metrics",
      presetKey: "metrics-watcher",
      title: "数据看板官",
      duty: "盯播放、完播与转化，把哪条内容真的赚钱讲清楚。",
      fences: ["只读统计，不改渠道数据"],
      tasks: ["查看今日看板", "生成周复盘数据", "查异常波动"],
      sample: "近 7 天完播与转化曲线 + 三条爆款归因",
      sampleIsDemo: true,
    },
  ],

  goals: [
    {
      id: "ship-episode",
      title: "本周交付一集成片",
      metric: "一集从剧本到成片走完，且每步有回执",
      ownerPresetKey: "director",
      ownerTitle: "总导演",
      artifact: "成片 + 镜头单 + 渲染回执",
      steps: 4,
      approvals: 2,
    },
    {
      id: "budget-safe",
      title: "算力不超预算",
      metric: "单项目算力消耗不越过预算上限",
      ownerPresetKey: "render-operator",
      ownerTitle: "渲染师",
      artifact: "算力消耗账单 + 超限暂停记录",
      steps: 3,
      approvals: 1,
    },
    {
      id: "publish-clean",
      title: "发布不出事",
      metric: "公网发布全部经审，版权与平台规则零违规",
      ownerPresetKey: "publish-operator",
      ownerTitle: "发布专员",
      artifact: "发布排期 + 版权核验记录",
      steps: 3,
      approvals: 1,
    },
  ],

  tasks: [
    {
      id: "script-episode",
      title: "把本周选题写成剧本与分镜",
      ownerPresetKey: "director",
      ownerTitle: "总导演",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "剧本 + 分镜表（可直接开工）",
      approvals: 1,
      credits: 18,
      dispatchTitle: "生成本周选题的剧本与分镜表，整理镜头清单与预算预估，提交渲染前提请审批",
    },
    {
      id: "render-batch",
      title: "提交一批渲染并核对回执",
      ownerPresetKey: "render-operator",
      ownerTitle: "渲染师",
      steps: 3,
      eta: "约 4 分钟",
      artifact: "渲染回执 + 失败镜头重试方案",
      approvals: 1,
      credits: 24,
      dispatchTitle: "按镜头单提交渲染批次并核对回执，整理失败镜头的重试方案，超预算部分提请审批",
    },
    {
      id: "publish-plan",
      title: "排期发布并核验版权",
      ownerPresetKey: "publish-operator",
      ownerTitle: "发布专员",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "发布排期 + 版权核验记录",
      approvals: 1,
      credits: 12,
      dispatchTitle: "整理本周多平台发布排期并核验版权与授权，公网发布前提交审批",
    },
  ],

  achievements: QUEST_ACHIEVEMENTS,
  values: QUEST_VALUES,
  nextSteps: QUEST_NEXT_STEPS,

  // ai-video 枚举表（bundles/ai-video/feedback-enums.yml）里的 reject 适用码
  rejectReasons: [
    { code: "fact.risk", label: "事实红线风险" },
    { code: "compliance.platform", label: "平台合规风险" },
    { code: "budget.over", label: "预算超支" },
    { code: "other", label: "其他（我补一句）" },
  ],
};

/**
 * Bundle → 内容包。找不到对应包时返回 null：宁可不显示引导，也不把别的行业的
 * 人设、岗位与围栏张冠李戴（GEO 工作区里出现酒店岗位就是这么来的）。
 */
export const QUESTLINE_PACKS: Readonly<Record<string, QuestlineConfig>> = Object.freeze({
  hotel: QUESTLINE,
  "geo-growth": QUESTLINE_GEO,
  "ai-video": QUESTLINE_VIDEO,
});

export function questlineForBundle(bundleId: string | null | undefined): QuestlineConfig | null {
  const id = (bundleId ?? "").trim();
  if (!id) return null;
  return QUESTLINE_PACKS[id] ?? null;
}

/** 关卡一与"三位当家人"成就只认内容包的前三张卡：组件里禁止再硬编码岗位 id */
export function coreCardIds(content: QuestlineConfig = QUESTLINE): string[] {
  return content.employees.slice(0, 3).map((card) => card.id);
}

export function stageDef(stage: QuestStageId, content: QuestlineConfig = QUESTLINE): QuestStageDef {
  const found = content.stages.find((item) => item.id === stage);
  if (found) return found;
  const first = content.stages[0];
  if (!first) throw new Error("questline 配置缺少关卡定义");
  return first;
}

export function employeeCardOf(presetKey: string, content: QuestlineConfig = QUESTLINE): EmployeeCardDef | null {
  return content.employees.find((item) => item.presetKey === presetKey) ?? null;
}
