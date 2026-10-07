import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { invokeCapability, loadCatalog, mcpTools } from "./agent-capabilities.mjs";
import { copyRuntimeSources } from "./pack-workspace-modules.mjs";
import { GUIDE_CAPABILITY_ID, GUIDE_PATH, MAX_GUIDE_BYTES, workbenchGuide } from "../bundles/geo-growth/capabilities/workbench-guide.mjs";
import { productionPlan } from "../bundles/geo-growth/capabilities/video.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TOOL = "workloom_growth_video_workbench_guide";
const GUIDE_BYTES = readFileSync(join(ROOT, GUIDE_PATH));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CLI_ASSETS = [
  "scripts/workloom-agent.mjs", "scripts/workloom-agent-mcp.mjs",
  "scripts/agent-capabilities.mjs", "scripts/agent-capabilities.core.json",
];
const CATALOG_ASSETS = [
  "product.manifest.json", "bundles/geo-growth/agent-capabilities.json",
  "bundles/geo-growth/capabilities/workbench-guide.mjs",
];

function temp(t, prefix = "workloom 视频指南 中文 空格-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = temp(t);
  copyRuntimeSources(ROOT, root, [...CLI_ASSETS, ...CATALOG_ASSETS, GUIDE_PATH]);
  return root;
}

function cli(root, args, options = {}) {
  return spawnSync(process.execPath, [join(root, "scripts/workloom-agent.mjs"), ...args], {
    cwd: tmpdir(), encoding: "utf8", ...options,
  });
}

function mcp(root, calls) {
  const result = spawnSync(process.execPath, [join(root, "scripts/workloom-agent-mcp.mjs")], {
    cwd: tmpdir(), encoding: "utf8",
    env: { ...process.env, WORKLOOM_PRODUCT_ROOT: root, WORKLOOM_VIDEO_ARTIFACT_ROOT: tmpdir() },
    input: calls.map((call, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...call })).join("\n") + "\n",
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  return new Map(replies.map((reply) => [reply.id, reply]));
}

function guideCalls() {
  return [
    { method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "video-guide-test", version: "1" } } },
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: TOOL, arguments: {} } },
  ];
}

function assertBody(output) {
  assert.equal(output.schemaVersion, "workloom.capability-result/v1");
  assert.equal(output.capabilityId, GUIDE_CAPABILITY_ID);
  assert.equal(output.operation, "read");
  assert.equal(output.dataMode, "unverified");
  assert.equal(output.status, "succeeded");
  assert.equal(output.result.path, GUIDE_PATH);
  assert.equal(output.result.repository, "workloom-ai/WorkLoom-growth");
  assert.equal(output.result.markdown, GUIDE_BYTES.toString("utf8"));
  assert.equal(output.result.byteCount, GUIDE_BYTES.length);
  assert.equal(output.result.sha256, hash(GUIDE_BYTES));
}

test("本仓固定指南返回全文、版本、产品身份及原始字节摘要", () => {
  const result = workbenchGuide({});
  assert.equal(result.markdown, GUIDE_BYTES.toString("utf8"));
  assert.equal(result.sha256, hash(GUIDE_BYTES));
  assert.equal(result.byteCount, GUIDE_BYTES.length);
  assert.equal(result.guideVersion, "2026-10-07.1");
  assert.equal(result.repository, "workloom-ai/WorkLoom-growth");
  assert.match(result.markdown, /rawIntent/u);
  assert.match(result.markdown, /没有 Growthtest 的 nativeaudio 专用契约/u);
  assert.ok(result.limitations.some((item) => item.includes("TTS")));
});

test("指南锚定模块所在产品根，不被cwd或产物根替换", (t) => {
  const external = temp(t);
  mkdirSync(join(external, "docs"));
  writeFileSync(join(external, GUIDE_PATH), "external decoy, must not be read");
  const cwd = process.cwd();
  const artifactRoot = process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT;
  try {
    process.chdir(external);
    process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = external;
    assert.equal(workbenchGuide({}).sha256, hash(GUIDE_BYTES));
    assert.equal(workbenchGuide({}).markdown, GUIDE_BYTES.toString("utf8"));
  } finally {
    process.chdir(cwd);
    if (artifactRoot === undefined) delete process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT;
    else process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = artifactRoot;
  }
});

