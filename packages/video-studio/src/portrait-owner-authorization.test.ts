import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCharacterEntry } from "./character-archive.js";
import { assessPortraitDecision, selectPortraitDecisionRecord } from "./portrait-decision.js";
import { buildGateEvent } from "./gate-ledger.js";
import { assertPortraitOwnerWritePaths, buildPortraitOwnerAuthorization, EXPLICIT_PORTRAIT_AUTHORIZATION,
  portraitOwnerAuthorizationIssues, verifyPortraitOwnerAuthorization, type PortraitOwnerGateRecord } from "./portrait-owner-authorization.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const angles = ["front", "threeQuarter", "closeup", "side", "back", "actionPose", "emotionCloseup", "handDetail"];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portrait-authorization-")); roots.push(root);
  mkdirSync(join(root, ".workloom")); writeFileSync(join(root, ".workloom/live.env"), "G5_TEST_SENTINEL=not-a-provider-credential\n");
  const dir = join(root, "directory-differs-from-profile-id");
  mkdirSync(join(dir, "portraits/v1"), { recursive: true }); mkdirSync(join(dir, "reviews"));
  const profile = { schemaVersion: "workloom.character-profile/v1", id: "synthetic-actor", name: "测试AI角色", kind: "generated",
    portraitSets: [{ version: 1, dir: "portraits/v1", angles: [...angles], source: "pure-t2i", active: true, status: "ready" }] };
  for (const [index, angle] of angles.entries()) writeFileSync(join(dir, "portraits/v1", `actor-${angle}.png`), Buffer.alloc(60_000, index + 1));
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile));
  const entry = loadCharacterEntry(dir)!;
  const authorization = buildPortraitOwnerAuthorization(entry, { decisionOwner: "产品所有者", recordedBy: "Codex",
    statement: "将这组新AI角色设为默认1号，并用于已指定的本片。", anchorFile: entry.files.front! });
  const receiptFile = join(dir, "reviews", "v1-owner-acceptance-fixture.json");
  const receipt = { kind: "owner-acceptance", basis: EXPLICIT_PORTRAIT_AUTHORIZATION, approved: true, characterId: entry.id,
    version: 1, acceptedBy: authorization.decisionOwner, note: authorization.statement, authorization,
    artifacts: authorization.artifacts, anchors: [authorization.anchor] };
  const seal = () => writeFileSync(receiptFile, JSON.stringify(receipt)); seal();
  const gate = buildGateEvent({ stepKey: "g5-portrait-confirm", projectId: "portrait:synthetic-actor:v1", via: "owner-acceptance",
    sourceStage: "owner-acceptance", softApproved: true, checks: [{ id: "owner-acceptance", pass: true, hard: true, detail: "既有用途授权" }],
    evidence: { basis: EXPLICIT_PORTRAIT_AUTHORIZATION, characterId: entry.id, version: 1, authorization,
      ownerAcceptance: receiptFile, ownerAcceptanceSha256: sha(receiptFile) } });
  const expected = { dir, characterId: entry.id, version: 1, files: { ...entry.files } };
  const verify = (record: PortraitOwnerGateRecord = gate) => verifyPortraitOwnerAuthorization(record, expected);
  return { root, dir, entry, authorization, receipt, receiptFile, gate, expected, verify, profile, seal };
}
describe("既有所有者用途授权：不冒充视觉验收并绑定全部当前资产", () => {
  it("真实合同绑定八角度和新AI front；用途决策人和Codex分别留痕", () => {
    const f = fixture();
    expect(f.authorization.artifacts).toHaveLength(8);
    expect(f.authorization.anchor).toMatchObject({ kind: "generated-ai-front", file: "portraits/v1/actor-front.png", sha256: sha(f.entry.files.front!) });
    expect(f.verify()).toMatchObject({ ok: true, issues: [] });
    expect(assessPortraitDecision(f.gate)).toMatchObject({ kind: "human", decisive: true, blocking: false });
    expect(assessPortraitDecision(f.gate).detail).toContain("不代表人类逐图视觉验收");
  });
  it.each(["decisionOwner", "recordedBy", "statement", "anchor", "artifacts"])("缺少%s不能放行且不回退旧批准", (field) => {
    const f = fixture(); const broken = structuredClone(f.gate); delete (broken.evidence!.authorization as Record<string, unknown>)[field];
    expect(f.verify(broken).ok).toBe(false);
    const old = { ...f.gate, evidence: { basis: "human-review" } };
    expect(selectPortraitDecisionRecord([old, broken], f.gate.projectId)).toBe(broken);
    expect(assessPortraitDecision(broken)).toMatchObject({ kind: "invalid", decisive: true, blocking: true });
  });
  it("执行人不能充当同一决定的产品所有者，未知basis和机器伪装不走旧approved=true兜底", () => {
    const f = fixture(); const same = structuredClone(f.authorization); same.decisionOwner = same.recordedBy;
    expect(portraitOwnerAuthorizationIssues(same)).not.toEqual([]);
    expect(assessPortraitDecision({ ...f.gate, evidence: { basis: "invented-basis" } })).toMatchObject({ kind: "invalid", blocking: true });
    expect(assessPortraitDecision({ ...f.gate, via: "llm" })).toMatchObject({ kind: "invalid", blocking: true });
    expect(assessPortraitDecision({ via: "llm", sourceStage: "owner-acceptance", approved: true, evidence: { basis: "human-review" } })).toMatchObject({ kind: "machine", decisive: false });
    expect(assessPortraitDecision({ ...f.gate, evidence: { basis: "human-review", advisory: true } })).toMatchObject({ kind: "invalid", blocking: true });
  });
  it.each([undefined, "human-review", "unknown"])("新合同basis改为%s也不会降级为旧视觉验收", (basis) => {
    const f = fixture(); const changed = structuredClone(f.gate); changed.evidence!.basis = basis;
    expect(assessPortraitDecision(changed)).toMatchObject({ kind: "invalid", decisive: true, blocking: true });
    expect(f.verify(changed).ok).toBe(false);
    expect(selectPortraitDecisionRecord([{ ...f.gate, evidence: { basis: "human-review" } }, changed], f.gate.projectId)).toBe(changed);
  });
  it.each(["back", "handDetail", "front"])("授权之后修改%s当前字节必须失败", (angle) => {
    const f = fixture(); writeFileSync(f.entry.files[angle]!, Buffer.alloc(60_000, 99));
    expect(f.verify().ok).toBe(false);
  });
  it("缺图、重复声明角度、非激活版本和实际出片替代路径均失败", () => {
    const f = fixture(); rmSync(f.entry.files.back!); expect(f.verify().ok).toBe(false);
    writeFileSync(f.entry.files.back!, Buffer.alloc(60_000, 5));
    f.profile.portraitSets[0]!.angles.push("back"); writeFileSync(join(f.dir, "profile.json"), JSON.stringify(f.profile)); expect(f.verify().ok).toBe(false);
    f.profile.portraitSets[0]!.angles.pop(); f.profile.portraitSets[0]!.active = false; writeFileSync(join(f.dir, "profile.json"), JSON.stringify(f.profile)); expect(f.verify().ok).toBe(false);
    f.profile.portraitSets[0]!.active = true; writeFileSync(join(f.dir, "profile.json"), JSON.stringify(f.profile));
    f.expected.files.back = f.entry.files.front!; expect(f.verify().ok).toBe(false);
  });
  it.each(["characterId", "version", "approved", "basis", "acceptedBy", "note", "kind"])("回执%s与门冲突时即使重算回执摘要也失败", (field) => {
    const f = fixture(); (f.receipt as Record<string, unknown>)[field] = field === "version" ? 2 : field === "approved" ? false : "tampered";
    f.seal(); f.gate.evidence!.ownerAcceptanceSha256 = sha(f.receiptFile); expect(f.verify().ok).toBe(false);
  });
  it("完整回执SHA阻止任意文本篡改；门和回执合同不一致也失败", () => {
    const f = fixture(); writeFileSync(f.receiptFile, readFileSync(f.receiptFile, "utf8") + "\n "); expect(f.verify().ok).toBe(false);
    f.seal(); const gate = structuredClone(f.gate); (gate.evidence!.authorization as typeof f.authorization).statement = "伪造另一项用途授权，不是原有决定。";
    expect(f.verify(gate).ok).toBe(false);
  });
  it("回执和输出目录symlink、悬空ledger symlink均拒绝", () => {
    const f = fixture(); const outside = join(f.root, "outside.json"); writeFileSync(outside, readFileSync(f.receiptFile)); rmSync(f.receiptFile); symlinkSync(outside, f.receiptFile);
    expect(f.verify().ok).toBe(false);
    symlinkSync(join(f.root, "not-created-ledger"), join(f.dir, "gates.jsonl")); expect(() => assertPortraitOwnerWritePaths(f.dir)).toThrow(/重定向/);
    rmSync(join(f.dir, "gates.jsonl")); rmSync(join(f.dir, "reviews"), { recursive: true }); symlinkSync(f.root, join(f.dir, "reviews")); expect(() => assertPortraitOwnerWritePaths(f.dir)).toThrow(/重定向/);
  });
  it("显式锚不能换成其他角度或旧图；机器留证不覆盖人类决定，后续同版本否决有效", () => {
    const f = fixture(); expect(() => buildPortraitOwnerAuthorization(f.entry, { decisionOwner: "产品所有者", recordedBy: "Codex", statement: "按既有明确授权用于本片并设默认1号", anchorFile: f.entry.files.back! })).toThrow(/当前front/);
    const machine = { ...f.gate, via: "llm", sourceStage: "portrait-review", evidence: { advisory: true } };
    expect(selectPortraitDecisionRecord([f.gate, machine], f.gate.projectId)).toBe(f.gate);
    const rejected = { ...f.gate, approved: false, evidence: { basis: "human-review" } };
    expect(assessPortraitDecision(selectPortraitDecisionRecord([f.gate, rejected, machine], f.gate.projectId)).blocking).toBe(true);
  });
});

