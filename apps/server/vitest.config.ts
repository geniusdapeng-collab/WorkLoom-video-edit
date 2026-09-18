/**
 * server 测试配置：**串行跑测试文件**，不并发。
 *
 * 原因：本包的真库用例（contract/e2e/*.pg）共享同一个工作区（SERVICE_C_TEST_WORKSPACE_ID）
 * 与同一份 schema，并行时会互相踩：实测出现过 contract 的 /session 偶发 500
 * （多个文件同时在 ensureServiceSchema/DDL + 同工作区写入）。test-gate 已是必需门禁，
 * 不能接受偶发红灯；串行后 21 个文件仍是秒级（e2e 段自带 spawn 服务，最长）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
