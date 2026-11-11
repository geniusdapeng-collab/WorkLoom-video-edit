import { describe, expect, it } from "vitest";
import { projectUndeclaredPrdCharacterFields } from "./prd-authority.js";
import type { RequirementRecord } from "./requirement-contract.js";

function schema(): RequirementRecord {
  return {
    properties: {
      characterSystem: {
        properties: {
          characters: {
            items: {
              properties: {
                characterId: {},
                name: {},
                costume: {},
                identityAnchors: {},
              },
            },
          },
        },
      },
    },
  };
}

describe("PRD character schema whitelist", () => {
  it("removes only bounded undeclared decoration while preserving every declared field", () => {
    const value: RequirementRecord = {
      characterSystem: {
        characters: [{
          characterId: "young-rider-01",
          name: "李英子",
          costume: "w2 全覆保护赛车服",
          identityAnchors: ["自然鹅蛋脸", "深棕色眼睛"],
          role: "主角",
          sourceNote: "G4 审核说明",
        }],
      },
    };
    const before = structuredClone(value);
    expect(projectUndeclaredPrdCharacterFields(value, schema())).toEqual([
      "/characterSystem/characters/0/role",
      "/characterSystem/characters/0/sourceNote",
    ]);
    expect(value).toEqual({
      characterSystem: {
        characters: [{
          characterId: "young-rider-01",
          name: "李英子",
          costume: "w2 全覆保护赛车服",
          identityAnchors: ["自然鹅蛋脸", "深棕色眼睛"],
        }],
      },
    });
    expect((before.characterSystem as { characters: Array<Record<string, unknown>> }).characters[0])
      .toHaveProperty("role", "主角");
  });

  it("fails closed when a character has more than eight undeclared fields", () => {
    const extras = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`extra${index}`, index]));
    const value: RequirementRecord = {
      characterSystem: { characters: [{ characterId: "young-rider-01", name: "李英子", ...extras }] },
    };
    expect(() => projectUndeclaredPrdCharacterFields(value, schema())).toThrow("PRD_CHARACTER_SHAPE_INVALID");
  });
});
