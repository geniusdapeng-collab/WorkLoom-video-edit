/**
 * "点了没反应"门禁：带 actionLabel 的 EmptyState / BannerAlert 必须同时给 onAction。
 *
 * 组件口径（@workloom/ui）：`actionLabel` 存在即渲染一个按钮，onClick 绑定 `onAction`；
 * 只传 label 不传 handler 会得到一个**死按钮**——实测在 P3 夜班空态与 P6 横幅上出现过，
 * 属于用户视角的"页面坏了"。这里跨三端静态扫描，杜绝复现。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const APPS = ["apps/web/src", "apps/webb/src", "apps/webc/src"];
const COMPONENT = /<(EmptyState|BannerAlert|ErrorState|AsyncState)\b/;
/**
 * 豁免：/dev 组件状态矩阵页（DevMatrix）渲染的是**组件标本**——它展示各状态长什么样，
 * 标本上的按钮本就不接业务动作（页面自身只用于走查）。其余任何页面都不允许出现死按钮。
 */
const EXEMPT = [/pages\/dev\/DevMatrix\.tsx$/];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx") && !path.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

describe("带 actionLabel 的提示组件必须有 onAction（无死按钮）", () => {
  it("跨三端扫描：actionLabel 与 onAction 同时出现", () => {
    const violations: string[] = [];
    let checked = 0;
    for (const app of APPS) {
      for (const file of walk(join(REPO, app))) {
        if (EXEMPT.some((pattern) => pattern.test(file))) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (!COMPONENT.test(line)) return;
          // 组件可能跨行：取到下一次闭合或 10 行为止
          const window = lines.slice(index, index + 10).join("\n");
          if (!/actionLabel/.test(window)) return;
          checked += 1;
          if (!/onAction|action=/.test(window)) {
            violations.push(`${relative(REPO, file)}:${index + 1}`);
          }
        });
      }
    }
    expect(violations, `存在只有 actionLabel、没有 onAction 的死按钮：${violations.join("、")}`).toEqual([]);
    expect(checked, "扫描不到任何 actionLabel 说明匹配失配").toBeGreaterThanOrEqual(5);
  });
});
