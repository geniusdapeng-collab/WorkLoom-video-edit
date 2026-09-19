/**
 * growth 试点场景集（三个判断场景，与 bundles/geo-growth/model-policy.yml 的既有场景位对齐）
 *
 * 与现有场景的关系（不改基座、不改现有路由，先影子对照）：
 *   - comment-classify ↔ model-policy `comment-classify`（社媒评论/线索初筛，L1 谷时批量）
 *   - lead-qualify    ↔ model-policy `lead-qualify`（线索分级与跟进建议，L2）
 *   - fact-precheck   ↔ 围栏 G-GEO2「事实红线一票否决」的人工前置预检（**不替代**该围栏）
 *
 * 写法纪律（全部来自 TypeSafe 官方 jaggedness 文档）：
 *   ① instructions 一律英文短句、直述条件（模型字面理解，双关/双重否定会掉分）；
 *   ② 不做算术、不比较日期：需要数字/日期时留在代码里（本文件不构造此类问题）；
 *   ③ state 只放判断必需字段，避免无关长文干扰（context rot）；
 *   ④ 事实类问题只做「语义是否超出官方口径」的判断；品牌实体逐字一致性属于确定性比对，不进模型。
 */
import type {
  AnswerView,
  JevCallResult,
  JevRequest,
  Scene,
  SceneInput,
  SceneKey,
  SceneDecision,
} from "./types.js";

function percent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

function answer(result: JevCallResult, id: string): AnswerView {
  const found = result.byId[id];
  if (!found) throw new Error(`回答缺失：${id}`);
  return found;
}

/** 取所有回答置信度的最小值：任一维度不确定，整体就不该自动放行 */
function conservativeConfidence(result: JevCallResult, ids: readonly string[]): number {
  const values = ids.map((id) => answer(result, id).confidence);
  return Math.min(...values);
}

function anyDerived(result: JevCallResult, ids: readonly string[]): boolean {
  return ids.some((id) => answer(result, id).confidenceDerived);
}

/* ------------------------------------------------------------------ */
/* 场景 1：社媒评论 / 线索初筛                                          */
/* ------------------------------------------------------------------ */

const COMMENT_INTENT_CRITERIA: Record<string, string> = {
  inquiry: "Asks a factual question about the product, service, price or availability, without clear buying intent yet.",
  booking_intent: "States a concrete intention to book, buy, reserve or order, now or at a stated near-term time.",
  complaint: "Expresses dissatisfaction, a bad experience, or demands compensation or a fix.",
  smalltalk: "Social or off-topic chat that is not about the business offering.",
  spam: "Advertising, unrelated promotion, engagement bait, or a repeatable bot-like message.",
};

const COMMENT_INTENT_ZH: Record<string, string> = {
  inquiry: "咨询问询",
  booking_intent: "预订/购买意向",
  complaint: "投诉负面",
  smalltalk: "闲聊无关",
  spam: "广告/无效",
};

