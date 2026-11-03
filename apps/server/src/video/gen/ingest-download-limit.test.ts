import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { downloadToMediaStore } from "./ingest.js";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "download-limit-")); vi.stubEnv("WORKLOOM_MEDIA_DIR", root); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function response(chunks: number, chunkBytes: number, headers: Record<string, string> = {}, status = 200) {
  const seen = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulls === chunks) { controller.close(); return; }
      seen.pulls++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(seen.pulls));
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { seen, fetchImpl: vi.fn(async () => new Response(stream, { status, headers })) as unknown as typeof fetch };
}
describe("供应商产物下载的读取上限", () => {
  it("Content-Length已经超限时取消响应，零body读取且无落盘", async () => {
    const r = response(16, 1, { "content-length": "16" });
    await expect(downloadToMediaStore("https://fixture.invalid/v.mp4", { workspaceId: "ws", maxBytes: 3, fetchImpl: r.fetchImpl })).rejects.toThrow("超过大小上限");
    expect(r.seen).toEqual({ pulls: 0, cancelled: true }); expect(existsSync(join(root, "video"))).toBe(false);
  });
  const untrustedLengthHeaders: Record<string, string>[] = [{}, { "content-length": "1" }];
  it.each(untrustedLengthHeaders)("没有可靠长度%s时逐块计数，越界立即cancel，不读完响应", async headers => {
    const r = response(100, 5, headers);
    await expect(downloadToMediaStore("https://fixture.invalid/v.mp4", { workspaceId: "ws", maxBytes: 7, fetchImpl: r.fetchImpl })).rejects.toThrow("超过大小上限");
    expect(r.seen.cancelled).toBe(true); expect(r.seen.pulls).toBe(2); expect(existsSync(join(root, "video"))).toBe(false);
  });
  it("正好达到上限的正常流完整入库，字节摘要与收据相等", async () => {
    const r = response(3, 2, { "content-type": "video/mp4" });
    const media = await downloadToMediaStore("https://fixture.invalid/v.mp4", { workspaceId: "ws", maxBytes: 6, fetchImpl: r.fetchImpl });
    const bytes = readFileSync(media.absPath); expect(bytes).toEqual(Buffer.from([1, 1, 2, 2, 3, 3]));
    expect(media.bytes).toBe(6); expect(media.sha256).toBe(createHash("sha256").update(bytes).digest("hex")); expect(r.seen.cancelled).toBe(false);
  });
  it("空流不生成成功收据或文件", async () => {
    const r = response(0, 2);
    await expect(downloadToMediaStore("https://fixture.invalid/v.mp4", { workspaceId: "ws", fetchImpl: r.fetchImpl })).rejects.toThrow(/为空|非空/);
    expect(existsSync(join(root, "video"))).toBe(false);
  });
  it("HTTP故障取消未使用body、保留HTTP错误，不落盘", async () => {
    const r = response(16, 1, {}, 503);
    await expect(downloadToMediaStore("https://fixture.invalid/v.mp4", { workspaceId: "ws", fetchImpl: r.fetchImpl })).rejects.toThrow("HTTP 503");
    expect(r.seen).toEqual({ pulls: 0, cancelled: true }); expect(existsSync(join(root, "video"))).toBe(false);
  });
  it("读取异常保留错误、释放reader且无部分内容地址文件", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic interrupted stream")); } });
    await expect(downloadToMediaStore("https://fixture.invalid/v.mp4", { workspaceId: "ws", fetchImpl: async () => new Response(stream) })).rejects.toThrow("synthetic interrupted stream");
    expect(stream.locked).toBe(false); expect(existsSync(join(root, "video"))).toBe(false);
  });
});
