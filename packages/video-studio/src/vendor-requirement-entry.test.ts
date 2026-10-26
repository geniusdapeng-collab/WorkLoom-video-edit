import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { Module, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireVendorRequirementEntry,
  createVendorRequirementEntryLoader,
  type VendorRequirementEntryLease,
  type VendorRequirementEntryPolicy,
} from "./vendor-requirement-entry.js";

const anchor = "const requirementList = this._convertDiscoveryToRequirementList(discoveryResult, upstreamFields);";
const replacement = "const requirementList = await this._convertDiscoveryToRequirementList(discoveryResult, upstreamFields, metadata);";
const roots: string[] = [];

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function policyFor(source: string): VendorRequirementEntryPolicy {
  const transformed = source.split(anchor).join(replacement);
  return {
    sourceSha256: digest(source),
    sourceBytes: Buffer.byteLength(source),
    transformedSha256: digest(transformed),
    transformedBytes: Buffer.byteLength(transformed),
    anchor,
    replacement,
    patchId: "test.g3-requirement-await/v1",
  };
}

const fixtureSource = `
const helper = require('./helper.cjs');
helper.evaluations += 1;
exports.started = true;
const cycle = require('./cycle.cjs');
class HyperrealitySystem {
  static signalHandlersInstalled = false;
  async _convertDiscoveryToRequirementList(discoveryResult, upstreamFields, metadata) {
    this.events.push('converter-start');
    await new Promise(resolve => setTimeout(resolve, 12));
    this.events.push('converter-end');
    return { discoveryResult, upstreamFields, metadata, resolved: true };
  }
  constructor() {
    this.events = [];
    if (!HyperrealitySystem.signalHandlersInstalled) {
      helper.signalRegistrations += 1;
      helper.signals.on('shutdown', () => undefined);
      HyperrealitySystem.signalHandlersInstalled = true;
    }
  }
  async create(discoveryResult, upstreamFields, metadata) {
    ${anchor}
    if (!requirementList.resolved || typeof requirementList.then === 'function') {
      throw new Error('PROMISE_LEAKED_INTO_CONSUMER');
    }
    this.events.push('consumer');
    return requirementList;
  }
}
exports.HyperrealitySystem = HyperrealitySystem;
exports.context = {
  filename: __filename,
  dirname: __dirname,
  id: module.id,
  moduleFilename: module.filename,
  loadedDuringEvaluation: module.loaded,
  exportsIsThis: this === exports,
  helperPath: require.resolve('./helper.cjs'),
};
exports.helper = helper;
exports.cycle = cycle;
`;

type FixtureResult = {
  discoveryResult: unknown;
  upstreamFields: unknown;
  metadata: unknown;
  resolved: boolean;
};
type FixtureInstance = {
  events: string[];
  create: (discovery: unknown, upstream: unknown, metadata: unknown) => Promise<FixtureResult>;
};
type FixtureExports = {
  HyperrealitySystem: new () => FixtureInstance;
  started: boolean;
  helper: { evaluations: number; signalRegistrations: number; signals: { listenerCount: (event: string) => number } };
  cycle: { entry: FixtureExports; startedDuringCycle: boolean; constructorDuringCycle: unknown };
  context: Record<string, unknown>;
};

function fixture(source = fixtureSource, policyOverride: Partial<VendorRequirementEntryPolicy> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vendor-requirement-entry-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"commonjs"}\n');
  const entry = join(root, "entry.cjs");
  writeFileSync(entry, source);
  writeFileSync(join(root, "helper.cjs"), "module.exports = { evaluations: 0, signalRegistrations: 0, signals: new (require('node:events').EventEmitter)() };\n");
  writeFileSync(join(root, "cycle.cjs"), `
const entry = require('./entry.cjs');
module.exports = { entry, startedDuringCycle: entry.started, constructorDuringCycle: Object.getOwnPropertyDescriptor(entry, 'HyperrealitySystem')?.value };
`);
  const policy = { ...policyFor(source), ...policyOverride };
  return { root, entry, source, policy, acquire: createVendorRequirementEntryLoader(policy), require: createRequire(entry) };
}

