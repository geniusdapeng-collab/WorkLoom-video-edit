/** Import reviewed research into the file archive without relabelling public material as customer uploads. */
import { constants, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, fstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PRODUCT_ARCHIVE_SCHEMA, verifyProductArchive, type ProductArchive, type ProductArchivePhoto } from "@hyperreality/video-studio";
import type { PreparedMarketingFacts } from "./marketing-authority.js";
import { revalidateStageFacts } from "./marketing-facts.js";
import { sourceDocument, sourceUrl, type SourceSnapshot } from "./marketing-source-fetcher.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

const angle = z.enum(["front", "three-quarter", "side", "rear", "detail", "action", "top"]);
const segment = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const label = z.string().trim().min(1).max(240);
const metadataSchema = z.object({
  id: segment, type: z.enum(["product", "company", "solution"]).default("product"), displayName: label,
  category: label.optional(), model: label.optional(), brand: label.optional(), company: label.optional(),
  aliases: z.array(label).max(50).optional(),
  relations: z.object({ companyId: segment.optional(), products: z.array(segment).max(100).optional(),
    solutions: z.array(segment).max(100).optional(), includes: z.array(z.object({ id: segment, role: label.optional() }).strict()).max(100).optional() }).strict().optional(),
}).strict();
const selectionSchema = z.object({
  schemaVersion: z.literal("workloom.product-research-image-selection/v1"),
  allowedImageRoots: z.array(z.string().min(1)).min(1).max(10),
  images: z.array(z.object({ id: segment, file: z.string().min(1), pageUrl: z.string().url(), imageUrl: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(50_000).max(8_000_000),
    angle, role: z.enum(["hero", "detail", "scene", "packaging"]).optional(),
  }).strict()).max(100),
}).strict();
export type ProductResearchMetadata = z.input<typeof metadataSchema>;
export type ProductResearchImageSelection = z.infer<typeof selectionSchema>;
type CheckedSource = SourceSnapshot & { raw: string };
function fail(message: string): never { throw new Error(`PRODUCT_RESEARCH_INVALID: ${message}`); }
const same = (a: unknown, b: unknown): boolean => canonicalRenderJson(a) === canonicalRenderJson(b);
const sha = (value: string | Buffer): string => renderSha256(value);
const canonical = (value: string): string => value.normalize("NFKC").replace(/[\s\-_/]/g, "").toLowerCase();

function realFile(file: string, root: string, maxBytes: number): Buffer {
  const absolute = path.resolve(file), boundary = path.resolve(root);
  if (!path.isAbsolute(file) || !absolute.startsWith(`${boundary}${path.sep}`) || realpathSync(boundary) !== boundary
    || realpathSync(absolute) !== absolute) fail("file escaped its explicit root or used a symlink");
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !stat.size || stat.size > maxBytes) fail("file is empty, non-regular, or oversized");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) fail("file changed while reading");
    return bytes;
  } finally { closeSync(fd); }
}
function bound(root: string, ref: string, expected: string): Buffer {
  if (!ref || path.isAbsolute(ref) || ref.split(/[\\/]/).some(part => !part || part === "." || part === "..")
    || !/^[a-f0-9]{64}$/.test(expected)) fail("invalid evidence reference or SHA256");
  const bytes = realFile(path.resolve(root, ref), root, 2 * 1024 * 1024);
  if (sha(bytes) !== expected) fail("current evidence SHA256 changed");
  return bytes;
}
function readJson(file: string): unknown {
  const bytes = realFile(path.resolve(file), path.dirname(path.resolve(file)), 8 * 1024 * 1024);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { return fail("input is not valid JSON"); }
}

