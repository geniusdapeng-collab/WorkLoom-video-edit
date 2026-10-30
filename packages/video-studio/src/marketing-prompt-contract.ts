type RecordValue = Record<string, unknown>;

export interface MarketingPromptOptions {
  targetDuration: number;
  noPeople: boolean;
}

export interface MarketingPromptNormalization<T> {
  value: T;
  changes: string[];
}

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const NO_PERSON_MICRO_ACTION = "无人物微动作；仅由画布上的光标、光点、连线与亮度变化表达节奏";

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
      next[key] = normalizePromptString(value, null, options);
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
