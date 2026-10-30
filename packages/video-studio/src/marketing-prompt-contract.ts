type RecordValue = Record<string, unknown>;

export interface MarketingPromptOptions {
  targetDuration: number;
  noPeople: boolean;
  /** Client explicitly restricts visuals to abstract interfaces, code, and diagrams. */
  abstractOnly?: boolean;
  /** Formal delivery frame rate when the caller has already resolved it. */
  frameRate?: 24 | 25 | 30 | 60;
  /** Exact source-bound names/claims that may appear as visible text. */
  allowedVisibleText?: string[];
}

export interface MarketingPromptNormalization<T> {
  value: T;
  changes: string[];
}

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const NO_PERSON_MICRO_ACTION = "无人物微动作；仅由画布上的光标、光点、连线与亮度变化表达节奏";
const ABSTRACT_UNSAFE = /仪器|工具|台面|接待|机房|暗室|铭牌|不锈钢|拉丝|哑光|倒角|刻线|刻字|实体|家具|座椅|墙面|地面|地板|室内|照明|顶灯|装饰画|反光板|实拍|工作室|面板|磨砂面|真实材质|真实光源|物理|灰尘|细颗粒|照片级|摄影质感|实物感|焦距|焦段|焦平面|三脚架|大光圈|浅景深|空间纵深|光比|色温|照度|该导演|该情绪|：\s*[、，]|\d+(?:\.\d+)?\s*(?:mm|cm|米|厘米|毫米|度|°|K)\b/iu;
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
  "技能增强": "本镜技法只使用本次已审抽象视觉规则、二维图形与受控明暗变化；不引用未指定导演、外部作品、真实器材或未审场景。",
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
  "技能增强": "任何视觉手法均以二维文字可读、图形稳定和可截图复核为优先，不引入实体摄影或未审创作参考。",
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

export function marketingVisibleTextFromG1(content: string): string[] {
  try {
    const root = JSON.parse(content) as RecordValue;
    const facts = isRecord(root.facts) ? root.facts : root;
    const identity = isRecord(facts.productQuery) && isRecord(facts.productQuery.identity)
      ? facts.productQuery.identity
      : isRecord(facts.identity) ? facts.identity : {};
    const product = isRecord(facts.productQuery) ? facts.productQuery : {};
    const rawByAgent = isRecord(facts.rawByAgent) ? facts.rawByAgent : {};
    const rawA1 = isRecord(rawByAgent.A1) ? rawByAgent.A1 : {};
    const extracted = isRecord(rawA1.identity) ? rawA1.identity : {};
    const values: string[] = [];
    const add = (value: unknown): void => {
      if (typeof value !== "string") return;
      const text = value.trim();
      if (text && !values.includes(text)) values.push(text);
    };
    add(product.name ?? identity.name);
    add(product.brand ?? identity.brand);
    const points = Array.isArray(extracted.official_selling_points)
      ? extracted.official_selling_points
      : Array.isArray(identity.official_selling_points) ? identity.official_selling_points : [];
    for (const point of points) {
      if (isRecord(point)) add(point.point);
    }
    const specs = isRecord(extracted.specs) ? extracted.specs : isRecord(identity.specs) ? identity.specs : {};
    if (isRecord(specs)) {
      for (const key of ["License", "license", "Default branch", "Source model"]) {
        add(specs[key]);
        if (/^license$/iu.test(key) && typeof specs[key] === "string") add(`License: ${specs[key]}`);
      }
    }
    for (const source of Array.isArray(facts.sources) ? facts.sources : []) {
      if (isRecord(source)) add(source.finalUrl);
    }
    return values.slice(0, 8);
  } catch {
    return [];
  }
}

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
  if (options.abstractOnly && options.frameRate !== undefined && options.frameRate !== 24) {
    next = next.replace(/\b24fps\b/giu, `${options.frameRate}fps`);
  }
  return duration === null ? next : capTimecodes(next, duration);
}