/** Verify current research bytes and complete review bindings; this does not grant G1 or production authority. */
function checkedResearch(file: string): { prepared: PreparedMarketingFacts; sources: CheckedSource[]; researchSha256: string; dossierSha256: string } {
  const researchPath = path.resolve(file), root = path.dirname(researchPath);
  const researchBytes = realFile(researchPath, root, 8 * 1024 * 1024);
  const prepared = JSON.parse(researchBytes.toString("utf8")) as PreparedMarketingFacts;
  const b = prepared.bundle;
  if (!b || b.schemaVersion !== "workloom.marketing-facts/v1" || b.issuer !== "workloom.marketing-authority" || b.policyVersion !== "source-claims/v1"
    || prepared.root !== root || !b.scope || !Number.isInteger(b.scope.attempt) || b.scope.attempt < 1) fail("research issuer, root, or scope is invalid");
  for (const value of [b.scope.tenantId, b.scope.workspaceId, b.scope.projectId, b.scope.runId]) {
    if (typeof value !== "string" || !value || /[/\\\0]/.test(value) || value === "." || value === "..") fail("invalid research scope component");
  }
  const prefix = `stages/preproduction/attempt-${b.scope.attempt}.marketing`;
  const age = Date.now() - Date.parse(b.collectedAt);
  if (prepared.prefix !== prefix || prepared.storeRoot !== path.join(root, `${prefix}-dossier`)
    || !Number.isFinite(age) || age < -30_000 || age > 24 * 3600_000) fail("research is expired or not bound to the current attempt");
  if (!Array.isArray(b.sources) || !b.sources.length || !Array.isArray(b.stages) || b.stages.length !== 3
    || !Array.isArray(b.outputReviews) || b.outputReviews.length !== 0 || !same(prepared.raw, b.rawByAgent)
    || sha(canonicalRenderJson(b.rawByAgent)) !== b.rawSha256 || sha(canonicalRenderJson(b.dossier)) !== b.dossierSha256) fail("research raw payload or dossier binding changed");
  if (sha(prepared.g1Content) !== b.g1ContentSha256) fail("G1 review content SHA changed");
  const g1 = JSON.parse(prepared.g1Content) as { facts?: unknown; instruction?: unknown; requestedIntent?: unknown; requestedMetadata?: unknown };
  if (!same(g1.facts, { ...b, g1ContentSha256: "" }) || typeof g1.instruction !== "string" || typeof g1.requestedIntent !== "string"
    || !g1.requestedMetadata || !same(JSON.parse(prepared.g1Content), g1)) fail("research content is not bound to its complete facts bundle");
  const sourceIds = new Set<string>();
  const sources = b.sources.map(source => {
    if (sourceIds.has(source.sourceId) || !source.rawRef.startsWith(`${prefix}-sources/`) || !source.textRef.startsWith(`${prefix}-sources/`)) fail("source identity is duplicate or outside this attempt");
    sourceIds.add(source.sourceId);
    sourceUrl(source.requestedUrl); sourceUrl(source.finalUrl);
    const rawBytes = bound(root, source.rawRef, source.rawSha256), text = bound(root, source.textRef, source.textSha256).toString("utf8");
    if (rawBytes.length !== source.bytes || !Array.isArray(source.assetUrls)) fail("source byte count or image index changed");
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(source.contentType)?.[1] ?? "utf-8";
    const raw = new TextDecoder(charset, { fatal: true }).decode(rawBytes);
    const decoded = sourceDocument(raw, source.contentType, source.finalUrl);
    if (decoded.text !== text || !source.assetUrls.every(url => decoded.assetUrls.includes(url) || hydrationImages(raw).has(url))
      || source.sourceId !== `SRC-${sha(`${source.finalUrl}\n${source.textSha256}`).slice(0, 24)}`) fail("source raw/text/image-index binding changed");
    const { rawRef: _rawRef, textRef: _textRef, ...snapshot } = source;
    return { ...snapshot, text, raw };
  });
  for (const stage of ["A1", "A2", "A3"] as const) {
    const records = b.stages.filter(record => record.stage === stage), record = records[0];
    if (records.length !== 1 || !record || record.facts.stage !== stage || !Array.isArray(record.sourceIds)) fail("missing or duplicate station");
    const used = record.sourceIds.map(id => sources.find(source => source.sourceId === id));
    if (used.some(source => !source) || new Set(record.sourceIds).size !== used.length) fail("station source binding is invalid");
    const snapshots = used.map(source => { const { raw: _raw, ...snapshot } = source!; return snapshot; });
    revalidateStageFacts(record.facts, snapshots);
    if (!same(record.facts.payload, b.rawByAgent[stage])) fail("reviewed station differs from Jenny input");
    if (record.facts.claims.length || record.review) {
      const review = record.review, verdict = review?.verdict;
      if (!review || review.ref !== `${prefix}-${stage}.review.json` || !verdict || verdict.stage !== "script" || verdict.status !== "passed"
        || verdict.approved !== true || verdict.via !== "llm" || verdict.degraded !== false || verdict.rerun !== false
        || !verdict.model?.trim() || typeof verdict.score !== "number" || !Number.isFinite(verdict.score) || verdict.score < 85 || verdict.score > 100
        || !Array.isArray(verdict.hardFailures) || verdict.hardFailures.length || !Array.isArray(verdict.issues) || !Array.isArray(verdict.suggestions)
        || !verdict.reason?.trim() || !Number.isFinite(verdict.ms) || verdict.ms < 0 || verdict.evidence?.length !== 1
        || verdict.evidence[0]?.path !== path.resolve(root, review.ref) || verdict.evidence[0]?.sha256 !== review.sha256
        || verdict.evidence[0]?.scope !== "complete-text") fail("independent complete-source LLM review is absent or invalid");
      const reviewBytes = bound(root, review.ref, review.sha256);
      if (reviewBytes.toString("utf8") !== canonicalRenderJson({ scope: b.scope, productQuery: b.productQuery, facts: record.facts, sources: snapshots })) fail("review did not cover the current complete facts and source texts");
    }
  }
  const dossier = b.dossier as { product_id?: string; identity?: Record<string, unknown> };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dossier.product_id ?? "")) fail("Jenny dossier ID is invalid");
  const dossierPath = path.join(prepared.storeRoot, dossier.product_id!, "dossier.json");
  const dossierBytes = realFile(dossierPath, root, 2 * 1024 * 1024);
  if (!same(JSON.parse(dossierBytes.toString("utf8")), dossier)) fail("current Jenny dossier differs from reviewed assembly");
  const a1 = b.rawByAgent.A1.identity as Record<string, unknown>;
  for (const key of ["name", "brand", "category", "model", "specs"]) if (!same(dossier.identity?.[key], a1[key] ?? (key === "specs" ? {} : ""))) fail("Jenny identity differs from reviewed A1");
  const require = createRequire(import.meta.url);
  const schema = require(fileURLToPath(new URL("../../../../vendor/supermickey/hyperreality-system/engines/data-mining-engine/contracts/dossier-schema.js", import.meta.url))) as { validate(value: unknown): { ok: boolean } };
  if (!schema.validate(dossier).ok) fail("Jenny dossier schema validation failed");
  return { prepared, sources, researchSha256: sha(researchBytes), dossierSha256: sha(dossierBytes) };
}

