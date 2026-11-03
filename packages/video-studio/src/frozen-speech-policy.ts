import { isNoSpeechDeclaration } from "./dialogue-contract.js";
import { requirementRecord } from "./requirement-contract.js";

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
export function assertNoSpokenPromptPackage(value: unknown, gate: string): void {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`PRD_SPEECH_CONFLICT: ${gate} 缺少当前正式逐镜字段，无法核验人声口径`);
  }
  for (const [i, raw] of value.entries()) {
    const row = requirementRecord(raw, "当前正式逐镜字段");
    const fields = row.fields === undefined ? {} : requirementRecord(row.fields, "当前逐镜子字段");
    const keys = ["dialogue", "dialogueBlocks", "narration", "voice_over", "voiceover"];
    if (keys.some(key => !noSpokenContent(row[key]) || !noSpokenContent(fields[key]))) {
      throw new Error(`PRD_SPEECH_CONFLICT: ${gate} 第 ${i + 1} 镜包含与本次明确无人声台词要求冲突的字段`);
    }
  }
}
