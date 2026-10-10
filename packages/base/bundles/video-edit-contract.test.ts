/**
 * video-edit（视频AI剪辑包）契约回归测试。
 *
 * 背景：`acquisition-loop.test.ts` 已经守"每步有人 / 围栏可解析"，但它按目录扫描，
 * 不会检查**包内自洽**（护栏对象是否在本包或组合对象表里存在、动作前缀别名缺口、
 * UI 用例页是否注册、管线岗位是否只引用本包 preset）。新包首次并入组合时这些缺口
 * 表现为"运行时才炸"，因此这里把口径钉死在 CI：
 *   ① bundle.json 过行业契约（含 provides 资产存在性）；
 *   ② presets 过 WorkforcePreset 契约（含写岗位必须绑围栏/写工具/事件覆盖）；
 *   ③ 管线 owner ∈ 本包 preset，gates ∈ 本包围栏规则 id；
 *   ④ 围栏 object_types ⊆ 组合对象表；动作前缀命中对象别名时必须显式覆盖（同 scan:fences 口径）；
 *   ⑤ UI 用例页必须在已注册页面表内；
 *   ⑥ 组合装配确实包含本包（主包依赖已接线）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseBundleManifest, parseWorkforcePresets } from "@workloom/industry-contract";
import { REGISTERED_PAGES, bundlesRoot, composeWorkforce, loadComposedAssets, mergeComposedFenceRules } from "./assembly.js";

const ROOT = bundlesRoot();
const BUNDLE_ID = "video-edit";
const BUNDLE_DIR = join(ROOT, BUNDLE_ID);
const PRIMARY_BUNDLE = "geo-growth";

interface FencePack { version?: string; rules?: Array<{ rule_id?: string; match?: { object_types?: string[]; actions?: string[] } }>; fences?: Array<{ rule_id?: string; match?: { object_types?: string[]; actions?: string[] } }> }
const fenceRulesOf = (pack: FencePack) => [...(pack.rules ?? []), ...(pack.fences ?? [])];

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(dir, entry.name));
}

describe("video-edit：包内契约自洽（并入组合后不再漂移）", () => {
  const manifest = parseBundleManifest(JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf-8")));

  it("bundle.json 通过行业契约，且 provides 声明的资产全部存在", () => {
    const missing: string[] = [];
    for (const [slot, value] of Object.entries(manifest.workloom.provides)) {
      const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      for (const assetPath of paths) {
        if (!existsSync(join(BUNDLE_DIR, assetPath))) missing.push(`${slot}:${assetPath}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("presets 全部通过 WorkforcePreset 契约（11 个岗位）", () => {
    const docs = manifest.workloom.provides.presets.map((assetPath) =>
      YAML.parse(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8")));
    const presets = parseWorkforcePresets(docs);
    expect(presets).toHaveLength(11);
    expect(presets.map((preset) => preset.preset_key)).toContain("edit-compositor");
  });

  it("管线每一步都有人、每个门都有规则：owner ∈ 本包 preset，gates ∈ 本包围栏", () => {
    const presetKeys = new Set(manifest.workloom.provides.presets.map((assetPath) =>
      (YAML.parse(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8")) as { preset_key?: string }).preset_key));
    const fenceRuleIds = new Set<string>();
    for (const assetPath of manifest.workloom.provides.fences) {
      for (const rule of fenceRulesOf(YAML.parse(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8")) as FencePack)) {
        if (rule?.rule_id) fenceRuleIds.add(rule.rule_id);
      }
    }
    const broken: string[] = [];
    for (const assetPath of manifest.workloom.provides.pipelines) {
      const doc = YAML.parse(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8")) as {
        steps?: Array<{ step_key?: string; owner?: string; gates?: string[] }>;
      };
      for (const step of doc.steps ?? []) {
        if (!step.owner || !presetKeys.has(step.owner)) broken.push(`${assetPath}:${step.step_key} owner=${step.owner ?? "未声明"}`);
        for (const gate of step.gates ?? []) {
          if (!fenceRuleIds.has(gate)) broken.push(`${assetPath}:${step.step_key} gate=${gate}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("围栏不引用未知对象，且动作前缀别名缺口为零（同 scan:fences 口径）", () => {
    const assets = loadComposedAssets(PRIMARY_BUNDLE);
    const objectTypes = new Set<string>();
    for (const bundleId of assets.bundleIds) {
      const path = join(ROOT, bundleId, "schemas/objects.json");
      if (!existsSync(path)) continue;
      const doc = JSON.parse(readFileSync(path, "utf-8")) as { objects?: Array<{ type: string }> };
      for (const object of doc.objects ?? []) objectTypes.add(object.type);
    }
    const unknown: string[] = [];
    const aliasGaps: string[] = [];
    for (const { bundleId, rule } of mergeComposedFenceRules(assets.fencePacks)) {
      if (bundleId !== BUNDLE_ID) continue;
      for (const objectType of rule.match.object_types) {
        if (!objectTypes.has(objectType)) unknown.push(`${rule.rule_id} → ${objectType}`);
      }
      for (const action of rule.match.actions) {
        const alias = action.split(".")[0]!;
        if (objectTypes.has(alias) && !rule.match.object_types.includes(alias)) {
          aliasGaps.push(`${rule.rule_id} → ${action}`);
        }
      }
    }
    expect(unknown).toEqual([]);
    expect(aliasGaps).toEqual([]);
  });

  it("UI 用例页都在已注册页面表内", () => {
    const doc = JSON.parse(readFileSync(join(BUNDLE_DIR, "ui/cases.json"), "utf-8")) as { pages?: string[]; cases?: Array<{ page?: string }> };
    const pages = new Set(REGISTERED_PAGES);
    const unknown = [...new Set([...(doc.pages ?? []), ...(doc.cases ?? []).map((entry) => entry.page ?? "")])]
      .filter((page) => page && !pages.has(page as (typeof REGISTERED_PAGES)[number]));
    expect(unknown).toEqual([]);
    expect((doc.cases ?? []).length).toBeGreaterThan(0);
  });

  it("主包组合已接线：geo-growth 依赖 video-edit，且组合编制里能看到本包岗位", () => {
    const primary = parseBundleManifest(JSON.parse(readFileSync(join(ROOT, PRIMARY_BUNDLE, "bundle.json"), "utf-8")));
    const dependency = (primary.workloom.dependencies ?? []).find((entry) => entry.bundleId === BUNDLE_ID);
    expect(dependency, "geo-growth 未声明对 video-edit 的依赖").toBeTruthy();
    expect(dependency!.version).toBe(manifest.version);
    const composed = composeWorkforce(PRIMARY_BUNDLE);
    const owners = new Set([...composed.presets.values()].map((entry) => entry.bundleId));
    expect(owners.has(BUNDLE_ID)).toBe(true);
    expect([...composed.presets.values()].filter((entry) => entry.bundleId === BUNDLE_ID).length)
      .toBe(manifest.workloom.provides.presets.length);
  });

  it("包内文件命名与声明一致：presets/skills/pipelines 目录没有未声明资产", () => {
    const declaredPresets = new Set(manifest.workloom.provides.presets.map((assetPath) => assetPath.replace("presets/", "")));
    const declaredPipelines = new Set(manifest.workloom.provides.pipelines.map((assetPath) => assetPath.replace("pipelines/", "")));
    const undeclaredPresets = listFiles(join(BUNDLE_DIR, "presets"), (name) => name.endsWith(".yml"))
      .map((file) => file.split("/").pop()!)
      .filter((name) => !declaredPresets.has(name));
    const undeclaredPipelines = listFiles(join(BUNDLE_DIR, "pipelines"), (name) => name.endsWith(".yml"))
      .map((file) => file.split("/").pop()!)
      .filter((name) => !declaredPipelines.has(name));
    expect(undeclaredPresets).toEqual([]);
    expect(undeclaredPipelines).toEqual([]);
  });
});
