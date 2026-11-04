import { prdFail } from "./prd-authority.js";
import { type FrozenSegmentContract, type RequirementContract, type RequirementRecord } from "./requirement-contract.js";
import { splitShotAssertions } from "./shot-intent.js";

export interface RivalIdentityScope {
  leadId: string;
  leadName: string;
}

const nativeFusionIdentity = "\n24. character_constraint: 角色约束(只出现指定角色,禁止分身)\n";
const nativeRepairIdentity = " - character_constraint：必须包含①单角色限制（仅出现/只出现指定角色）②禁止分身声明（禁止分身/克隆/重复出现）";
const repairFormatStart = "\n\n【字段格式硬约束】（修复后必须逐项满足，机器将按此复检）\n";
const repairFormatEnd = "\n\n【检查发现的问题】\n";
const nativeAuthorityCast = "\n客户受众原文是权威口径；模型年龄/性别细分仅为推测。只使用合同内人物，characterId 必须等于所选 id，姓名一致。人物档案是人物表达依据，不能当成商品事实；";

function positiveClauses(text: string): string[] {
  return splitShotAssertions(text.replace(/并非|不是|不可/gu, "禁止")).positive.split("；");
}

function movingRivals(text: string): boolean {
  return positiveClauses(text).some(clause => /对手(?:车|骑手|摩托车)?/u.test(clause)
    && /超车|超越|连超|追击|追近|追逐|竞速|高速|行驶|并行|并排/u.test(clause));
}

function hasDriverlessRivalAuthority(text: string): boolean {
  const marker = "__WORKLOOM_DRIVERLESS_RIVAL__";
  return text.split(/[。；;，,\n]/u).some(clause => {
    if (!/(?:对手|对方)(?:摩托)?车/u.test(clause) || !/无人(?:驾驶|空车)?|无驾驶员|空车/u.test(clause)) return false;
    // Here “无人” is the vehicle's description, so preserve the surrounding
    // actual prohibitions while making that description visible to the splitter.
    const masked = clause.replace(/无人(?:驾驶|空车)?|无驾驶员|空车/gu, marker)
      .replace(/不可|不应|并非|不是|拒绝|防止|不允许/gu, "禁止").replace(/并且|而且|且/gu, "；");
    return splitShotAssertions(masked).positive.includes(marker);
  });
}

/** The caller supplies its verified current G4 snapshot, never generated shot prose. */
export function reviewedRivalIdentity(input: {
  contract: RequirementContract;
  cuts: FrozenSegmentContract;
  reviewedPrd: RequirementRecord;
  shotId: string;
  duration: unknown;
}): RivalIdentityScope | undefined {
  const { contract, cuts, reviewedPrd, shotId, duration } = input;
  const index = contract.scenes.findIndex(scene => scene.id === shotId);
  const scene = contract.scenes[index], interval = cuts.intervals[index];
  if (!scene || !interval || duration !== scene.duration || duration !== cuts.secondsPerSegment
    || contract.cast.characters.length !== 1) return undefined;
  const actor = contract.cast.characters[0]!;
  if (typeof actor.id !== "string" || typeof actor.name !== "string" || !actor.name.trim()
    || !scene.actions.some(action => action.actorId === actor.id)) return undefined;
  const owner = positiveClauses(interval.brief).join("；");
  const completeOwner = positiveClauses(cuts.intervals.map(item => item.brief).join("；")).join("；");
  if (!/赛道/u.test(completeOwner) || !/对手车/u.test(completeOwner)
    || !/超车|超越|追击|追近|追逐|竞速/u.test(owner)
    || !scene.props.some(prop => /摩托车|机车/u.test(`${prop.name}；${prop.description}`))) return undefined;
  const approvedCharacters = (reviewedPrd.characterSystem as RequirementRecord | undefined)?.characters;
  const approvedScenes = (reviewedPrd.scenePlan as RequirementRecord | undefined)?.scenes;
  if (!Array.isArray(approvedCharacters) || approvedCharacters.length !== 1
    || approvedCharacters[0]?.characterId !== actor.id || approvedCharacters[0]?.name !== actor.name
    || !Array.isArray(approvedScenes)) return undefined;
  const approved = approvedScenes.filter(value => value?.sceneId === shotId);
  if (approved.length !== 1 || approved[0]?.duration !== duration) return undefined;
  const plan = approved[0] as RequirementRecord;
  const planText = [plan.purpose, ...(Array.isArray(plan.visualRequirements) ? plan.visualRequirements : [])]
    .filter((value): value is string => typeof value === "string").join("；");
  const actorActions = scene.actions.filter(action => action.actorId === actor.id).map(action => action.description).join("；");
  if (hasDriverlessRivalAuthority(cuts.intervals.map(item => item.brief).join("；"))
    || hasDriverlessRivalAuthority(actorActions) || hasDriverlessRivalAuthority(planText)) return undefined;
  return movingRivals(actorActions) && movingRivals(planText) ? { leadId: actor.id, leadName: actor.name } : undefined;
}

