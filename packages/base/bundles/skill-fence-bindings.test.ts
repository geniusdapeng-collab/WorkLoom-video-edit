import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { COMPOSED_SKILL_BINDINGS } from "../../../scripts/skill-bindings.mts";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const BUNDLE_ROOT = join(REPO_ROOT, "bundles/ai-video");
const EXPECTED = {
  "bgm-library-license": ["G-BGM0", "G-BGM1", "G-BGM5"],
  "bgm-vocal-separation": ["G-BGM0", "G-BGM3", "G-BGM5"],
  "cover-kb": ["G-MAT1", "G-SUB2", "G-SUB3"],
  "opening-hook-craft": ["G6", "G7"],
  "talkcraft-ops": ["G-DLV1", "G-MAT1", "G-VOICE4"],
} as const;

describe("ai-video 组合技能围栏绑定", () => {
  for (const [skill, expected] of Object.entries(EXPECTED)) {
    it(`${skill} 的安装绑定与技能身份一致`, () => {
      const raw = readFileSync(join(BUNDLE_ROOT, "skills", skill, "SKILL.md"), "utf8");
      const front = YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "{}") as {
        name?: string;
        description?: string;
      };

      expect(front.name).toBe(skill);
      expect((front.description ?? "").trim().length).toBeGreaterThan(40);
      expect([...(COMPOSED_SKILL_BINDINGS["ai-video"][skill] ?? [])].sort()).toEqual([...expected].sort());
    });
  }
});
