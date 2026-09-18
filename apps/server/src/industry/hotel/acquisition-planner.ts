/**
 * 酒店获客行业规划器（QuestPlanner seam 的行业实现）。
 *
 * 为什么需要它：基座确定性规划器只按装配工具生成空参步骤，而围栏的判定条件是
 * 业务参数（R6 `params.rating<=3`、R1 `after.price/before.price`）——缺数据时按 D27
 * 「宁错杀」熔断，于是"差评必审挂起""越线调价上浮"这类获客闭环在演示里根本走不到。
 *
 * 行业规划器的职责：把店长/老板的口语目标翻译成**带业务上下文**的步骤，并且**不猜数据**：
 *   - 能从目标或一店一档（价带、房型、评分）推导的参数才写进步骤；
 *   - 推不出来就省略，让围栏按失败关闭处理（宁可挂起，不可误放）。
 * 参数一旦进入围栏就不可能被模型改写——这里只做确定性直译，不做任何"取巧补数"。
 */
import { planQuest, type AssembledPreset, type QuestPlanner, type QuestStep } from "@workloom/runtime";

/** 一店一档里与获客闭环相关的字段（缺失即视为未建档，相关意图退回通用规划） */
interface PlanningArchive {
  business?: Record<string, unknown>;
  property?: { name?: string; rooms?: number };
  entity_card?: { product_lines?: Array<{ model?: string; name?: string }>; core_selling_points?: string[] };
  content_assets?: { materials?: number };
  conversion_assets?: { coupon_skus?: Array<{ sku?: string; title?: string; stock?: number }> };
  forbidden?: string[];
}

function archiveOf(preset: AssembledPreset): PlanningArchive {
  const essentials = preset.essentials as unknown as { archive?: Record<string, unknown> } | undefined;
  return (essentials?.archive ?? {}) as PlanningArchive;
}

