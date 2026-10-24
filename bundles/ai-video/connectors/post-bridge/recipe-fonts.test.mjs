/** Real local package/reedit regression: synthetic fixtures, production engines, zero model calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

test("three declared fonts, tracks and covers reach current media; scoped revisions retain them and reject drift", { timeout: 240_000 }, async () => {
  const keepRoot = process.env.WORKLOOM_FONT_TEST_KEEP_DIR;
  if (keepRoot) fs.mkdirSync(keepRoot, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(keepRoot ?? os.tmpdir(), "post-recipe-fonts-")));
  const savedVariantDir = process.env.WORKLOOM_POST_VARIANT_DIR;
  const savedFontsDir = process.env.WORKLOOM_SUBTITLE_FONTS_DIR;
  const recipes = path.join(root, "recipes"), library = path.join(root, "music");
  fs.mkdirSync(recipes); fs.mkdirSync(library);
  const ids = ["tech", "warm", "energy"];
  const subtitles = ["noto-sans-sc-variable", "noto-serif-sc-variable", "lxgw-wen-kai"];
  const covers = ["source-han-sans-cn-heavy", "zcool-xiaowei", "smiley-sans-oblique"];
  process.env.WORKLOOM_POST_VARIANT_DIR = recipes;
  try {
    const { buildDeliveryPackage, planDelivery, readRevisionBase, reedit, resolveBinaries } = await import("./core.mjs");
    const { inspectDeliveryManifest } = await import("./quality-gate.mjs");
    const bins = resolveBinaries();
    const ffmpeg = (args) => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", ...args], { stdio: "pipe", timeout: 30_000 });
    const media = (file) => JSON.parse(execFileSync(bins.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
    const packs = ids.map((id, index) => ({ schemaVersion: "workloom.style-variant/v1", id, name: id,
      color: { profile: ["cool-technical", "warm-film", "high-contrast-social"][index], intensity: 0.15 },
      transitions: { mode: "hard" },
      bgm: { trackId: `fixture-${id}`, policy: "keep-dialogue", musicLevelDb: -24, targetLufs: -14, section: "full", fadeInSec: 0.1, fadeOutSec: 0.1 },
      cover: { title: ["参数先看", "骑行日常", "点燃热爱"][index], hook: ["看清真实细节", "让路程有温度", "把热爱放进生活"][index],
        fontId: covers[index], alignment: [8, 2, 5][index], marginRatio: 0.12, at: [0.2, 0.5, 0.8][index] },
      subtitleStyle: { fontId: subtitles[index] }, copy: { titleTemplate: "{title}", tone: id },
    }));
    write(path.join(recipes, "index.json"), { defaults: ids, variants: ids.map(id => ({ id, file: `${id}.json` })) });
    packs.forEach(pack => write(path.join(recipes, `${pack.id}.json`), pack));
    const tracks = ids.map((id, index) => {
      const file = `${id}.wav`;
      ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${550 + index * 230}:duration=5`, "-c:a", "pcm_s16le", path.join(library, file)]);
      return { id: `fixture-${id}`, title: id, file, durationSec: 5, style: "fixture", mood: "fixture",
        license: "workloom-self-generated", source: "offline-synthetic-fixture", artist: "test fixture" };
    });
    write(path.join(library, "tracks.json"), { tracks });
    const source = path.join(root, "single-source-batch.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24:duration=2.5", "-f", "lavfi", "-i", "sine=frequency=330:duration=2.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    const sourceHash = hash(source), sourceMtime = fs.statSync(source).mtimeMs;
    const env = { ...process.env, WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: library,
      WORKLOOM_BGM_HOME: path.join(root, "bgm-home"), WORKLOOM_POST_ALLOWED_ROOTS: root, WORKLOOM_BGM_ALLOWED_ROOTS: root };
    const project = { projectId: "font-contract-fixture", title: "同源三风格", platform: "抖音", fps: 24, resolution: [360, 640],
      copy: { title: "同源三风格", hook: "真实本地加工", body: "仅测试合成素材", cta: "查看结果" } };
    const shots = [{ shotId: "S1", path: source }];
    const badRecipe = path.join(recipes, "tech.json");
    for (const fontId of ["missing-font-id", "smiley-sans-oblique", "", null]) {
      write(badRecipe, { ...packs[0], subtitleStyle: { fontId } });
      await assert.rejects(planDelivery({ project, shots, bins }), { code: "font_not_found" });
    }
    write(badRecipe, packs[0]);
    process.env.WORKLOOM_SUBTITLE_FONTS_DIR = path.join(root, "missing-fonts");
    await assert.rejects(planDelivery({ project, shots, bins }), { code: "font_not_found" });
    fs.mkdirSync(path.join(process.env.WORKLOOM_SUBTITLE_FONTS_DIR, "cn"), { recursive: true });
    fs.writeFileSync(path.join(process.env.WORKLOOM_SUBTITLE_FONTS_DIR, "cn", "NotoSansSC-Variable.ttf"), "owned corrupted-font fixture");
    await assert.rejects(planDelivery({ project, shots, bins }), { code: "verify_failed" });
    if (savedFontsDir === undefined) delete process.env.WORKLOOM_SUBTITLE_FONTS_DIR;
    else process.env.WORKLOOM_SUBTITLE_FONTS_DIR = savedFontsDir;
    const delivery = await buildDeliveryPackage({ project, shots, subtitles: { zhText: "1\n00:00:00,100 --> 00:00:02,200\n同一批镜头三种风格\n\n" },
      variants: ids, outDir: path.join(root, "delivery"), burnSubtitles: true, bins, env });
    assert.equal(delivery.passed, true);
    assert.equal(delivery.manifest.postQuality.passed, true);
    assert.deepEqual(delivery.manifest.variants.map(v => v.audio.trackId), ids.map(id => `fixture-${id}`));
    assert.equal(new Set(delivery.manifest.variants.map(v => v.cover.sha256)).size, 3);
    const evidence = delivery.manifest.variants.map((variant, index) => {
      assert.equal(variant.burned.font.selectedFontId, subtitles[index]);
      assert.equal(variant.cover.font.selectedFontId, covers[index]);
      assert.equal(variant.burned.font.allFromFontsDir, true);
      const proof = delivery.manifest.processing.find(row => row.stage === "subtitles" && row.id === `${variant.id}-burned`);
      const document = json(path.join(delivery.outDir, proof.path));
      assert.deepEqual(document.execution.font, variant.burned.font);
      assert.equal(document.parameters.request.fontId, subtitles[index]);
      const video = media(path.join(delivery.outDir, variant.burned.path)).streams.find(row => row.codec_type === "video");
      assert.equal(video.width, 360); assert.equal(video.height, 640); assert.equal(video.avg_frame_rate, "24/1");
      return { id: variant.id, trackId: variant.audio.trackId, subtitleFontId: variant.burned.font.selectedFontId,
        coverFontId: variant.cover.font.selectedFontId, burnedSha256: variant.burned.sha256, coverSha256: variant.cover.sha256,
        assSha256: variant.burned.font.assSha256, fontSelections: variant.burned.font.selections };
    });
    const wrongSub = structuredClone(delivery.manifest);
    wrongSub.variants[0].style.subtitleStyle.fontId = subtitles[1];
    assert.equal((await inspectDeliveryManifest({ root: delivery.outDir, manifest: wrongSub, bins })).passed, false);
    const wrongCover = structuredClone(delivery.manifest);
    wrongCover.variants[0].cover.font.assText += ";modified";
    assert.equal((await inspectDeliveryManifest({ root: delivery.outDir, manifest: wrongCover, bins })).passed, false);
    for (const forgedId of ["noto-sans-sc-variable", "not-a-catalog-font"]) {
      const relabeled = structuredClone(delivery.manifest);
      relabeled.variants[0].style.cover.fontId = forgedId;
      relabeled.variants[0].cover.font.requestedFontId = forgedId;
      relabeled.variants[0].cover.font.selectedFontId = forgedId;
      assert.equal((await inspectDeliveryManifest({ root: delivery.outDir, manifest: relabeled, bins })).passed, false,
        "self-consistent IDs must not redefine the controlled font identity");
    }
    const wrongFontBytes = structuredClone(delivery.manifest);
    wrongFontBytes.variants[0].cover.font.fontFileSha256 = "0".repeat(64);
    assert.equal((await inspectDeliveryManifest({ root: delivery.outDir, manifest: wrongFontBytes, bins })).passed, false);
    const missingProof = structuredClone(delivery.manifest);
    missingProof.processing = missingProof.processing.filter(row => row.id !== "tech-burned");
    assert.equal((await inspectDeliveryManifest({ root: delivery.outDir, manifest: missingProof, bins })).passed, false);
    const revisionBase = (file) => { const state = readRevisionBase(file); return { expectedVersion: state.version, expectedProjectSha256: state.sha256 }; };
    const revision = await reedit({ projectPath: delivery.projectPath, ...revisionBase(delivery.projectPath), bins, env,
      patch: { subtitles: { variantId: "tech", style: { fontId: "zcool-xiaowei" } },
        cover: { variantId: "tech", title: "只改这一版", fontId: "lxgw-wen-kai" } } });
    assert.equal(revision.executed, true);
    assert.deepEqual(revision.variants.map(v => v.video.sha256), delivery.manifest.variants.map(v => v.video.sha256));
    assert.deepEqual(revision.variants.map(v => v.burned.font.selectedFontId), ["zcool-xiaowei", ...subtitles.slice(1)]);
    assert.deepEqual(revision.variants.map(v => v.cover.font.selectedFontId), ["lxgw-wen-kai", ...covers.slice(1)]);
    const copyOnly = await reedit({ projectPath: revision.projectPath, ...revisionBase(revision.projectPath), bins, env,
      patch: { copy: { variantId: "tech", body: "只改文案保留字体" } } });
    assert.equal(copyOnly.executed, true);
    assert.deepEqual(copyOnly.variants.map(v => v.burned.font.selectedFontId), ["zcool-xiaowei", ...subtitles.slice(1)]);
    assert.deepEqual(copyOnly.variants.map(v => v.cover.font.selectedFontId), ["lxgw-wen-kai", ...covers.slice(1)]);
    assert.deepEqual(copyOnly.variants.map(v => v.video.sha256), delivery.manifest.variants.map(v => v.video.sha256));
    assert.equal(hash(source), sourceHash); assert.equal(fs.statSync(source).mtimeMs, sourceMtime);
    assert.equal(media(path.join(delivery.outDir, delivery.manifest.master.path)).streams.some(row => row.codec_type === "subtitle"), false);
    write(path.join(root, "validation-evidence.json"), { passed: true, paidCalls: 0, fixture: "synthetic-local-only", sourceHash,
      sourceBytesAndMtimeUnchanged: true, normalizedSharedSourceCount: delivery.normalised.length, evidence,
      revisionVersions: [revision.version, copyOnly.version], invalidFontCases: 6, requestAndAssTamperRejected: true, missingProofRejected: true });
    console.info(`Local font media evidence: ${path.join(root, "validation-evidence.json")}`);
  } finally {
    if (savedVariantDir === undefined) delete process.env.WORKLOOM_POST_VARIANT_DIR;
    else process.env.WORKLOOM_POST_VARIANT_DIR = savedVariantDir;
    if (savedFontsDir === undefined) delete process.env.WORKLOOM_SUBTITLE_FONTS_DIR;
    else process.env.WORKLOOM_SUBTITLE_FONTS_DIR = savedFontsDir;
    if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
  }
});
