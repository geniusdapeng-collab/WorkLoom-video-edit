import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCharacterEntry, loadCharacterLibrary, resolveShotCast } from "./character-archive.js";

/**
 * 随仓内置角色库的门禁（T-2026-0928-0002）：
 *   ① 1 号李英子是唯一默认；2 号陈卓、3 号林予安保留独立身份和原路径；
 *   ② 原创虚构 AI 角色档案可装载、8 角度齐备、按名字可解析；
 *   ③ 清单里每个内置模特都要有可解析档案（防止"只加清单不加资产"）。
 */
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const CHARACTERS_ROOT = resolve(REPO_ROOT, "bundles/ai-video/library/characters");

describe("随仓内置角色库", () => {
  const registry = JSON.parse(readFileSync(resolve(CHARACTERS_ROOT, "registry.json"), "utf8")) as {
    defaultModel: string;
    models: Array<{ ordinal: number; id: string; name: string; archive: string }>;
  };

  it("默认模特是1号李英子；陈卓改2号，林予安顺延3号", () => {
    expect(registry.defaultModel).toBe("young-rider-01");
    expect(registry.models.map((model) => [model.ordinal, model.id]))
      .toEqual([[1, "young-rider-01"], [2, "chen-zhuo"], [3, "lin-yu-an"]]);
  });

  it("登记的内置模特都有可装载档案；必需角度齐备，声明了标准 8 角度的必须 8 角度齐备", () => {
    const required = ["front", "threeQuarter", "closeup", "side"];
    /** 随仓内置模特承诺标准8角度齐备。目录前缀不承担当前编号语义。 */
    const declined = [...required, "back", "actionPose", "emotionCloseup", "handDetail"];
    for (const model of registry.models) {
      const entry = loadCharacterEntry(resolve(REPO_ROOT, model.archive));
      expect(entry, model.id).not.toBeNull();
      expect(entry!.id).toBe(model.id);
      expect((entry as unknown as { ordinal: number }).ordinal).toBe(model.ordinal);
      expect(entry!.verification.status, `${model.id}: ${entry!.verification.issues.join("；")}`).toBe("passed");
      for (const angle of declined) {
        expect(Object.keys(entry!.files), `${model.id} ${angle}`).toContain(angle);
      }
    }
  });

  it("3号林予安按姓名可解析，且是原创虚构AI角色", () => {
    const library = loadCharacterLibrary(CHARACTERS_ROOT);
    expect([...library.keys()]).toEqual(expect.arrayContaining(["chen-zhuo", "lin-yu-an"]));
    const profile = JSON.parse(readFileSync(resolve(CHARACTERS_ROOT, "model-02-lin-yu-an/profile.json"), "utf8")) as { kind: string; id: string };
    expect(profile.kind).toBe("generated");
    const cast = resolveShotCast({ shotId: "S1", character: "林予安" }, [...library.values()].map((entry) => ({
      id: entry.id, name: entry.name, aliases: entry.aliases
    })));
    expect(cast.characters.map((character) => character.id)).toEqual(["lin-yu-an"]);
  });

  it("默认1号是本次新创作的虚构AI人物，按姓名绑定而不冒充真人授权", () => {
    const entry = loadCharacterEntry(resolve(CHARACTERS_ROOT, "model-01-young-rider"))!;
    expect(entry.kind).toBe("generated");
    expect(entry.subjectType).toBe("synthetic-digital-human");
    expect(entry.authorization?.status).toBe("synthetic-no-real-person");
    const wardrobeBound = loadCharacterEntry(entry.dir, { wardrobeId: "w1" })!;
    expect(wardrobeBound.verification.status).toBe("passed");
    expect(Object.keys(wardrobeBound.files)).toHaveLength(8);
    const wrongWardrobe = loadCharacterEntry(entry.dir, { wardrobe: { id: "other", name: "红色短裙" } })!;
    expect(wrongWardrobe.verification.status).toBe("unverified");
    expect(wrongWardrobe.files).toEqual({});
    const cast = resolveShotCast({ shotId: "S1", character: "李英子" }, [entry]);
    expect(cast.characters.map((character) => character.id)).toEqual([registry.defaultModel]);
    expect(entry.activeSet?.version).toBe(2);
    expect(entry.activeSet?.source).toBe("pure-t2i");
    expect(entry.verification.scope).toBe("legacy-current-bytes-only");
    const currentSet = entry.activeSet as unknown as { provenanceFile: string };
    expect(currentSet.provenanceFile).toBe("provenance/v2.json");
    const provenance = JSON.parse(readFileSync(resolve(entry.dir, currentSet.provenanceFile), "utf8"));
    expect(provenance.portraitVersion).toBe(2);
    expect(provenance.generationMode).toBe("eight-independent-pure-text-to-image");
    expect(provenance.commissioning.selectedOutputs).toBe(8);
    expect(provenance.commissioning.totalProviderCalls).toBe(8 + provenance.commissioning.excludedOutputs.length);
    expect(provenance.externalRealPersonReferences).toEqual([]);
    expect(provenance.existingCharacterReferences).toEqual([]);
    expect(provenance.angles).toHaveLength(8);
    for (const asset of provenance.angles) {
      expect(asset.output.sha256).toBe(entry.verification.assets[asset.angle]!.sha256);
      expect(asset.output.bytes).toBe(entry.verification.assets[asset.angle]!.bytes);
      expect(asset.request.referenceImages).toEqual([]);
      expect(asset.request.referenceImageCount).toBe(0);
      expect(asset.request.externalRealPersonReferenceCount).toBe(0);
      expect(asset.request.image).toBeUndefined();
      expect(asset.response.model).toBe(entry.activeSet!.model);
      expect(Number.isInteger(asset.response.created)).toBe(true);
      expect(asset.response.providerTaskId).toBeNull();
      const receiptBytes = readFileSync(resolve(entry.dir, asset.originalReceipt.file));
      expect(createHash("sha256").update(receiptBytes).digest("hex")).toBe(asset.originalReceipt.sha256);
      const dispatchBytes = readFileSync(resolve(entry.dir, asset.dispatchRecord.file));
      expect(createHash("sha256").update(dispatchBytes).digest("hex")).toBe(asset.dispatchRecord.sha256);
      const dispatch = JSON.parse(dispatchBytes.toString("utf8"));
      expect(dispatch.imageInputPresent).toBe(false);
      expect(dispatch.attempt).toBe(1);
      expect(createHash("sha256").update(JSON.stringify(dispatch.request)).digest("hex")).toBe(dispatch.requestSha256);
    }
    // v1 is historical image_gen lineage: front T2I, seven new-AI-master I2I.
    const historical = loadCharacterEntry(entry.dir, { pinnedVersion: 1 })!;
    expect(historical.verification.status).toBe("passed");
    expect(historical.activeSet?.source).toBe("img2img");
    const original = JSON.parse(readFileSync(resolve(entry.dir, "provenance.json"), "utf8"));
    expect(original.tool).toBe("image_gen");
    expect(original.master.referenceImageCount).toBe(0);
    expect(original.angles).toHaveLength(8);
    for (const asset of original.angles) {
      expect(asset.output.sha256).toBe(historical.verification.assets[asset.angle]!.sha256);
      expect(asset.output.bytes).toBe(historical.verification.assets[asset.angle]!.bytes);
      expect(asset.request.referenceImages).toHaveLength(asset.angle === "front" ? 0 : 1);
      if (asset.angle !== "front") expect(asset.request.referenceImages[0].sha256).toBe(original.master.sha256);
    }
  });
});
