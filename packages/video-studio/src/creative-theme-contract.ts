type RecordValue = Record<string, unknown>;

export interface CreativeThemeNormalization {
  result: RecordValue;
  applied: boolean;
  changes: string[];
}

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function explicitAudience(intent: string, brief: RecordValue): string {
  const fromBrief = text(brief.audience);
  if (fromBrief) return fromBrief;
  const match = /面向\s*([^，。；\n]{1,24}?)(?:的|做|拍|，|。|；|\n|$)/u.exec(intent);
  return match?.[1]?.trim() ?? "";
}

function marketingTone(value: unknown): string {
  const current = text(value);
  const allowed = ["温暖治愈", "轻快明朗", "冷酷精密", "诗意哀伤"];
  return allowed.find((tone) => current.includes(tone)) ?? "轻快明朗";
}

function safeDescription(theme: string, intent: string, noPerson: boolean): string {
  if (!noPerson) return "";
  const explicitVisuals = /(?:仅使用|只用|只拍)([^，。；\n]+)/u.exec(intent)?.[1]?.trim();
  const visuals = explicitVisuals || "抽象界面、材质细节与环境光影";
  return `全片无人物，以${visuals}呈现「${theme}」；不出现人物、人体局部或人物动作，`
    + "不把未核实的使用痛点、操作命令或实际效果写成既有事实。";
}

function stripUnrequestedTitles(style: string, intent: string): string {
  const titles = [...style.matchAll(/《[^》]+》/gu)].map((match) => match[0]);
  if (titles.length === 0 || titles.every((title) => intent.includes(title))) return style;
  return style
    .replace(/参考[^；。]*(?:[；。]|$)/gu, "视觉方向采用受控影像语法；")
    .replace(/《[^》]+》/gu, "受控影像语法")
    .replace(/受控影像语法(?:\s*的)?(?=受控影像语法)/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function officialClaims(metadata: RecordValue): string[] {
  const dossier = isRecord(metadata._dataDossier) ? metadata._dataDossier : {};
  const identity = isRecord(dossier.identity) ? dossier.identity : {};
  return list(identity.official_selling_points)
    .map((item) => isRecord(item) ? text(item.point) : "")
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * The vendor theme model receives the frozen brief, but it can still invent a
 * person, unverified pain point, conflicting tone, or external film title.
 * Normalize only host-authoritative fields before G2; creative subjects remain
 * the model's when they do not violate the current contract.
 */
export function normalizeCreativeThemeContract(
  resultValue: RecordValue,
  metadataValue: unknown,
): CreativeThemeNormalization {
  if (!isRecord(metadataValue)) return { result: resultValue, applied: false, changes: [] };
  const tasks = list(resultValue.tasks).filter(isRecord);
  if (tasks.length === 0) return { result: resultValue, applied: false, changes: [] };

  const result = structuredClone(resultValue);
  const metadata = metadataValue;
  const brief = isRecord(metadata.brief) ? metadata.brief : {};
  const route = isRecord(metadata.pipelineRoute) ? text(metadata.pipelineRoute.kind) : "";
  const selection = isRecord(metadata.builtinCharacterSelection) ? metadata.builtinCharacterSelection : {};
  const noPerson = text(selection.mode) === "none"
    || metadata.hasPerson === false
    || metadata.noCharacters === true;
  const intent = text(metadata.customerOriginalIntent) || text(result._originalStoryText);
  const audience = explicitAudience(intent, brief);
  const claims = officialClaims(metadata);
  const changes: string[] = [];

  for (const task of list(result.tasks).filter(isRecord)) {
    if (noPerson) {
      if (task.protagonist !== null || task.protagonist !== undefined) {
        task.protagonist = null;
        changes.push("no-person-protagonist-removed");
      }
      if (task.character_consistency !== null || task.character_consistency !== undefined) {
        task.character_consistency = null;
        changes.push("no-person-consistency-removed");
      }
      if (list(task.shots).length > 0) {
        task.shots = [];
        changes.push("no-person-draft-shots-cleared");
      }
      const description = text(task.description);
      if (!description || /你|他|她|开发者|用户|人物|角色|主角|屏幕前|身影|手指|手部|转身|走向|敲下|抬头|蹲/u.test(description)) {
        task.description = safeDescription(text(task.theme) || text(brief.product) || "本次主题", intent, true);
        changes.push("no-person-description-normalized");
      }
      const dialogue = "全片无人物对白、无口播、无拟人旁白；不新增人物声音。";
      if (task.dialogue_requirement !== dialogue) {
        task.dialogue_requirement = dialogue;
        changes.push("no-person-dialogue-contract-normalized");
      }
    }

    if (route === "marketing") {
      const tone = marketingTone(task.tone);
      if (task.tone !== tone) {
        task.tone = tone;
        changes.push("marketing-tone-normalized");
      }
    }

    const expectedAudience = audience
      ? `${audience}（客户原文明确）`
      : "客户未明确指定；任何人群假设均为待审核";
    if (task.target_audience !== expectedAudience) {
      task.target_audience = expectedAudience;
      changes.push("audience-authority-normalized");
    }

    const style = text(task.visual_style);
    const normalizedStyle = stripUnrequestedTitles(style, intent);
    if (normalizedStyle !== style) {
      task.visual_style = normalizedStyle;
      changes.push("unrequested-external-title-removed");
    }

    const contract = [
      noPerson ? "本片明确无人，不出现人物、人体局部或人物动作" : "",
      "不得新增客户原文未提供的导演、影片或作品名",
      "不得把未经 G1 核验的用户痛点、操作命令、使用效果或收益承诺写成既有事实",
      claims.length ? `本次 G1 核验官方主张（以“官方仓库/官方主张”归属）：${claims.join("；")}` : "",
    ].filter(Boolean);
    const notes = text(task.special_notes);
    const contractLine = `宿主创意合同：${contract.join("；")}。`;
    if (contract.length > 0 && !notes.includes(contractLine)) {
      task.special_notes = [notes, contractLine].filter(Boolean).join("\n");
      changes.push("theme-authority-contract-injected");
    }
    task._workloomThemeContractNormalization = {
      schemaVersion: "workloom.creative-theme-normalization/v1",
      noPerson,
      audienceSource: audience ? "customer-or-brief" : "not-specified",
      changes: [...new Set(changes)],
    };
  }

  return { result, applied: changes.length > 0, changes: [...new Set(changes)] };
}
