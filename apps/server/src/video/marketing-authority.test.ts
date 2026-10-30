/** 实际来源HTTP、A1–A5 vendor装订、reviewStage及文件摘要；只有模型回答是HTTP协议替身。 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMarketingFacts, finalizeMarketingFacts, verifyMarketingFacts, toJennyMarketingRaw, type PreparedMarketingFacts } from "./marketing-authority.js";
import { fetchMarketingSource, requestSource } from "./marketing-source-fetcher.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
const scope = { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "P1", runId: "RUN1", attempt: 1 };
const env = { LLM_BASE_URL: "https://api.deepseek.com", LLM_API_KEY: "test-only", LLM_MODEL: "deepseek-flash" };
const sourceUrl = "https://source.example.com/f3";
const sourceText = "星野 F3 是一款风扇，风量 9 档。价格 399 CNY。待机功率 0，自动启停 false，接口 USB/C~口。尾部注意：9 档是风量档位，不是能耗等级；不得声称静音或市场第一。";
let server: Server, origin: string, root: string, modelCalls: any[], rejectJudge: boolean, extractionCalls: string[], extractionOptions: unknown[];
let simulatedProviderCalls: ReturnType<typeof simulatedProviderCompletion>[];
/** 独立声明的模拟 token 账单，不从字符/字节数推算，也不代表真实供应商 tokenizer。 */
function simulatedProviderCompletion(data: unknown, maxTokens: number, syntheticTokenCharge: number) {
  const complete = JSON.stringify(data), length = syntheticTokenCharge > maxTokens;
  return { success: true, content: length ? complete.slice(0, -1) : complete,
    simulation: { syntheticTokenCharge, maxTokens, finishReason: length ? "length" : "stop" } };
}
beforeAll(async () => {
  server = createServer((req, res) => {
    const imagePage = req.url === "/with-image";
    res.writeHead(200, { "content-type": imagePage ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
    res.end(imagePage ? `<html><body><p>${sourceText}</p><img src="${sourceUrl}/hero.png"></body></html>` : sourceText);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "marketing-authority-"))); modelCalls = []; extractionCalls = []; extractionOptions = []; simulatedProviderCalls = []; rejectJudge = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    modelCalls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      id: "marketing-authority-judge",
      model: "deepseek-flash",
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          approved: !rejectJudge,
          score: rejectJudge ? 10 : 96,
          issues: rejectJudge ? ["来源不支持此主张"] : [],
          suggestions: [],
          reason: rejectJudge ? "原文限定相冲突" : "逐项原文支持",
        }) },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }));
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function prepare(options: { noSearch?: boolean; noAux?: boolean; badQuote?: boolean; modelFailure?: boolean; mode?: string; attempt?: number; specs?: Record<string, string | number | boolean>; quoteIds?: boolean;
  citationFault?: "metadata" | "duplicate" | "missing" | "persistent" | "changed-payload" | "repair-quote" | "repair-source" | "repair-model-failure";
  imageExtras?: boolean;
  imageMetadata?: "complete" | "no-source" | "no-angle" | "minimal";
  syntheticTokenCharge?: number;
} = {}): Promise<PreparedMarketingFacts> {
  let searches = 0, a1Calls = 0;
  return prepareMarketingFacts({ scope: { ...scope, attempt: options.attempt ?? 1 }, root, intent: "做一条风扇介绍", metadata: { brief: { product: "星野 F3", brand: "星野" } }, env: { ...env, ...(options.mode ? { VM_DATA_MINING_MODE: options.mode } : {}) },
    llm: { reason: async (prompt, llmOptions) => {
      extractionOptions.push(llmOptions);
      extractionCalls.push(prompt); if (options.modelFailure) return { success: false, error: "LLM unavailable" };
      const match = /当前阶段：(A[123])\n(.*)$/s.exec(prompt)!; const source = JSON.parse(match[2]!).sources[0];
      if (match[1] !== "A1") return { success: true, data: { payload: match[1] === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "页面仅商品规格，无可核实评价或竞品" } };
      a1Calls++;
      if (a1Calls === 2 && options.citationFault === "repair-model-failure") return { success: false, error: "LLM unavailable" };
      const specs = options.specs ?? { 风量: "9 档" };
      const data: { payload: any; citations: any[] } = { payload: { identity: { name: "星野 F3", specs, ...(options.citationFault ? { prices: [{ amount: 399, currency: "CNY", source_url: sourceUrl }] } : {}), official_selling_points: [{ point: "风量 9 档", source_url: sourceUrl }] }, images: [] },
        citations: ["/identity/name", ...Object.keys(specs).map(key => `/identity/specs/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`), ...(options.citationFault ? ["/identity/prices/0/amount", "/identity/prices/0/currency"] : []), "/identity/official_selling_points/0/point"]
          .map(pointer => ({ pointer, sourceId: source.sourceId, ...(options.quoteIds ? { quoteId: source.textFragments[0].quoteId } : { quote: options.badQuote ? "不存在的事实" : sourceText }) })) };
      if (options.imageExtras) data.payload.images.push({ url: sourceUrl + "/hero.png", page_url: sourceUrl, angle: "unknown", width: 1080, height: 1920 });
      if (options.imageMetadata) data.payload.images.push({ url: sourceUrl + "/hero.png", page_url: sourceUrl,
        ...(["complete", "no-angle"].includes(options.imageMetadata) ? { source: "模型自称官方" } : {}),
        ...(["complete", "no-source"].includes(options.imageMetadata) ? { angle: "unknown" } : {}),
      });
      if (options.citationFault && (a1Calls === 1 || options.citationFault === "persistent")) {
        if (options.citationFault === "duplicate") data.citations.push({ ...data.citations[0]! });
        else if (options.citationFault === "missing") data.citations.pop();
        else data.citations.push({ pointer: "/identity/prices/0/source_url", sourceId: source.sourceId, quote: sourceText });
      }
      if (a1Calls === 2 && options.citationFault === "changed-payload") data.payload.identity.name = "换成另一商品";
      if (a1Calls === 2 && options.citationFault === "repair-quote") data.citations[0]!.quote = "不存在的事实";
      if (a1Calls === 2 && options.citationFault === "repair-source") data.citations[0]!.sourceId = "SRC-invented";
      if (options.syntheticTokenCharge !== undefined) {
        const response = simulatedProviderCompletion(data, llmOptions?.maxTokens ?? 0, options.syntheticTokenCharge);
        simulatedProviderCalls.push(response); return response;
      }
      return { success: true, data };
    } }, dependencies: {
      search: async () => (++searches, options.noSearch || options.noAux && searches > 20 ? [] : [{ title: "星野规格", url: sourceUrl, snippet: "故意错误摘要999档，不能当事实" }]),
      fetchSource: async url => fetchMarketingSource(url, { resolver: async () => [{ address: "93.184.216.34", family: 4 }], transport: async (_url, _address, signal) => requestSource(new URL(options.imageMetadata || options.imageExtras ? "/with-image" : "/", origin), { address: "127.0.0.1", family: 4 }, signal) }),
    } });
}
const shots = [{ shotId: "S1", prompt: "窗边展示星野 F3 风扇，字幕说明风量 9 档。", fields: { 场景: "窗边", 产品: "星野 F3", 规格: "9 档" } }];
describe("营销事实宿主完整执行", () => {
  it("真实HTTP正文→三站提取/完整支持审核→A1–A5→逐最终镜头事实审核→复读", async () => {
    const prepared = await prepare();
    expect(prepared.bundle.stages.map(stage => [stage.stage, stage.facts.status])).toEqual([["A1", "source_bound"], ["A2", "no_evidence"], ["A3", "no_evidence"]]);
    expect(prepared.bundle.sources).toHaveLength(1); expect(prepared.bundle.restrictions).toHaveLength(2); expect(extractionCalls).toHaveLength(3);
    expect(extractionOptions).toEqual(Array.from({ length: 3 }, () => ({ forceJson: true, temperature: 0, maxTokens: 16384, thinking: { type: "disabled" } })));
    expect(prepared.bundle.dossier.identity).toMatchObject({ specs: { 风量: "9 档" } });
    expect(prepared.bundle.dossier.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ claim_ref: "identity.specs.风量", source_url: sourceUrl, agent: "ProductInfoCollector" })]));
    const g1 = JSON.parse(prepared.g1Content) as { facts: Record<string, unknown> };
    expect(g1.facts).not.toHaveProperty("g1ContentSha256");
    expect(prepared.bundle.g1ContentSha256).toBe(renderSha256(prepared.g1Content));
    expect((prepared.bundle.dossier.gaps as string[]).some(gap => gap.includes('规格 "风量" 无来源'))).toBe(false);
    expect((prepared.bundle.dossier.gaps as string[]).some(gap => gap.includes("价格"))).toBe(true);
    expect(prepared.bundle.rawByAgent.A1.identity).toMatchObject({ specs: { 风量: "9 档" } });
    expect(prepared.bundle.rawSha256).toBe(renderSha256(canonicalRenderJson(prepared.raw)));
    expect(prepared.g1Content).toContain('"schemaVersion":"workloom.marketing-facts/v1"'); expect(modelCalls).toHaveLength(3);
    expect(JSON.stringify(modelCalls)).toContain("不得声称静音或市场第一"); expect(JSON.stringify(modelCalls)).not.toContain("999档");
    const saved = await finalizeMarketingFacts(prepared, shots, env); expect(modelCalls).toHaveLength(4);
    expect(modelCalls.every(call => call.response_format.type === "json_object"
      && call.thinking?.type === "enabled" && call.reasoning_effort === "high"
      && !("temperature" in call))).toBe(true);
    const checked = await verifyMarketingFacts({ root, ...saved, scope, shots }); expect(checked.outputReviews[0]?.promptSha256).toBe(renderSha256(shots[0]!.prompt));
    expect(await readFile(path.join(root, checked.sources[0]!.textRef), "utf8")).toBe(sourceText);
  });
  it("模拟provider需12000 token预算：旧8192截断，16384保留完整事实并完成装订与复读", async () => {
    const specs = { "接口/~": "USB/C~口", 待机功率: 0, 自动启停: false };
    const prepared = await prepare({ quoteIds: true, specs, syntheticTokenCharge: 12000 });
    const a1 = prepared.bundle.stages[0]!, response = simulatedProviderCalls[0]!;
    const complete = JSON.parse(response.content), oldCap = simulatedProviderCompletion(complete, 8192, 12000);
    expect(oldCap.simulation).toEqual({ syntheticTokenCharge: 12000, maxTokens: 8192, finishReason: "length" });
    expect(() => JSON.parse(oldCap.content)).toThrow();
    expect(simulatedProviderCalls).toHaveLength(1);
    expect(response.simulation).toEqual({ syntheticTokenCharge: 12000, maxTokens: 16384, finishReason: "stop" });
    const reference = a1.extractions![0]!, bytes = await readFile(path.join(root, reference.ref), "utf8"), artifact = JSON.parse(bytes);
    expect(renderSha256(bytes)).toBe(reference.sha256);
    expect(artifact).toMatchObject({ status: "accepted", response: { success: true, content: response.content, data: null } });
    expect(prepared.raw.A1).toMatchObject(complete.payload); expect(prepared.raw.A1.identity).toMatchObject({ specs });
    expect(a1.facts.claims.map(claim => claim.pointer).sort()).toEqual(complete.citations.map((citation: any) => citation.pointer).sort());
    expect(a1.facts.claims.every(claim => claim.quote === sourceText && claim.quoteEnd === sourceText.length)).toBe(true);
    expect(a1.facts.claims).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: "/identity/specs/自动启停", value: false })]));
    expect(prepared.bundle.dossier.identity).toMatchObject({ specs });
    expect(prepared.bundle.rawSha256).toBe(renderSha256(canonicalRenderJson(prepared.raw)));
    expect(await readFile(path.join(root, prepared.bundle.sources[0]!.textRef), "utf8")).toBe(sourceText);
    expect(JSON.stringify(modelCalls)).toContain(sourceText); expect(extractionCalls).toHaveLength(3);
    const saved = await finalizeMarketingFacts(prepared, shots, env), checked = await verifyMarketingFacts({ root, ...saved, scope, shots });
    expect(checked.rawByAgent).toEqual(prepared.raw); expect(checked.stages[0]!.facts.claims).toEqual(a1.facts.claims);
    expect(checked.outputReviews).toHaveLength(1); expect(modelCalls).toHaveLength(4);
  });
  it("模拟provider仍超过16384而返回截断JSON：只提取一次、保留原响应且不进入支持审核", async () => {
    await expect(prepare({ quoteIds: true, syntheticTokenCharge: 20000 })).rejects.toThrow("MARKETING_EXTRACTION_UNVERIFIED");
    expect(extractionOptions).toEqual([{ forceJson: true, temperature: 0, maxTokens: 16384, thinking: { type: "disabled" } }]);
    expect(extractionCalls).toHaveLength(1); expect(modelCalls).toHaveLength(0); expect(simulatedProviderCalls).toHaveLength(1);
    const response = simulatedProviderCalls[0]!;
    expect(response.simulation).toEqual({ syntheticTokenCharge: 20000, maxTokens: 16384, finishReason: "length" });
    expect(() => JSON.parse(response.content)).toThrow();
    const prefix = "stages/preproduction/attempt-1.marketing", artifact = JSON.parse(await readFile(path.join(root, `${prefix}-A1.extraction-1.json`), "utf8"));
    expect(artifact).toMatchObject({ status: "rejected", response: { success: true, content: response.content, data: null } });
    expect(artifact.error).toContain("MARKETING_EXTRACTION_UNVERIFIED");
    await expect(readFile(path.join(root, `${prefix}-A1.extraction-2.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, `${prefix}-facts.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([false, true])("选择原文ID→宿主装订→独立支持审核→完整事实复读，结构纠错=%s", async repair => {
    const prepared = await prepare({ quoteIds: true, ...(repair ? { citationFault: "missing" as const } : {}) });
    const a1 = prepared.bundle.stages[0]!, attempts = await Promise.all(a1.extractions!.map(async item => JSON.parse(await readFile(path.join(root, item.ref), "utf8"))));
    const artifact = attempts.at(-1)!;
    expect(artifact.schemaVersion).toBe("workloom.marketing-extraction/v3");
    const request = JSON.parse(artifact.prompt.slice(artifact.prompt.lastIndexOf("当前阶段：A1\n") + "当前阶段：A1\n".length));
    expect(request.payloadJsonSchema.properties.images.items).toMatchObject({ additionalProperties: false, required: ["url", "page_url"] });
    expect(Object.keys(request.payloadJsonSchema.properties.images.items.properties).sort()).toEqual(["angle", "page_url", "source", "url"]);
    expect(artifact.response.data.citations.every((citation: any) => citation.quoteId && !("quote" in citation))).toBe(true);
    expect(artifact.citationBindings).toHaveLength(artifact.response.data.citations.length);
    expect(artifact.citationBindings[0]).toMatchObject({ start: 0, end: sourceText.length, textSha256: renderSha256(sourceText), quoteSha256: renderSha256(sourceText) });
    expect(a1.facts.claims.every(claim => claim.quote === sourceText)).toBe(true);
    expect(modelCalls).toHaveLength(3); expect(JSON.stringify(modelCalls)).toContain(sourceText);
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    await expect(verifyMarketingFacts({ root, ...saved, scope, shots })).resolves.toMatchObject({ scope });
    if (repair) expect(attempts.map(item => item.status)).toEqual(["rejected", "accepted"]);
  });
  it.each(["binding-offset", "binding-quote-id", "response-quote-id", "prompt-policy", "prompt-fragment", "version", "schema", "schema-missing", "schema-stage", "version-downgrade"])("重算摘要也拒绝ID桥%s篡改", async kind => {
    const prepared = await prepare({ quoteIds: true }), saved = await finalizeMarketingFacts(prepared, shots, env);
    const reference = prepared.bundle.stages[0]!.extractions![0]!, artifact = JSON.parse(await readFile(path.join(root, reference.ref), "utf8"));
    if (kind === "binding-offset") artifact.citationBindings[0].start++;
    if (kind === "binding-quote-id") artifact.citationBindings[0].quoteId = "Q1-000000000000";
    if (kind === "response-quote-id") artifact.response.data.citations[0].quoteId = "Q1-000000000000";
    if (kind === "prompt-policy") artifact.prompt = artifact.prompt.replace("不能改写或拼接", "允许自由发挥");
    if (kind === "prompt-fragment") artifact.prompt = artifact.prompt.replace(sourceText, "删除正文");
    if (kind === "version") delete artifact.schemaVersion;
    if (kind === "version-downgrade") artifact.schemaVersion = "workloom.marketing-extraction/v2";
    if (kind.startsWith("schema")) {
      const marker = "当前阶段：A1\n", offset = artifact.prompt.lastIndexOf(marker) + marker.length;
      const request = JSON.parse(artifact.prompt.slice(offset));
      if (kind === "schema") request.payloadJsonSchema.properties.images.items.additionalProperties = true;
      if (kind === "schema-missing") delete request.payloadJsonSchema;
      if (kind === "schema-stage") request.payloadJsonSchema = { type: "object", properties: { reviews: { type: "array" } } };
      artifact.prompt = artifact.prompt.slice(0, offset) + canonicalRenderJson(request);
    }
    const bytes = canonicalRenderJson(artifact); await writeFile(path.join(root, reference.ref), bytes); reference.sha256 = renderSha256(bytes);
    const bundle = canonicalRenderJson(prepared.bundle); await writeFile(path.join(root, saved.ref), bundle);
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: renderSha256(bundle), scope, shots })).rejects.toThrow(/MARKETING_/);
  });
  it.each(["v1", "v2"])("已发布的旧%s档案保留原合同和完整来源时仍可严格复读", async version => {
    const prepared = await prepare(), saved = await finalizeMarketingFacts(prepared, shots, env);
    // 冻结的v1三行头与原始全文sources；公共规则保持原字节，模拟升级前已接受的档案。
    const legacyHead = [
      '输出严格JSON {"payload":本阶段结构,"citations":[{"pointer":"/identity/name","sourceId":"SRC-…","quote":"正文连续原文"}],"noEvidenceReason":"仅无可用证据时填写"}。',
      "每个非空事实叶子（商品名/品牌/类别/型号/specs全部值/价格金额币种/卖点/评价原话评分/竞品名和属性）都必须有且只有一条citations。",
      "pointer按JSON Pointer指向payload叶子；quote必须是提供正文的连续原文，不能改写或拼接。数组下标从0开始，规格键中~用~0、/用~1。",
    ];
    for (const stage of prepared.bundle.stages) for (const reference of stage.extractions ?? []) {
      const artifact = JSON.parse(await readFile(path.join(root, reference.ref), "utf8")), marker = `当前阶段：${stage.stage}\n`;
      const split = artifact.prompt.lastIndexOf(marker), request = JSON.parse(artifact.prompt.slice(split + marker.length));
      if (version === "v1") request.sources = request.sources.map(({ textFragments, ...source }: any) => ({ ...source, text: textFragments.map((fragment: any) => fragment.text).join("") }));
      delete request.payloadJsonSchema;
      const header = artifact.prompt.slice(0, split + marker.length).split("\n");
      const oldHeader = header.filter((line: string) => !line.startsWith("当前阶段的payloadJsonSchema来自宿主实际严格验证器；"));
      artifact.prompt = (version === "v1" ? [...legacyHead, ...oldHeader.slice(4)] : oldHeader).join("\n") + canonicalRenderJson(request);
      if (version === "v1") { delete artifact.schemaVersion; delete artifact.citationBindings; }
      else artifact.schemaVersion = "workloom.marketing-extraction/v2";
      const bytes = canonicalRenderJson(artifact); await writeFile(path.join(root, reference.ref), bytes); reference.sha256 = renderSha256(bytes);
    }
    const bundle = canonicalRenderJson(prepared.bundle); await writeFile(path.join(root, saved.ref), bundle);
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: renderSha256(bundle), scope, shots })).resolves.toMatchObject({ scope });
  });
  it("模型仍添加图片宽高时严格拒绝且不修剪原始输出、不重试", async () => {
    await expect(prepare({ imageExtras: true })).rejects.toThrow("MARKETING_PAYLOAD_INVALID");
    expect(extractionCalls).toHaveLength(1); expect(modelCalls).toHaveLength(0);
    const artifact = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-1.json"), "utf8"));
    expect(artifact.status).toBe("rejected"); expect(artifact.response.data.payload.images[0]).toMatchObject({ width: 1080, height: 1920 });
    await expect(readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-2.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["spec", "no-search", "bad-quote", "model-failure", "support-rejected"])("%s不能得到可送G1的事实包", async kind => {
    rejectJudge = kind === "support-rejected";
    await expect(prepare({ mode: kind === "spec" ? "spec" : undefined, noSearch: kind === "no-search", badQuote: kind === "bad-quote", modelFailure: kind === "model-failure" })).rejects.toThrow();
    if (["spec", "no-search", "bad-quote", "model-failure"].includes(kind)) expect(modelCalls).toHaveLength(0);
  });
  it.each(["metadata", "duplicate", "missing"] as const)("%s引用结构只同源纠正一次，原始输出保留且仍完成支持评审", async citationFault => {
    const prepared = await prepare({ citationFault }), a1 = prepared.bundle.stages[0]!;
    expect(extractionCalls).toHaveLength(4); expect(modelCalls).toHaveLength(3); expect(a1.extractions).toHaveLength(2);
    expect(extractionOptions).toEqual(Array.from({ length: 4 }, () => ({ forceJson: true, temperature: 0, maxTokens: 16384, thinking: { type: "disabled" } })));
    const attempts = await Promise.all(a1.extractions!.map(async item => {
      const bytes = await readFile(path.join(root, item.ref), "utf8"); expect(renderSha256(bytes)).toBe(item.sha256); return JSON.parse(bytes);
    }));
    expect(attempts.map(item => item.status)).toEqual(["rejected", "accepted"]);
    expect(attempts[0].error).toMatch(/MARKETING_(CITATION_INVALID|CLAIM_UNSOURCED)/);
    expect(attempts[1].prompt).toContain('"requiredCitationPointers":'); expect(attempts[1].prompt).toContain('"/identity/prices/0/amount"');
    expect(attempts[1].response.data.payload).toEqual(attempts[0].response.data.payload);
    const marker = "当前阶段：A1\n";
    expect(JSON.parse(attempts[1].prompt.slice(attempts[1].prompt.lastIndexOf(marker) + marker.length)).sources)
      .toEqual(JSON.parse(attempts[0].prompt.slice(attempts[0].prompt.lastIndexOf(marker) + marker.length)).sources);
    expect(attempts[1].prompt).toContain(sourceText);
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    await expect(verifyMarketingFacts({ root, ...saved, scope, shots })).resolves.toMatchObject({ scope });
  });
  it.each(["persistent", "changed-payload", "repair-quote", "repair-source", "repair-model-failure"] as const)("%s纠错仍失败时封顶两次，不能通过支持评审", async citationFault => {
    await expect(prepare({ citationFault })).rejects.toThrow(/MARKETING_(CITATION_INVALID|EXTRACTION_PAYLOAD_CHANGED|EXTRACTION_UNVERIFIED)/);
    expect(extractionCalls).toHaveLength(2); expect(modelCalls).toHaveLength(0);
    const first = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-1.json"), "utf8"));
    const second = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-2.json"), "utf8"));
    expect(first.status).toBe("rejected"); expect(second.status).toBe("rejected");
    await expect(readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-3.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("错误引文不属于结构纠错，直接拒绝且保留原始模型输出", async () => {
    await expect(prepare({ badQuote: true })).rejects.toThrow("MARKETING_CITATION_INVALID");
    expect(extractionCalls).toHaveLength(1);
    const artifact = JSON.parse(await readFile(path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-1.json"), "utf8"));
    expect(artifact.response.data.citations[0].quote).toBe("不存在的事实"); expect(artifact.status).toBe("rejected");
  });
  it("拒绝尝试写盘失败不能继续调用模型纠错", async () => {
    const file = path.join(root, "stages/preproduction/attempt-1.marketing-A1.extraction-1.json");
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "existing-evidence", { flag: "wx" });
    await expect(prepare({ citationFault: "metadata" })).rejects.toMatchObject({ code: "EEXIST" });
    expect(extractionCalls).toHaveLength(1); expect(modelCalls).toHaveLength(0); expect(await readFile(file, "utf8")).toBe("existing-evidence");
  });
  it.each(["response", "scope", "status", "source", "payload"])("重算摘要也不能把%s篡改成已接受提取证据", async kind => {
    const prepared = await prepare({ citationFault: "metadata" }), saved = await finalizeMarketingFacts(prepared, shots, env);
    const record = prepared.bundle.stages[0]!.extractions![1]!, artifact = JSON.parse(await readFile(path.join(root, record.ref), "utf8"));
    if (kind === "response") artifact.response.data.citations[0].quote = "不存在的事实";
    if (kind === "scope") artifact.scope.projectId = "another-project";
    if (kind === "status") artifact.status = "rejected";
    if (kind === "source") artifact.prompt = artifact.prompt.replaceAll(sourceText, "裁掉正文");
    if (kind === "payload") artifact.response.data.payload.identity.name = "another-product";
    const bytes = canonicalRenderJson(artifact); await writeFile(path.join(root, record.ref), bytes); record.sha256 = renderSha256(bytes);
    const bundle = canonicalRenderJson(prepared.bundle); await writeFile(path.join(root, saved.ref), bundle);
    await expect(verifyMarketingFacts({ root, ref: saved.ref, sha256: renderSha256(bundle), scope, shots })).rejects.toThrow(/MARKETING_/);
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
  it.each(["complete", "no-source", "no-angle", "minimal"] as const)("真实页面图片%s元数据→实际A1–A5装订→最终事实复读，原始事实不变", async imageMetadata => {
    const prepared = await prepare({ imageMetadata, quoteIds: true }), before = canonicalRenderJson(prepared.raw);
    const converted = toJennyMarketingRaw(prepared.raw, prepared.bundle);
    expect(converted.A1.images).toEqual([{ url: sourceUrl + "/hero.png", page_url: sourceUrl, source: "source.example.com", angle: "unknown" }]);
    expect(prepared.bundle.dossier.visual_assets).toMatchObject({ images: [expect.objectContaining({ url: sourceUrl + "/hero.png", source: "source.example.com", angle: "unknown" })] });
    expect(canonicalRenderJson(prepared.raw)).toBe(before); expect(canonicalRenderJson(prepared.bundle.rawByAgent)).toBe(before);
    expect(prepared.bundle.rawSha256).toBe(renderSha256(before));
    const saved = await finalizeMarketingFacts(prepared, shots, env);
    await expect(verifyMarketingFacts({ root, ...saved, scope, shots })).resolves.toMatchObject({ scope });
  });
  it.each(["url", "page-url", "stage-source", "source-hash"])("Jenny图片装订拒绝%s不匹配，即使原始回填摘要被重算", async kind => {
    const prepared = await prepare({ imageMetadata: "minimal" }), raw = structuredClone(prepared.raw), evidence = structuredClone(prepared.bundle);
    if (kind === "url") (raw.A1.images as any[])[0].url = "https://other.example.com/invented.png";
    if (kind === "page-url") (raw.A1.images as any[])[0].page_url = "https://other.example.com/unfetched";
    evidence.rawSha256 = renderSha256(canonicalRenderJson(raw)); evidence.stages[0]!.facts.payload = raw.A1;
    if (kind === "stage-source") evidence.stages[0]!.sourceIds = [];
    if (kind === "source-hash") evidence.sources[0]!.textSha256 = "0".repeat(64);
    // Remove specs in this adapter-only negative probe so image binding is the deciding guard.
    (raw.A1.identity as any).specs = {}; (evidence.stages[0]!.facts.payload.identity as any).specs = {};
    evidence.rawSha256 = renderSha256(canonicalRenderJson(raw));
    expect(() => toJennyMarketingRaw(raw, evidence)).toThrow("MARKETING_IMAGE_UNVERIFIED");
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