test("指南拒绝调用方路径和非法对象；catalog保留既有null归一化", async () => {
  for (const input of [null, [], "", { path: "../private" }, { root: tmpdir() }, { title: "生成一片" }]) {
    assert.throws(() => workbenchGuide(input), (error) => error.code === "INVALID_INPUT");
  }
  const catalog = await loadCatalog(ROOT);
  for (const input of [[], "", { path: "../private" }]) {
    await assert.rejects(invokeCapability(catalog, GUIDE_CAPABILITY_ID, input), (error) => error.code === "INVALID_INPUT");
  }
  // The shared transport has always normalized a missing/null input to {}.
  // Keep that compatibility without changing the common transport for a guide.
  assertBody(await invokeCapability(catalog, GUIDE_CAPABILITY_ID, null));
});

test("清单只读低风险，invoke无需网络或供应商凭据", async () => {
  const catalog = await loadCatalog(ROOT);
  const descriptor = catalog.entries.get(GUIDE_CAPABILITY_ID);
  assert.equal(descriptor.operation, "read");
  assert.equal(descriptor.risk, "low");
  assert.equal(descriptor.dataMode, "unverified");
  assert.deepEqual(descriptor.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  const tool = mcpTools(catalog).find((entry) => entry.name === TOOL);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  const output = await invokeCapability(catalog, GUIDE_CAPABILITY_ID, {}, {
    fetcher: () => { throw new Error("unexpected network"); }, env: {},
  });
  assertBody(output);
});

test("实际CLI异cwd list/describe/invoke读取同一全文；非法输入非零退出", (t) => {
  const root = fixture(t);
  const listed = cli(root, ["list", "--root", root]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(JSON.parse(listed.stdout).capabilities.some((entry) => entry.id === GUIDE_CAPABILITY_ID));
  const described = cli(root, ["describe", GUIDE_CAPABILITY_ID, "--root", root]);
  assert.equal(described.status, 0, described.stderr);
  assert.equal(JSON.parse(described.stdout).transport.export, "workbenchGuide");
  const invoked = cli(root, ["invoke", GUIDE_CAPABILITY_ID, "--root", root]);
  assert.equal(invoked.status, 0, invoked.stderr);
  assertBody(JSON.parse(invoked.stdout));
  const bad = cli(root, ["invoke", GUIDE_CAPABILITY_ID, "--input-file", "-"], { input: '{"path":"../private"}' });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_INPUT");
});

test("实际MCP发现工具并回读相同正文，非法参数保留isError", (t) => {
  const root = fixture(t);
  const calls = [...guideCalls(), { method: "tools/call", params: { name: TOOL, arguments: { path: "../private" } } }];
  const replies = mcp(root, calls);
  assert.equal(replies.get(1).result.serverInfo.name, "workloom-agent");
  assert.ok(replies.get(2).result.tools.some((entry) => entry.name === TOOL));
  assert.equal(replies.get(3).result.isError, false);
  assertBody(JSON.parse(replies.get(3).result.content[0].text));
  assert.equal(replies.get(4).result.isError, true);
  assert.equal(JSON.parse(replies.get(4).result.content[0].text).error.code, "INVALID_INPUT");
});

test("缺件、空文档、超上限、无版本、UTF8损坏及身份冲突都失败关闭", async (t) => {
  const root = fixture(t);
  const imported = await import(pathToFileURL(join(root, "bundles/geo-growth/capabilities/workbench-guide.mjs")).href);
  const path = join(root, GUIDE_PATH);
  rmSync(path);
  assert.throws(() => imported.workbenchGuide({}), (error) => error.code === "GUIDE_UNAVAILABLE");
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_GUIDE_BYTES + 1, "x"), Buffer.from("missing version"), Buffer.from([0xc3, 0x28])]) {
    writeFileSync(path, bytes);
    assert.throws(() => imported.workbenchGuide({}), (error) => error.code === "GUIDE_UNAVAILABLE");
  }
  writeFileSync(path, GUIDE_BYTES);
  const product = JSON.parse(readFileSync(join(root, "product.manifest.json"), "utf8"));
  product.repository = "workloom-ai/workloom-growthtest";
  writeFileSync(join(root, "product.manifest.json"), JSON.stringify(product));
  assert.throws(() => imported.workbenchGuide({}), (error) => error.code === "GUIDE_UNAVAILABLE");
});