/** Actual decode, not a header-only size guess. Uses the same local media toolchain as the video workbench. */
function decodeImage(bytes: Buffer): { width: number; height: number; extension: string } {
  const probe = spawnSync(process.env.WL_FFPROBE ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "json", "pipe:0"], { input: bytes, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (probe.error || probe.status !== 0) fail("image probe failed");
  const stream = (JSON.parse(probe.stdout) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }> }).streams?.[0];
  const { width = 0, height = 0, codec_name = "" } = stream ?? {};
  const extension = ({ png: "png", mjpeg: "jpg", webp: "webp", gif: "gif" } as Record<string, string>)[codec_name];
  if (!extension || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 40_000_000 || Math.max(width, height) < 600) fail("image format or decoded dimensions are invalid");
  const decoded = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-threads", "1", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"], { input: bytes, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (decoded.error || decoded.status !== 0) fail("image pixel decode failed");
  return { width, height, extension };
}
function hydrationImages(raw: string): Set<string> {
  const images = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || !/^https?:\/\//.test(value) || !/\.(?:jpe?g|png|webp|gif)(?:[!?]|$)/i.test(value)) return;
    try { images.add(sourceUrl(value).href); } catch { /* Invalid public image URLs are not candidates. */ }
  };
  // Never execute a page script. Nuxt's recognized serialized hydration payload stores URLs in JSON string literals.
  for (const script of raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, "")
    .matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = script[1]!, body = script[2]!.trim();
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attrs)) {
      let data: unknown;
      try { data = JSON.parse(body); } catch { continue; }
      const walk = (item: unknown): void => {
        if (Array.isArray(item)) item.forEach(walk);
        else if (item && typeof item === "object") Object.values(item).forEach(walk);
        else add(item);
      };
      walk(data);
    } else if (/^window\.__NUXT__\s*=\s*\(function\s*\(/.test(body)) {
      // Comment tokens are consumed too, so strings inside JS comments cannot become candidate URLs.
      for (const token of body.matchAll(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
        if (token[1]) { try { add(JSON.parse(token[1])); } catch { /* Non-JSON string literal is not supported. */ } }
      }
    }
  }
  return images;
}
const DIMENSIONS: Record<string, keyof NonNullable<NonNullable<ProductArchive["specs"]>["dimensions"]>> = {
  车长: "lengthMm", 全长: "lengthMm", 长度: "lengthMm", length: "lengthMm", lengthmm: "lengthMm",
  车宽: "widthMm", 全宽: "widthMm", 宽度: "widthMm", width: "widthMm", widthmm: "widthMm",
  车高: "heightMm", 全高: "heightMm", 高度: "heightMm", height: "heightMm", heightmm: "heightMm",
  座高: "seatHeightMm", 坐高: "seatHeightMm", seatheight: "seatHeightMm", seatheightmm: "seatHeightMm",
  轴距: "wheelbaseMm", wheelbase: "wheelbaseMm", wheelbasemm: "wheelbaseMm",
  整备质量: "curbWeightKg", 整备重量: "curbWeightKg", curbweight: "curbWeightKg", curbweightkg: "curbWeightKg",
};
function dimension(key: string, value: unknown): { field: string; value: number } | null {
  const field = DIMENSIONS[canonical(key)];
  if (!field) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 && /(?:mm|kg)$/.test(canonical(key)) ? { field, value } : null;
  }
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米|m|千克|公斤|kg)\s*$/i.exec(value);
  if (!match) return null;
  const unit = match[2]!.toLowerCase(), weight = field === "curbWeightKg";
  if (weight !== /^(千克|公斤|kg)$/.test(unit)) return null;
  const amount = Number(match[1]) * (weight ? 1 : /^(厘米|cm)$/.test(unit) ? 10 : /^(米|m)$/.test(unit) ? 1000 : 1);
  return Number.isFinite(amount) && amount > 0 ? { field, value: amount } : null;
}

