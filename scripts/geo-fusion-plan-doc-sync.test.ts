/**
 * 口径文档同步门禁（防复发，2026-09-24 立）：
 *
 * `docs/geo-fusion-plan.md` §2.2「口径说明」行里手写着四个**极易漂移**的数字——
 * 组合编制总岗数、各包声明岗数、同名遮蔽处数、三包 `provides.fences` 并集条数。
 * 历史上它们已经漂移过多次（75 / 76 / 77 / 78 / 79 岗；围栏 112 / 114 / 115 条；
 * `suite-hotel` 里写死的 72 岗断言），每次都靠人工复算才发现。
 *
 * 本用例把这一行钉到**装配器运行结果**上：任何人改岗位 / 围栏而忘了同步文档，
 * `pnpm test:scripts` 直接红——口径只有一个事实源，不靠记忆维护。
 * （README 统计块与围栏包头注释由 `pnpm capabilities --check` 守着，本用例只补文档正文。）
 *
 * 2026-10-10：组合参与包从三包扩展到四包（新增 video-edit 视频AI剪辑包），
 * 本用例改为**从主包依赖动态推导**参与包清单，避免再出现"加包忘改门禁"的漂移。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { composeWorkforce } from "@workloom/base/bundles";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_BUNDLE = "geo-growth";
const CN_NUMERALS = ["零", "一", "二", "三", "四", "五", "六", "七", "八"] as const;

/** 参与组合的包：主包 + 其声明的依赖（顺序与装配器一致：依赖在前、主包在后）。 */
const BUNDLES: string[] = (() => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "bundles", PRIMARY_BUNDLE, "bundle.json"), "utf-8")) as {
    workloom: { dependencies?: Array<{ bundleId: string }> };
  };
  return [...(manifest.workloom.dependencies ?? []).map((dep) => dep.bundleId), PRIMARY_BUNDLE];
})();
const BUNDLE_COUNT_LABEL = CN_NUMERALS[BUNDLES.length] ?? String(BUNDLES.length);

interface Manifest {
  workloom: { provides: { presets: string[]; fences: string[] } };
}

const readManifest = (bundleId: string): Manifest =>
  JSON.parse(readFileSync(join(ROOT, "bundles", bundleId, "bundle.json"), "utf-8")) as Manifest;

/** 每包声明的 preset 个数（按 `provides.presets` 资产清单，与装配器同源）。 */
function declaredPresetCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bundleId of BUNDLES) {
    const keys = new Set<string>();
    for (const assetPath of readManifest(bundleId).workloom.provides.presets) {
      const text = readFileSync(join(ROOT, "bundles", bundleId, assetPath), "utf-8");
      const matched = /^preset_key:\s*["']?([A-Za-z0-9_-]+)/m.exec(text);
      keys.add(matched ? matched[1]! : `?${assetPath}`);
    }
    counts[bundleId] = keys.size;
  }
  return counts;
}

/** 各包 `provides.fences` 逐文件解析后的 `rule_id` 去重并集（文档写的就是这个口径）。 */
function fenceUnionSize(): number {
  const ids = new Set<string>();
  for (const bundleId of BUNDLES) {
    for (const assetPath of readManifest(bundleId).workloom.provides.fences) {
      const doc = YAML.parse(readFileSync(join(ROOT, "bundles", bundleId, assetPath), "utf-8")) as {
        rules?: Array<{ rule_id?: string }>;
        fences?: Array<{ rule_id?: string }>;
      };
      for (const rule of [...(doc.rules ?? []), ...(doc.fences ?? [])]) {
        if (rule?.rule_id) ids.add(rule.rule_id);
      }
    }
  }
  return ids.size;
}

describe("口径说明行与装配器实测同步（防复发）", () => {
  const line = (): string => {
    const found = readFileSync(join(ROOT, "docs/geo-fusion-plan.md"), "utf-8")
      .split("\n")
      .find((row) => row.includes("的完整组合编制为") && row.includes("包合并"));
    expect(found, "docs/geo-fusion-plan.md 缺「口径说明」行（§2.2）").toBeTruthy();
    return found!;
  };
  /** 各仓对该行的加粗写法不完全一致（三仓同源但排版有差），比对前统一去掉 `**` 强调符。 */
  const plain = (): string => line().replace(/\*\*/g, "");

  it("组合编制总岗数 / 遮蔽处数 = 装配器运行结果", () => {
    const composed = composeWorkforce("geo-growth");
    expect(plain()).toContain(`完整组合编制为${BUNDLE_COUNT_LABEL}包合并 ${composed.presets.size} 岗`);
    expect(plain()).toContain(`其中 ${composed.shadowed.length} 处同名遮蔽`);
  });

  it("各包声明岗数 = 各包 provides.presets 资产数", () => {
    const counts = declaredPresetCounts();
    const clause = BUNDLES.map((bundleId) => `${bundleId} ${counts[bundleId]}`).join(" + ");
    expect(plain()).toContain(`各包声明 ${clause}`);
  });

  it("组合围栏并集条数 = provides.fences 逐文件 rule_id 去重数", () => {
    expect(plain()).toContain(`围栏并集 ${fenceUnionSize()} 条`);
  });
});
