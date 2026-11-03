// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ qualify: vi.fn(), submit: vi.fn(), status: vi.fn(), decide: vi.fn(), canApprove: true, prompt: "inert exact scene prompt" }));
vi.mock("../../../lib/trpc", () => {
  const draft = { id: "RS-draft", project_id: "P1", shot_id: "S1", script_key: "D1", version: 1,
    status: "draft", md: "inert exact scene prompt", char_check: {}, diff_summary: null };
  return { ensureDemoLogin: async () => undefined, trpc: { approvals: { decide: { mutate: fake.decide } }, video: {
    cms: { listScripts: { query: async () => [draft] }, getScript: { query: async () => draft } },
    production: { shots: { query: async () => ({ shots: [{ shotId: "S1", durationSec: 10,
      prompt: fake.prompt, promptSha256: "a".repeat(64) }] }) }, qualifyShotReceipt: { mutate: fake.qualify }, g8Status: { query: fake.status } },
    gen: { catalog: { query: async () => ({ models: [{ id: "doubao-seedance-2-5", name: "Inert Seedance", provider: "seedance",
      modes: [], available: true, pricing: null, limits: { aspectRatios: ["16:9"], resolutions: ["720p"] } }] }) },
      estimate: { query: async () => ({ estimate: { usd: 1, cny: 7.2 }, spend: { monthCny: 0, caps: {} }, allowed: true }) },
      jobs: { query: async () => [] } },
    render: { submit: { mutate: fake.submit } },
  } } };
});
vi.mock("../../../shell/NavigationAccess", () => ({
  useNavigationAccess: () => ({ identityKey: "workspace:operator", scope: { tenantId: "tenant", workspaceId: "workspace" },
    status: "ready", canAction: (action: string) => action === "workspace.write" || (action === "approval.decide" && fake.canApprove) }),
}));
vi.mock("../../../shell/Bridge", () => ({ Bridge: ({ left, right, children }: Record<string, ReactNode>) => <>{left}{children}{right}</> }));
vi.mock("../../../components/hud", () => ({ BannerAlert: ({ children }: { children: ReactNode }) => <p role="alert">{children}</p>,
  EmptyState: () => null, Skeleton: () => null }));
import Studio from "../pages/Studio";
import Assets from "../pages/Assets";


const address = "/ai-video/assets?tab=studio&project=P1&shot=S1";
const contract = { modelId: "doubao-seedance-2-5", aspectRatio: "9:16", resolution: "1080p", generateAudio: false };
const ticket = { approvalId: "apr-11111111111111111111", shotId: "S1", modelId: contract.modelId,
  durationSec: 10, estimatedCny: 7.2, allowOverage: false, requestHash: "a".repeat(64), expiresAt: "2099-01-01T08:00:00.000Z", jobId: null };
let host: HTMLDivElement;
let root: Root;
let status: Record<string, unknown> | null;
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.includes(label));
const studio = () => <MemoryRouter initialEntries={[address]}><Studio /></MemoryRouter>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  status = null;
  fake.canApprove = true;
  fake.prompt = "inert exact scene prompt";
  fake.qualify.mockReset().mockResolvedValue({ qualificationId: "PQ1", qualificationToken: "inert-q1" });
  fake.status.mockReset().mockImplementation(async () => ({ contract, ticket: status }));
  fake.submit.mockReset().mockImplementation(async (input: { g8ApprovalId?: string }) => {
    if (!input.g8ApprovalId) {
      status = { ...ticket, status: "pending" };
      throw new Error("G8_HUMAN_APPROVAL_REQUIRED:" + ticket.approvalId);
    }
    status = { ...ticket, status: "submitted", jobId: "RJ-original" };
    return { jobId: "RJ-original", mock: false, provider: "seedance", durationSec: 10, estUsd: 1, estCny: 7.2 };
  });
  fake.decide.mockReset().mockImplementation(async () => { status = { ...ticket, status: "approved" }; });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("reads the same ticket after reload and requires separate explicit approval and paid submission clicks", async () => {
  await act(async () => root.render(studio()));
  expect(host.textContent).toContain("1080p");
  expect(host.textContent).toContain("9:16");
  expect(button("审核并申请付费授权")?.disabled).toBe(false);
  await act(async () => button("审核并申请付费授权")!.click());
  expect(fake.qualify).toHaveBeenCalledExactlyOnceWith({ projectId: "P1", shotId: "S1", modelId: contract.modelId, mode: "manual", params: {} });
  expect(fake.submit).toHaveBeenCalledExactlyOnceWith({ qualificationToken: "inert-q1" });
  expect(host.textContent).toContain("待人工授权");
  expect(host.textContent).toContain(ticket.approvalId);
  expect(host.textContent).not.toContain("inert-q1");
  expect(button("审核并申请付费授权")).toBeUndefined();
  expect(button("提交已授权的付费渲染")).toBeUndefined();

  await act(async () => root.render(null));
  await act(async () => root.render(studio()));
  expect(host.textContent).toContain(ticket.approvalId);
  await act(async () => button("批准本次付费渲染")!.click());
  expect(fake.decide).toHaveBeenCalledExactlyOnceWith({ approvalId: ticket.approvalId, gesture: "approve" });
  expect(fake.qualify).toHaveBeenCalledTimes(1);
  expect(fake.submit).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("已授权 · 等待提交");
  await act(async () => button("提交已授权的付费渲染")!.click());
  expect(fake.submit.mock.calls).toEqual([[{ qualificationToken: "inert-q1" }],
    [{ g8ApprovalId: ticket.approvalId, allowOverage: false }]]);
  expect(fake.qualify).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("生成任务已受理");
  expect(host.textContent).toContain("RJ-original");
  expect(button("提交已授权的付费渲染")).toBeUndefined();
});

