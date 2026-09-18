/**
 * 获客五环闭环完整性（业务域回归测试，只读磁盘资产，不触 DB）。
 *
 * 为什么需要这组测试：`bundle:governance` 已覆盖契约/资产/兼容性/完整性签名，但
 * **管线步骤 owner ↔ 数字员工 preset ↔ 技能资产 ↔ 围栏规则** 这四层之间的交叉引用
 * 无人校验。一旦断链，运行时表现是"某一步没人执行"或"触发器挂空岗"，属于静默失败——
 * 正是 L9.2「不装出半个班子」要禁止的状态。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadOfficialSkills } from "../skills/official.js";
import { bundlesRoot } from "./assembly.js";

interface PresetDoc {
  preset_key?: string;
  skills?: string[];
  fence_bindings?: string[];
}

interface PipelineDoc {
  quest?: string;
  steps?: Array<{ step_key?: string; owner?: string; gates?: string[] }>;
}

const ROOT = bundlesRoot();
const REPO_ROOT = dirname(ROOT);
const BUNDLES = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function readYaml<T>(file: string): T {
  return YAML.parse(readFileSync(file, "utf8")) as T;
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, predicate));
    else if (predicate(entry.name)) out.push(path);
  }
  return out;
}

interface BundleView {
  id: string;
  dir: string;
  presets: Map<string, { file: string; doc: PresetDoc }>;
  pipelines: Array<{ file: string; doc: PipelineDoc }>;
  fenceRuleIds: Set<string>;
}

function loadBundle(id: string): BundleView {
  const dir = join(ROOT, id);
  const presets = new Map<string, { file: string; doc: PresetDoc }>();
  for (const file of listFiles(join(dir, "presets"), (n) => n.endsWith(".yml"))) {
    const doc = readYaml<PresetDoc>(file);
    if (doc.preset_key) presets.set(doc.preset_key, { file, doc });
  }
  const pipelines = listFiles(join(dir, "pipelines"), (n) => n.endsWith(".yml"))
    .map((file) => ({ file, doc: readYaml<PipelineDoc>(file) }));
  const fenceRuleIds = new Set<string>();
  for (const file of listFiles(join(dir, "fences"), (n) => /\.ya?ml$/.test(n))) {
    for (const match of readFileSync(file, "utf8").matchAll(/rule_id:\s*"?([A-Za-z0-9_-]+)"?/g)) {
      fenceRuleIds.add(match[1]!);
    }
  }
  return { id, dir, presets, pipelines, fenceRuleIds };
}

const VIEWS = BUNDLES.map(loadBundle);

/** 官方技能名（用生产加载器解析，测试与运行时同一口径） */
const OFFICIAL_SKILLS = new Set(loadOfficialSkills(REPO_ROOT).map((skill) => skill.name));

/** 注册表技能：skills/registry/<技能>/SKILL.md（平铺单技能） */
function registrySkillExists(skill: string): boolean {
  return existsSync(join(REPO_ROOT, "skills", "registry", skill, "SKILL.md"));
}

/** 技能资产可解析：行业包自带 skills/<name>/，或官方/注册表技能资产 */
function skillAssetExists(bundle: BundleView, skill: string): boolean {
  if (existsSync(join(bundle.dir, "skills", skill))) return true;
  return OFFICIAL_SKILLS.has(skill) || registrySkillExists(skill);
}

describe("获客五环管线：每一步都有人", () => {
  it("管线步骤 owner 必须是本行业包内已定义的数字员工 preset_key（不挂空岗）", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const { file, doc } of bundle.pipelines) {
        for (const step of doc.steps ?? []) {
          if (!step.owner || !bundle.presets.has(step.owner)) {
            broken.push(`${bundle.id}/${file.split("/").pop()} step=${step.step_key ?? "?"} owner=${step.owner ?? "未声明"}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("获客主链路（hotel 五环）步骤齐备且顺序覆盖五环", () => {
    const hotel = VIEWS.find((b) => b.id === "hotel")!;
    const loop = hotel.pipelines.find((p) => p.doc.quest === "hotel-acquisition-loop");
    expect(loop, "酒店获客主链路管线缺失").toBeDefined();
    const keys = (loop!.doc.steps ?? []).map((s) => s.step_key);
    expect(keys).toEqual([
      "intent-radar", "content-schedule", "dual-publish", "reception",
      "lead-grading", "coupon-convert", "attribution", "guest-retention", "funnel-review",
    ]);
  });
});

describe("围栏引用完整性：管线门与员工绑定都必须有规则定义", () => {
  it("管线 gates 引用的规则 id 必须在本行业包围栏资产中存在", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const { file, doc } of bundle.pipelines) {
        for (const step of doc.steps ?? []) {
          for (const gate of step.gates ?? []) {
            if (!bundle.fenceRuleIds.has(gate)) {
              broken.push(`${bundle.id}/${file.split("/").pop()} step=${step.step_key ?? "?"} gate=${gate}`);
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("员工 fence_bindings 引用的规则 id 必须存在（未声明即禁写的前提是可解析）", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const [key, { file, doc }] of bundle.presets) {
        for (const fence of doc.fence_bindings ?? []) {
          if (!bundle.fenceRuleIds.has(fence)) {
            broken.push(`${bundle.id}/${file.split("/").pop()} preset=${key} fence=${fence}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("员工技能资产可解析", () => {
  it("preset.skills 的每一项都能解析到行业包技能或官方/注册表技能资产", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const [key, { file, doc }] of bundle.presets) {
        for (const skill of doc.skills ?? []) {
          if (!skillAssetExists(bundle, skill)) {
            broken.push(`${bundle.id}/${file.split("/").pop()} preset=${key} skill=${skill}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("组合包 preset_key 冲突（已知债务登记）", () => {
  /**
   * 组合装载（geo-growth 依赖 hotel + ai-video）会把三个行业包的 preset 装进同一工作区，
   * 而数字员工身份就是 preset_key（agents 幂等键 =(workspace_id, preset_key)）。
   * 同名不同义 = 只能上岗一个，另一个静默失效（业务岗位丢失）。
   *
   * 当前 4 处冲突需要产品侧裁决"保留哪一份定义或改名"，故此处只做**登记 + 防增长**：
   * 修复后请同步收缩本清单，不得新增。
   */
  it("跨包重复 preset_key 只能是已登记的 4 处，不得新增", () => {
    const owners = new Map<string, string[]>();
    for (const bundle of VIEWS) {
      for (const key of bundle.presets.keys()) {
        owners.set(key, [...(owners.get(key) ?? []), bundle.id].sort());
      }
    }
    const conflicts = Object.fromEntries(
      [...owners.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => [key, list]),
    );
    expect(conflicts).toEqual({
      "ads-optimizer": ["ai-video", "geo-growth"],
      "company-ceo": ["geo-growth", "hotel"],
      "publish-operator": ["ai-video", "geo-growth"],
      "review-analyst": ["ai-video", "geo-growth"],
    });
  });
});