export function rivalIdentityRequirement(scope: RivalIdentityScope): string {
  return `命名主角仅${scope.leadName}（${scope.leadId}），保持本次唯一身份及定妆引用；`
    + "已审竞速动作必需的其他驾驶员为全盔匿名成年对手骑手，正常驾驶各自对手车，不增加命名角色或定妆引用；"
    + "禁止主角分身或克隆，不得把必要对手车写成无人空车。";
}

/** Replace the exact rule-owned template, keeping every other native system instruction. */
export function bindRivalFusionIdentity(prompt: string, scope: RivalIdentityScope): string {
  const pieces = prompt.split(nativeFusionIdentity);
  if (pieces.length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "原生 Fusion 角色约束模板边界已经变化");
  return pieces.join(`\n24. character_constraint: ${rivalIdentityRequirement(scope)}\n`);
}

/** Only the host-owned unquoted template in its freshly built authority addition is eligible. */
export function bindRivalAuthorityIdentity(authorityPrompt: string): string {
  const pieces = authorityPrompt.split(nativeAuthorityCast);
  if (pieces.length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "宿主制作权威的命名人物模板边界已经变化");
  return pieces.join("\n客户受众原文是权威口径；模型年龄/性别细分仅为推测。只使用合同内命名人物身份，characterId 必须等于所选 id，姓名一致。"
    + "已审竞速动作必需的匿名成年对手骑手全盔遮面、正常驾驶各自对手车，不增命名身份或定妆引用，不得替代主角，禁止主角分身或克隆。"
    + "人物档案是人物表达依据，不能当成商品事实；");
}

/** A unique lead identity does not exclude the required anonymous physical counterpart. */
export function rivalIdentityFormatIssues(issues: unknown[], value: unknown, scope: RivalIdentityScope): unknown[] {
  if (typeof value !== "string") return issues;
  const clauses = positiveClauses(value), positive = clauses.join("；");
  const identity = clauses.some(clause => /命名主角(?:仅|只)|唯一(?:命名|具名)主角|具名主角(?:仅|只)/u.test(clause)
    && clause.includes(scope.leadName));
  const counterpart = clauses.some(clause => /匿名|无名|不具名/u.test(clause) && /成年|成人/u.test(clause)
    && /全盔|全覆[^，；。]{0,8}头盔/u.test(clause) && /对手骑手|对手[^，；。]{0,12}骑手/u.test(clause));
  const validIdentity = identity && counterpart && !/分身|克隆|重复出现/u.test(positive);
  return issues.flatMap(value => {
    const issue = value as RequirementRecord | null;
    if (!issue || issue.fieldEn !== "character_constraint" || issue.issueType !== "incomplete"
      || typeof issue.description !== "string") return [value];
    const nativeMissing = /^角色约束缺少要素：(单角色限制(?:、禁止分身声明)?|禁止分身声明)$/u.exec(issue.description);
    if (!nativeMissing) return [value];
    const missing = nativeMissing[1]!.split("、").filter(key => key !== "单角色限制" || !validIdentity)
      .map(key => key === "单角色限制" ? "命名主角身份与必要对手骑手区分" : key);
    return missing.length ? [{ ...issue,
      description: `角色约束缺少要素：${missing.join("、")}`, suggestion: rivalIdentityRequirement(scope) }] : [];
  });
}

/** The last pinned format section belongs to the native builder, after all source quotations. */
export function bindRivalRepairIdentity(prompt: string, scope: RivalIdentityScope): string {
  const start = prompt.lastIndexOf(repairFormatStart);
  const end = prompt.indexOf(repairFormatEnd, start + repairFormatStart.length);
  if (start < 0 || end < 0) prdFail("PRD_VENDOR_UNAVAILABLE", "原生字段修复格式提示边界已经变化");
  const bodyStart = start + repairFormatStart.length;
  const body = prompt.slice(bodyStart, end), pieces = body.split(nativeRepairIdentity);
  if (pieces.length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "原生角色修复字段规则已经变化");
  return prompt.slice(0, bodyStart) + pieces.join(` - character_constraint：${rivalIdentityRequirement(scope)}`) + prompt.slice(end);
}
