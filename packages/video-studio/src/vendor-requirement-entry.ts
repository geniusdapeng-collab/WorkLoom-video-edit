import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { Module, createRequire } from "node:module";
import { dirname, isAbsolute } from "node:path";
import { compileFunction } from "node:vm";

/** The constructor is checked at runtime; callers retain their existing vendor interface. */
export type VendorRequirementExports = {
  HyperrealitySystem: new (...args: never[]) => unknown;
};

export type VendorRequirementEntryIdentity = Readonly<{
  entryPath: string;
  sourceSha256: string;
  transformedSha256: string;
  patchId: string;
}>;

export type VendorRequirementEntryLease = Readonly<{
  exports: VendorRequirementExports;
  identity: VendorRequirementEntryIdentity;
  release: () => void;
}>;

/** A separate loader can exercise the same mechanism with inert test fixtures. */
export type VendorRequirementEntryPolicy = Readonly<{
  sourceSha256: string;
  sourceBytes: number;
  transformedSha256: string;
  transformedBytes: number;
  anchor: string;
  replacement: string;
  patchId: string;
}>;

const PRODUCTION_POLICY: VendorRequirementEntryPolicy = Object.freeze({
  sourceSha256: "489171f35ce7cf5fc2cc4387e07380337ea1a574df638533f2b90ed6bd1f86fd",
  sourceBytes: 205980,
  transformedSha256: "583b8b6f82aa3cbda330d2827caa2c7bcdb161f6bb43cddbda3cb7de3e93c8e1",
  transformedBytes: 205996,
  anchor: "const requirementList = this._convertDiscoveryToRequirementList(discoveryResult, upstreamFields);",
  replacement: "const requirementList = await this._convertDiscoveryToRequirementList(discoveryResult, upstreamFields, metadata);",
  patchId: "workloom.g3-requirement-await/v1",
});

