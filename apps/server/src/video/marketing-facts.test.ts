import { describe, expect, it } from "vitest";
import {
  filterUnsafeMarketingExtraction,
  stageFactPointers,
  stagePayloadJsonSchema,
  validateStageFacts,
  revalidateStageFacts,
} from "./marketing-facts.js";
import { renderSha256 } from "./gen/compiled-request.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
const body = "星野 F3 风量 9 档。价格 399 CNY。评价：低档安静。评分 4。另一款北斗支持 5 档。";
const source: SourceSnapshot = { sourceId: "SRC-1", requestedUrl: "https://source.example.com/f3", finalUrl: "https://source.example.com/f3", redirectChain: [], fetchedAt: new Date().toISOString(), contentType: "text/plain", rawSha256: renderSha256(body), textSha256: renderSha256(body), bytes: Buffer.byteLength(body), text: body, assetUrls: ["https://source.example.com/hero.png"] };
const citation = (pointer: string, quote = body) => ({ pointer, sourceId: source.sourceId, quote });
function fixture() { return { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" }, official_selling_points: [{ point: "风量 9 档", source_url: source.finalUrl, channel: "假称官方" }] }, images: [] }, citations: [citation("/identity/name"), citation("/identity/specs/风量"), citation("/identity/official_selling_points/0/point")] }; }
describe("逐事实叶子的正文绑定", () => {
  it("正常回填逐项有原文位置，渠道由实际URL产生并可复核", () => {
    const facts = validateStageFacts("A1", fixture(), [source]); expect(facts.status).toBe("source_bound"); expect(facts.claims).toHaveLength(3);
    expect(facts.claims[0]).toMatchObject({ quoteStart: 0, quoteEnd: body.length, textSha256: source.textSha256, status: "source-bound" });
    expect(JSON.stringify(facts.payload)).toContain("source.example.com"); expect(JSON.stringify(facts.payload)).not.toContain("假称官方");
    expect(() => revalidateStageFacts(facts, [source])).not.toThrow();
  });
  it("精确位置仅接受原位连续原文；重复文本旧quote仍取首次，显式位置可选择后一次", () => {
    const repeated = { ...source, text: body + "\n" + body, textSha256: renderSha256(body + "\n" + body) };
    const legacy = validateStageFacts("A1", fixture(), [repeated]);
    expect(legacy.claims.every(claim => claim.quoteStart === 0)).toBe(true);
    const positioned = fixture(); positioned.citations.forEach(citation => Object.assign(citation, { quoteStart: body.length + 1 }));
    const facts = validateStageFacts("A1", positioned, [repeated]);
    expect(facts.claims.every(claim => claim.quoteStart === body.length + 1 && claim.quoteEnd === repeated.text.length)).toBe(true);
    expect(() => revalidateStageFacts(facts, [repeated])).not.toThrow();
    for (const offset of [-1, 0.5, 1, repeated.text.length, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = fixture(); Object.assign(invalid.citations[0]!, { quoteStart: offset });
      expect(() => validateStageFacts("A1", invalid, [repeated])).toThrow();
    }
  });
  it.each(["missing", "duplicate", "wrong-pointer", "wrong-source", "invented-quote", "text-hash", "mixed-fake-url", "inferred"])("%s不能升格事实", kind => {
    const value = fixture(), sources = structuredClone([source]);
    if (kind === "missing") value.citations.pop();
    if (kind === "duplicate") value.citations.push(value.citations[0]!);
    if (kind === "wrong-pointer") value.citations[0]!.pointer = "/identity/unknown";
    if (kind === "wrong-source") value.citations[0]!.sourceId = "SRC-fake";
    if (kind === "invented-quote") value.citations[0]!.quote = "不存在的优势";
    if (kind === "text-hash") sources[0]!.text += "changed";
    if (kind === "mixed-fake-url") value.payload.identity.official_selling_points[0]!.source_url = "https://fake.example.com/";
    if (kind === "inferred") Object.assign(value.payload, { inferred_notes: ["推断"] });
    expect(() => validateStageFacts("A1", value, sources)).toThrow();
  });
  it("规格键叫source/url仍是事实，必须引证；JSON Pointer转义不丢键", () => {
    const value: any = fixture(); value.payload.identity.specs = { source: "产地", "a/b~c": "9 档" };
    expect(() => validateStageFacts("A1", value, [source])).toThrow();
    value.citations = [citation("/identity/name"), citation("/identity/specs/source"), citation("/identity/specs/a~1b~0c"), citation("/identity/official_selling_points/0/point")];
    expect(validateStageFacts("A1", value, [source]).claims).toHaveLength(4);
    expect(stageFactPointers("A1", value.payload)).toEqual(["/identity/name", "/identity/specs/source", "/identity/specs/a~1b~0c", "/identity/official_selling_points/0/point"]);
  });
  it("引用路径清单与验证器同源，价格来源URL和所有图片元数据均不属于事实", () => {
    const payload = { identity: { name: "星野 F3", specs: { url: "USB", 待机功率: 0, 自动启停: false }, prices: [{ amount: 399, currency: "CNY", note: "页面价格", source_url: source.finalUrl }],
      official_selling_points: [{ point: "9档", source_url: source.finalUrl, channel: "媒体" }] }, images: [{ url: source.assetUrls[0], page_url: source.finalUrl, source: "页面", angle: "品牌 Logo" }] };
    expect(stageFactPointers("A1", payload)).toEqual(["/identity/name", "/identity/specs/url", "/identity/specs/待机功率", "/identity/specs/自动启停",
      "/identity/prices/0/amount", "/identity/prices/0/currency", "/identity/prices/0/note", "/identity/official_selling_points/0/point"]);
    expect(() => stageFactPointers("A1", { identity: { name: "" } })).toThrow("MARKETING_PAYLOAD_INVALID");
  });
  it("空A2/A3必须有明确缺证据原因，A1不能空", () => {
    for (const stage of ["A2", "A3"] as const) {
      const payload = stage === "A2" ? { reviews: [] } : { competitors: [] };
      expect(() => validateStageFacts(stage, { payload, citations: [] }, [])).toThrow("MARKETING_EVIDENCE_EMPTY");
      expect(validateStageFacts(stage, { payload, citations: [], noEvidenceReason: "未采到可验证正文" }, []).status).toBe("no_evidence");
    }
    expect(() => validateStageFacts("A1", { payload: { identity: { name: "商品" } }, citations: [], noEvidenceReason: "无" }, [])).toThrow();
    expect(validateStageFacts("A1", { ...fixture(), noEvidenceReason: "" }, [source]).status).toBe("source_bound");
    expect(() => validateStageFacts("A2", { payload: { reviews: [] }, citations: [], noEvidenceReason: "" }, []))
      .toThrow("MARKETING_EVIDENCE_EMPTY");
    const noCompetitor = validateStageFacts("A3", {
      payload: { competitors: [] },
      citations: [],
      noEvidenceReason: "来源页只有 91.8k stars、39.1k forks，但没有竞品",
    }, []);
    expect(noCompetitor.noEvidenceReason).toBe("本次已抓取来源中没有可核实的竞品事实");
  });
  it("评价必须原话，评分单独引证；合法URL不能证明改写评价", () => {
    const value = { payload: { reviews: [{ text: "低档安静", rating: 4, url: source.finalUrl }] }, citations: [citation("/reviews/0/text"), citation("/reviews/0/rating")] };
    expect(validateStageFacts("A2", value, [source]).claims).toHaveLength(2);
    value.payload.reviews[0]!.text = "所有档位绝对无声"; expect(() => validateStageFacts("A2", value, [source])).toThrow("MARKETING_REVIEW_PARAPHRASED");
  });
  it("图片只能来自实际页面候选，不能借合法page_url夹带假图", () => {
    const value: any = fixture(); value.payload.images = [{ url: source.assetUrls[0], page_url: source.finalUrl, angle: "unknown" }];
    expect(validateStageFacts("A1", value, [source]).claims).toHaveLength(3);
    value.payload.images[0].url = "https://other.example.com/fake.png"; expect(() => validateStageFacts("A1", value, [source])).toThrow("MARKETING_URL_UNVERIFIED");
  });
  it("绝对化官方促销语保留在原始响应但排除出可交付事实并重排引用", () => {
    const filtered = filterUnsafeMarketingExtraction("A1", {
      payload: {
        identity: {
          name: "星野 F3",
          official_selling_points: [
            { point: "风量 9 档", source_url: source.finalUrl },
            { point: "Perfect to run anywhere", source_url: source.finalUrl },
            { point: "模块化设计", source_url: source.finalUrl },
          ],
        },
        images: [],
      },
      citations: [
        { pointer: "/identity/name", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/official_selling_points/0/point", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/official_selling_points/1/point", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/official_selling_points/2/point", sourceId: source.sourceId, quote: body },
      ],
    });
    const value = filtered.value as any;
    expect(value.payload.identity.official_selling_points.map((item: any) => item.point)).toEqual(["风量 9 档", "模块化设计"]);
    expect(value.citations.map((item: any) => item.pointer)).toEqual([
      "/identity/name",
      "/identity/official_selling_points/0/point",
      "/identity/official_selling_points/1/point",
    ]);
    expect(filtered.exclusions).toEqual([{
      pointer: "/identity/official_selling_points/1/point",
      value: "Perfect to run anywhere",
      reason: "absolute-marketing-claim",
    }]);
  });
  it("绝对化推荐被拆成推断规格时一并移除，不把推荐语升级成兼容性事实", () => {
    const filtered = filterUnsafeMarketingExtraction("A1", {
      payload: {
        identity: {
          name: "Home Assistant",
          specs: {
            License: "Apache-2.0",
            "Supported hardware": "Raspberry Pi or a local server",
          },
          official_selling_points: [
            { point: "Perfect to run on a Raspberry Pi or a local server.", source_url: source.finalUrl },
          ],
        },
        images: [],
      },
      citations: [
        { pointer: "/identity/name", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/specs/License", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/specs/Supported hardware", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/official_selling_points/0/point", sourceId: source.sourceId, quote: body },
      ],
    });
    const value = filtered.value as any;
    expect(value.payload.identity.specs).toEqual({ License: "Apache-2.0" });
    expect(value.payload.identity.official_selling_points).toEqual([]);
    expect(value.citations.map((item: any) => item.pointer)).toEqual([
      "/identity/name",
      "/identity/specs/License",
    ]);
    expect(filtered.exclusions.map((item) => item.pointer)).toEqual([
      "/identity/official_selling_points/0/point",
      "/identity/specs/Supported hardware",
    ]);
  });
  it("绝对化促销语直接写入规格时也移除，不要求同时出现在卖点数组", () => {
    const filtered = filterUnsafeMarketingExtraction("A1", {
      payload: {
        identity: {
          name: "Home Assistant",
          specs: {
            License: "Apache-2.0",
            Deployment: "Perfect to run on a Raspberry Pi or a local server.",
          },
          official_selling_points: [{ point: "Open source home automation", source_url: source.finalUrl }],
        },
        images: [],
      },
      citations: [
        { pointer: "/identity/specs/License", sourceId: source.sourceId, quote: body },
        { pointer: "/identity/specs/Deployment", sourceId: source.sourceId, quote: body },
      ],
    });
    const value = filtered.value as any;
    expect(value.payload.identity.specs).toEqual({ License: "Apache-2.0" });
    expect(value.citations.map((item: any) => item.pointer)).toEqual(["/identity/specs/License"]);
    expect(filtered.exclusions).toEqual([{
      pointer: "/identity/specs/Deployment",
      value: "Perfect to run on a Raspberry Pi or a local server.",
      reason: "absolute-marketing-claim",
    }]);
  });
  it.each(["A1", "A2", "A3"] as const)("%s提取输入合同由实际严格schema产生并保留边界", stage => {
    const schema: any = stagePayloadJsonSchema(stage);
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    if (stage === "A1") {
      expect(schema.properties.identity).toMatchObject({ additionalProperties: false, required: ["name"] });
      expect(schema.properties.identity.properties.specs.additionalProperties.anyOf.map((entry: any) => entry.type)).toEqual(["string", "number", "boolean"]);
      expect(schema.properties.images).toMatchObject({ maxItems: 20, items: { additionalProperties: false, required: ["url", "page_url"] } });
      expect(Object.keys(schema.properties.images.items.properties).sort()).toEqual(["angle", "page_url", "source", "url"]);
      const value: any = fixture(); value.payload.images = [{ url: source.assetUrls[0], page_url: source.finalUrl, width: 1080, height: 1920 }];
      expect(() => validateStageFacts("A1", value, [source])).toThrow("MARKETING_PAYLOAD_INVALID");
    } else if (stage === "A2") expect(schema.properties.reviews).toMatchObject({ maxItems: 30, items: { additionalProperties: false } });
    else expect(schema.properties.competitors).toMatchObject({ maxItems: 3, items: { additionalProperties: false } });
  });
  it.each(["value", "offset", "hash", "status"])("已保存%s变化复读必须拒绝", kind => {
    const facts: any = validateStageFacts("A1", fixture(), [source]);
    if (kind === "value") facts.claims[0].value = "changed";
    if (kind === "offset") facts.claims[0].quoteStart = 1;
    if (kind === "hash") facts.claims[0].textSha256 = "0".repeat(64);
    if (kind === "status") facts.status = "supported";
    expect(() => revalidateStageFacts(facts, [source])).toThrow("MARKETING_FACTS_CHANGED");
  });
});
