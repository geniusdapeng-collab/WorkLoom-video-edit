type RecordValue = Record<string, unknown>;

export interface MarketingPromptOptions {
  targetDuration: number;
  noPeople: boolean;
  /** Client explicitly restricts visuals to abstract interfaces, code, and diagrams. */
  abstractOnly?: boolean;
}

export interface MarketingPromptNormalization<T> {
  value: T;
  changes: string[];
}

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const NO_PERSON_MICRO_ACTION = "无人物微动作；仅由画布上的光标、光点、连线与亮度变化表达节奏";
const ABSTRACT_UNSAFE = /仪器|工具|台面|接待|机房|暗室|铭牌|不锈钢|拉丝|倒角|刻线|刻字|实体|家具|座椅|墙面|地面|地板|室内|照明|顶灯|装饰画|反光板|实拍|空间纵深|光比|色温|照度|\d+(?:\.\d+)?\s*(?:米|厘米|毫米|度|°|K)\b/iu;
const ABSTRACT_TERM_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/暗色微距工作台空间|微距工作台空间|微距工作台|工作台空间/gu, "二维抽象画布"],
  [/仪器外壳|关闭的仪器外壳|仪器|哑光工具|台面实体模型|实体模型|实体面板|金属构件|拉丝不锈钢|不锈钢|铭牌/gu, "抽象二维图形层"],
  [/深灰磨砂台面|浅色墙面|墙面|地面|浅灰色地板|地板|台面/gu, "二维背景层"],
  [/接待区展示角|接待区风格的座椅|接待区|座椅/gu, "二维展示层"],
  [/空间纵深约?三米|空间纵深|三米|两厘米|十五厘米|厘米|毫米/gu, "受控视觉尺度"],
  [/暖橙标签自身发出的[^，。；\n]*暖光/gu, "小面积暖色提示光"],
  [/色温[^，。；\n]*/gu, "受控冷白基准"],
  [/光比[^，。；\n]*/gu, "受控明暗层次"],
  [/黑色反光板|柔光箱|实体灯具|灯具|顶灯/gu, "抽象明暗层"],
  [/刻线|刻字|刻痕|倒角/gu, "发光描边"],
  [/物理动作链/gu, "抽象图形变化序列"],
  [/可触摸的|真实可触/gu, "二维可读的"],
] as const;
const ABSTRACT_FIELD_FALLBACK: Readonly<Record<string, string>> = {
  "导演意图": "极简抽象信息片，信息只由本次 G1 已审原文、二维图形与受控明暗变化承载；不拍摄实体场景，不暗示未核实硬件、材质、尺寸或可运行效果。",
  "基础": "高质量二维图形与文字合成，保留本次 G1 已审原文和抽象几何；不新增实体材质、设备外观、真实空间或运行界面。",
  "场景": "纯黑或冷灰二维抽象画布，只包含本次 G1 已审原文、抽象几何节点、文字层、光标与示意角标；不出现人物、真实空间、家具、工具、实体硬件或可运行界面。",
  "灯光设计": "只使用概念性冷白自发光与受控明暗变化塑造文字和图形层级；不声明实体灯具、物理空间、色温、光比或照度参数。",
  "明亮约束": "屏上文字和关键图形在平台安全区内清晰可读，暗部保持纯黑；不使用未核实材质或环境细节制造对比。",
  "构图": "9:16 竖屏二维图层构图，本次 G1 已审原文与抽象几何按层级排列并避开平台遮挡区；不出现实体陈设或空间纵深。",
  "色彩/色调": "纯黑、冷灰与冷白构成受控二维色板，仅用于已审原文、抽象图形和来源角标；不新增品牌色、实体材质或未审环境色。",
  "景深": "二维图层保持清晰，仅允许概念性的前后层明暗差；不声明真实镜头、焦段、物理景深、尺寸或空间纵深。",
  "运镜": "固定机位或受控二维图层位移，保持 9:16 安全区稳定；不拍摄实体空间，不新增真实镜头型号或物理位移参数。",
  "动作": "本次 G1 已审原文、光标和抽象几何节点按顺序出现、连线、亮灭并停稳；不出现人物、实体物件动作、机械装配或可运行效果。",
  "道具": "无实物道具；只使用本次 G1 已审原文、抽象文字层、光标、几何节点和示意角标。",
  "时间轴": "按本镜时长推进：已审原文与抽象几何依次出现、亮起并停稳；不出现人物、实体空间、硬件动作或可运行效果。",
  "转场": "使用硬切或抽象明暗层过渡；不依赖实体空间连续性或未审场景。",
  "主标题内容": "本次 G1 已审原文与官方仓库地址",
  "副标题内容": "官方仓库原文自述 | 本片不扩展事实用途",
  "标题字体设计": "等宽无衬线字形，冷白与深灰二维自发光；笔画和间距稳定，不声明实体材质、铭牌、倒角或真实布光。",
  "开场音频设计": "无对白、无口播、无人声、无音乐、无BGM、无配乐、无节拍；仅保留经授权的抽象环境音与动作音效。",
  "标题动画设计": "扫描线、光标和二维文字层按受控节奏出现、亮起并停稳；不暗示实体设备、真实场景或可运行效果。",
  "角色": "全片无人，不出现人物、人体局部、服装、化妆、表情或人物动作；画面主体仅为本次 G1 已审原文与抽象图形。",
  "角色一致性": "本镜头无角色；保持二维色板、字形、光标和抽象几何样式一致，不引用实体材质或未审场景。",
} as const;
const ABSTRACT_FIELD_DETAIL: Readonly<Record<string, string>> = {
  "导演意图": "视觉信息严格服务于可核对原文和抽象结构，不使用实体场景、未审器材或可运行效果承担叙事。",
  "基础": "图形边缘、字形和层级关系保持稳定，暗部不依靠真实材质制造细节，所有可读内容由后期精确锁定。",
  "场景": "所有元素均停留在二维图层内，保持清晰的文字安全区、受控留白和来源标注位置；不通过透视、陈设、倒影或设备轮廓暗示真实世界。",
  "灯光设计": "亮部、灰阶和暗部的变化只用于突出文字与几何边界，保持冷白、低饱和和稳定对比，不把概念光效解释为真实空间照明。",
  "构图": "文字和图形按信息优先级分层，关键原文始终可读，来源标注不遮挡主体；四周保留平台安全边距，画面不依靠物理空间建立纵深。",
  "色彩/色调": "色板收敛为纯黑、冷灰与冷白，强调色面积受控且只服务信息层级；避免品牌色、材质色和未审环境色成为事实暗示。",
  "景深": "用图层亮度、清晰度和透明度建立前后关系，不使用真实光学参数；关键原文、地址和光标保持同一可读平面。",
  "运镜": "运动只发生在二维文字与图形层，速度平缓、起止可追溯，不使用真实拍摄设备参数；落幅保持可截图核对的稳定状态。",
  "动作": "文字出现、节点连线、亮起和停稳均有明确先后顺序，过程保持连续性；所有动作仅发生在二维图形内，并与对应时间轴逐项一致。",
  "道具": "所有视觉元素均由后期文字、矢量或抽象发光图形构成，保持可替换、可审计和无实体依赖，不进入真实设备或产品外观。",
  "时间轴": "各阶段保留起止状态与停顿，最终让关键原文、仓库地址和光标处于稳定可核对画面，并与本镜实测时长一致。",
  "转场": "转场只改变二维图层亮度、位置或透明度，不建立未审实体空间之间的连续性。",
  "标题字体设计": "字形、字距、行高和层级保持一致，冷白强调文字与来源信息；不新增材质照片、实体铭牌或未审装饰纹理。",
  "开场音频设计": "声音只用于时间提示和抽象动作落点，不暗示真实设备运行、产品效果或未审环境。",
  "标题动画设计": "动画顺序保持可读、可停稳、可截图复核，文字出现与光标落位一致，结尾不留未完成运动。",
  "角色": "角色相关字段不适用，仅保留无人画面和抽象图形合同。",
  "角色一致性": "二维文字、图形和色板的跨镜一致性以已审合同为准，不引入人物或实体材质连续性。",
} as const;
const ABSTRACT_OBJECT_TAGS: Readonly<Record<string, string>> = {
  scene: "场景",
  action: "动作",
  props: "道具",
  lighting: "灯光设计",
  lightingString: "灯光设计",
  composition: "构图",
  color_palette: "色彩/色调",
  colorPalette: "色彩/色调",
  depth_of_field: "景深",
  depthOfField: "景深",
  camera_movement: "运镜",
  cameraString: "运镜",
  timeline: "时间轴",
  transition: "转场",
  title: "主标题内容",
  title_content: "主标题内容",
  subtitle: "副标题内容",
  subtitle_content: "副标题内容",
  title_font_design: "标题字体设计",
  opening_audio_design: "开场音频设计",
  promptBase: "场景",
  fusionText: "场景",
  character: "角色",
  consistency: "角色一致性",
} as const;

