import { createHash } from "node:crypto";
import type { GateVerdict } from "./gates.js";
import type { PrdAuthority, PrdMarketingScope } from "./prd-authority.js";
import { RequirementContractError, requirementHash, requirementRecord, type RequirementRecord } from "./requirement-contract.js";

export interface RequirementApprovedTheme {
  scope: PrdMarketingScope;
  contentMd: string;
  contentSha256: string;
  verdict: GateVerdict;
}

/** These values come from Studio's private prepared authority and approval closure, never metadata. */
export interface RequirementAuthorityOptions {
  authority: PrdAuthority;
  approvedTheme: () => RequirementApprovedTheme | undefined;
  /** Studio binds the existing G1 verifier to its actual workDir/project and current private cfg. */
  validateAuthority: () => void;
}

export function requirementAuthorityFailure(code: string, message: string): never {
  throw Object.assign(new RequirementContractError(code, message), { retryable: false });
}

export function captureRequirementTheme(
  authority: PrdAuthority, contentMd: string, verdict: GateVerdict
): RequirementApprovedTheme | undefined {
  if (!verdict.approved) return undefined;
  if (typeof contentMd !== "string" || !contentMd.trim()) {
    requirementAuthorityFailure("REQUIREMENT_THEME_UNVERIFIED", "本次 G2 原文缺失");
  }
  return structuredClone({ scope: authority.marketing.scope, contentMd,
    contentSha256: createHash("sha256").update(contentMd).digest("hex"), verdict });
}

/** Relabel the vendor's fixed heading only. Every source fact and the original intent stay intact. */
export function qualifyRequirementThemeInput(value: unknown, intent: unknown, metadataValue: unknown = {}): string {
  if (typeof value !== "string") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "原始主题输入不是文本");
  const metadata = requirementRecord(metadataValue, "主题输入 metadata");
  const record = (item: unknown): RequirementRecord | undefined => item && typeof item === "object" ? item as RequirementRecord : undefined;
  const brief = record(metadata.brief), cards = record(record(metadata._dataDossier)?.cards);
  const theme = record(cards?.theme_card), briefCard = record(cards?.brief_card);
  const facts = theme?.differentiation_space;
  if (!Array.isArray(facts) || !facts.length) return value;
  // Reconstruct the exact pinned vendor prefix from the actual arguments. Searching
  // by label/line alone could edit a customer's intent, product name or a fact value.
  const before: string[] = [];
  const product = brief?.product || briefCard?.product;
  if (product) before.push(`商品：${product}`);
  if (brief?.category || briefCard?.category) before.push(`品类：${brief?.category || briefCard?.category}`);
  const sellingPoints = Array.isArray(brief?.sellingPoints) && brief.sellingPoints.length
    ? brief.sellingPoints : (Array.isArray(briefCard?.sellingPoints) ? briefCard.sellingPoints : []);
  if (sellingPoints.length) before.push(`核心卖点：${sellingPoints.slice(0, 3).join("、")}`);
  const audience = brief?.audience || briefCard?.audience;
  if (audience) before.push(`目标人群：${audience}`);
  if (brief?.platform) before.push(`投放平台：${brief.platform}`);
  if (brief?.goal) before.push(`转化目标：${({ seeding: "种草", traffic: "引流", conversion: "转化" } as Record<string, string>)[String(brief.goal)] || brief.goal}`);
  const prefix = `${intent}\n[营销 Brief 与商品情报]\n${before.length ? before.join("\n") + "\n" : ""}`;
  const original = "差异化空位（竞品没讲的）：", line = original + facts.slice(0, 3).join("、");
  if (!value.startsWith(prefix) || value.slice(prefix.length, prefix.length + line.length) !== line
    || !["\n", ""].includes(value.slice(prefix.length + line.length, prefix.length + line.length + 1))) {
    requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "原始主题来源标签不再匹配受控的字段位置");
  }
  return value.slice(0, prefix.length) + "来源事实与创意候选（按本次 G1 证据状态与用途限制使用，不预设竞品结论）："
    + value.slice(prefix.length + original.length)
    + "\n[宿主来源标签校正] 原“差异化空位”仅作素材候选，原事实值完整保留。A1 商品来源主张不构成 A3 竞品结论；"
    + "本次 A3 若为 no_evidence，不得据此写竞品没讲、竞品弱点或市场领先。具体事实与用途以本次完整 G1 为准。";
}