function fixtureExports(lease: VendorRequirementEntryLease): FixtureExports {
  return lease.exports as unknown as FixtureExports;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const fixtureRequire = createRequire(join(root, "entry.cjs"));
    for (const cacheKey of Object.keys(fixtureRequire.cache)) {
      if (cacheKey.startsWith(`${root}/`)) delete fixtureRequire.cache[cacheKey];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("controlled vendor requirement entry", () => {
  it("awaits the delayed real converter before consumption and passes the exact metadata", async () => {
    const test = fixture();
    const originalBytes = readFileSync(test.entry);
    const lease = test.acquire(test.entry);
    const system = new (fixtureExports(lease).HyperrealitySystem)();
    const discovery = { answer: "产品事实" };
    const upstream = { characters: [{ id: "synthetic-lead", kind: "generated" }] };
    const metadata = { contract: { characters: [{ id: "synthetic-lead" }], unknown: null } };
    const pending = system.create(discovery, upstream, metadata);
    expect(system.events).toEqual(["converter-start"]);
    const result = await pending;
    expect(system.events).toEqual(["converter-start", "converter-end", "consumer"]);
    expect(result.discoveryResult).toBe(discovery);
    expect(result.upstreamFields).toBe(upstream);
    expect(result.metadata).toBe(metadata);
    expect(readFileSync(test.entry)).toEqual(originalBytes);
    expect(digest(readFileSync(test.entry))).toBe(test.policy.sourceSha256);
    expect(lease.identity).toEqual({
      entryPath: test.entry,
      sourceSha256: test.policy.sourceSha256,
      transformedSha256: test.policy.transformedSha256,
      patchId: test.policy.patchId,
    });
    expect(Object.isFrozen(lease.identity)).toBe(true);
    expect(Object.isFrozen(lease)).toBe(true);
    lease.release();
  });

  it("preserves original CJS path, relative require, exports-this, and circular cache behavior", () => {
    const test = fixture();
    const lease = test.acquire(test.entry);
    const exported = fixtureExports(lease);
    expect(exported.context).toEqual({
      filename: test.entry,
      dirname: dirname(test.entry),
      id: test.entry,
      moduleFilename: test.entry,
      loadedDuringEvaluation: false,
      exportsIsThis: true,
      helperPath: join(test.root, "helper.cjs"),
    });
    expect(exported.cycle.startedDuringCycle).toBe(true);
    expect(exported.cycle.constructorDuringCycle).toBeUndefined();
    expect(exported.cycle.entry).toBe(exported);
    expect(test.require(test.entry)).toBe(exported);
    expect(test.require.cache[test.entry]?.exports).toBe(exported);
    expect(test.require.cache[test.entry]?.loaded).toBe(true);
    expect(exported.helper.evaluations).toBe(1);
    const symbols = Object.getOwnPropertySymbols(test.require.cache[test.entry]!);
    const marker = symbols.map((key) => Object.getOwnPropertyDescriptor(test.require.cache[test.entry]!, key))
      .find((descriptor) => descriptor?.value?.identity === lease.identity);
    expect(marker).toMatchObject({ writable: false, configurable: false, enumerable: false });
    expect(Object.isFrozen(marker?.value)).toBe(true);
    lease.release();
  });

  it("shares one constructor across overlapping holders and retains it after idempotent release", async () => {
    const test = fixture();
    const first = test.acquire(test.entry);
    const second = test.acquire(test.entry);
    expect(second.exports).toBe(first.exports);
    expect(second.identity).toBe(first.identity);
    const firstSystem = new (fixtureExports(first).HyperrealitySystem)();
    const secondSystem = new (fixtureExports(second).HyperrealitySystem)();
    const a = firstSystem.create("first", {}, { holder: 1 });
    const b = secondSystem.create("second", {}, { holder: 2 });
    first.release();
    first.release();
    expect(test.require(test.entry)).toBe(second.exports);
    expect((await Promise.all([a, b])).map((result) => result.discoveryResult)).toEqual(["first", "second"]);
    second.release();
    const third = test.acquire(test.entry);
    expect(third.exports.HyperrealitySystem).toBe(first.exports.HyperrealitySystem);
    new (fixtureExports(third).HyperrealitySystem)();
    expect(fixtureExports(third).helper.evaluations).toBe(1);
    expect(fixtureExports(third).helper.signalRegistrations).toBe(1);
    expect(fixtureExports(third).helper.signals.listenerCount("shutdown")).toBe(1);
    expect(test.require.cache[test.entry]).toBeDefined();
    third.release();
  });

  it("uses one real cache key for an alias and never writes the source file", () => {
    const test = fixture();
    const alias = join(test.root, "alias.cjs");
    symlinkSync(test.entry, alias);
    const before = readFileSync(test.entry);
    const a = test.acquire(alias);
    const b = test.acquire(test.entry);
    expect(a.identity.entryPath).toBe(test.entry);
    expect(a.exports).toBe(b.exports);
    expect(test.require.cache[alias]).toBeUndefined();
    expect(readFileSync(test.entry)).toEqual(before);
    a.release();
    b.release();
  });

  it("rejects an ordinary unpatched preloaded module without deleting or replacing it", () => {
    const test = fixture();
    const ordinary = test.require(test.entry) as FixtureExports;
    const cached = test.require.cache[test.entry];
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_CACHE_CONFLICT");
    expect(test.require.cache[test.entry]).toBe(cached);
    expect(test.require(test.entry)).toBe(ordinary);
    expect(ordinary.helper.evaluations).toBe(1);
  });

  it("rejects a separately owned marked module rather than creating a second class", () => {
    const test = fixture();
    const first = test.acquire(test.entry);
    const otherLoader = createVendorRequirementEntryLoader(test.policy);
    expect(() => otherLoader(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_CACHE_CONFLICT");
    expect(test.require(test.entry)).toBe(first.exports);
    expect(fixtureExports(first).helper.evaluations).toBe(1);
    first.release();
  });

  it.each(["module", "exports", "constructor", "constructor-getter", "loaded", "filename", "id", "deleted"])(
    "fails closed when the owned cache %s identity is tampered with", (kind) => {
      const test = fixture();
      const first = test.acquire(test.entry);
      const cached = test.require.cache[test.entry]!;
      if (kind === "module") test.require.cache[test.entry] = new Module(test.entry);
      if (kind === "exports") cached.exports = { ...first.exports };
      if (kind === "constructor") cached.exports.HyperrealitySystem = class Other {};
      if (kind === "constructor-getter") Object.defineProperty(cached.exports, "HyperrealitySystem", { get: () => first.exports.HyperrealitySystem });
      if (kind === "loaded") cached.loaded = false;
      if (kind === "filename") cached.filename = `${test.entry}.other`;
      if (kind === "id") cached.id = `${test.entry}.other`;
      if (kind === "deleted") delete test.require.cache[test.entry];
      const afterTamper = test.require.cache[test.entry];
      expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_CACHE_CONFLICT");
      expect(test.require.cache[test.entry]).toBe(afterTamper);
      expect(fixtureExports(first).helper.evaluations).toBe(1);
      first.release();
      first.release();
    },
  );

  it("rechecks disk bytes for every acquire and preserves the existing cache on source drift", () => {
    const test = fixture();
    const first = test.acquire(test.entry);
    const cached = test.require.cache[test.entry];
    writeFileSync(test.entry, test.source + " ");
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_SOURCE_MISMATCH");
    writeFileSync(test.entry, test.source.replace("converter-start", "converter-other"));
    expect(Buffer.byteLength(readFileSync(test.entry))).toBe(test.policy.sourceBytes);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_SOURCE_MISMATCH");
    expect(test.require.cache[test.entry]).toBe(cached);
    expect(test.require(test.entry)).toBe(first.exports);
    first.release();
  });

  it("fails closed on a missing source even with an existing ready module", () => {
    const test = fixture();
    const first = test.acquire(test.entry);
    const cached = test.require.cache[test.entry];
    unlinkSync(test.entry);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_PATH_INVALID");
    expect(test.require.cache[test.entry]).toBe(cached);
    expect(cached?.exports).toBe(first.exports);
    first.release();
  });

  it.each(["missing", "duplicate"])("rejects a %s exact patch anchor before evaluation", (kind) => {
    const source = kind === "missing" ? fixtureSource.replace(anchor, "const requirementList = {};" )
      : `${fixtureSource}\n// ${anchor}\n`;
    const test = fixture(source);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_PATCH_MISMATCH");
    expect(test.require.cache[test.entry]).toBeUndefined();
    expect(test.require.cache[join(test.root, "helper.cjs")]).toBeUndefined();
  });

  it("rejects a wrong transformed digest before compiling or caching", () => {
    const test = fixture(fixtureSource, { transformedSha256: "0".repeat(64) });
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_PATCH_MISMATCH");
    expect(test.require.cache[test.entry]).toBeUndefined();
  });

  it("rejects wrong source digest and byte count before evaluating dependencies", () => {
    const digestMismatch = fixture(fixtureSource, { sourceSha256: "0".repeat(64) });
    const lengthMismatch = fixture(fixtureSource, { sourceBytes: Buffer.byteLength(fixtureSource) + 1 });
    for (const test of [digestMismatch, lengthMismatch]) {
      expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_SOURCE_MISMATCH");
      expect(test.require.cache[test.entry]).toBeUndefined();
      expect(test.require.cache[join(test.root, "helper.cjs")]).toBeUndefined();
    }
  });

  it("removes only its unready placeholder after compile failure and prevents implicit retry", () => {
    const test = fixture(`${fixtureSource}\n)\n`);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_COMPILE_FAILED");
    expect(test.require.cache[test.entry]).toBeUndefined();
    expect(test.require.cache[join(test.root, "helper.cjs")]).toBeUndefined();
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_LOAD_FAILED");
    expect(readFileSync(test.entry, "utf8")).toBe(test.source);
  });

  it("does not re-evaluate top-level side effects after an evaluation error", () => {
    const source = fixtureSource.replace("exports.started = true;", "throw new Error('FIXTURE_TOP_LEVEL_FAILURE');");
    const test = fixture(source);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_LOAD_FAILED");
    const helper = test.require(join(test.root, "helper.cjs")) as { evaluations: number };
    expect(helper.evaluations).toBe(1);
    expect(test.require.cache[test.entry]).toBeUndefined();
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_LOAD_FAILED");
    expect(helper.evaluations).toBe(1);
  });

  it("does not delete a foreign cache replacement made during failed initialization", () => {
    const source = `${fixtureSource}\nrequire.cache[__filename] = { id: __filename, filename: __filename, loaded: true, exports: { foreign: true } };\n`;
    const test = fixture(source);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_CACHE_CONFLICT");
    const replacementModule = test.require.cache[test.entry];
    expect(replacementModule?.exports).toEqual({ foreign: true });
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_LOAD_FAILED");
    expect(test.require.cache[test.entry]).toBe(replacementModule);
  });

  it("removes its own unready slot if evaluation corrupts the module identity", () => {
    const test = fixture(`${fixtureSource}\nmodule.id = 'incorrect-module-id';\n`);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_CACHE_CONFLICT");
    expect(test.require.cache[test.entry]).toBeUndefined();
    const helper = test.require(join(test.root, "helper.cjs")) as { evaluations: number };
    expect(helper.evaluations).toBe(1);
    expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_LOAD_FAILED");
    expect(helper.evaluations).toBe(1);
  });

  it.each(["{}", "{ HyperrealitySystem: () => ({}) }", "Object.create({ HyperrealitySystem: class Inherited {} })"])(
    "rejects invalid or inherited constructor exports %s", (exportsExpression) => {
      const test = fixture(`${fixtureSource}\nmodule.exports = ${exportsExpression};\n`);
      expect(() => test.acquire(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_EXPORT_INVALID");
      expect(test.require.cache[test.entry]).toBeUndefined();
    },
  );

  it("copies fixture policy and cannot override the production pin", () => {
    const test = fixture();
    test.policy.sourceSha256 = "0".repeat(64);
    const lease = test.acquire(test.entry);
    expect(fixtureExports(lease).helper.evaluations).toBe(1);
    expect(() => acquireVendorRequirementEntry(test.entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_SOURCE_MISMATCH");
    expect(test.require(test.entry)).toBe(lease.exports);
    lease.release();
  });

  it("rejects malformed policy and invalid entry paths without creating cache state", () => {
    expect(() => createVendorRequirementEntryLoader({ ...policyFor(fixtureSource), anchor: "" }))
      .toThrow("VENDOR_REQUIREMENT_ENTRY_POLICY_INVALID");
    const test = fixture();
    for (const entry of ["./entry.cjs", "", `${test.entry}\0`, resolve(test.root, "missing.cjs"), test.root]) {
      expect(() => test.acquire(entry)).toThrow("VENDOR_REQUIREMENT_ENTRY_PATH_INVALID");
    }
    expect(test.require.cache[test.entry]).toBeUndefined();
  });
});