export function isAbstractMarketingIntent(value: string): boolean {
  return /仅使用抽象|只用抽象|抽象界面|抽象[^。\n]{0,12}示意|不展示未核实硬件/iu.test(value)
    && /全片无人|无人物|无人出镜/iu.test(value);
}

function timecodeSeconds(value: string): number | null {
  const match = /^T(\d{2}):(\d{2}(?:\.\d+)?)$/u.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function capTimecodes(value: string, duration: number): string {
  return value.replace(/T\d{2}:\d{2}(?:\.\d+)?/gu, (timecode) => {
    const seconds = timecodeSeconds(timecode);
    return seconds !== null && seconds > duration
      ? `T00:${String(duration).padStart(2, "0")}`
      : timecode;
  });
}

function normalizePromptString(value: string, duration: number | null, options: MarketingPromptOptions): string {
  let next = value
    .replace(
      /01\.【语言约束】[^\n]*/u,
      "01.【语言约束】除本次 G1 已审原文、许可证字段和仓库地址外，其余字段必须使用中文；不得新增未审英文表述。",
    )
    .replace(
      /全部字段必须使用中文输出[^。\n]*。?/gu,
      "除本次 G1 已审原文、许可证字段和仓库地址外，其余字段必须使用中文；不得新增未审英文表述。",
    )
    .replace(/官方仓库逐行核对\s*\|\s*开发者点开许可行亲自验证/gu, "G1 已审原文 | 许可证字段与仓库地址")
    .replace(/官方仓库逐行核对/gu, "仅展示本次 G1 已审原文")
    .replace(/开发者点开[^，。\n|]*/gu, "")
    .replace(/好莱坞技能库/gu, "抽象视觉规则")
    .replace(/本次已审抽象视觉规则/gu, "抽象视觉规则")
    .replace(/微表情_[^、,，。\s]+/gu, "")
    .replace(/Camera增强\s*:/giu, "镜头约束：")
    .replace(/\b(?:85|50|35|24|135|200)mm\b/giu, "固定中焦视角")
    .replace(/开放式公共大厅|嵌入式灯带|接待台|展板|沙发|茶几|灰色哑光瓷砖|办公家具|家具|大厅/gu, "无材质细节的纯黑空间")
    .replace(/摄影棚|水磨石|吸音毡|LED灯|金属夹持臂|显示终端|显示器|键盘|键帽/gu, "无材质细节的抽象画布")
    .replace(/金属质感总线导轨|总线导轨|导轨/gu, "抽象线框链路")
    .replace(/凹形卡槽|模块卡槽|接口卡槽|卡槽|槽口/gu, "线框接口")
    .replace(/槽深/gu, "位移距离")
    .replace(/槽底|卡槽内壁|线框接口内壁|内壁/gu, "线框内侧")
    .replace(/模块方块/gu, "模块图形")
    .replace(/针脚/gu, "连接节点")
    .replace(/可触摸的哑光金属/gu, "可见的抽象发光线框")
    .replace(/金属接触面|接触面/gu, "对齐边界")
    .replace(/接触瞬间/gu, "对齐瞬间")
    .replace(/咬合/gu, "对齐")
    .replace(/锁合/gu, "对齐停靠")
    .replace(/贴合/gu, "对齐")
    .replace(/物理阶段/gu, "图形变化阶段")
    .replace(/依次导入/gu, "依次对齐")
    .replace(/机械运动/gu, "受控图形运动")
    .replace(/金属构件|倒角高光/gu, "抽象线框节点")
    .replace(/按真实金属构件拍摄/gmu, "按抽象线框示意")
    .replace(/第三条，标改写。/gu, "模块化方式（改写引用）。")
    .replace(/[“"]?第三条[”"]?\s*[,，]?\s*标改写[。.]?/gu, "模块化方式（改写引用）")
    .replace(/阳极氧化铝|哑光橡胶垫|黑色办公椅|机箱风扇|机械键盘|键盘击键|击键声|散热风扇|橡胶垫|操作台|桌面/gmu, (term) => {
      if (/风扇/u.test(term)) return "抽象低频音床";
      if (/击键|键盘/u.test(term)) return "极短机械节拍";
      return "无材质细节的暗面";
    })
    .replace(/黑色金属窄边框|金属窄边框|金属边框|屏幕边框|屏面边框|显示器/gmu, "无材质细节的抽象画布边界")
    .replace(/竖屏显示器|真实屏幕|屏幕|屏面/gmu, "抽象发光画布")
    .replace(/哑光黑玻璃/gu, "无材质抽象发光画布")
    .replace(/玻璃表面/gu, "抽象画布表面")
    .replace(/暖金色|暖金|暖白|金属反光|金属材质|金属/gmu, "冷白自发光")
    .replace(/机箱风扇的低频底噪|风扇低频|底噪/gmu, "抽象低频音床")
    .replace(/击键声|键盘敲击|键盘声|敲击声/gmu, "极短机械节拍")
    .replace(/no text\s*,?\s*/giu, "")
    .replace(/no watermark\s*,?\s*/giu, "")
    .replace(/no signage\s*,?\s*/giu, "")
    .replace(/no non-diegetic music[^。\n]*/giu, "")
    .replace(/禁止字幕条与角标/gu, "")
    .replace(/禁止画面出现中文汉字与无关字母/gu, "除本次 G1 已审原文外，不出现其他文字")
    .replace(/主体面部明亮清晰，阴影保留层次不死黑。/gu, "画布亮部与 G1 原文清晰可读，暗部保留层次且不抬灰。")
    .replace(/面部微表情自然真实,?眼神聚焦有神采,?符合场景氛围与角色身份/gu, NO_PERSON_MICRO_ACTION)
    .replace(/面部细节：[^。\n]*[。]?/gu, "")
    .replace(/微动作：[^。\n]*[。]?/gu, "")
    .replace(/呼吸：[^。\n]*[。]?/gu, "")
    .replace(/\b(?:quietly|confidently|lightly|firmly|softly|gently|calmly|precisely)\b\s*(?:说)?[:：]?/giu, "")
    .replace(/\b(?:focused|precise|brisk|lucid|assured|clean|tense|calm|restrained|cinematic|photorealistic)\b/giu, "受控抽象")
    .replace(/\b8K\b/giu, "高质量")
    .replace(/\b(?:f\/\d+(?:\.\d+)?)\b/giu, "受控景深")
    .replace(/\b(?:3000|3200|5600|6000|6500)K\b/giu, "冷白色温")
    .replace(/\bBPM\b/giu, "节拍速度")
    .replace(/写实拍摄|实拍质感|照片级写实|棚拍空间|写实/gmu, "受控抽象影像")
    .replace(/^(\d{2}\.)【台词】[^\n]*/gmu, "$1【台词】无对白；仅以本次 G1 已审原文和图形节奏传达信息。")
    .replace(/^(\d{2}\.)【微动作】\s*(?:[。.]?)$/gmu, `$1【微动作】${NO_PERSON_MICRO_ACTION}`)
    .replace(/^(\d{2}\.)【负面约束】\s*[。.]?\s*$/gmu, "$1【负面约束】禁止人物、人体局部、实体硬件、可运行效果、额外字幕、品牌标识、用户评价与竞品对比。")
    .replace(/^(\d{2}\.)【情绪】\s*[。.]?\s*$/gmu, "$1【情绪】冷酷精密；无人物表演，仅由画布上的光线、文字与线条变化表达节奏。");
  if (options.noPeople) {
    next = next
      .replace(/，站立姿态[^。\n]*/gu, "")
      .replace(/^(\d{2}\.)【音频】[^\n]*/gmu,
        "$1【音频】无对白、无口播、无人声、无音乐、无BGM、无配乐、无节拍；仅允许经授权的抽象环境音与动作音效，配乐由后期环节统一加入。")
      .replace(/^(\d{2}\.)【开场音频设计】[^\n]*/gmu,
        "$1【开场音频设计】无对白、无口播、无人声、无音乐、无BGM、无配乐、无节拍；仅允许经授权的抽象环境音与动作音效，节奏由画面内图形变化决定。")
      .replace(
        /，?[^。\n]*(?:转身|走动|抱头|伸展|指向|握拳|眨眼|瞪眼|肩膀|眼神|嘴唇|面部|眉头|嘴角|点头)[^。\n]*/gu,
        "；全片无人，不出现人物、人体局部或人物动作",
      )
      .replace(/^(\d{2}\.)【微动作】[^\n]*/gmu, `$1【微动作】${NO_PERSON_MICRO_ACTION}`)
      .replace(/^(\d{2}\.)【情绪】[^\n]*/gmu,
        "$1【情绪】冷酷精密；无人物表演，仅由画布上的光线、文字与线条变化表达节奏。")
      .replace(/\*\*定妆照\*\*:\s*有/gu, "**定妆照**: 无（无角色）")
      .replace(
        /【角色】[^\n]*/u,
        "【角色】全片无人，不出现人物、人体局部、服装、化妆、表情或人物动作；画面主体仅为 G1 已审原文与抽象图形",
      );
  }
  return duration === null ? next : capTimecodes(next, duration);
}

function normalizeAbstractField(tag: string, content: string): string {
  const unsafe = ABSTRACT_UNSAFE.test(content);
  let next = content;
  for (const [pattern, replacement] of ABSTRACT_TERM_REPLACEMENTS) next = next.replace(pattern, replacement);
  if (tag === "时间轴") {
    const timecodes = [...next.matchAll(/T\d{2}:\d{2}(?:\.\d+)?/gu)].map((match) => match[0]);
    if (unsafe && timecodes.length >= 2) {
      next = `${timecodes[0]}–${timecodes[timecodes.length - 1]} ${ABSTRACT_FIELD_FALLBACK[tag]!.replace(/^按本镜时长推进：/u, "")}`;
    }
  }
  if (unsafe && ABSTRACT_FIELD_FALLBACK[tag]) {
    next = `${ABSTRACT_FIELD_FALLBACK[tag]}${ABSTRACT_FIELD_DETAIL[tag] ? ` ${ABSTRACT_FIELD_DETAIL[tag]}` : ""}`;
  }
  return next;
}

function normalizeAbstractPromptMarkdown(value: string, changes: string[]): string {
  let fieldIndex = 0;
  let changed = false;
  const output: string[] = [];
  for (const line of value.split("\n")) {
    if (/^###\s+/u.test(line)) fieldIndex = 0;
    if (/^[；;]\s*全片无人，不出现人物、人体局部或人物动作\s*$/u.test(line.trim())) {
      changed = true;
      continue;
    }
    const field = /^(\d{2}\.)【([^】]+)】([\s\S]*)$/u.exec(line);
    if (!field) {
      output.push(line);
      continue;
    }
    fieldIndex += 1;
    const tag = field[2]!;
    const original = field[3]!;
    const content = ABSTRACT_FIELD_FALLBACK[tag] ? normalizeAbstractField(tag, original) : original;
    const replacement = `${String(fieldIndex).padStart(2, "0")}.【${tag}】${content}`;
    if (replacement !== line) changed = true;
    output.push(replacement);
  }
  if (changed) changes.push("abstract-field-contract-normalized");
  return output.join("\n");
}

function rebalanceDurations<T extends RecordValue>(items: T[], target: number): { items: T[]; changed: boolean } {
  const durations = items.map((item) => Number(item.duration ?? item.duration_sec ?? 0));
  if (items.length === 0 || durations.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { items, changed: false };
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - target) < 1e-9) return { items, changed: false };
  const exact = durations.map((value) => value * target / total);
  const next = exact.map(Math.floor);
  const remaining = target - next.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - next[index]! }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let offset = 0; offset < remaining; offset++) {
    const index = order[offset % order.length]!.index;
    next[index] = next[index]! + 1;
  }
  return {
    items: items.map((item, index) => ({
      ...item,
      ...(typeof item.duration === "number" ? { duration: next[index] } : {}),
      ...(typeof item.duration_sec === "number" ? { duration_sec: next[index] } : {}),
    })),
    changed: true,
  };
}

