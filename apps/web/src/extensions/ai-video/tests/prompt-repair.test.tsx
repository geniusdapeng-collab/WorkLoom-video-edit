// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";

const fake = vi.hoisted(() => ({ plan: vi.fn(), repair: vi.fn(), status: vi.fn(), legacyStart: vi.fn() }));
vi.mock("../../../lib/trpc", () => ({ trpc: { video: { studio: {
  promptRepairPlan: { query: fake.plan }, repairPrompts: { mutate: fake.repair },
  status: { query: fake.status }, start: { mutate: fake.legacyStart },
} } } }));
import { PromptRepairCard } from "../components/PromptRepairCard";

const ready = () => ({
  kind: "ready", mode: "approved-source-prompt-repair", projectId: "P1", expectedLatestAttempt: 48,
  sourceRunId: "RUN-source", planDigest: "a".repeat(64), sourceCollectedAt: "2099-01-01T00:00:00.000Z",
  sourceExpiresAt: "2099-01-02T00:00:00.000Z", retainedGates: ["G1", "G2", "G3", "G4"], retainedShotCount: 3,
  authoringFields: [{ shotId: "opening", field: "timeline_script", reason: "补齐动作起点与时间轴的对应关系" }], warnings: [],
});
let host: HTMLDivElement;
let root: Root;
let completed: Mock<() => Promise<void>>;
const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.includes(text));
async function render(projectId = "P1", canRepair = true) {
  await act(async () => root.render(<PromptRepairCard key={projectId} projectId={projectId} canRepair={canRepair} onCompleted={completed} />));
}
async function click(text: string) {
  const action = button(text);
  expect(action, text).toBeDefined();
  await act(async () => action!.click());
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  completed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  fake.plan.mockReset().mockResolvedValue(ready());
  fake.repair.mockReset().mockResolvedValue({ kind: "started", runId: "RUN-repair", sourceAttempt: 48 });
  fake.status.mockReset().mockResolvedValue({ runId: "RUN-repair", projectId: "P1", status: "finished", error: null });
  fake.legacyStart.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("checks only on request and starts only after the separate explicit repair action", async () => {
  await render();
  expect(fake.plan).not.toHaveBeenCalled(); expect(fake.repair).not.toHaveBeenCalled();
  await click("检查能否接着修");
  expect(fake.plan).toHaveBeenCalledExactlyOnceWith({ projectId: "P1" });
  expect(fake.repair).not.toHaveBeenCalled();
  expect(host.textContent).toContain("第 48 轮"); expect(host.textContent).toContain("3 个镜头");
  expect(host.textContent).toContain("补齐动作起点与时间轴的对应关系");
  expect(host.textContent).toContain("视频生成需要后续单独确认");
  await click("修复提示词并重新审核");
  expect(fake.repair).toHaveBeenCalledExactlyOnceWith({ projectId: "P1", expectedLatestAttempt: 48, planDigest: "a".repeat(64) });
  expect(fake.status).toHaveBeenCalledExactlyOnceWith({ runId: "RUN-repair" });
  expect(completed).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("视频尚未生成"); expect(fake.legacyStart).not.toHaveBeenCalled();
});

it("shows unavailable source reasons without an executable action or a full restart", async () => {
  fake.plan.mockResolvedValue({ kind: "unavailable", projectId: "P1", code: "SOURCE_HASH_MISMATCH", message: "原图片字节已变化，需要重新核实" });
  await render(); await click("检查能否接着修");
  expect(host.textContent).toContain("原图片字节已变化");
  expect(button("修复提示词并重新审核")).toBeUndefined();
  expect(fake.repair).not.toHaveBeenCalled(); expect(fake.legacyStart).not.toHaveBeenCalled();
});

it("keeps a failed material read visible and allows another read without starting work", async () => {
  fake.plan.mockRejectedValueOnce(new Error("离线档案不可读"));
  await render(); await click("检查能否接着修");
  expect(host.textContent).toContain("材料检查未完成：离线档案不可读");
  await click("检查能否接着修");
  expect(fake.plan).toHaveBeenCalledTimes(2); expect(fake.repair).not.toHaveBeenCalled();
});

it("permits read-only inspection but disables execution without the workspace write grant", async () => {
  await render("P1", false); await click("检查能否接着修");
  expect(button("修复提示词并重新审核")?.disabled).toBe(true);
  expect(host.textContent).toContain("没有发起修复的权限");
  await click("修复提示词并重新审核"); expect(fake.repair).not.toHaveBeenCalled();
});

it.each(["2000-01-01T00:00:00.000Z", "invalid-expiry"])("does not execute an expired or unverifiable plan (%s)", async sourceExpiresAt => {
  fake.plan.mockResolvedValue({ ...ready(), sourceExpiresAt });
  await render(); await click("检查能否接着修");
  expect(button("修复提示词并重新审核")?.disabled).toBe(true);
  expect(host.textContent).toContain("原始资料已到期");
  await click("修复提示词并重新审核"); expect(fake.repair).not.toHaveBeenCalled();
});

it("expires an already displayed plan while the page remains open", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2099-01-01T23:59:59.500Z"));
  await render(); await click("检查能否接着修");
  expect(button("修复提示词并重新审核")?.disabled).toBe(false);
  await act(async () => vi.advanceTimersByTime(1_000));
  expect(button("修复提示词并重新审核")?.disabled).toBe(true);
  expect(fake.repair).not.toHaveBeenCalled();
});