export const commentClassifyScene: Scene = {
  key: "comment-classify",
  version: "1.0.0",
  description: "社媒评论/私信初筛：意图分类 + 是否销售线索 + 是否需要人工处理",
  primary: { id: "intent", type: "choice" },
  labelsZh: COMMENT_INTENT_ZH,
  build(input: SceneInput): JevRequest {
    return {
      state: {
        task: "Classify one customer comment for a Chinese hospitality and travel business.",
        comment: input.text,
        ...(input.context ? { context: input.context } : {}),
      },
      questions: {
        intent: {
          type: "choice",
          instructions:
            "Choose the single best category for this comment. Judge what the comment is asking for or expressing, not individual keywords.",
          criteria: COMMENT_INTENT_CRITERIA,
        },
        is_lead: {
          type: "boolean",
          instructions:
            "Does the comment come from a person who could become a paying customer and shows purchase or booking interest?",
          criteria: {
            true: "A potential customer showing concrete interest in booking or buying.",
            false: "General chat, spam, a pure complaint without purchase interest, or an existing customer service issue.",
          },
        },
        needs_human: {
          type: "boolean",
          instructions:
            "Should a human handle this comment because it involves a complaint, a refund or compensation demand, legal risk, price negotiation, or sensitive personal data?",
          criteria: {
            true: "Complaint, compensation, legal risk, negotiation, or sensitive personal data.",
            false: "A routine inquiry, a simple booking intent, smalltalk or spam with no risk signal.",
          },
        },
      },
    };
  },
  decide(result: JevCallResult): SceneDecision {
    const intent = answer(result, "intent");
    const lead = answer(result, "is_lead");
    const human = answer(result, "needs_human");
    const decision = intent.choice ?? "unknown";
    return {
      decision,
      decisionZh: COMMENT_INTENT_ZH[decision] ?? decision,
      confidence: intent.confidence,
      confidenceDerived: intent.confidenceDerived,
      details: {
        is_lead: lead.probability ?? 0,
        needs_human: human.probability ?? 0,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 场景 2：线索分级                                                     */
/* ------------------------------------------------------------------ */

const LEAD_LEVELS = [
  "No purchase intent is expressed; the message is informational or social only.",
  "Interested but vague: asks about the offering without a concrete purchase step.",
  "Clear intent: states a concrete booking, buying or reserving action, or asks how to pay and proceed.",
] as const;

const LEAD_LEVEL_ZH: Record<string, string> = { "0": "低意向", "1": "中意向", "2": "高意向" };

export const leadQualifyScene: Scene = {
  key: "lead-qualify",
  version: "1.0.0",
  description: "线索分级：购买意向强度（有序档位）+ 预算/时间/决策人三个事实问题",
  primary: { id: "intent_strength", type: "score" },
  labelsZh: LEAD_LEVEL_ZH,
  build(input: SceneInput): JevRequest {
    return {
      state: {
        task: "Qualify one sales lead for a Chinese hospitality and travel business.",
        message: input.text,
        ...(input.context ? { context: input.context } : {}),
      },
      questions: {
        intent_strength: {
          type: "score",
          instructions:
            "How concrete is this person's purchase or booking intent, judging only what the message states?",
          criteria: [...LEAD_LEVELS],
        },
        budget_stated: {
          type: "boolean",
          instructions: "Does the message state or ask about a budget, price range, or spending limit?",
        },
        timeline_stated: {
          type: "boolean",
          instructions:
            "Does the message mention a time horizon for the booking or purchase, such as this month, next week, or a specific trip date?",
        },
        decision_maker: {
          type: "boolean",
          instructions:
            "Does the message suggest the sender can decide or pay for this purchase themselves, for example by asking how to pay or to hold a room?",
        },
      },
    };
  },
  decide(result: JevCallResult): SceneDecision {
    const strength = answer(result, "intent_strength");
    const rawScore = strength.score ?? 0;
    const bucket = Math.min(LEAD_LEVELS.length - 1, Math.max(0, Math.round(rawScore)));
    const decision = String(bucket);
    const ids = ["intent_strength", "budget_stated", "timeline_stated", "decision_maker"] as const;
    return {
      decision,
      decisionZh: LEAD_LEVEL_ZH[decision] ?? decision,
      confidence: conservativeConfidence(result, ids),
      confidenceDerived: anyDerived(result, ids),
      details: {
        intent_strength: Number(rawScore.toFixed(3)),
        budget_stated: answer(result, "budget_stated").probability ?? 0,
        timeline_stated: answer(result, "timeline_stated").probability ?? 0,
        decision_maker: answer(result, "decision_maker").probability ?? 0,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 场景 3：事实红线预检（G-GEO2 的前置影子，不替代围栏）                  */
/* ------------------------------------------------------------------ */

const PRE_IDS = ["premise_supported", "invented_specifics", "brand_stance_risk"] as const;

export const factPrecheckScene: Scene = {
  key: "fact-precheck",
  version: "1.0.0",
  description: "GEO 草稿事实红线预检：前提是否在官方口径内 / 是否编造具体信息 / 是否是品牌表态",
  primary: { id: "premise_supported", type: "boolean" },
  build(input: SceneInput): JevRequest {
    const claims = input.officialClaims ?? [];
    if (claims.length === 0) {
      // 没有官方口径就无从判断「是否超出口径」——fail-closed，不允许拿空清单去猜
      throw new Error("fact-precheck 需要 officialClaims（官方口径清单），拒绝空清单预检");
    }
    return {
      state: {
        task: "Check whether a marketing draft stays within the official claims of a hospitality business.",
        draft: input.text,
        official_claims: claims,
        ...(input.context ? { context: input.context } : {}),
      },
      questions: {
        premise_supported: {
          type: "boolean",
          instructions:
            "Does every factual premise this draft relies on appear in the official claims list?",
          criteria: {
            true: "All factual premises are supported by the official claims list.",
            false: "At least one factual premise is not supported, or adds conditions the list does not state.",
          },
        },
        invented_specifics: {
          type: "boolean",
          instructions:
            "Does the draft state specific numbers, awards, certifications, partner names or third-party endorsements that are absent from the official claims list?",
        },
        brand_stance_risk: {
          type: "boolean",
          instructions:
            "Does the draft make a brand-level promise, guarantee, or stance on behalf of the company that would need human approval before publishing?",
        },
      },
    };
  },
  decide(result: JevCallResult): SceneDecision {
    const premise = answer(result, "premise_supported");
    const invented = answer(result, "invented_specifics");
    const stance = answer(result, "brand_stance_risk");
    const inventedP = invented.probability ?? 0;
    const stanceP = stance.probability ?? 0;
    const premiseP = premise.probability ?? 0;
    const decision =
      inventedP > 0.5 || stanceP > 0.5 ? "risk" : premiseP < 0.5 ? "unsupported" : "pass";
    const decisionZh = decision === "risk" ? "疑似编造/表态风险" : decision === "unsupported" ? "前提超出口径" : "预检通过";
    return {
      decision,
      decisionZh,
      confidence: conservativeConfidence(result, PRE_IDS),
      confidenceDerived: anyDerived(result, PRE_IDS),
      details: {
        premise_supported: premiseP,
        invented_specifics: inventedP,
        brand_stance_risk: stanceP,
      },
    };
  },
};

export const SCENES: Record<SceneKey, Scene> = {
  "comment-classify": commentClassifyScene,
  "lead-qualify": leadQualifyScene,
  "fact-precheck": factPrecheckScene,
};

export function sceneOf(key: string): Scene {
  const scene = SCENES[key as SceneKey];
  if (!scene) {
    throw new Error(`未知场景：${key}（可选：${Object.keys(SCENES).join(", ")}）`);
  }
  return scene;
}

/** 供报告与日志使用的可读摘要（不含 state 原文，避免把客户文本带进日志） */
export function summarizeDecision(decision: SceneDecision): string {
  const details = Object.entries(decision.details)
    .map(([key, value]) => `${key}=${typeof value === "number" ? percent(value) : value}`)
    .join(" ");
  return `${decision.decisionZh}(${decision.decision}) conf=${percent(decision.confidence)}${details ? ` ${details}` : ""}`;
}