const repo = resolve(import.meta.dirname, "../../..");
function cli(f: ReturnType<typeof fixture>, args: string[], tool = "portrait-agent.mts") {
  const noNetwork = `data:text/javascript,${encodeURIComponent('import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const read = fs.readFileSync; fs.readFileSync = function (file, ...args) { if (String(file) === process.env.HOME + "/.workloom/live.env") { process.stderr.write("FORBIDDEN_KEY_FILE_READ"); throw new Error("test key file read disabled"); } return read.call(this, file, ...args); }; syncBuiltinESMExports(); globalThis.fetch = async () => { process.stderr.write("FORBIDDEN_NETWORK_CALL"); throw new Error("test network disabled"); };')}`;
  return spawnSync(process.execPath, ["--import", noNetwork, "--import", resolve(repo, "node_modules/tsx/dist/loader.mjs"), resolve(repo, "scripts/tools", tool), ...args], {
    cwd: repo, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", HR_CHARACTER_LIBRARY: f.root, HOME: f.root, WL_FFMPEG: "false", WL_FFPROBE: "false" },
  });
}
const acceptArgs = (f: ReturnType<typeof fixture>) => ["accept", "--character", "directory-differs-from-profile-id", "--basis", EXPLICIT_PORTRAIT_AUTHORIZATION,
  "--by", "产品所有者", "--recorded-by", "Codex", "--note", "将这组新AI角色设为默认1号，并用于已指定的本片。", "--anchor", f.entry.files.front!];