it("retains the exact original operation after a lost acknowledgement and never retries automatically", async () => {
  fake.repair.mockRejectedValueOnce(new Error("启动回执丢失"));
  await render(); await click("检查能否接着修"); await click("修复提示词并重新审核");
  expect(fake.repair).toHaveBeenCalledTimes(1); expect(fake.status).not.toHaveBeenCalled();
  expect(button("重新检查材料")).toBeUndefined();
  expect(host.textContent).toContain("没有自动再次执行");
  await click("接回同一修复请求");
  expect(fake.repair).toHaveBeenCalledTimes(2);
  expect(fake.repair.mock.calls[1]![0]).toEqual(fake.repair.mock.calls[0]![0]);
  expect(completed).toHaveBeenCalledTimes(1); expect(fake.legacyStart).not.toHaveBeenCalled();
});

it.each(["busy", "stale"])("preserves a server %s result and requires another read instead of a fallback", async kind => {
  fake.repair.mockResolvedValue({ kind, message: "本项目执行状态已变化，请重新检查" });
  await render(); await click("检查能否接着修"); await click("修复提示词并重新审核");
  expect(host.textContent).toContain("本项目执行状态已变化"); expect(fake.repair).toHaveBeenCalledTimes(1);
  expect(button("修复提示词并重新审核")).toBeUndefined(); expect(button("检查能否接着修")).toBeDefined();
  expect(fake.legacyStart).not.toHaveBeenCalled();
});

it("drops an old project's late material response when the authoritative project key changes", async () => {
  let resolveOld!: (value: ReturnType<typeof ready>) => void;
  fake.plan.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await render(); await click("检查能否接着修");
  await render("P2");
  await act(async () => resolveOld(ready()));
  expect(host.textContent).not.toContain("第 48 轮"); expect(button("修复提示词并重新审核")).toBeUndefined();
  await click("检查能否接着修"); expect(fake.plan.mock.calls.at(-1)![0]).toEqual({ projectId: "P2" });
});

it("reads the same running operation after a progress error, without repeating the repair", async () => {
  fake.status.mockRejectedValueOnce(new Error("进度连接中断"));
  await render(); await click("检查能否接着修"); await click("修复提示词并重新审核");
  expect(host.textContent).toContain("进度连接中断");
  await click("刷新这次修复进度");
  expect(fake.status.mock.calls).toEqual([[{ runId: "RUN-repair" }], [{ runId: "RUN-repair" }]]);
  expect(fake.repair).toHaveBeenCalledTimes(1); expect(completed).toHaveBeenCalledTimes(1);
});

it("preserves a failed review and its reason without exposing a second execution button", async () => {
  fake.status.mockResolvedValue({ runId: "RUN-repair", projectId: "P1", status: "failed", error: "动作和时间轴仍然冲突" });
  await render(); await click("检查能否接着修"); await click("修复提示词并重新审核");
  expect(host.textContent).toContain("动作和时间轴仍然冲突"); expect(host.textContent).toContain("失败记录保留");
  expect(completed).not.toHaveBeenCalled(); expect(fake.repair).toHaveBeenCalledTimes(1);
  expect(button("修复提示词并重新审核")).toBeUndefined();
});

it("retries only the completed run's shot refresh when the first completion callback fails", async () => {
  completed.mockRejectedValueOnce(new Error("镜头列表连接中断")).mockResolvedValue(undefined);
  await render(); await click("检查能否接着修"); await click("修复提示词并重新审核");
  expect(host.textContent).toContain("修复已经完成，但镜头列表未刷新");
  expect(completed).toHaveBeenCalledTimes(1);
  await click("刷新这次修复进度");
  expect(completed).toHaveBeenCalledTimes(2); expect(fake.repair).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("镜头列表连接中断");
});

it("checks the actual click time even when expiry falls between the timer ticks", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2099-01-01T23:59:59.900Z"));
  await render(); await click("检查能否接着修");
  expect(button("修复提示词并重新审核")?.disabled).toBe(false);
  vi.setSystemTime(new Date("2099-01-02T00:00:00.010Z"));
  await click("修复提示词并重新审核");
  expect(fake.repair).not.toHaveBeenCalled();
  expect(host.textContent).toContain("原始资料已到期");
});

it("accepts the persisted pipeline completed status without requiring an error property", async () => {
  fake.status.mockResolvedValue({ runId: "RUN-repair", projectId: "P1", status: "completed", legacy: false, nextAction: "done" });
  await render(); await click("检查能否接着修"); await click("修复提示词并重新审核");
  expect(completed).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("视频尚未生成");
  expect(fake.repair).toHaveBeenCalledTimes(1);
});
