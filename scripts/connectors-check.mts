#!/usr/bin/env node
/**
 * connectors:check · 真实连接器就绪检查（G7）
 * 未配置 → 打印 unconfigured（不阻断，提示缺哪些 env）；凭证齐备 → 打印 ready。
 */
import { connectorReadiness } from "@workloom/base/connectors";

const rows = connectorReadiness();
console.log("真实连接器就绪状态（fail-closed：未配置不回退 mock）：");
for (const r of rows) {
  console.log(`${r.state === "ready" ? "✓" : "○"} ${r.id.padEnd(16)} ${r.name} —— ${r.detail}`);
}
console.log("\n接入步骤见 docs/connectors-mock-exit.md；凭证只放环境变量/秘密存储，不进文件。");
