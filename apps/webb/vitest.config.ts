/**
 * B 端移动工作台测试配置（口径同 apps/web/vitest.config.ts）：
 * 继承应用 vite 配置，并内联 @workloom/ui（该制品为无扩展名 ESM 相对导入，Node 无法解析）。
 */
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      server: { deps: { inline: ["@workloom/ui"] } },
    },
  }),
);
