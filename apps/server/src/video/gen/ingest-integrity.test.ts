import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { storeLocalFile } from "./ingest.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
describe("本地产物内容地址完整性", () => {
  it("损坏的同名缓存重新入库必须恢复原始字节，返回摘要等于媒体仓实际摘要", () => {
    const root = mkdtempSync(join(tmpdir(), "render-integrity-")); roots.push(root);
    vi.stubEnv("WORKLOOM_MEDIA_DIR", join(root, "media"));
    const source = join(root, "source.mp4"); writeFileSync(source, "issued-original-bytes");
    const first = storeLocalFile(source, { workspaceId: "ws-integrity" });
    writeFileSync(first.absPath, "corrupted-cache");
    const next = storeLocalFile(source, { workspaceId: "ws-integrity" });
    expect(readFileSync(next.absPath)).toEqual(readFileSync(source));
    expect(sha(readFileSync(next.absPath))).toBe(next.sha256);
    expect(readFileSync(next.absPath).length).toBe(next.bytes);
    expect(storeLocalFile(source, { workspaceId: "ws-integrity" })).toEqual(next);
  });
  it("FIFO非普通文件在隔离子进程里立即拒绝，不阻塞服务事件循环", () => {
    const root = mkdtempSync(join(tmpdir(), "render-fifo-")); roots.push(root);
    const fifo = join(root, "source.fifo"); execFileSync("mkfifo", [fifo]);
    const source = new URL("./ingest.ts", import.meta.url).href;
    const script = `import { storeLocalFile } from ${JSON.stringify(source)}; try { storeLocalFile(${JSON.stringify(fifo)}, { workspaceId: 'ws-fifo' }); } catch (error) { if (!/文件/.test(String(error))) throw error; process.exit(0); } process.exit(2);`;
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { timeout: 2_000, encoding: "utf8" });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  });
  it("超限/空源不产生可接受的内容地址收据", () => {
    const root = mkdtempSync(join(tmpdir(), "render-integrity-")); roots.push(root);
    vi.stubEnv("WORKLOOM_MEDIA_DIR", join(root, "media"));
    const source = join(root, "source.mp4"); writeFileSync(source, "issued-original-bytes");
    expect(() => storeLocalFile(source, { workspaceId: "ws-integrity", maxBytes: 1 })).toThrow("超过大小上限");
    writeFileSync(source, "");
    expect(() => storeLocalFile(source, { workspaceId: "ws-integrity" })).toThrow(/空|非空/);
  });
});