test("指南文件和docs父目录符号链接均不能读取仓外文件", async (t) => {
  const root = fixture(t);
  const external = temp(t, "workloom external-");
  writeFileSync(join(external, "guide.md"), GUIDE_BYTES);
  const imported = await import(pathToFileURL(join(root, "bundles/geo-growth/capabilities/workbench-guide.mjs")).href);
  rmSync(join(root, GUIDE_PATH));
  symlinkSync(join(external, "guide.md"), join(root, GUIDE_PATH));
  assert.throws(() => imported.workbenchGuide({}), (error) => error.code === "GUIDE_UNAVAILABLE");
  rmSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(external, "ai-video-workbench-guide.md"), GUIDE_BYTES);
  symlinkSync(external, join(root, "docs"), "dir");
  assert.throws(() => imported.workbenchGuide({}), (error) => error.code === "GUIDE_UNAVAILABLE");
});

test("缺指南的真实CLI与MCP均保留失败事实", (t) => {
  const root = fixture(t);
  rmSync(join(root, GUIDE_PATH));
  const output = cli(root, ["invoke", GUIDE_CAPABILITY_ID]);
  assert.notEqual(output.status, 0);
  assert.equal(output.stdout, "");
  assert.equal(JSON.parse(output.stderr).error.code, "GUIDE_UNAVAILABLE");
  const replies = mcp(root, guideCalls());
  assert.equal(replies.get(3).result.isError, true);
  assert.equal(JSON.parse(replies.get(3).result.content[0].text).error.code, "GUIDE_UNAVAILABLE");
});

function packGuideBlock(path) {
  const source = readFileSync(join(ROOT, path), "utf8");
  const block = source.match(/^# VIDEO_WORKBENCH_ASSETS:BEGIN\n([\s\S]*?)^# VIDEO_WORKBENCH_ASSETS:END$/mu)?.[1];
  assert.ok(block, `${path} must copy the fixed guide and actual CLI readers`);
  return block;
}

test("三个真实pack脚本的固定资产复制块能运行，载荷CLI/MCP全文与SHA一致", (t) => {
  for (const script of ["scripts/pack-electron-payload.sh", "scripts/pack-macos.sh", "scripts/pack-windows.sh"]) {
    const payload = temp(t, "workloom installed 中文 空格-");
    copyRuntimeSources(ROOT, payload, CATALOG_ASSETS);
    const block = packGuideBlock(script);
    execFileSync("/bin/bash", ["-eu", "-c", block], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, R: payload, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    });
    for (const path of [GUIDE_PATH, ...CLI_ASSETS]) {
      assert.equal(hash(readFileSync(join(payload, path))), hash(readFileSync(join(ROOT, path))), `${script}: ${path}`);
    }
    assert.equal(existsSync(join(payload, "docs/AGENT-CLIENTS.md")), false);
    assert.equal(existsSync(join(payload, "work")), false);
    const output = cli(payload, ["invoke", GUIDE_CAPABILITY_ID]);
    assert.equal(output.status, 0, output.stderr);
    assertBody(JSON.parse(output.stdout));
    const replies = mcp(payload, guideCalls());
    assert.equal(replies.get(3).result.isError, false);
    assertBody(JSON.parse(replies.get(3).result.content[0].text));
  }
});

test("实际pack固定复制块遇到缺指南会非零退出", (t) => {
  const root = fixture(t);
  copyRuntimeSources(ROOT, root, ["scripts/pack-workspace-modules.mjs", "scripts/payload-policy.mjs", "scripts/product-runtime.mjs"]);
  rmSync(join(root, GUIDE_PATH));
  const payload = temp(t, "workloom incomplete payload-");
  const result = spawnSync("/bin/bash", ["-eu", "-c", packGuideBlock("scripts/pack-electron-payload.sh")], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, R: payload, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /视频指南载荷缺件/u);
});

test("计划指向指南并保留安全argv，不把指南当生产资格", () => {
  const keyFile = process.env.WORKLOOM_KEYS_FILE;
  try {
    process.env.WORKLOOM_KEYS_FILE = "/dev/null";
    const output = productionPlan({ title: "用户原话", projectId: "GUIDE-TEST" });
    assert.equal(output.previewOnly, true);
    assert.deepEqual(output.workbenchGuide, { capabilityId: GUIDE_CAPABILITY_ID, path: GUIDE_PATH, mustReadBeforeProduction: true });
    assert.ok(output.beforeRun[0].includes(GUIDE_CAPABILITY_ID));
    assert.equal(output.execution.command, "pnpm");
    assert.ok(output.execution.args.includes("scripts/tools/full-chain-film.mts"));
    assert.equal(output.execution.args.includes("--standard-post"), false);
  } finally {
    if (keyFile === undefined) delete process.env.WORKLOOM_KEYS_FILE;
    else process.env.WORKLOOM_KEYS_FILE = keyFile;
  }
});
