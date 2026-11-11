import { createHash } from "node:crypto";
import type { GateVerdict } from "./gates.js";
import type { PrdAuthority, PrdMarketingScope } from "./prd-authority.js";
import { RequirementContractError, requirementHash, requirementRecord, type RequirementRecord } from "./requirement-contract.js";
import { builtinWardrobeBoundary } from "./creative-theme-contract.js";
import { MARKETING_REFERENCE_BOUNDARY } from "./marketing-prd-contract.js";

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

/** Correct only a closed-form ordinal contradiction in the review draft. */
export function reconcileRequirementThemeDraft(draft: string): string {
  const overtakesTwo = /(?:连超|连续超越|连续超过)\s*(?:两|2)\s*(?:台|辆)/u.test(draft);
  const finalCornerSecond = /((?:最后一个弯|最后弯|末弯)[^。；\n]{0,40})第二位/u;
  if (!overtakesTwo || /套圈/u.test(draft) || !finalCornerSecond.test(draft)) return draft;
  return draft.replace(finalCornerSecond, "$1第三位")
    + "\n\n[宿主赛位一致性校正] 原草案在“第二位”起跑位下写“连超两台”，与三车竞争关系矛盾；"
    + "仅将核心描述的赛位改为“第三位”，保留连超两台、冲线夺冠及全部客户原文。";
}

/** Append the frozen customer source after the complete, unchanged creative draft. */
export function requirementThemeApprovalPayload(authority: PrdAuthority, draft: string): string {
  if (!draft.trim()) return draft;
  const reviewDraft = reconcileRequirementThemeDraft(draft);
  const source = JSON.stringify({
    schemaVersion: "workloom.g2-frozen-brief/v1",
    scope: authority.marketing.scope,
    g1Sha256: authority.marketing.g1Artifact.sha256,
    customerOriginalIntent: authority.metadata.customerOriginalIntent ?? null,
    brief: authority.metadata.brief ?? null,
  }, null, 2).replaceAll("`", "\\u0060");
  const sha256 = createHash("sha256").update(source).digest("hex");
  return `${reviewDraft}\n\n## G2 宿主冻结客户 Brief\n`
    + "此附件是当前项目的审阅基线。应逐项核对前面的实际创意，遗漏或矛盾须独立裁决；附件本身不证明创意已落实，也不增加商品事实或素材授权。\n"
    + `附件 JSON 原始字节 SHA256 ${sha256}\n\n`
    + ["```json", source, "```"].join("\n");
}

