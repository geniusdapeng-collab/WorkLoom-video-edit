/**
 * 官方技能磁盘加载器单测（D17）：两种目录布局都必须扫到，且残缺资产不入库。
 * 回归背景：只识别"套件/技能"两层时，平铺的 deal-flow / cross-platform-review
 * 扫不到，而行业包 preset 按技能名引用它们（商单经理、复盘分析师）→ 岗位上岗即断链。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOfficialSkills, parseSkillFrontmatter } from "./official.js";

function writeSkill(dir: string, name: string, extra = "description: 示例技能"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\nversion: 1.2.3\n${extra}\n---\n\n# ${name}\n`);
}

describe("loadOfficialSkills 目录布局", () => {
  it("多技能套件（套件/技能）与单技能套件（平铺）都能装载", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-skills-"));
    writeSkill(join(root, "skills/official/suite-a/skill-one"), "skill-one");
    writeSkill(join(root, "skills/official/flat-skill"), "flat-skill");

    const loaded = loadOfficialSkills(root);
    expect(loaded.map((s) => s.name).sort()).toEqual(["flat-skill", "skill-one"]);
    // 平铺目录按"单技能套件"记账：suite = 目录名，便于技能广场归类展示
    expect(loaded.find((s) => s.name === "flat-skill")?.suite).toBe("flat-skill");
    expect(loaded.find((s) => s.name === "skill-one")?.suite).toBe("suite-a");
    expect(loaded.find((s) => s.name === "flat-skill")?.version).toBe("1.2.3");
  });

  it("缺 name 的残缺资产不入库（不静默放行）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-skills-"));
    writeSkill(join(root, "skills/official/broken"), "placeholder");
    writeFileSync(join(root, "skills/official/broken/SKILL.md"), "# 没有 frontmatter 的技能\n");
    writeSkill(join(root, "skills/official/healthy"), "healthy");

    expect(loadOfficialSkills(root).map((s) => s.name)).toEqual(["healthy"]);
  });

  it("目录不存在时返回空数组（不抛错）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-skills-"));
    expect(loadOfficialSkills(root)).toEqual([]);
  });
});

describe("parseSkillFrontmatter", () => {
  it("缺 version 时回落 1.0（与既有口径一致）", () => {
    expect(parseSkillFrontmatter("---\nname: x\n---\n正文")).toEqual({ name: "x", version: "1.0", description: "" });
  });
});
