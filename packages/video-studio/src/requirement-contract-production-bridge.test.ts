import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRequirementContractBridge, installVendorRequirementContractBridge } from "./requirement-contract-bridge.js";

const loader = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./vendor-requirement-entry.js", () => ({ acquireVendorRequirementEntry: loader.acquire }));
const directories: string[] = [];
const disposers: Array<() => void> = [];
beforeEach(() => { loader.acquire.mockReset(); });
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wl-contract-production-seam-")); directories.push(root);
  const entry = join(root, "index.js");
  mkdirSync(join(root, "engines"));
  writeFileSync(join(root, "engines/requirement-discovery-engine.js"), `
class RequirementDiscoveryEngine {
  discover() { return { original: true }; }
  _fastMode() { return { originalFallback: true }; }
  generateMarkdown() { return "### 2.1 目标受众画像\\n**主要受众**"; }
}
module.exports = { RequirementDiscoveryEngine };
`);
  class Vendor {
    async _convertDiscoveryToRequirementList() { return { original: true }; }
    _renderRequirementContract() { return "original contract"; }
  }
  const release = vi.fn();
  loader.acquire.mockReturnValue({ exports: { HyperrealitySystem: Vendor }, identity: { entryPath: entry }, release });
  return { entry, Vendor, release };
}

describe("production contract bridge uses the controlled cache authority", () => {
  it("acquires the pinned entry, verifies its constructor and releases only its extra loader holder", () => {
    const f = fixture(), original = f.Vendor.prototype._renderRequirementContract;
    const dispose = installVendorRequirementContractBridge(f.Vendor, f.entry); disposers.push(dispose);
    expect(loader.acquire).toHaveBeenCalledExactlyOnceWith(f.entry);
    expect(f.release).toHaveBeenCalledTimes(1);
    assertRequirementContractBridge(f.Vendor.prototype);
    expect(f.Vendor.prototype._renderRequirementContract).not.toBe(original);
    dispose(); dispose();
    expect(f.Vendor.prototype._renderRequirementContract).toBe(original);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a different constructor and does not patch it or reload a raw entry", () => {
    const f = fixture();
    class Other extends f.Vendor {}
    const native = Other.prototype._renderRequirementContract;
    expect(() => installVendorRequirementContractBridge(Other, f.entry)).toThrow("REQUIREMENT_BRIDGE_CHANGED");
    expect(Other.prototype._renderRequirementContract).toBe(native);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["CACHE_CONFLICT", "SOURCE_MISMATCH", "LOAD_FAILED"])("propagates controlled %s without fallback require", code => {
    const f = fixture(), failure = new Error(`VENDOR_REQUIREMENT_ENTRY_${code}`);
    loader.acquire.mockImplementation(() => { throw failure; });
    expect(() => installVendorRequirementContractBridge(f.Vendor, f.entry)).toThrow(failure);
    expect(f.release).not.toHaveBeenCalled();
  });

  it("releases its extra holder on a real dependency load error without changing vendor methods", () => {
    const f = fixture(), native = f.Vendor.prototype._renderRequirementContract;
    rmSync(join(f.entry, "..", "engines/requirement-discovery-engine.js"));
    expect(() => installVendorRequirementContractBridge(f.Vendor, f.entry)).toThrow(/Cannot find module/);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.Vendor.prototype._renderRequirementContract).toBe(native);
  });
});