export function importProductResearchArchive(input: { researchFile: string; selectionFile: string; metadataFile: string; root: string }): { directory: string; archive: ProductArchive; summary: Record<string, unknown> } {
  const metadata = metadataSchema.parse(readJson(input.metadataFile));
  const selection = selectionSchema.parse(readJson(input.selectionFile));
  const checked = checkedResearch(input.researchFile), { prepared, sources } = checked, b = prepared.bundle;
  const a1 = b.stages.find(stage => stage.stage === "A1")!.facts;
  const identity = a1.payload.identity as { name: string; brand?: string; model?: string; category?: string; specs: Record<string, unknown>;
    prices: Array<{ amount: number; currency: string; note?: string }>; official_selling_points: Array<{ point: string }> };
  const reviewedImages = a1.payload.images as Array<{ url: string; page_url: string; angle?: string }>;
  if (metadata.model && canonical(metadata.model) !== canonical(identity.model ?? "")) fail("requested model does not match the reviewed exact model");
  const vehicleCategory = /摩托|机车|汽车|机动车|motorcycle|vehicle|truck|\bcar\b/i;
  const researchedVehicle = vehicleCategory.test(identity.category ?? "");
  const vehicle = metadata.type === "product" && (metadata.category?.toLowerCase() === "vehicle" || researchedVehicle);
  if (vehicle && (!researchedVehicle || metadata.category && !vehicleCategory.test(metadata.category))) fail("vehicle category conflicts with reviewed identity");
  const roots = selection.allowedImageRoots.map(root => {
    if (!path.isAbsolute(root) || path.resolve(root) !== realpathSync(root)) fail("allowedImageRoots must be explicit real directories");
    return path.resolve(root);
  });
  const imageIds = new Set<string>(), imageHashes = new Set<string>();
  const imageData = selection.images.map((item, index) => {
    const root = roots.find(root => path.resolve(item.file).startsWith(`${root}${path.sep}`));
    if (!root || imageIds.has(item.id) || imageHashes.has(item.sha256)) fail("image root, unique ID, or unique content requirement failed");
    imageIds.add(item.id); imageHashes.add(item.sha256);
    const bytes = realFile(item.file, root, 8_000_000);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) fail("selected image current bytes changed");
    const pageUrl = sourceUrl(item.pageUrl).href, imageUrl = sourceUrl(item.imageUrl).href;
    const reviewedImage = reviewedImages.find(image => sourceUrl(image.page_url).href === pageUrl && sourceUrl(image.url).href === imageUrl);
    if (!reviewedImage) fail("selected image is not in the independently reviewed A1 image set for this exact product");
    if (reviewedImage.angle && reviewedImage.angle !== "unknown" && reviewedImage.angle !== item.angle) fail("selected angle contradicts the reviewed A1 angle");
    const source = sources.find(source => source.requestedUrl === pageUrl || source.finalUrl === pageUrl);
    const currentCandidates = source ? sourceDocument(source.raw, source.contentType, source.finalUrl).assetUrls : [];
    if (!source || !(currentCandidates.includes(imageUrl) || hydrationImages(source.raw).has(imageUrl))) fail("image URL is not mapped to an actual reviewed source page");
    const decoded = decodeImage(bytes);
    const photo: ProductArchivePhoto = { id: item.id, file: `photos/${String(index + 1).padStart(2, "0")}-${item.id}.${decoded.extension}`,
      role: item.role ?? (index === 0 ? "hero" : "detail"), angle: item.angle, sha256: item.sha256, bytes: item.bytes,
      width: decoded.width, height: decoded.height,
      note: `sourcePage=${pageUrl}; imageUrl=${imageUrl}; sourceId=${source.sourceId}; sourceRawSha256=${source.rawSha256}; reference only; authorization not confirmed`,
    };
    return { bytes, photo, sourceId: source.sourceId, pageUrl, imageUrl };
  });
  if (metadata.type === "product" && (!imageData.length || imageData.filter(item => item.photo.role === "hero").length !== 1)) fail("product requires exactly one hero and real photos");
  if (vehicle && new Set(imageData.map(item => item.photo.angle)).size < 2) fail("vehicle requires at least two legal, selected image angles");
  const gaps: string[] = [];
  const dimensions: Record<string, number> = {}, dimensionClaims: Record<string, string[]> = {};
  const parameters: NonNullable<NonNullable<ProductArchive["specs"]>["parameters"]> = [];
  const exportedClaims: Array<Record<string, unknown>> = [];
  const sourceNotes: string[] = [];
  const appendFact = (name: string, pointer: string, value: unknown): boolean => {
    const claim = a1.claims.find(claim => claim.pointer === pointer);
    if (!claim) fail("fact lacks a revalidated claim");
    const source = sources.find(source => source.sourceId === claim.sourceId)!;
    const text = String(value);
    if (text.length > 240) { gaps.push(`fact-too-long:${pointer}`); return false; }
    if (/未知|未核实|不详|冲突|待确认|unknown|unverified|conflict/i.test(text)) { gaps.push(`fact-unresolved:${pointer}`); return false; }
    parameters.push({ name, value: text, source: `${source.finalUrl}#${claim.claimId}; textSha256=${claim.textSha256}` });
    exportedClaims.push({ claimId: claim.claimId, pointer: claim.pointer, value: claim.value, sourceId: claim.sourceId,
      textSha256: claim.textSha256, quoteSha256: sha(claim.quote), quoteStart: claim.quoteStart, quoteEnd: claim.quoteEnd });
    return true;
  };
  for (const key of ["name", "brand", "category", "model"] as const) {
    if (identity[key]) appendFact(`研究身份.${key}`, `/identity/${key}`, identity[key]);
  }
  for (const [index, price] of identity.prices.entries()) {
    for (const key of ["amount", "currency", "note"] as const) {
      if (price[key] !== undefined) appendFact(`价格[${index + 1}].${key}`, `/identity/prices/${index}/${key}`, price[key]);
    }
  }
  for (const [index, point] of identity.official_selling_points.entries()) {
    if (appendFact(`已审核来源条目[${index + 1}]`, `/identity/official_selling_points/${index}/point`, point.point)) sourceNotes.push(point.point);
  }
  for (const [key, value] of Object.entries(identity.specs)) {
    const pointer = `/identity/specs/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (!appendFact(key, pointer, value)) continue;
    const claim = a1.claims.find(claim => claim.pointer === pointer)!;
    const parsed = dimension(key, value);
    if (parsed) {
      if (dimensions[parsed.field] !== undefined && dimensions[parsed.field] !== parsed.value) fail("conflicting sourced dimensions");
      dimensions[parsed.field] = parsed.value; dimensionClaims[parsed.field] = [...(dimensionClaims[parsed.field] ?? []), claim.claimId];
    } else if (DIMENSIONS[canonical(key)]) gaps.push(`dimension-not-parsed:${key}`);
  }
  if (vehicle && Object.keys(dimensions).length < 2) fail("vehicle requires at least two finite positive source-bound dimensions with explicit units");
  const now = new Date().toISOString();
  const searchedQueries = [...new Set(b.stages.flatMap(stage => stage.discovery.queries).map(query => typeof query === "string" ? query : query && typeof query === "object" && "q" in query ? String(query.q) : "").filter(Boolean))];
  if (!searchedQueries.length) fail("research has no actual discovery queries");
  const archive: ProductArchive = { schemaVersion: PRODUCT_ARCHIVE_SCHEMA, ...metadata,
    ...(vehicle ? { category: "vehicle" } : {}),
    aliases: [...new Set([...(metadata.aliases ?? []), identity.name, ...(identity.model ? [identity.model] : [])])],
    source: { kind: "system-generated", priority: 1, generatedAt: now, generator: "scripts/tools/product-archive.mts@from-research",
      reviewStatus: "pending-owner-review", searchedQueries,
      evidence: sources.map(source => ({ query: searchedQueries.join(" | "), url: source.finalUrl, site: new URL(source.finalUrl).hostname,
        note: `queryAttribution=research-matrix; sourceId=${source.sourceId}; rawSha256=${source.rawSha256}; textSha256=${source.textSha256}; facts=${a1.claims.filter(claim => claim.sourceId === source.sourceId).map(claim => claim.claimId).join(",")}` })),
      extraction: { method: "reviewed-research-and-selected-real-images", verified: false, note: "Source-bound facts, complete-source LLM review and current Jenny dossier checked; image source mapping and pixel decode checked. No G1 human approval or production authority granted." },
      disclaimer: "系统检索资料，版权、商用授权与参数未经客户确认；图片仅作真实外观参考，正式投放前须核对授权。来源正文只保留在本地研究目录。" },
    photos: imageData.map(item => item.photo), specs: { parameters, ...(Object.keys(dimensions).length ? { dimensions } : {}),
      notes: [...sourceNotes.map(note => `已审核来源条目：${note}`), ...b.restrictions, ...gaps.map(gap => `研究缺口：${gap}`), "公司与品牌名称可按用户提供的档案名称规范化；不构成人物背书或素材授权。"] }, createdAt: now, updatedAt: now };
  const outputRoot = path.resolve(input.root);
  mkdirSync(outputRoot, { recursive: true });
  if (realpathSync(outputRoot) !== outputRoot) fail("output root used a symlink");
  const target = path.join(outputRoot, metadata.id);
  if (existsSync(target)) fail("archive already exists; replacement requires a new explicit destination");
  const temporary = mkdtempSync(path.join(outputRoot, ".research-import-"));
  const summary: Record<string, unknown> = { schemaVersion: "workloom.product-research-import/v1", importedAt: now,
    researchSha256: checked.researchSha256, scope: b.scope, dossierProductId: b.dossier.product_id, dossierSha256: checked.dossierSha256,
    normalizedMetadataSha256: sha(canonicalRenderJson(metadata)), canonicalImageSelectionSha256: sha(canonicalRenderJson(selection)),
    reviewedA1Claims: a1.claims.length, exportedClaims, dimensionClaims, gaps,
    jennyGapCount: Array.isArray(b.dossier.gaps) ? b.dossier.gaps.length : null,
    jennyReferenceImageCount: Array.isArray((b.dossier.visual_assets as { images?: unknown[] } | undefined)?.images)
      ? (b.dossier.visual_assets as { images: unknown[] }).images.length : null,
    selectedImageCount: imageData.length, restrictions: b.restrictions,
    normalization: { requested: metadata, reviewedIdentity: { name: identity.name, brand: identity.brand, model: identity.model, category: identity.category } },
    stages: b.stages.map(stage => ({ stage: stage.stage, status: stage.facts.status, claims: stage.facts.claims.length,
      ...(stage.review ? { supportReviewSha256: stage.review.sha256, model: stage.review.verdict.model, score: stage.review.verdict.score, via: stage.review.verdict.via } : {}),
      discovery: { candidates: stage.discovery.candidates, fetched: stage.discovery.fetched } })),
    sources: sources.map(({ sourceId, requestedUrl, finalUrl, rawSha256, textSha256, bytes, fetchedAt }) => ({ sourceId, requestedUrl, finalUrl, rawSha256, textSha256, bytes, fetchedAt })),
    images: imageData.map(({ photo, sourceId, pageUrl, imageUrl }) => ({ id: photo.id, file: photo.file, sourceId, pageUrl, imageUrl,
      sha256: photo.sha256, bytes: photo.bytes, width: photo.width, height: photo.height, angle: photo.angle })),
    g1HumanApproved: false, productionAuthorityGranted: false, sourceTextCopied: false, originalImagesModified: false };
  try {
    mkdirSync(path.join(temporary, "photos"));
    for (const item of imageData) writeFileSync(path.join(temporary, item.photo.file), item.bytes, { flag: "wx" });
    const issues = verifyProductArchive(archive, { dir: temporary });
    if (issues.some(issue => issue.hard)) fail(`generated archive failed its native validator: ${issues.filter(issue => issue.hard).map(issue => issue.code).join(",")}`);
    writeFileSync(path.join(temporary, "profile.json"), `${JSON.stringify(archive, null, 2)}\n`, { flag: "wx" });
    writeFileSync(path.join(temporary, "research-import.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
    if (existsSync(target)) fail("archive destination appeared during import");
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
  return { directory: target, archive, summary };
}