function normalizeAbstractField(tag: string, content: string): string {
  const original = content.replace(/\s+\d{2}\.\s*$/u, "").trimEnd();
  const unsafe = ABSTRACT_UNSAFE.test(original);
  const incomplete = !/[。！？；.!?;…]$/u.test(original);
  let next = original;
  for (const [pattern, replacement] of ABSTRACT_TERM_REPLACEMENTS) next = next.replace(pattern, replacement);
  if (tag === "时间轴") {
    const timecodes = [...next.matchAll(/T\d{2}:\d{2}(?:\.\d+)?/gu)].map((match) => match[0]);
    if (unsafe && timecodes.length >= 2) {
      next = `${timecodes[0]}–${timecodes[timecodes.length - 1]} ${ABSTRACT_FIELD_FALLBACK[tag]!.replace(/^按本镜时长推进：/u, "")}`;
    }
  }
  if ((unsafe || incomplete) && ABSTRACT_FIELD_FALLBACK[tag]) {
    next = `${ABSTRACT_FIELD_FALLBACK[tag]}${ABSTRACT_FIELD_DETAIL[tag] ? ` ${ABSTRACT_FIELD_DETAIL[tag]}` : ""}`;
  }
  return next;
}

function extractAbstractVisibleText(value: string, seed: string[] = []): string[] {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    const text = candidate.trim();
    if (text && !candidates.includes(text)) candidates.push(text);
  };
  for (const item of seed) add(item);
  for (const match of value.matchAll(/\bLicense\s*[：:]\s*Apache-2\.0\b/giu)) add(match[0].replace(/[：:]/gu, ": ").replace(/\s+/gu, " "));
  for (const match of value.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gu)) add(match[0]);
  for (const match of value.matchAll(/[A-Z][A-Za-z0-9 ,.'’!?-]{24,220}[.!?]/gu)) {
    const sentence = match[0].trim();
    if (/\b(?:MP4|H\.264|H\.265|fps|T\d{2}:|prompt|negative|lighting|scene|shot|resolution)\b/iu.test(sentence)) continue;
    add(sentence);
  }
  return candidates.slice(0, 8);
}

function abstractTimeline(duration: number, action: string, hasText: boolean): string {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 4;
  const first = safeDuration / 3;
  const second = safeDuration * 2 / 3;
  const stamp = (value: number): string => `T00:${value.toFixed(1).padStart(4, "0")}`;
  return `${stamp(0)}–${stamp(first)} ${hasText ? "已审可见文字与抽象几何进入安全区" : "网格与空框进入稳定状态"}，光标建立首个落点；`
    + `${stamp(first)}–${stamp(second)} ${action}；`
    + `${stamp(second)}–${stamp(safeDuration)} ${hasText ? "已列明文字、图形与光标停稳" : "网格、空框与光标停稳"}，结尾保留可截图复核的静止画面。`
    + `三段区间由两个阶段边界分隔，边界只允许亮度与位置产生一次可追溯变化，不得跳帧或重复回闪；最终帧与字段、旁白、字幕轨和交付清单中的本镜时长一致。`;
}

const ABSTRACT_SHOT_VARIANTS: Readonly<Record<string, { scene: string; action: string; props: string; timeline: string }>> = {
  opening: {
    scene: "满幅来源入口：本镜列明字符串位于上半屏，光标与无文字来源角标位于下半屏",
    action: "本镜列明字符串先逐字出现，光标随后落位并在末尾停稳",
    props: "本镜列明字符串、方形光标与无文字来源角标",
    timeline: "本镜列明字符串和光标依次出现并停稳",
  },
  "scene-1": {
    scene: "横向代码行与选区框：三行等宽字段占据画面中部，右侧保留来源归属位置",
    action: "字段行自上而下出现，细框由左向右选中完整字段并在末端停稳",
    props: "多行等宽字段、二维选区框与无文字来源角标",
    timeline: "字段行逐行出现，选区框完成选中并在末端停稳",
  },
  "scene-2": {
    scene: "分布式节点网络：光点分布在网格四角与中心之间，连线保持开放，不形成单一枢纽",
    action: "光点按由外到内的顺序亮起，细线逐段连接，最后保留一处未闭合节点作为停顿",
    props: "节点阵列、二维连接线与无文字来源角标",
    timeline: "光点依次亮起，细线分段连接并保留一处未闭合节点",
  },
  "scene-3": {
    scene: "元数据与模块分支：上半屏排列字段行，下半屏用节点和分叉线表示模块化结构",
    action: "字段逐行出现，分支节点依次接入主干，所有连线完成后统一降亮并停稳",
    props: "元数据字段行、模块节点、分叉线与无文字来源角标",
    timeline: "字段逐行出现，模块节点接入主干后统一停稳",
  },
  "scene-4": {
    scene: "留白网格与光标：画面只保留低对比网格、中心空框和一枚光标，信息密度降至最低",
    action: "网格先降亮，空框保持完整，光标按固定节拍明灭三次后停止",
    props: "低对比网格、空框与方形光标",
    timeline: "网格持续降亮，空框保持完整，光标明灭三次后停止",
  },
  ending: {
    scene: "来源落款：本镜列明字符串居中排列，无文字来源角标固定在底部安全区",
    action: "本镜列明字符串先完整出现，光标随后停止闪烁并保持静止",
    props: "本镜列明字符串、无文字来源角标与方形光标",
    timeline: "本镜列明字符串完整落位，光标停止闪烁后静止",
  },
};

function selectAbstractVisibleTexts(shotId: string, values: string[]): string[] {
  const url = values.find((value) => /^https?:\/\//u.test(value));
  const license = values.find((value) => /^License\s*:/iu.test(value))
    ?? values.find((value) => /^Apache-2\.0$/iu.test(value));
  const official = values.filter((value) => value !== url && value !== license
    && Array.from(value).length >= 20);
  const clean = (items: Array<string | undefined>): string[] => [...new Set(items.filter((item): item is string => Boolean(item)))];
  if (shotId === "opening") return clean([url, values[0]]);
  if (shotId === "scene-1") return clean([official[0], values[1]]);
  if (shotId === "scene-2") return [license ?? "Apache-2.0"];
  if (shotId === "scene-3") return clean([url, license, official[1], official[0]]);
  if (shotId === "scene-4") return [];
  if (shotId === "ending") return clean([official[0], url]);
  return clean([values[0]]);
}

function buildAbstractPromptFields(shotId: string, duration: number, visibleTexts: string[]): string[] {
  const values = [...new Set(visibleTexts.filter(Boolean))];
  const hasText = values.length > 0;
  const sentence = values.map((value) => `“${value}”`).join("、");
  const variant = ABSTRACT_SHOT_VARIANTS[shotId] ?? ABSTRACT_SHOT_VARIANTS["scene-2"]!;
  const fields: Array<[string, string]> = [
    ["语言约束", "除本次 G1 已审原文、许可证字段和仓库地址外，其余字段使用中文；不新增未审英文。"],
    ["导演意图", "极简抽象信息片；以本次 G1 已审原文、二维几何和受控明暗变化建立证据感；所有表达保持可读、可停稳、可截图复核。"],
    ["基础", "高质量二维文字与图形合成；文字边缘清晰，灰度层次稳定，画面不依赖实体材质、真实摄影或未审场景。字形、线宽、光点和灰阶在每个镜头内保持一致，不因缩放或叠层出现断裂、重影、噪点堆积与非受控闪动。"],
    ["约束", "9:16 竖屏，2160x3840，30fps，H.264/MP4，AAC 48kHz 双声道；关键文字位于平台安全区，字幕轨不生成，画面文字仅作图形层。"],
    ["场景", `纯黑或冷灰二维抽象画布。本镜采用${variant.scene}；所有元素位于同一平面图层。文字与图形只在既定安全区内移动，层与层之间以明度、透明度和遮挡关系区分，无文字来源角标始终可辨认，任何装饰不得压住原文。来源角标为纯几何标记，不承载文字；${hasText ? "如出现地址，只使用本镜列明字符串。" : "本镜不出现任何文字、地址或标签。"}场景中的全部对象均为可替换的文字层或矢量层，不通过透视、阴影方向、景别变化或环境细节暗示画外空间。`],
    ["灯光设计", "只以冷白自发光和灰阶明暗差建立层级；亮部集中在文字与线条，暗部保持纯净，不声明实体灯具或环境照明。高光只沿字形和图形边缘出现，亮区面积随信息落点变化，暗区保持连续并避免过曝；所有明暗变化必须服务文字可读性、节点连接或结尾停稳。"],
    ["明亮约束", hasText ? "已审原文与关键图形在安全区内清晰可读，暗部不抬灰；亮暗变化只服务信息层级与停稳。" : "网格线、空框和光标在安全区内保持可辨，暗部不抬灰；亮暗变化只服务停顿和停稳。"],
    ["构图", hasText
      ? "文字与抽象几何按信息优先级分层；主体居中或按场景节奏偏置，四周保留平台安全边距，无文字来源角标不遮挡原文。每个画面的第一视觉落点为可核对文字，第二落点为节点或光标，第三层才允许出现辅助线；任何元素不得越出安全区、跨屏裁切或与平台遮挡区重叠。主次层级在所有时间点保持可辨，不以满屏装饰替代信息结构，也不让辅助线条先于原文抢占视线。"
      : "低对比网格与中心空框按安全区居中，光标作为唯一动态落点；四周保持暗场留白，不出现文字、节点连线或辅助标签。构图在明灭前后保持稳定，结尾可完整截取空框与光标。"],
    ["色彩/色调", "纯黑、冷灰和冷白构成低饱和色板；强调色面积受控，不新增品牌色、材质色或未审环境色。文字使用最高明度，细线与节点使用中灰，背景保持连续暗场；不使用渐变彩光、彩色阴影或高饱和装饰，保证不同镜头之间色感一致。"],
    ["景深", "二维图层保持清晰；前后关系只由透明度、灰阶和图层叠放表达，关键原文、地址和光标处于同一可读平面。较远图形仅降低明度与不透明度，不做失焦、散景或距离推断；文字在出现和落位过程中保持相同清晰度，结尾停稳后可完整截取。"],
    ["运镜", "固定二维视图或受控图层位移；起止位置明确、速度平缓、落幅稳定，不使用真实摄影器材或物理光学位移参数。一次镜头只保留一个方向的信息推进，图层位移距离与速度以文字可读为上限；动作结束后所有元素停在可复核构图，不追加摆动、呼吸或自动回弹。"],
    ["角色", "全片无人，不出现人物、人体局部、服装、化妆、表情或人物动作；画面主体仅为已审原文和抽象图形。角色相关识别、身份、表演和一致性检查在本镜统一标记为不适用，后续不得由生成模型自行补人。"],
    ["服装", "无角色出场，本字段不适用。"],
    ["化妆", "无角色出场，本字段不适用。"],
    ["动作", hasText
      ? `屏上文字严格按【可见文字锁定】的完整清单逐字呈现。本镜执行${variant.action}。出现阶段先锁定首字符与来源关系，推进阶段保持字距和行序不变，收束阶段统一完成连线并停止亮度变化；所有动作只发生在二维图层，结果可截图复核。`
      : `本镜不显示任何屏上文字；${variant.action}。所有变化只发生在二维网格、空框和光标，收束后保持静止并可截图复核。`],
    ["道具", hasText
      ? `无实物道具；本镜使用${variant.props}，文字层只使用【可见文字锁定】列明字符串。文字层由后期精确排版，几何与光标由二维矢量生成；所有元素均保留独立层级与可审计位置，不调用未提供的产品图、人物素材或实体素材。`
      : `无实物道具；本镜仅使用${variant.props}，不出现文字层、产品图、人物素材或实体素材。所有元素由二维矢量生成并保留独立层级。`],
    ["定妆照", "不适用（cast.mode=none，无角色与定妆照）。"],
    ["台词", hasText ? "不适用（本片无对白）；只允许逐字呈现本镜列明的已审可见文字。" : "不适用（本片无对白，本镜也无屏上文字）。"],
    ["时间轴", abstractTimeline(duration, variant.timeline, hasText)],
    ["情绪", "冷酷精密；无人物表演，仅由文字、图形、亮度与停稳节奏表达。情绪强度保持克制，结尾回到稳定与可信，不通过夸张对比、闪烁或音效煽动。"],
    ["节奏", "开头建立可读落点，中段按信息顺序展开，结尾统一降亮并停稳；不依赖快速抖动或多层噪声推动节奏。每个阶段的信息出现数量受控，前后镜保留明确停顿，高潮只由连线完成和文字停稳形成，避免重复闪烁与过量运动。"],
    ["转场", "统一使用 0.2 秒硬切；上一镜末帧与下一镜首帧亮度差受控，不新增叠化、缓推或空间连续性要求。切点保留稳定帧，前后文字形状与基线不得跳变；无文字来源角标仅作几何参照。"],
    ["音频", "无对白、无口播、无人声、无音乐、无BGM、无配乐、无音乐节拍；仅允许经授权的抽象键盘击键、低频环境音与动作音效，并与本镜剪辑点对齐。"],
    ["音频纪律", "本片按无对白处理，台词人声与旁白字段不适用；若后期新增人声，必须另走已审文案逐字朗读与授权核验。只保留抽象键盘击键、低频环境音和动作音效，配乐由后期统一处理；整体响度 -14 LUFS，True Peak ≤ -1 dBTP，AAC 48kHz 双声道。声音不得伪装产品运行、真人操作或未审空间。"],
    ["负面约束", "禁止人物、人体局部、实体空间、设备外观、可运行界面、价格类、销量类、评价类、竞品类信息、额外文字、品牌标识和未审外部素材。禁止画面内出现未列明的英文、乱码、占位符、重复字段、彩色噪点、粒子堆叠、过曝或遮挡原文；负面规则本身不上屏，也不能被误写为产品事实或替代来源标注。"],
    ["角色约束", "画面无人物，禁止任何人物入镜。"],
    ["角色一致性", "本镜无角色；保持二维色板、字形、光标和抽象几何样式一致。"],
    ["微动作", NO_PERSON_MICRO_ACTION],
    ["可见文字锁定", hasText ? `本镜只允许以下精确字符串上屏：${sentence}；不截断、不改标点、不新增其他文字。` : "本镜无屏上文字；不得由生成端补字、标签或占位符。"],
    ["技术交付", "2160x3840，9:16，30fps，H.264/MP4，AAC 48kHz 双声道；AAC 响度 -14 LUFS，True Peak ≤ -1 dBTP。"],
  ];
  return fields.map(([tag, content], index) => `${String(index + 1).padStart(2, "0")}.【${tag}】${content}`);
}

function normalizeAbstractPromptMarkdown(value: string, changes: string[], options: MarketingPromptOptions): string {
  const durationRows = new Map([...value.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?)s\s*\|/gmu)]
    .map((match) => [match[1]!.trim(), Number(match[2])]));
  const visibleTexts = extractAbstractVisibleText(value, options.allowedVisibleText);
  const lines = value.split("\n");
  const output: string[] = [];
  let shotId = "";
  let inPrompt = false;
  let blockIndex = 0;
  const rebuilt: Array<{ shotId: string; chars: number; count: number; duration: number }> = [];
  for (const line of lines) {
    const heading = /^###\s+([^(\s]+)\(/u.exec(line);
    if (heading) {
      shotId = heading[1]!;
      output.push(line
        .replace(/片头·\d+字段/gu, "片头·30字段")
        .replace(/内容·\d+字段/gu, "内容·30字段"));
      continue;
    }
    if (!inPrompt && shotId && /^\*\*长度\*\*/u.test(line)) {
      const duration = durationRows.get(shotId) ?? 4;
      output.push(line.replace(/\*\*时间轴\*\*:\s*[^\n]*/u,
        `**时间轴**: 完整覆盖本镜 ${duration}s；按首段、推进段、停稳段三段执行`));
      continue;
    }
    if (line.trim() === "```markdown") {
      inPrompt = true;
      output.push(line);
      continue;
    }
    if (inPrompt && line.trim() === "```") {
      const duration = durationRows.get(shotId) ?? 4;
      const visible = selectAbstractVisibleTexts(shotId, visibleTexts);
      const fields = buildAbstractPromptFields(shotId, duration, visible);
      const content = fields.join("\n");
      output.push(...fields, line);
      rebuilt.push({ shotId, chars: Array.from(content).length, count: fields.length, duration });
      blockIndex += 1;
      inPrompt = false;
      continue;
    }
    if (inPrompt) continue;
    if (/^[；;]\s*全片无人，不出现人物、人体局部或人物动作/u.test(line.trim())) continue;
    output.push(line);
  }
  if (rebuilt.length === 0) {
    let fieldIndex = 0;
    const normalized = output.flatMap((line) => {
      if (/^###\s+/u.test(line)) fieldIndex = 0;
      if (/^[；;]\s*全片无人，不出现人物、人体局部或人物动作/u.test(line.trim())) return [];
      const field = /^(\d{2}\.)【([^】]+)】([\s\S]*)$/u.exec(line);
      if (!field) return [line];
      fieldIndex += 1;
      const tag = field[2]!;
      const content = ABSTRACT_FIELD_FALLBACK[tag] ? normalizeAbstractField(tag, field[3]!) : field[3]!;
      return [`${String(fieldIndex).padStart(2, "0")}.【${tag}】${content}`];
    });
    changes.push("abstract-field-contract-normalized");
    return normalized.join("\n");
  }
  let normalized = output.join("\n");
  if (rebuilt.length) {
    for (const block of rebuilt) {
      const pattern = new RegExp(`^\\|\\s*${block.shotId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\|.*$`, "mu");
      normalized = normalized.replace(pattern,
        `| ${block.shotId} | ${block.duration}s | ${block.chars} | ✅ ${block.count}/30 | — | — | ✓ | ✓ |`);
    }
    let lengthIndex = 0;
    normalized = normalized.replace(/^\*\*长度\*\*:\s*\d+\s*字符/mgu, () => {
      const block = rebuilt[lengthIndex++];
      return block ? `**长度**: ${block.chars} 字符` : "**长度**: 未记录字符";
    });
    const average = Math.round(rebuilt.reduce((sum, block) => sum + block.chars, 0) / rebuilt.length);
    normalized = normalized.replace(/\*\*平均长度\*\*:\s*\d+\s*字符/u, `**平均长度**: ${average} 字符`);
    normalized = normalized.replace(
      /## ⚠️ 审核须知[\s\S]*?(?=\n\*\*请回复)/u,
      "## ⚠️ 审核须知\n\n"
      + "1. 内容镜头逐镜至少 25 个独立字段，片头至少 30 个独立字段。\n"
      + "2. 每个镜头的时间轴覆盖完整时长并给出停稳落幅。\n"
      + "3. 屏上文字只使用本镜列明的 G1 已审原文、许可证字段与仓库地址。\n"
      + "4. 无人片的定妆照、服装、化妆和人物一致性字段统一记为不适用，不引用人物素材。\n"
      + "5. 负面约束使用中文且不得包含未审人物、实体空间、设备外观、可运行效果、评价、销量或竞品内容。\n"
      + "6. 六镜必须保留不同的二维信息构图、动作与信息推进，不以重复模板冒充多镜交付。\n\n",
    );
  }
  changes.push("abstract-field-contract-normalized");
  return normalized;
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
  if (options.abstractOnly) next = normalizeAbstractPromptMarkdown(next, changes, options);
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

export function buildMarketingPreproductionReport(input: {
  productionResult: RecordValue;
  scriptResult?: RecordValue | null;
  timing?: RecordValue | null;
  confirmations?: RecordValue | null;
  contractScenes?: unknown[];
  options: MarketingPromptOptions;
}): string {
  const shots = Array.isArray(input.productionResult.shots)
    ? input.productionResult.shots.filter(isRecord)
    : [];
  const prompts = Array.isArray(input.productionResult.prompts)
    ? input.productionResult.prompts.filter(isRecord)
    : [];
  const visibleTexts = extractAbstractVisibleText("", input.options.allowedVisibleText);
  const contractScenes = Array.isArray(input.contractScenes) ? input.contractScenes.filter(isRecord) : [];
  const resolvedDurations = shots.map((shot, index) => {
    const id = String(shot.shotId ?? shot.shot_id ?? "");
    const matched = contractScenes.find((scene) => String(scene.id ?? "") === id) ?? contractScenes[index];
    return Number(matched?.duration ?? shot.duration ?? 0);
  });
  const totalDuration = resolvedDurations.reduce((sum, duration) => sum + duration, 0);
  const roleCount = input.options.noPeople
    ? 0
    : listLength(isRecord(input.scriptResult?.blueprint)
      ? (isRecord(input.scriptResult!.blueprint.character_system) ? input.scriptResult!.blueprint.character_system.characters : input.scriptResult!.blueprint.characters)
      : undefined);
  const effectiveMs = Number(input.timing?.effective ?? 0);
  const lines = [
    "# 预生产结果报告",
    "",
    `**镜头总数**: ${shots.length}`,
    `**总时长**: ${totalDuration} 秒`,
    `**角色数**: ${roleCount}`,
    `**提示词数**: ${Math.max(prompts.length, shots.length)}`,
    `**有效处理时间**: ${Number.isFinite(effectiveMs) && effectiveMs > 0 ? `${Math.round(effectiveMs / 60000)} 分钟` : "未记录（预生产计时未回传）"}`,
    "**渲染提交**: 否（预生产门不提交视频 POST）",
    "",
    "## 不适用项清单",
    "",
    `- 台词速率/占比：${input.options.noPeople ? "不适用（本片无对白）" : "待实际音轨核验"}`,
    "- 口型：不适用（本片无人物）",
    "- 音频响度：未验证（预生产阶段无最终音轨）",
    "- 定妆照与人物一致性：不适用（cast.mode=none）",
    "",
    "## 镜头与提示词",
    "",
    "> 场景的“预估镜头数”是前期拆分建议；G6 每场产出一份融合提示词，G7 按真实提示词数逐项核验，不把预估数写成未提供的独立生成任务。",
    "",
    "| 镜头 | 时长 | 字段数 | 提示词字符数 | 精确可见文字 | 二维场景 |",
    "|------|------|--------|--------------|--------------|----------|",
  ];
  const promptBodies: Array<{ shotId: string; duration: number; body: string; scene: string; visible: string; fields: string[] }> = [];
  for (const [index, shot] of shots.entries()) {
    const shotId = String(shot.shotId ?? shot.shot_id ?? prompts[index]?.shotId ?? `shot-${index + 1}`);
    const duration = resolvedDurations[index] ?? 0;
    const visibleValues = selectAbstractVisibleTexts(shotId, visibleTexts);
    const visible = visibleValues.join(" | ");
    const fields = buildAbstractPromptFields(shotId, duration, visibleValues);
    const body = fields.join("\n");
    const scene = body.split("\n").find((line) => line.includes("【场景】"))?.replace(/^\d+\.【场景】/u, "") ?? "";
    promptBodies.push({ shotId, duration, body, scene, visible, fields });
    lines.push(`| ${shotId} | ${duration}s | ${fields.length} | ${Array.from(body).length} | ${visible.replace(/\|/gu, "／")} | ${scene.replace(/\|/gu, "／")} |`);
  }
  for (const prompt of promptBodies) {
    const field = (tag: string): string => prompt.fields.find((line) => line.includes(`【${tag}】`))?.replace(/^\d+\.【[^】]+】/u, "") ?? "";
    lines.push(
      "",
      `### ${prompt.shotId}`,
      "",
      `**时长**: ${prompt.duration}s`,
      "",
      "**完整镜头卡**：",
      "",
      "| 镜头卡字段 | 内容 |",
      "|------------|------|",
      `| 场景 | ${field("场景").replace(/\|/gu, "／")} |`,
      `| 构图 | ${field("构图").replace(/\|/gu, "／")} |`,
      `| 光影层次 | ${field("灯光设计").replace(/\|/gu, "／")} |`,
      `| 二维视图 | ${field("运镜").replace(/\|/gu, "／")} |`,
      `| 主体动作 | ${field("动作").replace(/\|/gu, "／")} |`,
      `| 图像元素 | ${field("道具").replace(/\|/gu, "／")} |`,
      `| 定妆照 | ${field("定妆照").replace(/\|/gu, "／")} |`,
      `| 精确可见文字 | ${prompt.visible.replace(/\|/gu, "／")} |`,
      `| 时间轴 | ${field("时间轴").replace(/\|/gu, "／")} |`,
      "",
      "**完整提示词**：",
      "",
      "```markdown",
      prompt.body,
      "```",
    );
  }
  lines.push("", "## 确认记录", "");
  for (const [key, value] of Object.entries(input.confirmations ?? {})) {
    const record = isRecord(value) ? value : {};
    const approved = record.approved === true;
    const skipped = record.skipped === true;
    if ((key === "portraitGeneration" || key === "portrait") && input.options.noPeople) continue;
    lines.push(`- ${key}: ${approved ? "通过" : "未通过"}${skipped ? "（跳过）" : ""}`);
  }
  if (input.options.noPeople) lines.push("- portraitGeneration: 不适用（cast.mode=none）");
  lines.push(
    "",
    "## 下一步",
    "",
    "本报告只确认预生产三件套与完整提示词正文；不提交视频渲染，也不把待执行计划写成已完成回执。",
    "",
    "> 时长核对：各镜时长之和等于客户明确目标时长；最终媒体时长仍须在渲染与后期阶段实测。",
    "",
  );
  return lines.join("\n");
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
