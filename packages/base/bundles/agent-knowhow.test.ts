/**
 * 数字员工配套技能「行业 Know-How 结构」回归（T-2026-0926-0101）
 *
 * 为什么单独一组：技能文件是本仓最容易被"顺手改薄"的资产——
 *  · 决策原则被删成口号 → 岗位在真机上只能凭模型自由发挥；
 *  · SOP 丢掉"回执/失败"路径 → 失败时静默兜底，链路上看不见；
 *  · 关键指标没有来源 → 阈值变成拍脑袋，无法复核；
 *  · 岗位与技能绑定断开 → 技能存在但没人调用（孤儿资产）。
 * 这些都能在磁盘上静态验出来，所以本组测试不触 DB、不依赖 ffmpeg。
 *
 * 覆盖范围：本轮先锁「营销前置两站 + 事实红线评审」三个技能（S-A 分型）。
 * 随后逐批把其它技能纳入（见 docs/audit/GAP-LEDGER.md）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { bundlesRoot } from "./assembly.js";

const ROOT = bundlesRoot();
const BUNDLE_DIR = join(ROOT, "ai-video");

/** S-A 型技能必须齐备的五个区块（结构等价判定，允许标题带括注） */
const REQUIRED_SECTIONS = ["决策原则", "打法库", "SOP", "关键指标", "失败模式"] as const;

const SKILLS: Array<{ name: string; boundBy: string[] }> = [
  // 营销片前置：情报五站（G1 前）
  { name: "jenny-loom-research", boundBy: ["intel-collector", "intel-reviewer", "intel-competitor", "intel-verifier", "intel-binder", "trend-researcher"] },
  // 营销片前置：Brief 解析（G2 前）
  { name: "marketing-brief-parser", boundBy: ["creative-planner"] },
  // 营销片事实红线闸 + G6 评审材料
  { name: "director-review", boundBy: ["continuity-reviewer"] },
];

const skillText = (name: string): string => readFileSync(join(BUNDLE_DIR, "skills", name, "SKILL.md"), "utf8");

/** 取 "## 标题" 区块（到下一个 "## " 为止），标题允许带括注 */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 3);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const numbered = (block: string): number => (block.match(/^\d+\.\s/gm) ?? []).length;
const bullets = (block: string): number => (block.match(/^-\s/gm) ?? []).length;
const tableRows = (block: string): number => {
  const rows = block.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (/^\|\s*-+/.test(rows[i]!)) continue;
    if (i + 1 < rows.length && /^\|\s*-+/.test(rows[i + 1]!)) continue;
    count += 1;
  }
  return count;
};

describe("数字员工配套技能 · 行业 Know-How 结构（S-A）", () => {
  for (const { name, boundBy } of SKILLS) {
    const text = skillText(name);

    it(`${name}：五个 Know-How 区块齐备`, () => {
      for (const heading of REQUIRED_SECTIONS) {
        expect(section(text, heading), `${name} 缺「${heading}」区块`).not.toBe("");
      }
    });

    it(`${name}：决策原则 ≥3 条且含阈值或失败关闭语义`, () => {
      const block = section(text, "决策原则");
      expect(numbered(block) + bullets(block)).toBeGreaterThanOrEqual(3);
      expect(/失败关闭|禁止|不得|即.*(剔除|打回|停摆|拒收|挂起)/.test(block), "决策原则必须可判定（阈值或失败关闭）").toBe(true);
    });

    it(`${name}：打法库 ≥3 条且至少 2 条分支`, () => {
      const block = section(text, "打法库");
      expect(bullets(block)).toBeGreaterThanOrEqual(3);
      expect((block.match(/\*\*分支/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it(`${name}：SOP ≥3 步且每步带触发/回执/失败路径`, () => {
      const steps = section(text, "SOP").split("\n").filter((l) => /^\d+\.\s/.test(l));
      expect(steps.filter((l) => l.includes("触发") && l.includes("回执") && l.includes("失败")).length).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：关键指标 ≥4 行且带来源列`, () => {
      const block = section(text, "关键指标");
      expect(tableRows(block)).toBeGreaterThanOrEqual(4);
      expect(block).toContain("来源");
    });

    it(`${name}：失败模式 ≥3 行且含检测器与处置`, () => {
      const block = section(text, "失败模式");
      expect(tableRows(block)).toBeGreaterThanOrEqual(3);
      expect(block).toContain("检测器");
      expect(block).toContain("处置");
    });

    it(`${name}：无不可判定的模板化表述`, () => {
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
    });

    it(`${name}：岗位绑定未断链（技能不会变成孤儿）`, () => {
      const bound: string[] = [];
      for (const preset of boundBy) {
        const p = join(BUNDLE_DIR, "presets", `${preset}.yml`);
        expect(existsSync(p), `preset 缺失：${preset}`).toBe(true);
        const doc = YAML.parse(readFileSync(p, "utf8")) as { skills?: string[] };
        if ((doc.skills ?? []).includes(name)) bound.push(preset);
      }
      expect(bound.length).toBeGreaterThan(0);
    });
  }
});
