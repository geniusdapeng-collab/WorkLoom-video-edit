/** Real host/Jenny assembly and image decode; only LLM transport and public-source fetch are controlled test doubles. */
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareMarketingFacts, type PreparedMarketingFacts } from "./marketing-authority.js";
import { sourceDocument, type SourceSnapshot } from "./marketing-source-fetcher.js";
import { canonicalRenderJson, renderSha256 as sha } from "./gen/compiled-request.js";
import { importProductResearchArchive, type ProductResearchImageSelection } from "./product-research-archive.js";

const temporary: string[] = [];
let first: Buffer, second: Buffer;
beforeAll(() => {
  const image = (seed: number): Buffer => {
    const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=640x640,noise=alls=50:allf=t:all_seed=${seed}`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { maxBuffer: 8_000_000 });
    if (result.error || result.status !== 0) throw new Error("Real ffmpeg image fixture failed");
    return result.stdout;
  };
  first = image(1); second = image(2);
});
afterEach(() => { vi.unstubAllGlobals(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pageUrl = "https://research.example.com/rc";
const imageUrls = ["https://media.example.com/rc-front.png", "https://media.example.com/rc-side.png"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
function cli(args: string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "scripts/tools/product-archive.mts"), ...args],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PII_SALT: "test-only-research-cli-salt" } });
}
function savePrepared(file: string, prepared: PreparedMarketingFacts): void {
  const g1 = JSON.parse(prepared.g1Content);
  g1.facts = { ...prepared.bundle, g1ContentSha256: "" };
  prepared.g1Content = canonicalRenderJson(g1); prepared.bundle.g1ContentSha256 = sha(prepared.g1Content);
  writeFileSync(file, JSON.stringify(prepared));
}
async function fixture(options: { specs?: Record<string, string | number | boolean>; hydration?: "nuxt" | "json" | "fake"; omitReviewedImages?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "product-research-archive-"))); temporary.push(root);
  const researchRoot = path.join(root, "research"); mkdirSync(researchRoot);
  const specs = options.specs ?? { 座高: "825 毫米", 轴距: "1420 毫米", 创始人: "测试甲" };
  const body = `测试品牌 RC-1 是摩托车；${Object.entries(specs).map(([key, value]) => `${key} ${value}`).join("；")}；全国统一指导价 128000 CNY；赛道专用，不具备道路行驶资质。`;
  const html = `<html><body><p>${body}</p>${options.hydration === "nuxt" ? `<script>window.__NUXT__=(function(a){return {image:a}})("${imageUrls[0]!.replace(/\//g, "\\u002F")}");</script><img src="${imageUrls[1]}">`
    : options.hydration === "json" ? `<script type="application/json">${JSON.stringify({ images: imageUrls })}</script>`
      : options.hydration === "fake" ? `<script>const image="${imageUrls[0]}";</script><!-- <img src="${imageUrls[1]}"> -->`
        : [...imageUrls, "https://media.example.com/neighbour-rc-2.png"].map(url => `<img src="${url}">`).join("")}</body></html>`;
  const document = sourceDocument(html, "text/html", pageUrl), textSha256 = sha(document.text);
  if (options.hydration === "nuxt" || options.hydration === "json") document.assetUrls = [...new Set([...document.assetUrls, ...imageUrls])];
  const source: SourceSnapshot = { sourceId: `SRC-${sha(`${pageUrl}\n${textSha256}`).slice(0, 24)}`, requestedUrl: pageUrl, finalUrl: pageUrl,
    redirectChain: [], fetchedAt: new Date().toISOString(), contentType: "text/html", rawSha256: sha(html), textSha256,
    bytes: Buffer.byteLength(html), ...document };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "product-research-judge",
    model: "deepseek-flash",
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify({
        approved: true,
        score: 96,
        issues: [],
        suggestions: [],
        reason: "All current fixture claims match complete source.",
      }) },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  }))));
  const prepared = await prepareMarketingFacts({
    scope: { tenantId: "tenant-test", workspaceId: "workspace-test", projectId: "product-test", runId: "run-test", attempt: 1 },
    root: researchRoot, intent: "测试商品研究", metadata: { dataMining: { name: "测试品牌 RC-1", brand: "测试品牌", model: "RC-1", category: "摩托车" } },
    env: { LLM_BASE_URL: "https://api.deepseek.com", LLM_API_KEY: "test-only", LLM_MODEL: "deepseek-flash" },
    llm: { reason: async prompt => {
      const stage = /当前阶段：(A[123])/.exec(prompt)?.[1];
      if (stage !== "A1") return { success: true, data: { payload: stage === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "本页没有评价或竞品" } };
      return { success: true, data: { payload: { identity: { name: "测试品牌 RC-1", brand: "测试品牌", model: "RC-1", category: "摩托车", specs,
        prices: [{ amount: 128000, currency: "CNY", note: "全国统一指导价", source_url: pageUrl }],
        official_selling_points: [{ point: "赛道专用，不具备道路行驶资质", source_url: pageUrl }],
      }, images: options.omitReviewedImages || options.hydration === "fake" ? [] : imageUrls.map(url => ({ url, page_url: pageUrl, source: "research.example.com", angle: "unknown" })) },
        citations: ["name", "brand", "model", "category", "prices/0/amount", "prices/0/currency", "prices/0/note", "official_selling_points/0/point", ...Object.keys(specs).map(key => `specs/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)]
          .map(key => ({ pointer: `/identity/${key}`, sourceId: source.sourceId, quote: source.text })) } };
    } }, dependencies: { search: async () => [{ title: "测试品牌 RC-1", url: pageUrl, snippet: "Not used as facts" }],
      fetchSource: async () => ({ snapshot: source, rawBytes: Buffer.from(html) }) },
  });
  const imageRoot = path.join(root, "images"); mkdirSync(imageRoot);
  const images = [first, second].map((bytes, index) => { const file = path.join(imageRoot, `${index}.png`); writeFileSync(file, bytes); return {
    id: index ? "side-photo" : "front-photo", file, pageUrl, imageUrl: imageUrls[index]!, sha256: sha(bytes), bytes: bytes.length,
    angle: index ? "side" as const : "front" as const, role: index ? "detail" as const : "hero" as const,
  }; });
  const selection: ProductResearchImageSelection = { schemaVersion: "workloom.product-research-image-selection/v1", allowedImageRoots: [imageRoot], images };
  const metadata: Record<string, unknown> = { id: "test-rc", displayName: "测试品牌 RC-1", type: "product", category: "vehicle", brand: "测试品牌", model: "RC-1" };
  const files = { researchFile: path.join(researchRoot, "prepared-research.json"), selectionFile: path.join(root, "selection.json"), metadataFile: path.join(root, "metadata.json"), root: path.join(root, "library") };
  const save = () => { savePrepared(files.researchFile, prepared); writeFileSync(files.selectionFile, JSON.stringify(selection)); writeFileSync(files.metadataFile, JSON.stringify(metadata)); };
  save();
  return { files, prepared, selection, metadata, save, run: () => importProductResearchArchive(files), root };
}

