import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBundleUiProjection, type BundleUiProjection } from "@workloom/base/bundles";
import {
  bindBusinessAdapter,
  registeredBusinessAdapterIds,
} from "./business-registry.js";

describe("服务前台行业适配器契约", () => {
  const hotelProjection = loadBundleUiProjection("hotel");
  const projectionAs = (
    bundleId: string,
    serviceFront: BundleUiProjection["ui"]["serviceFront"],
  ): BundleUiProjection => ({
    ...hotelProjection,
    primaryBundleId: bundleId,
    bundleId,
    sources: hotelProjection.sources?.map((source) => ({
      ...source,
      bundleId,
      role: "primary",
      parentBundleId: null,
    })),
    ui: { ...hotelProjection.ui, serviceFront },
  });

  it("酒店仅由已封装活动 Bundle 的 adapterId 显式启用", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    });
    expect(result).toMatchObject({
      state: "ready",
      bundleId: "hotel",
      installId: "bi-hotel",
      adapter: { id: "hotel.service-front-v1" },
    });
    expect(result.adapter?.kbLexicon?.synonyms).toContainEqual(["会员", "会员卡"]);
  });

  it("未声明行业适配器的包（ai-video）绝不回退酒店", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "ai-video",
      activeInstalls: [{ id: "bi-video", bundleId: "ai-video" }],
    }, () => projectionAs("ai-video", {
      ...hotelProjection.ui.serviceFront,
      adapterId: undefined,
    }));
    expect(result.state).toBe("adapter-not-declared");
    expect(result.adapter).toBeNull();
  });

  it("无活动装配、指针冲突、投影篡改和未知适配器均失败关闭", () => {
    expect(bindBusinessAdapter({ workspaceBundleId: "ai-video", activeInstalls: [] }).adapter).toBeNull();

    const mismatch = bindBusinessAdapter({
      workspaceBundleId: "ai-video",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    });
    expect(mismatch).toMatchObject({ state: "bundle-mismatch", adapter: null });

    const invalid = bindBusinessAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    }, () => { throw new Error("摘要不一致"); });
    expect(invalid).toMatchObject({ state: "projection-invalid", adapter: null });

    const unknownProjection = projectionAs("unknown", {
      ...hotelProjection.ui.serviceFront,
      adapterId: "unknown.service-front-v1",
    });
    const unknown = bindBusinessAdapter({
      workspaceBundleId: "unknown",
      activeInstalls: [{ id: "bi-unknown", bundleId: "unknown" }],
    }, () => unknownProjection);
    expect(unknown).toMatchObject({ state: "adapter-unknown", adapter: null });
  });

  it("受控注册表不包含通用默认适配器（本仓只登记酒店服务前台）", () => {
    expect(registeredBusinessAdapterIds()).toEqual(["hotel.service-front-v1"]);
  });

  it("其他 Bundle 即使伪造酒店 adapterId，也无权选择酒店实现（geo-growth 的现状即此）", () => {
    // 事实核对：本仓 bundles/geo-growth/bundle.json 当前声明的正是 hotel.service-front-v1，
    // 受控目录只允许 bundleId=hotel 选择它 —— 于是 GEO 工作区的 C 端业务数据接口失败关闭为空，
    // 不会读到酒店订单/会员。这条用例锁的就是这个安全不变量。
    const result = bindBusinessAdapter({
      workspaceBundleId: "geo-growth",
      activeInstalls: [{ id: "bi-geo", bundleId: "geo-growth" }],
    }, () => projectionAs("geo-growth", {
      ...hotelProjection.ui.serviceFront,
      adapterId: "hotel.service-front-v1",
    }));
    expect(result).toMatchObject({ state: "adapter-untrusted", adapter: null, bundleId: "geo-growth" });
  });

  it("基座网关、通用对话和启动引导不再含酒店数据访问或酒店展示语义", () => {
    const gateway = readFileSync(new URL("../gateway.ts", import.meta.url), "utf8");
    const dialog = readFileSync(new URL("../dialog.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
    const ticket = readFileSync(new URL("../ticket.ts", import.meta.url), "utf8");
    const forbidden = /biz-hotel|hotelBizAdapter|demo_orders|demo_members|云栖酒店|房型价格|客房部|前厅部/;
    expect(gateway).not.toMatch(forbidden);
    expect(dialog).not.toMatch(forbidden);
    expect(store).not.toMatch(forbidden);
    expect(ticket).not.toMatch(forbidden);
  });

  it("通用注册表不直接导入任何具体行业实现", () => {
    const registry = readFileSync(new URL("./business-registry.ts", import.meta.url), "utf8");
    expect(registry).not.toMatch(/service-front-adapter|hotelBizAdapter|industry\/hotel/);
    expect(registry).toContain("business-adapter-catalog");
  });
});