it("a viewer without the approval grant sees the native status without the decision action", async () => {
  fake.canApprove = false;
  status = { ...ticket, status: "pending" };
  await act(async () => root.render(studio()));
  expect(host.textContent).toContain("待人工授权");
  expect(host.textContent).toContain("具备审批权限的成员");
  expect(button("批准本次付费渲染")).toBeUndefined();
  expect(fake.decide).not.toHaveBeenCalled();
  expect(fake.submit).not.toHaveBeenCalled();
});

it("unknown provider outcome and unavailable readback provide no action that could reissue a request", async () => {
  status = { ...ticket, status: "outcome_unknown" };
  await act(async () => root.render(studio()));
  expect(host.textContent).toContain("提交结果待核对");
  expect(button("审核并申请付费授权")).toBeUndefined();
  expect(button("提交已授权的付费渲染")).toBeUndefined();
  fake.status.mockRejectedValueOnce(new Error("readback unavailable"));
  await act(async () => button("刷新付费授权状态")!.click());
  expect(host.textContent).toContain("readback unavailable");
  expect(button("审核并申请付费授权")).toBeUndefined();
  expect(fake.qualify).not.toHaveBeenCalled();
  expect(fake.submit).not.toHaveBeenCalled();
});

it("does not silently substitute another shot for an outdated exact-shot link", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={[address.replace("shot=S1", "shot=stale")]}>
    <Studio />
  </MemoryRouter>));
  expect(host.textContent).toContain("链接中的镜头 stale 已不在当前预生产结果中");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="预生产镜头"]')?.value).toBe("");
  expect(fake.status).not.toHaveBeenCalled();
  expect(fake.submit).not.toHaveBeenCalled();
});

function AssetsWithLocation() {
  const location = useLocation();
  return <><p data-location={location.search} /><Assets /></>;
}
it("Assets verifies the exact service shot and hands the selected mode to Studio without requesting authorization", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={["/ai-video/assets?project=P1"]}><AssetsWithLocation /></MemoryRouter>));
  await act(async () => button("批量任务")!.click());
  fake.prompt = "different current source";
  await act(async () => button("在生成工作室打开当前镜头")!.click());
  expect(host.textContent).toContain("与服务预生产镜头不一致");
  expect(host.querySelector("[data-location]")?.getAttribute("data-location")).toBe("?project=P1");
  fake.prompt = "inert exact scene prompt";
  await act(async () => button("在生成工作室打开当前镜头")!.click());
  expect(host.querySelector("[data-location]")?.getAttribute("data-location")).toBe("?tab=studio&project=P1&shot=S1&mode=batch");
  expect(fake.qualify).not.toHaveBeenCalled();
  expect(fake.decide).not.toHaveBeenCalled();
  expect(fake.submit).not.toHaveBeenCalled();
});