function normalizeRecord(record: RecordValue, options: MarketingPromptOptions, changes: string[]): RecordValue {
  const next: RecordValue = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      const normalized = normalizePromptString(value, null, options);
      const abstractTag = options.abstractOnly ? ABSTRACT_OBJECT_TAGS[key] : undefined;
      next[key] = abstractTag ? normalizeAbstractField(abstractTag, normalized) : normalized;
    } else if (Array.isArray(value) && ["shots", "prompts"].includes(key)) {
      const records = value.filter(isRecord);
      if (records.length === value.length && records.length > 1) {
        const balanced = rebalanceDurations(records, options.targetDuration);
        if (balanced.changed) changes.push(`${key}-duration-conservation`);
        next[key] = balanced.items.map((item) => normalizeRecord(item, options, changes));
      } else {
        next[key] = value.map((item) => normalizeUnknown(item, options, changes));
      }
    } else {
      next[key] = normalizeUnknown(value, options, changes);
    }
  }
  const duration = Number(next.duration ?? next.duration_sec ?? 0);
  if (Number.isFinite(duration) && duration > 0) {
    for (const [key, value] of Object.entries(next)) {
      if (typeof value === "string") next[key] = capTimecodes(value, duration);
    }
    if (options.noPeople) {
      if (typeof next.timeline === "string") {
        next.timeline = `T00:00–T00:${String(duration).padStart(2, "0")} 抽象发光画布上的 G1 已审原文与图形按已审节奏变化；画面无人、无硬件实体，结尾静止至本镜结束`;
        changes.push("no-person-timeline-normalized");
      }
      if (typeof next.dialogue === "string") {
        next.dialogue = "无对白；仅以 G1 已审原文和图形节奏传达信息。";
        changes.push("no-dialogue-normalized");
      }
    }
  }
  return next;
}

