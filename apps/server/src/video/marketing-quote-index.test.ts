import { describe, expect, it } from "vitest";
import { quoteIndexedSources, resolveMarketingExtraction, sourceQuoteFragments } from "./marketing-quote-index.js";
import { revalidateStageFacts, validateStageFacts } from "./marketing-facts.js";
import { renderSha256 } from "./gen/compiled-request.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";

const text = "星野 F3 风扇。悬挂部分，新车采用测试组件。风量为9档。\n价格399元。";
function source(body = text, sourceId = "SRC-current"): SourceSnapshot {
  return { sourceId, requestedUrl: "https://source.example.com/", finalUrl: "https://source.example.com/", redirectChain: [], fetchedAt: "2026-10-24T00:00:00.000Z", contentType: "text/plain", rawSha256: renderSha256(body), textSha256: renderSha256(body), bytes: Buffer.byteLength(body), text: body, assetUrls: [] };
}
function extraction(snapshot: SourceSnapshot) {
  const quoteId = sourceQuoteFragments(snapshot)[0]!.quoteId;
  return { payload: { identity: { name: "星野 F3", specs: { 风量: "9档" } }, images: [] }, citations: ["/identity/name", "/identity/specs/风量"].map(pointer => ({ pointer, sourceId: snapshot.sourceId, quoteId })) };
}
describe("当前完整来源的可选择引文片段", () => {
  it.each([["短原文", "短原文"], ["Unicode与换行", "甲".repeat(639) + "😀\r\n" + "乙".repeat(1600)], ["长正文", ("完整段落。\n" + "丙".repeat(350) + "。\r\n").repeat(70)]])("连续保留正文，不丢换行或拆坏Unicode：%s", (_name, body) => {
    const snapshot = source(body), fragments = sourceQuoteFragments(snapshot);
    expect(fragments.map(fragment => fragment.text).join("")).toBe(body);
    let offset = 0;
    for (const fragment of fragments) {
      expect(fragment.start).toBe(offset); expect(fragment.end).toBeGreaterThan(offset); expect(fragment.end - fragment.start).toBeLessThanOrEqual(640);
      expect(fragment.text).toBe(body.slice(fragment.start, fragment.end)); expect(fragment.quoteId).toMatch(/^Q[1-9]\d*-[a-f0-9]{12}$/);
      expect(fragment.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/); expect(fragment.text).not.toMatch(/\r$/);
      offset = fragment.end;
    }
    expect(offset).toBe(body.length);
    expect(quoteIndexedSources([snapshot])[0]).toMatchObject({ sourceId: snapshot.sourceId, textSha256: snapshot.textSha256, textFragments: fragments });
    expect(quoteIndexedSources([snapshot])[0]).not.toHaveProperty("text");
  });
  it("选择ID由宿主装订真实原字节，严格事实验证及其位置合同保持不变", () => {
    const snapshot = source(), raw = extraction(snapshot), before = JSON.stringify(raw), result = resolveMarketingExtraction(raw, [snapshot]);
    expect(result.extraction.citations.map(citation => citation.quote)).toEqual([text, text]);
    expect(result.bindings[0]).toMatchObject({ sourceId: snapshot.sourceId, start: 0, end: text.length, textSha256: snapshot.textSha256, quoteSha256: renderSha256(text) });
    expect(validateStageFacts("A1", result.extraction, [snapshot]).claims[0]).toMatchObject({ quote: text, quoteStart: 0, quoteEnd: text.length });
    expect(JSON.stringify(raw)).toBe(before); expect(result.extraction.payload).toEqual(raw.payload);
  });
  it("重复原文选择后一个片段时，选择绑定、事实位置和复读保持同一位置", () => {
    const body = "同文".repeat(320), snapshot = source(body.repeat(2)), fragments = sourceQuoteFragments(snapshot);
    expect(fragments).toHaveLength(2); expect(fragments[0]!.text).toBe(fragments[1]!.text);
    const raw = extraction(snapshot); raw.citations.forEach(citation => citation.quoteId = fragments[1]!.quoteId);
    const resolved = resolveMarketingExtraction(raw, [snapshot]), facts = validateStageFacts("A1", resolved.extraction, [snapshot]);
    expect(resolved.bindings.every(binding => binding.start === 640 && binding.end === 1280)).toBe(true);
    expect(facts.claims.every(claim => claim.quoteStart === 640 && claim.quoteEnd === 1280)).toBe(true);
    expect(() => revalidateStageFacts(facts, [snapshot])).not.toThrow();
    const bad = structuredClone(resolved.extraction); bad.citations[0]!.quoteStart = 639;
    expect(() => validateStageFacts("A1", bad, [snapshot])).toThrow("MARKETING_CITATION_INVALID");
  });
  it.each(["unknown-id", "wrong-source", "changed-source", "changed-source-rehashed", "cross-source", "both-fields"])("%s不能将任意文本装订成引文", kind => {
    const snapshot = source(), raw: any = extraction(snapshot); let sources = [snapshot];
    if (kind === "unknown-id") raw.citations[0].quoteId = "Q1-000000000000";
    if (kind === "wrong-source") raw.citations[0].sourceId = "SRC-invented";
    if (kind === "changed-source") snapshot.text += "改变";
    if (kind === "changed-source-rehashed") { snapshot.text += "改变"; snapshot.textSha256 = renderSha256(snapshot.text); }
    if (kind === "cross-source") { const other = source(text, "SRC-other"); sources.push(other); raw.citations[0].sourceId = other.sourceId; }
    if (kind === "both-fields") raw.citations[0].quote = text;
    expect(() => resolveMarketingExtraction(raw, sources)).toThrow();
  });
  it("旧字面quote仍严格拒绝改写，不因新增ID桥归一化或自动修补", () => {
    const snapshot = source(), raw = { payload: { identity: { name: "星野 F3", specs: { 风量: "9档" } }, images: [] }, citations: [
      { pointer: "/identity/name", sourceId: snapshot.sourceId, quote: "悬挂部分采用测试组件" },
      { pointer: "/identity/specs/风量", sourceId: snapshot.sourceId, quote: "风量为9档" },
    ] };
    const result = resolveMarketingExtraction(raw, [snapshot]);
    expect(result.bindings).toEqual([]); expect(() => validateStageFacts("A1", result.extraction, [snapshot])).toThrow("MARKETING_CITATION_INVALID");
  });
  it("同文不同来源与位置产生不同ID，重复来源ID/错误摘要失败", () => {
    const one = source(), two = source(text, "SRC-other");
    expect(sourceQuoteFragments(one)[0]!.quoteId).not.toBe(sourceQuoteFragments(two)[0]!.quoteId);
    expect(() => quoteIndexedSources([one, { ...one }])).toThrow("MARKETING_SOURCE_INVALID");
    expect(() => sourceQuoteFragments({ ...one, textSha256: "0".repeat(64) })).toThrow("MARKETING_SOURCE_INVALID");
    expect(() => sourceQuoteFragments(source(""))).toThrow("MARKETING_SOURCE_INVALID");
  });
});
