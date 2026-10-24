/** 完整来源分段供模型选择；引文只从本次保存原文装订，不接受模型改写。 */
import { z } from "zod";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
import { extractionSchema } from "./marketing-facts.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

export interface SourceQuoteFragment { quoteId: string; start: number; end: number; text: string }
export interface IndexedMarketingSource extends Omit<SourceSnapshot, "text"> { textFragments: SourceQuoteFragment[] }
export interface CitationBinding {
  pointer: string; sourceId: string; quoteId: string; textSha256: string;
  start: number; end: number; quoteSha256: string;
}
const indexedCitation = z.object({ pointer: z.string().min(1).max(500), sourceId: z.string().min(1).max(100),
  quoteId: z.string().regex(/^Q[1-9]\d*-[a-f0-9]{12}$/),
}).strict();
const selectableExtraction = extractionSchema.extend({ citations: z.array(z.union([
  extractionSchema.shape.citations.element, indexedCitation,
])).max(200) });

export function sourceQuoteFragments(source: SourceSnapshot): SourceQuoteFragment[] {
  if (!source.sourceId || !source.text || renderSha256(source.text) !== source.textSha256) throw new Error("MARKETING_SOURCE_INVALID：分段前必须验证完整原文摘要");
  const fragments: SourceQuoteFragment[] = [];
  let start = 0;
  while (start < source.text.length) {
    let end = Math.min(start + 640, source.text.length);
    if (end < source.text.length) {
      // 优先保留完整段落/句子；没有合适边界仍连续保留全部字符，不把正文裁成摘要。
      const candidates = ["\n", "。", "！", "？", "；"].map(separator => source.text.lastIndexOf(separator, end - 1));
      const boundary = Math.max(...candidates);
      if (boundary >= start + 320) end = boundary + 1;
      const previous = source.text.charCodeAt(end - 1), next = source.text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff || source.text[end - 1] === "\r" && source.text[end] === "\n") end--;
    }
    const text = source.text.slice(start, end);
    const fingerprint = renderSha256(canonicalRenderJson({ sourceId: source.sourceId, textSha256: source.textSha256, start, end, text })).slice(0, 12);
    fragments.push({ quoteId: `Q${fragments.length + 1}-${fingerprint}`, start, end, text });
    start = end;
  }
  return fragments;
}

export function quoteIndexedSources(sources: SourceSnapshot[]): IndexedMarketingSource[] {
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) throw new Error("MARKETING_SOURCE_INVALID：来源ID重复");
  return sources.map(source => {
    const { text: _text, ...metadata } = source;
    return { ...metadata, textFragments: sourceQuoteFragments(source) };
  });
}

/** 旧quote仍逐字核验；新quoteId只能选当前source+hash+位置指纹对应的真实片段。 */
export function resolveMarketingExtraction(raw: unknown, sources: SourceSnapshot[]): {
  extraction: ReturnType<typeof extractionSchema.parse>; bindings: CitationBinding[];
} {
  const parsed = selectableExtraction.parse(raw);
  const indexed = quoteIndexedSources(sources), bySource = new Map(indexed.map(source => [source.sourceId, source]));
  const bindings: CitationBinding[] = [];
  const citations = parsed.citations.map(citation => {
    if ("quote" in citation) return citation;
    const source = bySource.get(citation.sourceId), fragment = source?.textFragments.find(item => item.quoteId === citation.quoteId);
    if (!source || !fragment) throw new Error("MARKETING_QUOTE_ID_INVALID：引文ID不是本次完整来源中的真实片段");
    bindings.push({ pointer: citation.pointer, sourceId: citation.sourceId, quoteId: fragment.quoteId, textSha256: source.textSha256,
      start: fragment.start, end: fragment.end, quoteSha256: renderSha256(fragment.text) });
    return { pointer: citation.pointer, sourceId: citation.sourceId, quote: fragment.text, quoteStart: fragment.start };
  });
  return { extraction: extractionSchema.parse({ ...parsed, citations }), bindings };
}
