/** 实际来源HTTP、A1–A5 vendor装订、reviewStage及文件摘要；只有模型回答是HTTP协议替身。 */
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMarketingFacts, finalizeMarketingFacts, verifyMarketingFacts, toJennyMarketingRaw, type PreparedMarketingFacts } from "./marketing-authority.js";
import { fetchMarketingSource, requestSource } from "./marketing-source-fetcher.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
const scope = { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "P1", runId: "RUN1", attempt: 1 };
const env = { LLM_BASE_URL: "https://judge.example.test", LLM_API_KEY: "test-only", LLM_MODEL: "test-judge" };
const sourceUrl = "https://source.example.com/f3";
const sourceText = "星野 F3 是一款风扇，风量 9 档。待机功率 0，自动启停 false，接口 USB/C~口。尾部注意：9 档是风量档位，不是能耗等级；不得声称静音或市场第一。";
let server: Server, origin: string, root: string, modelCalls: any[], rejectJudge: boolean, extractionCalls: string[];
beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(sourceText); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "marketing-authority-"))); modelCalls = []; extractionCalls = []; rejectJudge = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { modelCalls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approved: !rejectJudge, score: rejectJudge ? 10 : 96, issues: rejectJudge ? ["来源不支持此主张"] : [], suggestions: [], reason: rejectJudge ? "原文限定相冲突" : "逐项原文支持" }) } }] })); }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function prepare(options: { noSearch?: boolean; noAux?: boolean; badQuote?: boolean; modelFailure?: boolean; mode?: string; attempt?: number; specs?: Record<string, string | number | boolean> } = {}): Promise<PreparedMarketingFacts> {
  let searches = 0;
  return prepareMarketingFacts({ scope: { ...scope, attempt: options.attempt ?? 1 }, root, intent: "做一条风扇介绍", metadata: { brief: { product: "星野 F3", brand: "星野" } }, env: { ...env, ...(options.mode ? { VM_DATA_MINING_MODE: options.mode } : {}) },
    llm: { reason: async prompt => {
      extractionCalls.push(prompt); if (options.modelFailure) return { success: false, error: "LLM unavailable" };
      const match = /当前阶段：(A[123])\n(.*)$/s.exec(prompt)!; const source = JSON.parse(match[2]!).sources[0];
      if (match[1] !== "A1") return { success: true, data: { payload: match[1] === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "页面仅商品规格，无可核实评价或竞品" } };
      const specs = options.specs ?? { 风量: "9 档" };
      return { success: true, data: { payload: { identity: { name: "星野 F3", specs, official_selling_points: [{ point: "风量 9 档", source_url: sourceUrl }] }, images: [] }, citations: ["/identity/name", ...Object.keys(specs).map(key => `/identity/specs/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`), "/identity/official_selling_points/0/point"].map(pointer => ({ pointer, sourceId: source.sourceId, quote: options.badQuote ? "不存在的事实" : sourceText })) } };
    } }, dependencies: {
      search: async () => (++searches, options.noSearch || options.noAux && searches > 20 ? [] : [{ title: "星野规格", url: sourceUrl, snippet: "故意错误摘要999档，不能当事实" }]),
      fetchSource: async url => fetchMarketingSource(url, { resolver: async () => [{ address: "93.184.216.34", family: 4 }], transport: async (_url, _address, signal) => requestSource(new URL(origin), { address: "127.0.0.1", family: 4 }, signal) }),
    } });
}
const shots = [{ shotId: "S1", prompt: "窗边展示星野 F3 风扇，字幕说明风量 9 档。", fields: { 场景: "窗边", 产品: "星野 F3", 规格: "9 档" } }];
describe("营销事实宿主完整执行", () => {
  it("真实HTTP正文→三站提取/完整支持审核→A1–A5→逐最终镜头事实审核→复读", async () => {
    const prepared = await prepare();
    expect(prepared.bundle.stages.map(stage => [stage.stage, stage.facts.status])).toEqual([["A1", "source_bound"], ["A2", "no_evidence"], ["A3", "no_evidence"]]);
    expect(prepared.bundle.sources).toHaveLength(1); expect(prepared.bundle.restrictions).toHaveLength(2); expect(extractionCalls).toHaveLength(3);
    expect(prepared.bundle.dossier.identity).toMatchObject({ specs: { 风量: "9 档" } });
    expect(prepared.bundle.dossier.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ claim_ref: "identity.specs.风量", source_url: sourceUrl, agent: "ProductInfoCollector" })]));
    expect((prepared.bundle.dossier.gaps as string[]).some(gap => gap.includes('规格 "风量" 无来源'))).toBe(false);
    expect((prepared.bundle.dossier.gaps as string[]).some(gap => gap.includes("价格"))).toBe(true);
    expect(prepared.bundle.rawByAgent.A1.identity).toMatchObject({ specs: { 风量: "9 档" } });
    expect(prepared.bundle.rawSha256).toBe(renderSha256(canonicalRenderJson(prepared.raw)));
    expect(prepared.g1Content).toContain('"schemaVersion":"workloom.marketing-facts/v1"'); expect(modelCalls).toHaveLength(3);
    expect(JSON.stringify(modelCalls)).toContain("不得声称静音或市场第一"); expect(JSON.stringify(modelCalls)).not.toContain("999档");
    const saved = await finalizeMarketingFacts(prepared, shots, env); expect(modelCalls).toHaveLength(4);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots }); expect(checked.outputReviews[0]?.promptSha256).toBe(renderSha256(shots[0]!.prompt));
    expect(await readFile(path.join(root, checked.sources[0]!.textRef), "utf8")).toBe(sourceText);
  });
  it.each(["spec", "no-search", "bad-quote", "model-failure", "support-rejected"])("%s不能得到可送G1的事实包", async kind => {
    rejectJudge = kind === "support-rejected";
    await expect(prepare({ mode: kind === "spec" ? "spec" : undefined, noSearch: kind === "no-search", badQuote: kind === "bad-quote", modelFailure: kind === "model-failure" })).rejects.toThrow();
    if (["spec", "no-search", "bad-quote", "model-failure"].includes(kind)) expect(modelCalls).toHaveLength(0);
  });
  it("最终镜头夸大主张被监制拒绝，事实包不能完成", async () => {
    const prepared = await prepare(); rejectJudge = true;
    await expect(finalizeMarketingFacts(prepared, [{ ...shots[0]!, prompt: "全市场第一，零噪音" }], env)).rejects.toThrow("MARKETING_PROMPT_FACTS_REJECTED");
    await expect(readFile(path.join(root, `${prepared.prefix}-facts.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["raw", "text", "review", "prompt", "fields", "scope", "attempt", "expired", "claim-offset"])("%s变化不能复用营销事实资格", async kind => {
    const prepared = await prepare(), saved = await finalizeMarketingFacts(prepared, shots, env); let hash = saved.sha256;
    const requestedShots = structuredClone(shots), expectedScope = { ...scope };
    if (["raw", "text", "review"].includes(kind)) {
      const source = prepared.bundle.sources[0]!, file = kind === "raw" ? source.rawRef : kind === "text" ? source.textRef : prepared.bundle.stages[0]!.review!.ref;
      await writeFile(path.join(root, file), "changed");
    }
    if (kind === "prompt") requestedShots[0]!.prompt += "未审主张";
    if (kind === "fields") requestedShots[0]!.fields.规格 = "99 档";
    if (kind === "scope") expectedScope.tenantId = "other";
    if (kind === "attempt") expectedScope.attempt = 2;
    if (kind === "expired" || kind === "claim-offset") {
      if (kind === "expired") prepared.bundle.collectedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      else prepared.bundle.stages[0]!.facts.claims[0]!.quoteStart++;
      const text = canonicalRenderJson(prepared.bundle); await writeFile(path.join(root, saved.ref), text); hash = renderSha256(text);
    }
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: hash, scope: expectedScope, shots: requestedShots })).rejects.toThrow();
  });
  it("重复attempt写盘失败必须终止，不能当抓源失败换候选", async () => {
    await prepare(); await expect(prepare()).rejects.toMatchObject({ code: "EEXIST" });
  });
  it("Jenny桥逐项绑定转义pointer、0/false和finalUrl，不改变原始审核值或摘要", async () => {
    const specs = { "接口/~": "USB/C~口", 待机功率: 0, 自动启停: false };
    const prepared = await prepare({ specs }), before = canonicalRenderJson(prepared.raw);
    const converted = toJennyMarketingRaw(prepared.raw, prepared.bundle);
    expect(converted.A1.identity).toMatchObject({ specs: Object.fromEntries(Object.entries(specs).map(([key, value]) => [key, { value, source_url: sourceUrl }])) });
    expect(prepared.bundle.dossier.identity).toMatchObject({ specs });
    expect((prepared.bundle.dossier.provenance as Array<Record<string, unknown>>).filter(item => String(item.claim_ref).startsWith("identity.specs."))).toHaveLength(3);
    expect((prepared.bundle.dossier.gaps as string[]).some(gap => /规格 .* 无来源/.test(gap))).toBe(false);
    const redirected = structuredClone(prepared.bundle); redirected.sources[0]!.finalUrl = `${sourceUrl}?final=1`;
    const redirectedId = `SRC-${renderSha256(`${redirected.sources[0]!.finalUrl}\n${redirected.sources[0]!.textSha256}`).slice(0, 24)}`;
    const a1 = redirected.stages.find(item => item.stage === "A1")!;
    redirected.sources[0]!.sourceId = redirectedId; a1.sourceIds = [redirectedId]; a1.facts.claims.forEach(claim => { claim.sourceId = redirectedId; });
    expect(toJennyMarketingRaw(prepared.raw, redirected).A1.identity).toMatchObject({ specs: { 待机功率: { source_url: `${sourceUrl}?final=1` } } });
    expect(canonicalRenderJson(prepared.raw)).toBe(before); expect(canonicalRenderJson(prepared.bundle.rawByAgent)).toBe(before);
    expect(prepared.bundle.rawSha256).toBe(renderSha256(before)); expect(converted.A2).toEqual(prepared.raw.A2); expect(converted.A3).toEqual(prepared.raw.A3);
  });
  it.each(["raw-hash", "raw-value-rehashed", "claim-value", "claim-missing", "claim-duplicate", "claim-stage", "claim-status", "source-missing", "source-stage", "source-duplicate", "source-text-hash", "source-url", "source-final-url-changed"])("Jenny桥拒绝%s，不伪造规格来源", async kind => {
    const prepared = await prepare(), raw = structuredClone(prepared.raw), evidence = structuredClone(prepared.bundle);
    const a1 = evidence.stages.find(item => item.stage === "A1")!, claim = a1.facts.claims.find(item => item.pointer === "/identity/specs/风量")!;
    if (kind === "raw-hash" || kind === "raw-value-rehashed") (raw.A1.identity as { specs: Record<string, unknown> }).specs.风量 = "99 档";
    if (kind === "raw-value-rehashed") evidence.rawSha256 = renderSha256(canonicalRenderJson(raw));
    if (kind === "claim-value") claim.value = "99 档";
    if (kind === "claim-missing") a1.facts.claims = a1.facts.claims.filter(item => item !== claim);
    if (kind === "claim-duplicate") a1.facts.claims.push(structuredClone(claim));
    if (kind === "claim-stage") claim.stage = "A2";
    if (kind === "claim-status") (claim as { status: string }).status = "unverified";
    if (kind === "source-missing") evidence.sources = [];
    if (kind === "source-stage") a1.sourceIds = [];
    if (kind === "source-duplicate") evidence.sources.push(structuredClone(evidence.sources[0]!));
    if (kind === "source-text-hash") evidence.sources[0]!.textSha256 = "0".repeat(64);
    if (kind === "source-url") evidence.sources[0]!.finalUrl = "file:///private/source";
    if (kind === "source-final-url-changed") evidence.sources[0]!.finalUrl = "https://forged.example.com/spec";
    expect(() => toJennyMarketingRaw(raw, evidence)).toThrow(/MARKETING_(FACTS_CHANGED|SPEC_UNVERIFIED|SOURCE_INVALID)/);
  });
});