function normalizeUnknown(value: unknown, options: MarketingPromptOptions, changes: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeUnknown(item, options, changes));
  if (!isRecord(value)) {
    return typeof value === "string" ? normalizePromptString(value, null, options) : value;
  }
  return normalizeRecord(value, options, changes);
}

function normalizeMarkdownDurations(
  markdown: string,
  target: number,
  options: MarketingPromptOptions,
  changes: string[],
): string {
  const rows = [...markdown.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?)s\s*\|/gmu)];
  if (rows.length === 0) return markdown;
  const balanced = rebalanceDurations(rows.map((match) => ({ duration: Number(match[2]) })), target);
  if (!balanced.changed) return markdown;
  changes.push("gate-duration-conservation");
  let rowIndex = 0;
  let next = markdown.replace(
    /^(\|\s*([^|]+?)\s*\|)\s*(\d+(?:\.\d+)?)s(\s*\|)/gmu,
    (_line, prefix: string, _name: string, _duration, suffix: string) =>
      `${prefix} ${balanced.items[rowIndex++]!.duration}s${suffix}`,
  );
  if (options.noPeople && /^\|\s*镜头\s*\|\s*时长\s*\|.*有定妆照/mu.test(next)) {
    next = next.split("\n").map((line) => {
      if (!/^\|\s*(?!镜头\b|---)/u.test(line) || !line.includes("|")) return line;
      const columns = line.split("|");
      if (columns.length >= 9) columns[6] = " — ";
      return columns.join("|");
    }).join("\n");
    changes.push("portrait-not-applicable-table");
  }
  const sections = [...next.matchAll(/^###\s+([^\n(]+)\(/gmu)];
  for (let index = 0; index < sections.length; index++) {
    const match = sections[index]!;
    const start = match.index!;
    const end = sections[index + 1]?.index ?? next.length;
    const row = rows.findIndex((item) => item[1]!.trim() === match[1]!.trim());
    if (row < 0) continue;
    const duration = Number(balanced.items[row]!.duration);
    next = `${next.slice(0, start)}${capTimecodes(next.slice(start, end), duration)}${next.slice(end)}`;
  }
  return `${next}\n\n> 宿主时长校正：${balanced.items.map((item) => `${item.duration}s`).join(" + ")} = ${target}s；以上各镜以校正后时长为绝对时间上界。\n`;
}

export function normalizeMarketingPromptText(
  value: string,
  options: MarketingPromptOptions,
): MarketingPromptNormalization<string> {
  const changes: string[] = [];
  let next = normalizePromptString(value ?? "", null, options);
  if (next !== value) changes.push("gate-prompt-contract-normalized");
  if (options.abstractOnly) next = normalizeAbstractPromptMarkdown(next, changes);
  next = normalizeMarkdownDurations(next, options.targetDuration, options, changes);
  return { value: next, changes: [...new Set(changes)] };
}

export function normalizeMarketingPromptResult<T>(
  value: T,
  options: MarketingPromptOptions,
): MarketingPromptNormalization<T> {
  const changes: string[] = [];
  return {
    value: normalizeUnknown(value, options, changes) as T,
    changes: [...new Set(changes)],
  };
}
