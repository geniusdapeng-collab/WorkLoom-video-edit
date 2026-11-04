import type { FrozenSegmentContract } from "./requirement-contract.js";

type Recordish = Record<string, unknown>;

function record(value: unknown): Recordish | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Recordish : undefined;
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

const speechAliases = ["narration", "voiceover", "voice_over", "voiceOver", "lines", "blocks", "monologue", "spoken_dialogue"];

export function hasExplicitSilentScreenplay(value: unknown): boolean {
  const script = record(value);
  const voice = record(script?.voice_system);
  const scenes = record(script?.structure)?.scenes;
  return voice?.global_voice_policy === "no_speech"
    && emptyArray(voice.voice_profiles) && Object.keys(voice).length === 2
    && Array.isArray(scenes) && scenes.length > 0
    && scenes.every((entry: unknown) => {
      const scene = record(entry);
      const dialogue = record(scene?.dialogue);
      return scene !== undefined && dialogue?.has_dialogue === false
        && emptyArray(dialogue.lines) && emptyArray(dialogue.blocks) && Object.keys(dialogue).length === 3
        && speechAliases.every((key) => !Object.hasOwn(scene, key));
    });
}

const speechTerm = "(?:对白|对话|独白|口播|旁白|画外音|解说|配音|台词|(?:可辨识的?)?(?:人声|背景话语)|voiceover|dialogue|narration)";
const explicitlySilentClause = new RegExp(
  `^(?:(?:全(?:片|段|程)|本(?:镜|段|场))?\\s*(?:禁止|禁用|没有|不(?:要|添加|新增|使用|配|加|出现)|无|零)(?:任何)?\\s*|(?:no|without)\\s+)`
  + `${speechTerm}(?:\\s*(?:、|以及|和|与|及|或|\\band\\b|\\bor\\b)\\s*${speechTerm})*$`,
  "iu",
);
const nativeNarrationToken = /旁白|voiceover/u;
const unverifiedSpeechCue = /旁白|画外音|对白|对话|独白|口播|解说|配音|台词|人声|背景话语|说话|讲话|交谈|聊天|喊叫|耳语|(?:说|喊|念|读)(?:道|出|[:：])|(?:^|[^a-z])(?:voice[\s_-]?over|narration|narrator|dialogue|spoken|speaker|monologue|says?|speaks?)(?![a-z])/iu;

/** A transient view for the native narration keyword check, never a rewritten screenplay. */
export function negatedNarrationScanView(value: unknown, frozen: FrozenSegmentContract): Recordish | undefined {
  const script = record(value);
  const structure = record(script?.structure);
  const scenes = structure?.scenes;
  if (!script || !structure || !Array.isArray(scenes) || scenes.length !== frozen.count || !hasExplicitSilentScreenplay(script)) return;
  const projected: Recordish[] = [];
  let foundNegation = false;
  for (const [index, scene] of scenes.entries()) {
    const interval = frozen.intervals[index];
    const timing = record(scene.timing);
    if (!interval || timing?.start !== interval.startSec || timing.end !== interval.endSec || timing.duration !== frozen.secondsPerSegment) return;
    const view = { ...scene };
    for (const field of ["setting", "visual_notes"]) {
      if (typeof scene[field] !== "string") continue;
      view[field] = scene[field].split(/([。.;；，,\n!！])/u).map((clause: string) => {
        if (!explicitlySilentClause.test(clause.trim())) return clause;
        foundNegation ||= nativeNarrationToken.test(clause);
        return "";
      }).join("");
    }
    // Keep the native failure on mixed/ambiguous prose and unknown speech-bearing
    // fields. The only omitted field here is the separately verified empty dialogue.
    if (unverifiedSpeechCue.test(JSON.stringify({ ...view, dialogue: undefined }))) return;
    projected.push(view);
  }
  return foundNegation ? { ...script, structure: { ...structure, scenes: projected } } : undefined;
}

export class SilentScreenplayError extends Error {
  constructor(message: string) {
    super(`FROZEN_SCREENPLAY_SPEECH_UNVERIFIED: ${message}`);
  }
}

function replaceNativeRule(prompt: string, pattern: RegExp, value: string): string {
  const hits = [...prompt.matchAll(pattern)];
  if (hits.length !== 1) throw new SilentScreenplayError("原生剧本提示模板已变化，无法绑定冻结声音策略");
  return prompt.replace(pattern, () => value);
}

export function bindSilentScreenplayPrompt(prompt: string, hasFrozenSegments: boolean): string {
  let bound = replaceNativeRule(prompt,
    /^1\. (?:本片允许旁白\/画外音|禁止旁白（Voiceover）)[^\n]*\n2\. 每个场景必须有台词[^\n]*\n3\. 台词必须口语化[^\n]*\n4\. 【v2\.1\.5-fix-C】[^\n]*/gm,
    "1. 冻结声音策略：禁止可辨识人声。所有场景禁止对白、独白、口播、旁白、画外音和可辨识的背景话语。\n2. 用动作、表情、环境声和实际动作产生的声音表达故事。仅描述实有声音。\n3. 原文要求的传播信息用动作、物件或明确批准的画面文字呈现。\n4. 禁止 scene.narration、scene.voice_over、scene.voiceover、scene.lines 等游离语音字段。");
  if (!hasFrozenSegments) {
    bound = replaceNativeRule(bound, /^5\. 场景时长分配：[^\n]*台词长度[^\n]*/gm,
      "5. 场景时长按内容重要性、视觉复杂度与动作节奏分配。");
  }
  bound = replaceNativeRule(bound, /^8\. 【v2\.1\.10-fix】dialogue 对象[^\n]*/gm,
    "8. 每个场景必须精确提供 dialogue: {\"has_dialogue\":false,\"lines\":[],\"blocks\":[]}。");
  bound = replaceNativeRule(bound, /^- voice_system: \{global_voice_policy, voice_profiles: \[\.\.\.\]\}$/gm,
    '- voice_system: {"global_voice_policy": "no_speech", "voice_profiles": []}');
  bound = replaceNativeRule(bound, /^"dialogue": \{\n  "has_dialogue": true,[\s\S]*?^\}\n(?:旁白台词写法：[^\n]*\n)?/gm,
    '"dialogue": {"has_dialogue": false, "lines": [], "blocks": []}\n');
  bound = replaceNativeRule(bound, /^4\. 每个场景的台词必须包含在场景中（不能旁白）$/gm,
    "4. 逐场核对没有可辨识人声，真实环境声和动作声按需保留。");
  bound = replaceNativeRule(bound, /^□ 每句台词是否都能用动作演出来而不是说出来？$/gm,
    "□ 情节、转折和情感是否由具体可拍的行为表达？");
  return replaceNativeRule(bound, /^□ 原文的钉子台词与特写细节是否原样保留？$/gm,
    "□ 原文授权的传播信息与特写细节是否保留？");
}

export function bindSilentScreenplaySystemPrompt(prompt: string, hasFrozenSegments: boolean): string {
  const bound = replaceNativeRule(prompt, /^2\. 台词极简主义：[^\n]*\n3\. 每句台词必须挂在物理动作上[^\n]*/gm,
    "2. 冻结声音策略：禁止可辨识人声，包括对白、独白、口播、旁白、画外音及可辨识的背景话语。\n3. 情节和情绪通过物理动作、画面、环境声与真实动作声表达。");
  if (!hasFrozenSegments) return bound;
  return replaceNativeRule(bound, /^4\. 场景时长按情感权重分配：[^\n]*/gm,
    "4. 场景时长和顺序严格遵守用户冻结的分段区间；张力与留白都在各自区间内完成。");
}
