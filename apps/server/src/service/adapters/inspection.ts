/**
 * 巡检行业适配器注册契约（与 adapters/business.ts 的 BusinessAdapterRegistration 同构）。
 *
 * 用途：行业适配器目录（industry/inspection-adapter-catalog.ts）声明"哪个已构建的
 * 适配器实现可被哪些行业 Bundle 选中"。通用注册表不得 import 具体行业实现，只消费
 * 本类型；Bundle 清单仍须通过摘要/生产签名校验，不能声明任意模块路径。
 */
import type { InspectionAdapter } from "@workloom/base/inspection";

export interface InspectionAdapterRegistration {
  adapter: InspectionAdapter;
  bundleIds: readonly string[];
  /** 可选：把实现进一步限制到指定签名方（与业务适配器同口径） */
  trustedSignerKeyIds?: readonly string[];
}
