/**
 * base 测试配置：**串行跑测试文件**。
 *
 * 原因：本包的 PG 用例共享同一个演示工作区（ws-yunqi）与全局审批队列/事件账本，
 * 并行时互相踩：实测 `review-console/approvals.test.ts` 的审批行被并行文件消费，
 * 报"审批不存在"的偶发红灯。test-gate 已转必需门禁，不接受偶发失败；
 * 串行代价 14s → 27s，换来可复现的绿灯，值得。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