describe("reviewed research to truthful product archives", () => {
  it("imports source-bound vehicle dimensions and real decoded pictures without copying source articles or modifying originals", async () => {
    const f = await fixture(), result = f.run();
    expect(result.archive.source).toMatchObject({ kind: "system-generated", priority: 1, reviewStatus: "pending-owner-review" });
    expect(result.archive.specs?.dimensions).toMatchObject({ seatHeightMm: 825, wheelbaseMm: 1420 });
    expect(result.archive.photos.map(photo => [photo.angle, photo.width, photo.height])).toEqual([["front", 640, 640], ["side", 640, 640]]);
    expect(result.archive.specs?.parameters?.find(item => item.name === "创始人")?.source).toContain("#CL-");
    expect(result.archive.specs?.parameters?.find(item => item.name === "价格[1].amount")?.value).toBe("128000");
    expect(result.archive.specs?.parameters?.find(item => item.name === "价格[1].currency")?.value).toBe("CNY");
    expect(result.archive.specs?.notes).toContain("已审核来源条目：赛道专用，不具备道路行驶资质");
    expect(result.summary).toMatchObject({ sourceTextCopied: false, g1HumanApproved: false, productionAuthorityGranted: false });
    expect(sha(readFileSync(f.selection.images[0]!.file))).toBe(f.selection.images[0]!.sha256);
    expect(readFileSync(path.join(result.directory, "research-import.json"), "utf8")).not.toContain('"quote":');
    expect(() => f.run()).toThrow("already exists");
  });
  it.each(["nuxt", "json"] as const)("maps actual %s hydration image literals without evaluating scripts", async hydration => {
    expect((await fixture({ hydration })).run().archive.photos).toHaveLength(2);
  });
  it("supports sourced company/founder parameters and relations without requiring photos", async () => {
    const f = await fixture(); Object.assign(f.metadata, { id: "test-company", type: "company", relations: { products: ["test-rc"] } });
    delete f.metadata.category; delete f.metadata.model; f.selection.images = []; f.save();
    const result = f.run(); expect(result.archive.photos).toEqual([]); expect(result.archive.relations?.products).toEqual(["test-rc"]);
    expect(result.archive.specs?.parameters?.some(item => item.name === "创始人" && item.value === "测试甲")).toBe(true);
  });
  it.each(["raw", "text", "review", "dossier"] as const)("rejects current %s bytes changing after research", async kind => {
    const f = await fixture(), b = f.prepared.bundle;
    const ref = kind === "raw" ? b.sources[0]!.rawRef : kind === "text" ? b.sources[0]!.textRef : kind === "review" ? b.stages[0]!.review!.ref : `${f.prepared.prefix}-dossier/${b.dossier.product_id}/dossier.json`;
    writeFileSync(path.join(f.prepared.root, ref), "changed"); expect(() => f.run()).toThrow();
    expect(existsSync(f.files.root)).toBe(false);
  });
  it.each(["fallback", "no-evidence", "no-model", "scope", "missing-claim", "claim-offset", "expired", "ref-escape", "wrong-model"] as const)("rejects %s rather than accepting a passed flag", async kind => {
    const f = await fixture(), b = f.prepared.bundle, review = b.stages[0]!.review!;
    if (kind === "fallback") review.verdict.via = "fallback";
    if (kind === "no-evidence") review.verdict.evidence = [];
    if (kind === "no-model") review.verdict.model = "";
    if (kind === "scope") b.scope.workspaceId = "different";
    if (kind === "missing-claim") b.stages[0]!.facts.claims.pop();
    if (kind === "claim-offset") b.stages[0]!.facts.claims[0]!.quoteStart++;
    if (kind === "expired") b.collectedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    if (kind === "ref-escape") b.sources[0]!.rawRef = "../source.raw";
    if (kind === "wrong-model") f.metadata.model = "RC-2";
    f.save(); expect(() => f.run()).toThrow();
  });
  it("rejects a rehashed review that did not cover the complete current evidence", async () => {
    const f = await fixture(), review = f.prepared.bundle.stages[0]!.review!;
    const bytes = canonicalRenderJson({ facts: f.prepared.bundle.stages[0]!.facts, sources: [] });
    writeFileSync(path.join(f.prepared.root, review.ref), bytes); review.sha256 = sha(bytes); review.verdict.evidence![0]!.sha256 = sha(bytes);
    f.save(); expect(() => f.run()).toThrow("complete facts");
  });
  it.each(["hash", "bytes", "escape", "symlink", "page", "image-url", "illegal-angle", "same-angle", "duplicate-bytes", "corrupt-decode"] as const)("rejects selected image %s", async kind => {
    const f = await fixture(), item = f.selection.images[0]!;
    if (kind === "hash") item.sha256 = "0".repeat(64);
    if (kind === "bytes") item.bytes++;
    if (kind === "escape") item.file = path.join(f.root, "outside.png");
    if (kind === "symlink") { const target = path.join(path.dirname(item.file), "alias.png"); symlinkSync(item.file, target); item.file = target; }
    if (kind === "page") item.pageUrl = "https://other.example.com/page";
    if (kind === "image-url") item.imageUrl = "https://media.example.com/not-present.png";
    if (kind === "illegal-angle") (item as { angle: string }).angle = "unknown";
    if (kind === "same-angle") f.selection.images[1]!.angle = item.angle;
    if (kind === "duplicate-bytes") Object.assign(f.selection.images[1]!, { file: item.file, sha256: item.sha256, bytes: item.bytes });
    if (kind === "corrupt-decode") { const bytes = Buffer.alloc(60_000); writeFileSync(item.file, bytes); item.sha256 = sha(bytes); item.bytes = bytes.length; }
    f.save(); expect(() => f.run()).toThrow();
  });
  it("rejects arbitrary script/comment image text as source mapping", async () => {
    const f = await fixture({ hydration: "fake" }); expect(() => f.run()).toThrow("reviewed A1 image set");
  });
  const invalidDimensions: Array<Record<string, string>> = [{ 座高: "0 毫米", 轴距: "1420 毫米" }, { 座高: "825", 轴距: "1420 毫米" }, { 座高: "未知", 轴距: "1420 毫米" }, { 座高: "825 毫米", 轴距: "1420 毫米", wheelbase: "1.5 m" }];
  it.each(invalidDimensions)("rejects invalid or conflicting sourced dimensions %j", async specs => {
    const f = await fixture({ specs }); expect(() => f.run()).toThrow();
  });
  it("converts explicit centimetres/metres deterministically and keeps unresolved non-dimension facts as gaps", async () => {
    const f = await fixture({ specs: { 座高: "82.5 厘米", 轴距: "1.42 米", 重量: "未知" } });
    const result = f.run(); expect(result.archive.specs?.dimensions).toMatchObject({ seatHeightMm: 825, wheelbaseMm: 1420 });
    expect(result.summary.gaps).toContain("fact-unresolved:/identity/specs/重量"); expect(result.archive.specs?.parameters?.some(item => item.name === "重量")).toBe(false);
  });
  it("maps numeric dimensions only when the reviewed field itself carries a unit", async () => {
    const result = (await fixture({ specs: { seatHeightMm: 825, wheelbaseMm: 1420 } })).run();
    expect(result.archive.specs?.dimensions).toMatchObject({ seatHeightMm: 825, wheelbaseMm: 1420 });
  });
  it("does not allow a researched vehicle to bypass vehicle checks by omitting category", async () => {
    const f = await fixture(); delete f.metadata.category; f.selection.images[1]!.angle = "front"; f.save();
    expect(() => f.run()).toThrow("two legal");
  });
  it("rejects an explicit category that conflicts with the researched vehicle", async () => {
    const f = await fixture(); f.metadata.category = "book"; f.save(); expect(() => f.run()).toThrow("category conflicts");
  });
  it("rejects same-page neighbouring product pictures absent from reviewed A1", async () => {
    const f = await fixture(); f.selection.images[0]!.imageUrl = "https://media.example.com/neighbour-rc-2.png"; f.save();
    expect(() => f.run()).toThrow("reviewed A1 image set");
  });
  it("cannot turn an image-free Jenny dossier into a verified product selection", async () => {
    const f = await fixture({ omitReviewedImages: true }); expect(() => f.run()).toThrow("reviewed A1 image set");
  });
  it("runs the official CLI import and native archive verifier against the same current bytes", async () => {
    const f = await fixture();
    const imported = cli(["from-research", "--research", f.files.researchFile, "--selection", f.files.selectionFile,
      "--metadata", f.files.metadataFile, "--root", f.files.root]);
    expect(imported.error).toBeUndefined(); expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ sourceKind: "system-generated", photos: 2, reviewStatus: "pending-owner-review" });
    const verified = cli(["verify", "--root", f.files.root, "--id", "test-rc"]);
    expect(verified.status, verified.stderr).toBe(0); expect(verified.stdout).toContain("test-rc");
  });
  it("rejects incomplete CLI arguments before creating an archive", () => {
    const result = cli(["from-research"]); expect(result.status).not.toBe(0); expect(result.stderr).toContain("--research");
  });
});