/** 价带锚点：一店一档里房型价带 [低位, 高位] 的中值；无该房型返回 undefined（不猜价格） */
function bandAnchor(archive: PlanningArchive, roomType: string): number | undefined {
  const bands = archive.business?.price_bands as Record<string, unknown> | undefined;
  if (!bands) return undefined;
  const entry = Object.entries(bands).find(([name]) => roomType.includes(name) || name.includes(roomType));
  const band = entry?.[1];
  if (!Array.isArray(band) || band.length !== 2) return undefined;
  const lower = Number(band[0]);
  const upper = Number(band[1]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return undefined;
  return Math.round((lower + upper) / 2);
}

/** 目标里提到的房型（命中一店一档价带才认） */
function roomTypeOf(goal: string, archive: PlanningArchive): string | undefined {
  const bands = archive.business?.price_bands as Record<string, unknown> | undefined;
  if (!bands) return undefined;
  return Object.keys(bands).find((name) => goal.includes(name));
}

/** 调价意图：百分比（"调 5%"）或绝对价（"调到 510"/"¥510"） */
function priceIntentOf(goal: string): { kind: "percent"; pct: number } | { kind: "absolute"; value: number } | null {
  const percent = /([+-]?\d+(?:\.\d+)?)\s*(?:%|个点|个百分点)/.exec(goal);
  if (percent) {
    const pct = Number(percent[1]);
    if (Number.isFinite(pct) && Math.abs(pct) <= 100) return { kind: "percent", pct };
  }
  const absolute = /(?:到|至|为|¥|￥)\s*(\d{2,6}(?:\.\d+)?)/.exec(goal);
  if (absolute) {
    const value = Number(absolute[1]);
    if (Number.isFinite(value) && value > 0) return { kind: "absolute", value };
  }
  return null;
}

/** 评价评分：目标里明说"2 分差评"就用它；只说"差评"按最差一档 2 分处理（宁可送审） */
function ratingOf(goal: string): number {
  const explicit = /([1-5])\s*分/.exec(goal);
  if (explicit) return Number(explicit[1]);
  return 2;
}

function step(input: {
  index: number; action: string; objectType: string; tool: string;
  params?: Record<string, unknown>; objectId?: string;
  before?: unknown; after?: unknown; label: string;
}): QuestStep {
  return {
    stepId: `s${input.index}`,
    action: input.action,
    objectType: input.objectType,
    tool: input.tool,
    params: input.params ?? {},
    ...(input.objectId ? { objectId: input.objectId } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    label: input.label,
  };
}

/**
 * 行业规划器入口。未知意图一律交回基座确定性规划（不因为行业化而吞掉通用能力）。
 */
export function acquisitionQuestPlanner(goal: string): QuestPlanner {
  return (_goal, preset) => {
    const tools = new Set(preset.tools.map((tool) => tool.name));
    const archive = archiveOf(preset);

    // ① 口碑：差评回复（R6 差评必审挂起 → 人批 → 续跑）
    if (/(差评|评价|口碑|回复).*(回复|处理|跟进)?/.test(goal) && tools.has("review.reply")) {
      return [
        step({ index: 1, action: "review.list", objectType: "review", tool: "review.list", label: "拉取各渠道新评价" }),
        step({
          index: 2, action: "review.reply", objectType: "review", tool: "review.reply", objectId: "RV-DEMO-01",
          params: {
            review_id: "RV-DEMO-01",
            rating: ratingOf(goal),
            text: "很抱歉给您带来不便，我们已记录并安排专人跟进，欢迎随时联系前台。",
          },
          label: "起草并提交评价回复",
        }),
      ];
    }

    // ② 收益：调价（报价带内 auto / 越带与缺基准 → 围栏失败关闭）
    const priceIntent = priceIntentOf(goal);
    const mentionsPrice = /(调价|涨价|降价|定价|改价|房价|价格|调[到整])/.test(goal);
    if ((priceIntent || mentionsPrice) && tools.has("pms.price.write")) {
      const intent = priceIntent;
      const matchedRoom = roomTypeOf(goal, archive);
      const roomType = matchedRoom ?? "主打房型";
      // 锚点只认"目标里点名的房型"的价带；没点名就不拿别的房型价格顶替
      const anchor = matchedRoom ? bandAnchor(archive, matchedRoom) : undefined;
      let before: { price: number } | undefined;
      let after: { price: number } | undefined;
      if (intent?.kind === "percent") {
        // 百分比意图只依赖比值：以 100 为归一化基准，围栏判定（涨幅≤8%）与真实价格同口径
        before = { price: 100 };
        after = { price: Number((100 * (1 + intent.pct / 100)).toFixed(2)) };
      } else if (intent?.kind === "absolute" && anchor !== undefined) {
        before = { price: anchor };
        after = { price: intent.value };
      }
      return [
        step({ index: 1, action: "pms.price.read", objectType: "room_price", tool: "pms.price.read", params: { room_type: roomType }, label: `读取${roomType}当前价格` }),
        step({
          index: 2, action: "price.adjust", objectType: "room_price", tool: "pms.price.write", objectId: "OBJ-DLX-01",
          params: { room_type: roomType, ...(intent ? { price: intent.kind === "absolute" ? intent.value : after?.price } : {}) },
          ...(before ? { before } : {}), ...(after ? { after } : {}),
          label: intent ? `提交${roomType}调价` : "提交调价（未识别到目标价位，交围栏失败关闭）",
        }),
      ];
    }

    // ③ 客房履约：送物/维修/清洁（工单类型 + 房间号从目标直译）
    if (/(送|维修|报修|打扫|换床单|加床)/.test(goal) && tools.has("task.dispatch")) {
      const room = /(\d{3,4})\s*(?:房|房间)?/.exec(goal)?.[1];
      const kind = /(维修|报修|坏|故障|漏水|不制冷)/.test(goal) ? "repair" : "delivery";
      return [
        step({
          index: 1, action: "service.ticket.create", objectType: "ticket", tool: "task.dispatch",
          params: { kind, ...(room ? { room } : {}), request: goal.slice(0, 80) },
          label: `${kind === "repair" ? "报修" : "送物"}派单`,
        }),
      ];
    }

    // ④ 巡检：渠道/房价/评价三项只读扫描（只读动作恒 auto，异常进事件与告警）
    if (/(巡检|体检|检查|扫描)/.test(goal) && tools.has("price.scan")) {
      const steps: QuestStep[] = [];
      let index = 1;
      for (const [tool, objectType, label] of [
        ["channel.status.read", "hotel-channel", "渠道状态巡检"],
        ["price.scan", "room_price", "价格/房态扫描"],
        ["review.scan", "review", "新评价扫描"],
      ] as const) {
        if (!tools.has(tool)) continue;
        steps.push(step({ index, action: tool, objectType, tool, label }));
        index += 1;
      }
      if (steps.length > 0) return steps;
    }

    // ⑤ 内容：草稿→发布（发布必审 G9 由围栏把关）
    if (/(内容|文案|种草|短视频|发布)/.test(goal) && tools.has("content.draft")) {
      const steps: QuestStep[] = [
        step({ index: 1, action: "content.draft", objectType: "content", tool: "content.draft", params: { brief: goal.slice(0, 120) }, label: "生成内容草稿" }),
      ];
      if (tools.has("content.publish")) {
        steps.push(step({ index: 2, action: "content.publish", objectType: "content", tool: "content.publish", params: { brief: goal.slice(0, 120) }, label: "提交发布（公网外发必审）" }));
      }
      return steps;
    }

    // 未知意图：交回基座确定性规划（行业化不吞通用能力）
    return planQuest(goal, preset);
  };
}
