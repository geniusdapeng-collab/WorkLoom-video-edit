/**
 * 部署层 ToolExecutor 注入 seam（growth 实验车道先行；基座提案 0001 的本地版本）。
 *
 * 背景：`runQuest` 已预留 `input.toolExecutor`，但宿主没有注入点——真实连接器（视觉工位 bridge、
 * 发布 RPA 等）无法进入 Quest 步骤执行，步骤只能落 `executeDeclaredTool` 兜底（真实数据态返回
 * `connector-required` 且不回执），于是"让 AI 生成一张图"只会立项、不会出图。
 *
 * 口径（与提案一致，fail-closed）：
 *  - 只认环境变量 `WORKLOOM_TOOL_EXECUTOR_MODULE` 指向的模块（绝对路径），模块导出
 *    `createToolExecutorForScope(scope)`（或 `createToolExecutor()`）；
 *  - 未配置 / 导入失败 / 工厂抛错 / 返回 undefined → 一律 undefined（调用方保持原语义，
 *    绝不伪造成功回执）；错误只落服务端日志，不向客户端泄露路径细节；
 *  - 模块按路径缓存，en热更新（env 变了）自动重载。
 */
import { pathToFileURL } from "node:url";

export interface DeploymentToolResult {
  result: Record<string, unknown>;
  receipt: { synced: boolean; snapshot_uri?: string; verified_at?: string };
}

export type DeploymentToolExecutor = (
  name: string,
  params: Record<string, unknown>,
) => Promise<DeploymentToolResult>;

type Scope = { tenantId: string; workspaceId: string };

interface ModuleShape {
  createToolExecutorForScope?: (scope?: Partial<Scope>) => DeploymentToolExecutor | undefined;
  createToolExecutor?: () => DeploymentToolExecutor | undefined;
}

let cached: { modulePath: string; mod: ModuleShape } | null = null;

export async function loadDeploymentToolExecutor(scope: Scope): Promise<DeploymentToolExecutor | undefined> {
  const modulePath = (process.env.WORKLOOM_TOOL_EXECUTOR_MODULE ?? "").trim();
  if (!modulePath) return undefined;
  try {
    if (!cached || cached.modulePath !== modulePath) {
      const mod = (await import(pathToFileURL(modulePath).href)) as ModuleShape;
      cached = { modulePath, mod };
    }
    const factory = cached.mod.createToolExecutorForScope ?? cached.mod.createToolExecutor;
    if (!factory) return undefined;
    return factory({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }) ?? undefined;
  } catch (error) {
    console.error(
      "[tool-executor] 部署执行器加载失败（fail-closed：任务将按未核实处理）",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
