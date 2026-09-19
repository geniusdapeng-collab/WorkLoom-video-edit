import { describe, expect, it, vi } from "vitest";
import {
  createVisualBridgeExecutor,
  isVisualBridgeTool,
  VisualBridgeError,
  VISUAL_BRIDGE_TOOLS,
} from "./executor";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("visual bridge executor", () => {
  it("声明工具面且拒绝未声明工具", async () => {
    expect(VISUAL_BRIDGE_TOOLS).toContain("visualwrite.compose");
    expect(isVisualBridgeTool("visualwrite.compose")).toBe(true);
    expect(isVisualBridgeTool("browser.goto")).toBe(false);
    const fetchImpl = vi.fn();
    const executor = createVisualBridgeExecutor({ baseUrl: "http://127.0.0.1:9773", token: "t", fetchImpl });
    await expect(executor("browser.goto", {})).rejects.toMatchObject({ code: "not_provided" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("成功调用时透传 Bearer、工具名与回执", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:9773/action");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ tool: "visualwrite.compose", params: { recipe: "r" } });
      return jsonResponse({
        ok: true,
        result: { project: "/tmp/a.comp" },
        receipt: { synced: true, snapshot_uri: "file:///tmp/a.png", verified_at: "2026-09-19T00:00:00Z" },
      });
    });
    const executor = createVisualBridgeExecutor({ baseUrl: "http://127.0.0.1:9773/", token: "secret-token", fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await executor("visualwrite.compose", { recipe: "r" });
    expect(outcome.result.project).toBe("/tmp/a.comp");
    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.receipt.snapshot_uri).toBe("file:///tmp/a.png");
  });

  it("缺回执按未核实返回，不伪造 synced", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: { note: "no receipt" } }));
    const executor = createVisualBridgeExecutor({ baseUrl: "http://127.0.0.1:9773", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await executor("visualread.inspect", { project: "/tmp/a.comp" });
    expect(outcome.receipt).toEqual({ synced: false });
  });

  it("桥返回错误码时抛出具名错误", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "engine_failed", message: "render failed" }, 400));
    const executor = createVisualBridgeExecutor({ baseUrl: "http://127.0.0.1:9773", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(executor("visualwrite.render", {})).rejects.toMatchObject({ code: "engine_failed", message: "render failed" });
  });

  it("超时映射为 timeout", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    const executor = createVisualBridgeExecutor({ baseUrl: "http://127.0.0.1:9773", token: "t", timeoutMs: 5, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(executor("visualread.health", {})).rejects.toBeInstanceOf(VisualBridgeError);
    await expect(executor("visualread.health", {})).rejects.toMatchObject({ code: "timeout" });
  });
});
