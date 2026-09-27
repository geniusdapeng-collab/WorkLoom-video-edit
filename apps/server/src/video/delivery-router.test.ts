/** Actual tRPC middleware + delivery filesystem; authority lookup and unused DB handles are mocked. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "@workloom/base/tenancy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authority = vi.hoisted(() => vi.fn());
vi.mock("../service/access-authority.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../service/access-authority.js")>(), currentMemberAuthority: authority,
  resolveAuthoritativeClientAccess: async () => ({ navigationPermissions: ["ai-video.media.read"] }),
}));
vi.mock("@workloom/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workloom/db")>(),
  getAppPool: () => ({}), getGatewayPool: () => ({}),
}));
import { videoRouter } from "./router.js";
import { startDeliveryRevision } from "./delivery.js";
import { scopedDeliveryRoot } from "./delivery-trust.js";
import { seedTestPackage, TEST_DELIVERY_SECRET } from "./delivery-fixture.test-support.js";

const owner: Identity = { kind: "member", memberId: "owner", memberNo: "MEM-OWNER", name: "Owner", role: "owner", plan: "pro", tenantId: "tenant-router", workspaceId: "ws-router" };
const scope = { tenantId: owner.tenantId, workspaceId: owner.workspaceId };
const caller = (identity: Identity | null = owner) => videoRouter.createCaller({ identity, session: identity, partnerIdentity: null, headers: new Headers() }).delivery;
const mediaCaller = (identity: Identity | null = owner) => videoRouter.createCaller({ identity, session: identity, partnerIdentity: null, headers: new Headers() }).media;
let root: string;
let pkg: string;
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-router-"));
  previous = Object.fromEntries(["WORKLOOM_DELIVERY_DIR", "WORKLOOM_DELIVERY_SIGNING_SECRET", "WORKLOOM_POST_BRIDGE_CLI"].map((key) => [key, process.env[key]]));
  process.env.WORKLOOM_DELIVERY_DIR = root;
  process.env.WORKLOOM_DELIVERY_SIGNING_SECRET = TEST_DELIVERY_SECRET;
  pkg = join(scopedDeliveryRoot(root, scope), "PKG-1");
  seedTestPackage(pkg, scope);
  authority.mockReset().mockImplementation(async (identity) => ({ identity, permissions: {} }));
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("delivery routes derive scope from the authenticated identity", () => {
  it("own package is visible and downloadable through actual route handlers", async () => {
    expect(await caller().list({ limit: 20 })).toHaveLength(1);
    expect(await caller().get({ dir: "PKG-1" })).toMatchObject({ projectId: "P1", passed: true });
    const artifact = await caller().artifact({ dir: "PKG-1", ref: "master.mp4" });
    expect(Buffer.from(artifact.base64, "base64")).toEqual(readFileSync(join(pkg, "master.mp4")));
  });
  it.each([{ workspaceId: "other-workspace" }, { tenantId: "other-tenant" }])("all package routes isolate %j", async (changed) => {
    const other = caller({ ...owner, ...changed });
    expect(await other.list({ limit: 20 })).toEqual([]);
    await expect(other.get({ dir: "PKG-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.artifact({ dir: "PKG-1", ref: "master.mp4" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.selectVariant({ dir: "PKG-1", variantId: "a" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.triage({ dir: "PKG-1", feedback: "修改字幕", record: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.startRevision({ dir: "PKG-1", patch: { copy: { title: "test" } } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await other.job({ jobId: "unknown" })).toBeNull();
    expect(await other.jobs({ dir: "PKG-1" })).toEqual([]);
  });
  it("ignores forged tenant/workspace fields in client input", async () => {
    const other = caller({ ...owner, workspaceId: "other" });
    await expect(other.get({ dir: "PKG-1", scope, tenantId: owner.tenantId, workspaceId: owner.workspaceId } as never))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("blocks unauthenticated reads and readonly writes before filesystem mutations", async () => {
    await expect(caller(null).list({ limit: 20 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(null).artifact({ dir: "PKG-1", ref: "master.mp4" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const readOnly = caller({ ...owner, role: "readonly" });
    await expect(readOnly.selectVariant({ dir: "PKG-1", variantId: "a" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readOnly.triage({ dir: "PKG-1", feedback: "字幕", record: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readOnly.startRevision({ dir: "PKG-1", patch: { copy: { title: "x" } } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("draft packages return a business rejection on selection", async () => {
    rmSync(join(pkg, "delivery-seal.json"));
    await expect(caller().selectVariant({ dir: "PKG-1", variantId: "a" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("media ingestion rejects drafts, escaping paths and other scopes with business codes before DB writes", async () => {
    rmSync(join(pkg, "delivery-seal.json"));
    await expect(mediaCaller().ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(mediaCaller().ingestDelivery({ dir: "../PKG-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mediaCaller({ ...owner, workspaceId: "other" }).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mediaCaller({ ...owner, tenantId: "other" }).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("media ingestion requires both authentication and workspace write access", async () => {
    await expect(mediaCaller(null).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(mediaCaller({ ...owner, role: "readonly" }).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("isolates real revision job IDs and never notifies completion after failed exit", async () => {
    const cli = join(root, "test-revision-cli.mjs");
    const release = join(root, "release-test-revision");
    writeFileSync(cli, `import { existsSync } from "node:fs"; console.log("返修完成：v2 → /fake"); setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(2); }, 20);`);
    process.env.WORKLOOM_POST_BRIDGE_CLI = cli;
    const completed = vi.fn();
    const job = await startDeliveryRevision({ dir: "PKG-1", patch: { copy: { title: "test" } }, scope, onCompleted: completed });
    expect(await caller().job({ jobId: job.jobId })).toMatchObject({ jobId: job.jobId });
    const other = caller({ ...owner, tenantId: "other" });
    expect(await other.job({ jobId: job.jobId })).toBeNull();
    expect(await other.jobs({ dir: "PKG-1" })).toEqual([]);
    expect((await caller().jobs({ dir: "PKG-1" })).some((row) => row.jobId === job.jobId)).toBe(true);
    try {
      await vi.waitFor(() => expect(job.logTail.some((line) => line.includes("返修完成"))).toBe(true), { timeout: 10_000 });
      expect(job.status).toBe("running");
    } finally {
      writeFileSync(release, "release");
    }
    await vi.waitFor(() => expect(job.status).toBe("failed"), { timeout: 10_000 });
    expect(job.exitCode).toBe(2);
    expect(completed).not.toHaveBeenCalled();
  }, 30_000);
});