function failure(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(`VENDOR_REQUIREMENT_ENTRY_${code}: ${message}`, { cause }), {
    code: `VENDOR_REQUIREMENT_ENTRY_${code}`,
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyPolicy(policy: VendorRequirementEntryPolicy): VendorRequirementEntryPolicy {
  if (!policy || !/^[a-f0-9]{64}$/.test(policy.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(policy.transformedSha256)
    || !Number.isSafeInteger(policy.sourceBytes) || policy.sourceBytes < 1
    || !Number.isSafeInteger(policy.transformedBytes) || policy.transformedBytes < 1
    || typeof policy.anchor !== "string" || policy.anchor.length === 0
    || typeof policy.replacement !== "string" || policy.replacement.length === 0
    || policy.anchor === policy.replacement
    || typeof policy.patchId !== "string" || policy.patchId.trim().length === 0) {
    throw failure("POLICY_INVALID", "a complete immutable source and transform policy is required");
  }
  return Object.freeze({ ...policy });
}

function canonicalEntry(entry: string): string {
  if (typeof entry !== "string" || !isAbsolute(entry) || entry.includes("\0")) {
    throw failure("PATH_INVALID", "entry must be an absolute local file path");
  }
  try {
    const canonical = realpathSync(entry);
    if (!lstatSync(canonical).isFile()) throw new Error("entry is not an ordinary file");
    return canonical;
  } catch (cause) {
    throw failure("PATH_INVALID", "entry cannot be resolved to an ordinary file", cause);
  }
}

/** Hash the opened file and reject a replacement or write during the bounded read. */
function readSource(entry: string, policy: VendorRequirementEntryPolicy): string {
  let descriptor: number | undefined;
  try {
    const namedBefore = lstatSync(entry);
    if (!namedBefore.isFile() || namedBefore.size !== policy.sourceBytes) {
      throw failure("SOURCE_MISMATCH", "source type or byte length differs from the pinned entry");
    }
    descriptor = openSync(entry, "r");
    const openedBefore = fstatSync(descriptor);
    const buffer = Buffer.alloc(policy.sourceBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const bytes = buffer.subarray(0, bytesRead);
    const openedAfter = fstatSync(descriptor);
    const namedAfter = lstatSync(entry);
    const sameFile = [namedBefore, openedBefore, openedAfter, namedAfter].every((stat) =>
      stat.isFile() && stat.dev === namedBefore.dev && stat.ino === namedBefore.ino
      && stat.size === namedBefore.size && stat.mtimeMs === namedBefore.mtimeMs
      && stat.ctimeMs === namedBefore.ctimeMs);
    if (!sameFile || realpathSync(entry) !== entry || bytes.length !== policy.sourceBytes
      || sha256(bytes) !== policy.sourceSha256) {
      throw failure("SOURCE_MISMATCH", "source bytes or file identity differ from the pinned entry");
    }
    return bytes.toString("utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause
      && String(cause.code).startsWith("VENDOR_REQUIREMENT_ENTRY_")) throw cause;
    throw failure("SOURCE_MISMATCH", "pinned entry could not be read consistently", cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function transformSource(source: string, policy: VendorRequirementEntryPolicy): string {
  const parts = source.split(policy.anchor);
  if (parts.length !== 2) {
    throw failure("PATCH_MISMATCH", "the pinned caller must occur exactly once");
  }
  const transformed = parts.join(policy.replacement);
  const bytes = Buffer.from(transformed, "utf8");
  if (bytes.length !== policy.transformedBytes || sha256(bytes) !== policy.transformedSha256) {
    throw failure("PATCH_MISMATCH", "transformed entry differs from the pinned transform");
  }
  return transformed;
}

type OwnedEntry = {
  module: NodeModule;
  exports: VendorRequirementExports;
  constructor: VendorRequirementExports["HyperrealitySystem"];
  identity: VendorRequirementEntryIdentity;
  marker: object;
  state: "loading" | "ready";
  holders: number;
};

/**
 * Independent fixture loaders never alter the production loader's policy or ownership map.
 * The production API below has no environment, RPC, or caller-supplied policy override.
 */
export function createVendorRequirementEntryLoader(policyInput: VendorRequirementEntryPolicy):
  (entry: string) => VendorRequirementEntryLease {
  const policy = copyPolicy(policyInput);
  const owned = new Map<string, OwnedEntry>();
  const failed = new Map<string, Error>();
  const markerKey = Symbol("workloom.vendor-requirement-entry");

  function verifyOwned(entry: string, record: OwnedEntry, cache: NodeJS.Require["cache"]): void {
    const marker = Object.getOwnPropertyDescriptor(record.module, markerKey);
    const constructor = record.module.exports && typeof record.module.exports === "object"
      ? Object.getOwnPropertyDescriptor(record.module.exports, "HyperrealitySystem") : undefined;
    if (record.state !== "ready" || cache[entry] !== record.module || !record.module.loaded
      || record.module.filename !== entry || record.module.id !== entry
      || record.module.exports !== record.exports || constructor?.value !== record.constructor
      || !marker || marker.value !== record.marker || marker.writable || marker.configurable
      || !Object.isFrozen(record.marker)) {
      throw failure("CACHE_CONFLICT", "the owned module, exports, constructor, or marker changed");
    }
  }

  function lease(record: OwnedEntry): VendorRequirementEntryLease {
    record.holders += 1;
    let released = false;
    return Object.freeze({
      exports: record.exports,
      identity: record.identity,
      release: () => {
        if (released) return;
        released = true;
        record.holders -= 1;
        // Keep the ready CJS module for the lifetime of this process. Vendor static
        // instance registries and signal handlers must never acquire a second class.
      },
    });
  }

  return (entryInput: string): VendorRequirementEntryLease => {
    const entry = canonicalEntry(entryInput);
    const source = readSource(entry, policy);
    const transformed = transformSource(source, policy);
    const localRequire = createRequire(entry);
    const previousFailure = failed.get(entry);
    if (previousFailure) {
      throw failure("LOAD_FAILED", "a previous entry evaluation failed; a fresh process is required", previousFailure);
    }
    const existing = owned.get(entry);
    if (existing) {
      verifyOwned(entry, existing, localRequire.cache);
      return lease(existing);
    }
    if (localRequire.cache[entry]) {
      throw failure("CACHE_CONFLICT", "an entry not owned by this loader is already cached");
    }

    const identity: VendorRequirementEntryIdentity = Object.freeze({
      entryPath: entry,
      sourceSha256: policy.sourceSha256,
      transformedSha256: policy.transformedSha256,
      patchId: policy.patchId,
    });
    const cachedModule = new Module(entry);
    cachedModule.filename = entry;
    cachedModule.path = dirname(entry);
    cachedModule.paths = localRequire.resolve.paths("workloom-vendor-entry") ?? [];
    cachedModule.require = localRequire;
    const marker = Object.freeze({ identity });
    Object.defineProperty(cachedModule, markerKey, { value: marker });
    const record: OwnedEntry = {
      module: cachedModule,
      exports: cachedModule.exports as VendorRequirementExports,
      constructor: undefined as unknown as VendorRequirementExports["HyperrealitySystem"],
      identity,
      marker,
      state: "loading",
      holders: 0,
    };
    owned.set(entry, record);
    localRequire.cache[entry] = cachedModule;

    let phase = "COMPILE_FAILED";
    let ready = false;
    try {
      const execute = compileFunction(transformed, ["exports", "require", "module", "__filename", "__dirname"], {
        filename: entry,
      });
      phase = "LOAD_FAILED";
      execute.call(cachedModule.exports, cachedModule.exports, localRequire, cachedModule, entry, dirname(entry));
      if (localRequire.cache[entry] !== cachedModule) {
        throw failure("CACHE_CONFLICT", "entry evaluation replaced its owned cache slot");
      }
      const exported = cachedModule.exports as unknown;
      const constructor = exported && typeof exported === "object"
        ? Object.getOwnPropertyDescriptor(exported, "HyperrealitySystem") : undefined;
      if (!constructor || typeof constructor.value !== "function" || !constructor.value.prototype) {
        throw failure("EXPORT_INVALID", "entry did not export its own HyperrealitySystem constructor");
      }
      record.exports = exported as VendorRequirementExports;
      record.constructor = constructor.value as VendorRequirementExports["HyperrealitySystem"];
      record.state = "ready";
      cachedModule.loaded = true;
      verifyOwned(entry, record, localRequire.cache);
      ready = true;
      return lease(record);
    } catch (cause) {
      const error = cause instanceof Error && "code" in cause
        && String(cause.code).startsWith("VENDOR_REQUIREMENT_ENTRY_")
        ? cause : failure(phase, "the pinned transformed entry could not be initialized", cause);
      // Never remove an unrelated replacement, a ready module, or any dependency.
      if (!ready && localRequire.cache[entry] === cachedModule) {
        cachedModule.loaded = false;
        delete localRequire.cache[entry];
      }
      owned.delete(entry);
      // Top-level evaluation can have side effects before throwing. Do not retry it
      // implicitly and risk a second constructor or duplicate signal registration.
      failed.set(entry, error);
      throw error;
    }
  };
}

const acquireProductionEntry = createVendorRequirementEntryLoader(PRODUCTION_POLICY);

export function acquireVendorRequirementEntry(entry: string): VendorRequirementEntryLease {
  return acquireProductionEntry(entry);
}