/** Only transport prompts contain this block. It must never be saved as the original story. */
export function requirementAuthorityPrompt(authority: PrdAuthority, theme?: RequirementApprovedTheme): string {
  if (theme && (requirementHash(theme.scope) !== requirementHash(authority.marketing.scope)
    || theme.verdict.approved !== true || typeof theme.contentMd !== "string"
    || createHash("sha256").update(theme.contentMd).digest("hex") !== theme.contentSha256)) {
    requirementAuthorityFailure("REQUIREMENT_THEME_CHANGED", "G2 上下文不属于本次真实批准原文");
  }
  const metadata = authority.metadata;
  const key = requirementHash(authority);
  return `\n\n## 本次宿主需求权威输入 ${key}（冲突时按本节层级处理）\n`
    + `一、完整客户 Brief 和其中本片制作细则决定本片的主张用途、受众与交付要求。G1 接受某条事实，不能覆盖客户选择的用途限制，不能把底账事实自动变成钩子、口播、屏幕卖点或结尾。\n`
    + `完整客户 Brief：\n${JSON.stringify(metadata.brief)}\n`
    + `客户原始诉求：\n${JSON.stringify(metadata.customerOriginalIntent ?? null)}\n`
    + `客户明确生产/交付要求：\n${JSON.stringify(authority.profile)}\n`
    + `完整宿主选角与人物表达依据：\n${JSON.stringify({ selection: metadata.builtinCharacterSelection, characters: metadata.characters })}\n`
    + `人物档案只约束角色表达，不构成商品参数、试驾记录或真实消费者体验。客户受众原文优先；模型细分、情绪触发点和互动预期均为待审创作假设，不是已核实人群事实。\n`
    + `二、下面本次真实非降级 G1 原件只授权已接受 claims 及其限定用途。完整遵守 restrictions，并阅读嵌套 A1/A2/A3 support review 的 issues、suggestions 和证据状态。`
    + `A1 来源主张不构成竞品证据；A2/A3 为 no_evidence 时不得补写口碑、评分、销量、共识、竞品弱点或市场领先。媒体事实保留媒体、日期和 reported 等来源限定，不升格为实测或厂家独立认证。`
    + `已核规格数字和宣传性来源用语仍保留在事实底账；本片是否可用及如何使用须服从完整客户 Brief。未知外观不因选入道具或动作就成为已核实配置。\n`
    + `G1 完整原始裁决（所有意见与建议保持原层级）：\n${JSON.stringify(authority.marketing.g1Proof)}\n`
    + `G1 完整原件 ${authority.marketing.g1Artifact.path} / SHA256 ${authority.marketing.g1Artifact.sha256}：\n${authority.marketing.g1Artifact.content}\n`
    + `三、${theme ? `本次已批准 G2 的完整原文与原始裁决只提供创作上下文。advisories 是非阻断建议，不新增硬性门槛、审批或强制重试；不能覆盖客户 Brief/G1 用途限制。\nG2 SHA256 ${theme.contentSha256}：\n${theme.contentMd}\nG2 原始裁决：\n${JSON.stringify(theme.verdict)}\n` : "本次尚无已批准 G2 上下文；不推定主题或新创作已经通过。\n"}`
    + `场景、道具、动作、情绪、风险和艺术参考都是待审核创作方案，不是已核实拍摄事实或产品质量证明。可用影片/摄影语言作艺术参考，不因此声称品牌合作、媒体背书或真实设备已核实，也不把艺术参考本身列为新硬禁。`
    + `保留原任务的 JSON schema、输出格式、时长与人物合同。由本次模型生成内容，不要求抄写示例或固定镜头。G1/G2 输入不批准新场景，仍须实际 G3/G4 评审。\n`;
}

type Protect = <T>(operation: () => T) => T;
type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
interface EngineMethod { key: string; method: Method; owner: object; descriptor: PropertyDescriptor }
function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return Boolean(a && a.value === b.value && a.writable === b.writable && a.configurable === b.configurable
    && a.enumerable === b.enumerable && a.get === b.get && a.set === b.set);
}

/** A per-run facade preserves the original engine receiver, native retries, options and result. */
export function scopedRequirementEngine(
  value: unknown, protect: Protect, context: () => string, originalStory?: () => string
): RequirementRecord {
  const engine = requirementRecord(value, "原始需求模型引擎"), prototype = Object.getPrototypeOf(engine);
  const methods: EngineMethod[] = [];
  for (const key of ["reason", "reasonStructured", "reasonRaw", "generate", "chat"]) {
    const original = engine[key];
    if (original === undefined) continue;
    if (typeof original !== "function") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", `原始模型 ${key} 不是方法`);
    let owner: object | null = engine;
    while (owner && !Object.getOwnPropertyDescriptor(owner, key)) owner = Object.getPrototypeOf(owner);
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, key);
    if (!owner || !descriptor || descriptor.value !== original) {
      requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", `原始模型 ${key} 不是固定的数据属性`);
    }
    methods.push({ key, method: original as Method, owner, descriptor });
  }
  if (!methods.length) requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "原始模型没有可用调用接口");
  const check = () => {
    if (Object.getPrototypeOf(engine) !== prototype || methods.some(item => engine[item.key] !== item.method
      || !sameDescriptor(Object.getOwnPropertyDescriptor(item.owner, item.key), item.descriptor))) {
      requirementAuthorityFailure("REQUIREMENT_ENGINE_CHANGED", "本次模型引擎方法或属性身份发生变化");
    }
  };
  const view = Object.create(engine) as RequirementRecord;
  const injected = new Set<string>();
  for (const item of methods) {
    Object.defineProperty(view, item.key, { configurable: false, enumerable: item.descriptor.enumerable, writable: false,
      value: async function (this: RequirementRecord, ...args: unknown[]) {
        const complete = protect(() => {
          check();
          if (this !== view) requirementAuthorityFailure("REQUIREMENT_ENGINE_CHANGED", "需求模型方法脱离本次运行视图调用");
          const index = item.key === "chat" ? 1 : 0, original = args[index];
          if (typeof original !== "string") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "实际模型 prompt 不是文本");
          const addition = context();
          injected.add(addition);
          // A native caller may retain or shorten an earlier prompt before retrying.
          // Remove only our exact prior blocks and put the full current block last, once.
          let prompt = original;
          for (const previous of injected) prompt = prompt.split(previous).join("");
          // The pinned legacy chat branch omits BaseDiscoveryAgent's story appendix.
          // A shortened native retry also must retain that same complete source text.
          const story = originalStory?.();
          if (story && !prompt.includes(story)) prompt += `\n\n## 本次原始故事文本（完整来源）\n${story}`;
          const result = [...args]; result[index] = prompt + addition;
          return result;
        });
        let result: unknown;
        try { result = await Reflect.apply(item.method, engine, complete); }
        catch (error) {
          // Provider/parse failures retain the native retry budget. Authority failures
          // are sticky through protect(), so their retries cannot start another call.
          protect(check);
          throw error;
        }
        protect(check);
        return result;
      }
    });
  }
  return view;
}