/** Project explicit limits from the current, already verified G1 artifact. */
export function requirementThemeUsageBoundary(authority: PrdAuthority): string {
  const isRecord = (value: unknown): value is RequirementRecord => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const record = (value: unknown): RequirementRecord | undefined => isRecord(value) ? value : undefined;
  const records = (value: unknown): RequirementRecord[] => Array.isArray(value)
    ? value.filter(isRecord) : [];
  const root = requirementRecord(JSON.parse(authority.marketing.g1Artifact.content), "G1 原件");
  const facts = requirementRecord(root.facts, "G1 facts");
  const stages = records(facts.stages).filter(stage => stage.stage === "A1");
  if (stages.length > 1) requirementAuthorityFailure("REQUIREMENT_THEME_USAGE_UNVERIFIED", "G1 含多份 A1 主张");
  const stage = stages[0], a1 = record(stage?.facts);
  const claims = records(a1?.claims), sources = records(facts.sources);
  const specs = record(record(record(a1?.payload)?.identity)?.specs);
  const limitLabel = /^(?:(?:道路(?:行驶|使用|通行)|上路)资质|使用(?:资质|限制|前提|条件)|用途限制|适用条件|road(?: use)? eligibility|usage (?:restriction|limit|prerequisite))$/iu;
  const limitClause = /(?:^|[，。；、;:,.：])\s*(?:不具备|不允许|不支持|无(?:资质|资格)|不可|不能|不得|禁止|只(?:能|可|限)|仅|限于|须|需|必须|only\b|not (?:permitted|allowed|eligible|licensed|approved|supported)\b|no (?:public )?road use\b|requires?\b|must\b)/iu;
  const lines = [];
  for (const claim of claims) {
    const label = typeof claim.pointer === "string" ? /^\/identity\/specs\/([^/]+)$/u.exec(claim.pointer)?.[1] : undefined;
    if (!label || !limitLabel.test(label) || typeof claim.value !== "string" || !limitClause.test(claim.value)) continue;
    const matches = sources.filter(source => source.sourceId === claim.sourceId);
    const source = matches[0], url = typeof source?.finalUrl === "string" && URL.canParse(source.finalUrl) ? new URL(source.finalUrl) : undefined;
    const sourceId = typeof source?.textSha256 === "string" && url
      ? `SRC-${createHash("sha256").update(`${String(source.finalUrl)}\n${source.textSha256}`).digest("hex").slice(0, 24)}` : undefined;
    if (a1?.stage !== "A1" || a1.status !== "source_bound" || claim.stage !== "A1" || claim.status !== "source-bound"
      || specs?.[label] !== claim.value || claims.filter(item => item.pointer === claim.pointer).length !== 1
      || typeof claim.claimId !== "string" || !/^CL-[a-f0-9]{24}$/u.test(claim.claimId)
      || matches.length !== 1 || !source || !sourceId || sourceId !== claim.sourceId || !Array.isArray(stage?.sourceIds)
      || stage.sourceIds.filter(id => id === sourceId).length !== 1 || source?.textSha256 !== claim.textSha256
      || !/^[a-f0-9]{64}$/u.test(String(claim.textSha256)) || !url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      requirementAuthorityFailure("REQUIREMENT_THEME_USAGE_UNVERIFIED", `G1 的 ${label} 缺少唯一、值一致的原始来源绑定`);
    }
    lines.push(`${label}：${JSON.stringify(claim.value)}（G1 主张 ${claim.claimId}，来源 ${JSON.stringify(source.finalUrl)}）`);
  }
  if (!lines.length) return "";
  return `本次已核实的商品用途与资质边界（强制遵守；引号内为 JSON 编码的来源事实值）：\n${lines.join("\n")}\n`
    + "主题、场景、动作、对白及商品主张均须符合这些限制。将限制本身写成可选，或拟定与之矛盾的内容，应由独立 G2 审核退回。"
    + "是否在成片里另作文字或口播提示依客户要求及审核决定，限制本身始终适用。";
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

function requirementAdoptionBoundary(metadata: RequirementRecord): string {
  const brief = metadata.brief === undefined ? {} : requirementRecord(metadata.brief, "客户 Brief");
  const audience = typeof brief.audience === "string" && brief.audience.trim() ? brief.audience : null;
  return "\n## G3 成片采用边界与本轮自检\n"
    + "事实可核实与成片可采用分别判断。完整 G1 原件、来源限定与裁决供核对，采用范围以冻结客户原文及 Brief 为准。"
    + "即使规格已核实，钩子、开场/主体/结尾的目的与关键元素、道具名称与可见描述、动作、机位特写、屏幕文字、对白和声音仍须各自符合本片允许的用途。\n"
    + "当 Brief 限定为商品身份与用途、或要求无标识虚构演绎时，将未获本片采用许可的配置、部件细节、品牌外观和性能数字留在事实底账。"
    + "仪表读数、部件尺寸、外观纹样、声音或画面的表现也可能传递商品主张。依 Brief 创作可拍的通用道具、动作和相对关系，并把后期指定文字与生成画面分开。\n"
    + `客户 Brief 受众原文（JSON）：${JSON.stringify(audience)}。`
    + "有原文时，以其为本片受众范围；模型细分、年龄、兴趣和情绪触发只能是范围内创作假设，不能新增投放地区、语言人群或其他传播对象。"
    + "未指定时保留未指定；推测不能成为本片投放要求。无需扩大人群来说明画面清晰或内容易懂。\n"
    + "在同一次响应内逐项自检上述用途、画面与受众边界，把可执行内容填入现有字段后一次提交供独立 G3 审核。"
    + "已有明确口径时完成相应创作字段，省去占位、二选一或等待客户确认的文案。真实缺口写入相应风险字段，审核状态由实际流程记录。\n";
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
  const usageBoundary = theme ? "" : requirementThemeUsageBoundary(authority);
  const wardrobeBoundary = builtinWardrobeBoundary(metadata);
  const themeSelfCheck = theme ? "" : "创意主题输出前，在同一调用内逐项对照完整客户 Brief 和当前 G1，自检实际主题、核心描述、视觉、台词和特别备注。"
    + "将客户明确的开场、动作顺序、服装、产品名呈现位置、素材授权和交付约束落实在对应创作字段；附件中出现要求不代表方案已落实，客户未要求的内容不自行补充。"
    + "以人物的相对位置、动作、选择与感受建立张力。角色台词、内心独白、画外音和比喻均不得暗示 G1 未支持或 Brief 未准许使用的产品性能、性能余量或使用效果。"
    + "仅按实际授权使用参考素材；不能用已检索、已见到或已审核商品事实替代素材授权。\n";
  return `\n\n## 本次宿主需求权威输入 ${key}（冲突时按本节层级处理）\n`
    + `一、完整客户 Brief 和其中本片制作细则决定本片的主张用途、受众与交付要求。G1 接受某条事实，不能覆盖客户选择的用途限制，不能把底账事实自动变成钩子、口播、屏幕卖点或结尾。\n`
    + `完整客户 Brief：\n${JSON.stringify(metadata.brief)}\n`
    + `客户原始诉求：\n${JSON.stringify(metadata.customerOriginalIntent ?? null)}\n`
    + `客户明确生产/交付要求：\n${JSON.stringify(authority.profile)}\n`
    + `完整宿主选角与人物表达依据：\n${JSON.stringify({ selection: metadata.builtinCharacterSelection, characters: metadata.characters })}\n`
    + (wardrobeBoundary ? `${wardrobeBoundary}。\n` : "")
    + `人物档案只约束角色表达，不构成商品参数、试驾记录或真实消费者体验。客户受众原文优先；模型细分、情绪触发点和互动预期均为待审创作假设，不是已核实人群事实。\n`
    + `二、下面本次真实非降级 G1 原件只支持已接受 claims 及其来源限定。完整遵守 restrictions，并阅读嵌套 A1/A2/A3 support review 的 issues、suggestions 和证据状态。`
    + `A1 来源主张不构成竞品证据；A2/A3 为 no_evidence 时不得补写口碑、评分、销量、共识、竞品弱点或市场领先。媒体事实保留媒体、日期和 reported 等来源限定，不升格为实测或厂家独立认证。`
    + `已核规格数字和宣传性来源用语仍保留在事实底账；本片是否可用及如何使用须服从完整客户 Brief。未知外观不因选入道具或动作就成为已核实配置。\n`
    + `G1 完整原始裁决（所有意见与建议保持原层级）：\n${JSON.stringify(authority.marketing.g1Proof)}\n`
    + (usageBoundary ? `${usageBoundary}\n` : "")
    + `G1 完整原件 ${authority.marketing.g1Artifact.path} / SHA256 ${authority.marketing.g1Artifact.sha256}：\n${authority.marketing.g1Artifact.content}\n`
    + themeSelfCheck
    + `三、${theme ? `本次已批准 G2 的完整原文与原始裁决只提供创作上下文。advisories 是非阻断建议，不新增硬性门槛、审批或强制重试；不能覆盖客户 Brief/G1 用途限制。\nG2 SHA256 ${theme.contentSha256}：\n${theme.contentMd}\nG2 原始裁决：\n${JSON.stringify(theme.verdict)}\n` : "本次尚无已批准 G2 上下文；不推定主题或新创作已经通过。\n"}`
    + `场景、道具、动作、情绪、风险和艺术参考都是待审核创作方案，不是已核实拍摄事实或产品质量证明。${MARKETING_REFERENCE_BOUNDARY}ReferenceCurator 的内部参考字段仍按其实际 schema 保留；从中归纳手法，不将名称转成正式 PRD 参考。`
    + `保留原任务的 JSON schema、输出格式、时长与人物合同。由本次模型生成内容，不要求抄写示例或固定镜头。G1/G2 输入不批准新场景，仍须实际 G3/G4 评审。\n`
    + (theme ? requirementAdoptionBoundary(metadata) : "");
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
