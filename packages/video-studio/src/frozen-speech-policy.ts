import { isNoSpeechDeclaration } from "./dialogue-contract.js";
import { requirementRecord } from "./requirement-contract.js";

export const FROZEN_NO_SPEECH_AUDIO_DISCIPLINE =
  "【音频纪律】只保留与画面对应的真实环境声和动作音效；禁止可辨识人声，包括对白、独白、口播、旁白、画外音和可辨识的背景话语；禁止镜头外添加背景音乐、BGM 或配乐。";

// Both complete and parser-truncated copies of the old host rule begin here.
// Match only the pinned marker and positive instruction, never ordinary terms.
const GENERIC_POSITIVE_AUDIO_DISCIPLINE = "【音频纪律】本镜头音频仅允许：台词人声";

function hasGenericSpeechDiscipline(value: unknown): boolean {
  return typeof value === "string" && value.includes(GENERIC_POSITIVE_AUDIO_DISCIPLINE);
}

function noSpokenContent(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") return !value.trim() || isNoSpeechDeclaration(value);
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["has_dialogue", "hasDialogue", "lines", "blocks", "text"].includes(key))
    && [row.has_dialogue, row.hasDialogue].every(flag => flag === undefined || flag === false)
    && [row.lines, row.blocks].every(items => items === undefined || (Array.isArray(items) && items.length === 0))
    && noSpokenContent(row.text);
}

/** In explicit no-speech jobs, an authored line cannot become an approved media input through another alias. */
export function assertNoSpokenPromptPackage(value: unknown, gate: string, promptPackage?: string): void {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`PRD_SPEECH_CONFLICT: ${gate} 缺少当前正式逐镜字段，无法核验人声口径`);
  }
  if (hasGenericSpeechDiscipline(promptPackage)) {
    throw new Error(`PRD_SPEECH_CONFLICT: ${gate} 提示词原件含允许台词人声的通用宿主音频纪律`);
  }
  for (const [i, raw] of value.entries()) {
    const row = requirementRecord(raw, "当前正式逐镜字段");
    const fields = row.fields === undefined ? {} : requirementRecord(row.fields, "当前逐镜子字段");
    if ([row.audio, row.prompt, fields.audio, fields.prompt].some(hasGenericSpeechDiscipline)) {
      throw new Error(`PRD_SPEECH_CONFLICT: ${gate} 第 ${i + 1} 镜含允许台词人声的通用宿主音频纪律`);
    }
    const keys = ["dialogue", "dialogueText", "dialogueBlocks", "dialogue_blocks", "dialogues", "narration", "voice_over", "voiceover"];
    if (keys.some(key => !noSpokenContent(row[key]) || !noSpokenContent(fields[key]))) {
      throw new Error(`PRD_SPEECH_CONFLICT: ${gate} 第 ${i + 1} 镜包含与本次明确无人声台词要求冲突的字段`);
    }
  }
}
