/**
 * 酒店行业意图词表与规则扩展（单一事实源）。
 *
 * 基座规则表（packages/base/service-dialog/intents.ts）刻意保持行业无关：房型、订单、
 * 会员与「报修/送物」这类业务对象和履约动作，只能由活动行业包以 IntentRuleExtension
 * 注入。本模块是该注入点在本仓的唯一实现，同时被三条路径共用，避免词表分叉：
 *   ① 服务前台行业适配器 hotelBizAdapter.classify（biz_query 工具分流）
 *   ② 服务前台行业适配器 hotelBizAdapter.ticketKind（工单类型）
 *   ③ service/dialog.ts 的对话意图流水线 classify / ticketKindOf
 *
 * 规则顺序纪律（与 base 求值顺序配套）：
 *   - 明确业务对象（订单/会员/房型/工单进度）→ biz_query，优先于疑问句判定
 *     （「我的会员积分还有多少」是业务查询，不能落 kb_qa）；
 *   - 履约动作（报修/送物）→ service_request，但**低于**疑问句判定
 *     （「送站巴士几点发车」只是问信息，不建单）。
 */
import type { IntentRuleExtension } from "@workloom/base/service-dialog";

/** 工单进度查询（biz_query 子类，先于其它业务对象判定） */
export const HOTEL_RE_TICKET_STATUS = /工单.*(进度|状态|怎么样)|进度.*工单/;
/** 房型/房价目录查询（判定锚是房型名词，避免「面膜多少钱」类通用询价误判） */
export const HOTEL_RE_ROOM_RATE = /房价|房型|大床房|双床房|单人房|标准间|套房|海景房|钟点房/;
/** 订单/账单查询 */
export const HOTEL_RE_ORDER = /订单|预订|订房|入住记录|房费|账单/;
/** 会员/积分查询 */
export const HOTEL_RE_MEMBER = /会员|积分|等级|权益|余额/;
/** 报修类履约动作 → 工单类型 repair */
export const HOTEL_RE_REPAIR = /维修|修|坏|故障|漏水|不制冷|不制热|空调|热水|马桶/;
/** 送物/清洁类履约动作 → 工单类型 delivery */
export const HOTEL_RE_DELIVERY = /送|拿|打扫|换床单|加一|多要|再来/;

/** 文本 → 工单类型（无履约动作 → null；调用方决定兜底策略） */
export function hotelTicketKindOf(text: string): "repair" | "delivery" | null {
  if (HOTEL_RE_REPAIR.test(text)) return "repair";
  if (HOTEL_RE_DELIVERY.test(text)) return "delivery";
  return null;
}

/**
 * 酒店行业意图扩展：只声明行业可解释的部分，未命中返回 null 交还基座规则表，
 * 基座因此仍可在无行业扩展时保持行业无关（industry-neutral 不受影响）。
 */
export const hotelIntentRules: readonly IntentRuleExtension[] = [
  {
    id: "hotel.service-front-v1",
    classify(text: string) {
      if (HOTEL_RE_TICKET_STATUS.test(text)) return "biz_query";
      if (HOTEL_RE_ROOM_RATE.test(text)) return "biz_query";
      if (HOTEL_RE_ORDER.test(text)) return "biz_query";
      if (HOTEL_RE_MEMBER.test(text)) return "biz_query";
      if (hotelTicketKindOf(text) !== null) return "service_request";
      return null;
    },
  },
];