describe("官方portrait-agent CLI：临时库、零模型真实子进程", () => {
  it("新模式生成可被G5消费者核验的八图合同，reject按profile ID追加否决", () => {
    const f = fixture(); const result = cli(f, acceptArgs(f)); expect(result.status, result.stderr).toBe(0);
    const gates = readFileSync(join(f.dir, "gates.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)); const gate = gates.at(-1)!;
    expect(verifyPortraitOwnerAuthorization(gate, f.expected).ok).toBe(true);
    expect(gate.reason).not.toContain("看过原图后确认"); expect(gate.evidence.authorization.recordedBy).toBe("Codex");
    expect(gate.evidence.authorization.artifacts).toHaveLength(8); expect(gate.evidence.ownerAcceptanceSha256).toBe(sha(gate.evidence.ownerAcceptance));
    const rejected = cli(f, ["reject", "--character", "directory-differs-from-profile-id", "--by", "产品所有者", "--note", "当前版本用途发生变化，明确拒绝这次使用。"]); expect(rejected.status, rejected.stderr).toBe(0);
    const events = readFileSync(join(f.dir, "gates.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.at(-1).projectId).toBe("portrait:synthetic-actor:v1"); expect(assessPortraitDecision(selectPortraitDecisionRecord(events, gate.projectId)).blocking).toBe(true);
  }, 30_000);
  it("默认旧命令及显式human-visual-review继续写兼容human-review", () => {
    const f = fixture(); for (const basis of [[], ["--basis", "human-visual-review"]]) {
      const result = cli(f, ["accept", "--character", "directory-differs-from-profile-id", "--by", "视觉验收人", "--note", "本人已查看本版本原图并确认可用。", "--anchor", f.entry.files.front!, ...basis]); expect(result.status, result.stderr).toBe(0);
    }
    const events = readFileSync(join(f.dir, "gates.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2); expect(events.every((gate) => gate.evidence.basis === "human-review")).toBe(true);
  }, 30_000);
  it.each(["missing-executor", "missing-note", "flag-owner", "unknown-basis", "duplicate-basis", "non-front", "likeness"])("拒绝%s且不追加门事件", (mode) => {
    const f = fixture(); const args = acceptArgs(f);
    if (mode === "missing-executor") args.splice(args.indexOf("--recorded-by"), 2);
    if (mode === "missing-note") args.splice(args.indexOf("--note"), 2);
    if (mode === "flag-owner") args.splice(args.indexOf("--by") + 1, 1);
    if (mode === "unknown-basis") args[args.indexOf("--basis") + 1] = "invented";
    if (mode === "duplicate-basis") args.push("--basis", "human-visual-review");
    if (mode === "non-front") args[args.indexOf("--anchor") + 1] = f.entry.files.back!;
    if (mode === "likeness") args.push("--with-likeness");
    const result = cli(f, args); expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(() => readFileSync(join(f.dir, "gates.jsonl"))).toThrow();
    expect(result.stderr).not.toMatch(/HTTP|fetch failed|缺少 ARK|需要评审模型|FORBIDDEN_NETWORK_CALL|FORBIDDEN_KEY_FILE_READ/);
  }, 30_000);
  it("真实full-chain G5消费：八图合同通过，后四图或basis变化阻断；旧视觉命令兼容，机器only和混合引用不放行", () => {
    const f = fixture(); const accepted = cli(f, acceptArgs(f)); expect(accepted.status, accepted.stderr).toBe(0);
    const shots = join(f.root, "g5-shotlist.json"); writeFileSync(shots, JSON.stringify({ title: "Temporary G5 regression", character: { id: f.entry.id, name: f.entry.name },
      shots: [{ shotId: "G5-01", duration: 5, character: f.entry.name, scene: "现代校园室外走廊，单人静静站立。", action: "她自然微笑，轻轻抬头。", subject: { kind: "person", count: 1 }, dialogue: [], lens: "50mm", lighting: "晴天自然光" }] }));
    const runG5 = (project: string) => {
      const result = cli(f, ["--shots", shots, "--project", project, "--library", f.root, "--work-dir", join(f.root, project), "--out", join(f.root, `${project}-out`),
        "--stages", "continuity", "--route-kind", "narrative", "--platform", "youtube", "--keys-file", join(f.root, "no-keys.env")], "full-chain-film.mts");
      const events = readFileSync(join(f.root, project, "logs", project, "stages.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const gate = events.find((event) => event.stepKey === "g5-portrait-confirm");
      expect(gate, result.stdout + result.stderr).toBeTruthy(); expect(result.stderr).not.toContain("FORBIDDEN_NETWORK_CALL");
      return gate;
    };
    expect(runG5("G5-ACCEPTED").ok).toBe(true);
    writeFileSync(f.entry.files.handDetail!, Buffer.alloc(60_000, 99)); expect(runG5("G5-LAST-CHANGED").ok).toBe(false);
    writeFileSync(f.entry.files.handDetail!, Buffer.alloc(60_000, 8));
    const ledger = join(f.dir, "gates.jsonl"); const gate = JSON.parse(readFileSync(ledger, "utf8").trim()); delete gate.evidence.basis;
    writeFileSync(ledger, JSON.stringify(gate) + "\n"); expect(runG5("G5-BASIS-MISSING").ok).toBe(false);
    gate.evidence = { basis: "human-review", ownerAcceptance: gate.evidence.ownerAcceptance };
    writeFileSync(ledger, JSON.stringify(gate) + "\n"); expect(runG5("G5-NEW-RECEIPT-LEGACY").ok).toBe(false);
    const old = cli(f, ["accept", "--character", "directory-differs-from-profile-id", "--by", "临时视觉测试人", "--note", "本临时副本用于旧视觉验收兼容回归。", "--anchor", f.entry.files.front!]); expect(old.status, old.stderr).toBe(0);
    expect(runG5("G5-OLD-VISUAL").ok).toBe(true);
    writeFileSync(ledger, JSON.stringify({ stepKey: "g5-portrait-confirm", projectId: "portrait:synthetic-actor:v1", via: "llm", sourceStage: "portrait-review", approved: true, evidence: { advisory: true } }) + "\n");
    expect(runG5("G5-MACHINE-ONLY").ok).toBe(false);
    const profile = f.profile as typeof f.profile & { portraitSets: Array<{ assets?: Record<string, string> }> };
    profile.portraitSets[0]!.assets = { front: "asset://temporary-fixture" }; rmSync(f.entry.files.front!);
    writeFileSync(join(f.dir, "profile.json"), JSON.stringify(profile)); expect(runG5("G5-MIXED-REFS").ok).toBe(false);
    for (const angle of ["threeQuarter", "closeup", "side"]) { profile.portraitSets[0]!.assets![angle] = "asset://temporary-fixture"; rmSync(f.entry.files[angle]!); }
    writeFileSync(join(f.dir, "profile.json"), JSON.stringify(profile)); expect(runG5("G5-ALL-EXTERNAL").ok).toBe(true);
  }, 60_000);
});
