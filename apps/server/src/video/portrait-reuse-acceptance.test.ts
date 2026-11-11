import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { acceptPortraitArchiveReuse, loadPortraitReuseManifest, portraitReuseEvidence, verifyPortraitArchiveReuseAcceptance } from "./portrait-reuse-acceptance.js";
import { portraitReuseFixture } from "./portrait-reuse.test-support.js";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), "portrait-reuse-acceptance-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe("既有合成角色的独立复用证据", () => {
  it("绑定本次选择、源档案、四角度源图及本项目复制产物，不冒充生成/模型审核", () => {
    const fixture = portraitReuseFixture(dir, "P1");
    expect(loadPortraitReuseManifest(fixture.manifestPath)).toMatchObject({ manifestPath: fixture.manifestPath, approvedSelection: fixture.approvedSelection });
    const proof = acceptPortraitArchiveReuse(fixture.input);
    expect(proof).toMatchObject({ schemaVersion: "workloom.portrait-reuse-acceptance/v1", projectId: "P1", stage: { generatedPortraits: 0, reusedPortraits: 4 } });
    expect(proof.outputs).toHaveLength(4);
    expect(() => verifyPortraitArchiveReuseAcceptance({ ...fixture.input, proof, evidence: portraitReuseEvidence(proof) })).not.toThrow();
    expect(portraitReuseEvidence(proof).filter(item => item.scope === "archive-reuse-image")).toHaveLength(4);
  });
  it("accepts byte-identical alias directories for the same selected identity", () => {
    const f = portraitReuseFixture(dir, "P1");
    const aliasDir = path.join(f.root, "alias", f.manifest.characters[0]!.name);
    mkdirSync(aliasDir, { recursive: true });
    const alias = structuredClone(f.entry);
    for (const angle of ["front", "threeQuarter", "closeup", "side"] as const) {
      const file = path.join(aliasDir, `${angle}.png`);
      writeFileSync(file, readFileSync(f.outputs[angle]!.path));
      const bytes = readFileSync(file);
      const receipt = {
        path: file, realPath: realpathSync(file),
        sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
      };
      alias.files[angle] = file;
      alias.artifacts[angle] = receipt;
      alias.reuseReceipts[angle]!.output = receipt;
    }
    Object.assign(f.index.characters, { [f.manifest.characters[0]!.name]: alias });
    f.persistIndex();
    const proof = acceptPortraitArchiveReuse({ ...f.input, allowAdditionalAngles: true });
    expect(proof.outputs.map(item => item.sha256)).toEqual(
      ["front", "threeQuarter", "closeup", "side"].map(angle => f.outputs[angle]!.sha256),
    );
    expect(proof.outputs.map(item => item.path)).toEqual(
      ["front", "threeQuarter", "closeup", "side"].map(angle => f.outputs[angle]!.path),
    );
  });
  it.each(["missing-selection", "wrong-version", "real-person", "source-change", "profile-change", "manifest-change", "symlink-source", "missing-angle", "output-change", "receipt-source", "receipt-selection", "receipt-project", "receipt-angle", "generated", "pending", "mixed-receipts", "extra-output", "wrong-index-project"])("%s 不能通过或回退新生成", kind => {
    const f = portraitReuseFixture(dir, "P1");
    if (kind === "missing-selection") delete (f.manifest as Record<string, unknown>).approvedSelection;
    if (kind === "wrong-version") f.manifest.approvedSelection.selectedVersion = 3;
    if (kind === "real-person") f.manifest.characters[0]!.authorization.status = "real-person";
    if (["missing-selection", "wrong-version", "real-person"].includes(kind)) writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    if (kind === "source-change") writeFileSync(f.files.front!.path, "source changed");
    if (kind === "profile-change") writeFileSync(f.profile.path, "profile changed");
    if (kind === "manifest-change") writeFileSync(f.manifestPath, `${JSON.stringify(f.manifest)}\n`);
    if (kind === "symlink-source") { rmSync(f.files.front!.path); symlinkSync(f.files.side!.path, f.files.front!.path); }
    if (kind === "missing-angle") delete f.entry.reuseReceipts.side;
    if (kind === "output-change") writeFileSync(f.outputs.front!.path, "output changed");
    if (kind === "receipt-source") f.entry.reuseReceipts.front!.source = f.files.side;
    if (kind === "receipt-selection") f.entry.reuseReceipts.front!.selectionReceipt = { ...f.approvedSelection, rawIntent: "different approval" };
    if (kind === "receipt-project") f.entry.reuseReceipts.front!.projectId = "P2";
    if (kind === "receipt-angle") f.entry.reuseReceipts.front!.angle = "side";
    if (kind === "generated") f.stage.generatedPortraits = 1;
    if (kind === "pending") f.stage.pendingPortraits = 1;
    if (kind === "mixed-receipts") Object.assign(f.entry.receipts, { front: { schemaVersion: "workloom.portrait-cache/v2" } });
    if (kind === "extra-output") Object.assign(f.entry.files, { back: f.outputs.front!.path });
    if (kind === "wrong-index-project") f.index.projectId = "P2";
    f.persistIndex();
    expect(() => acceptPortraitArchiveReuse(f.input)).toThrow();
  });
  it("通过后任一字节变化、证据删减或伪写passed均不能重新核验", () => {
    const f = portraitReuseFixture(dir, "P1"), proof = acceptPortraitArchiveReuse(f.input);
    const evidence = portraitReuseEvidence(proof);
    expect(() => verifyPortraitArchiveReuseAcceptance({ ...f.input, proof, evidence: evidence.slice(1) })).toThrow();
    expect(() => verifyPortraitArchiveReuseAcceptance({ ...f.input, proof: { ...proof, status: "passed" }, evidence })).toThrow();
    writeFileSync(f.indexPath, `${JSON.stringify(f.index)}\n`);
    expect(() => verifyPortraitArchiveReuseAcceptance({ ...f.input, proof, evidence })).toThrow();
  });
  it.each(["real-person", "other-identity"])("即使摘要更新，manifest也不能把%s档案改称选定纯AI角色", kind => {
    const f = portraitReuseFixture(dir, "P1");
    const bytes = Buffer.from(JSON.stringify({ id: kind === "other-identity" ? "someone-else" : "model-01", kind: "generated",
      authorization: { status: kind === "real-person" ? "real-authorized" : "synthetic-no-real-person" } }));
    writeFileSync(f.profile.path, bytes); f.profile.sha256 = createHash("sha256").update(bytes).digest("hex"); f.profile.bytes = bytes.length;
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    expect(() => loadPortraitReuseManifest(f.manifestPath)).toThrow("manifest 不能把其他身份或真人档案改称纯AI角色");
  });
  it.each(["generated", "synthetic-digital-human", "virtual-preset", "authorized-real"])("档案kind=%s仍严格受纯AI授权和ID约束", kind => {
    const f = portraitReuseFixture(dir, "P1");
    const bytes = Buffer.from(JSON.stringify({ id: "model-01", kind, authorization: { status: "synthetic-no-real-person" } }));
    writeFileSync(f.profile.path, bytes); f.profile.sha256 = createHash("sha256").update(bytes).digest("hex"); f.profile.bytes = bytes.length;
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    if (["generated", "synthetic-digital-human"].includes(kind)) expect(() => loadPortraitReuseManifest(f.manifestPath)).not.toThrow();
    else expect(() => loadPortraitReuseManifest(f.manifestPath)).toThrow("manifest 不能把其他身份或真人档案改称纯AI角色");
  });
});
