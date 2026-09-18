/**
 * B 端工作台测试配置。
 *
 * 继承应用自身的 vite 配置（产品身份 define / 路由插件与构建同源），只补两条测试口径：
 *  - server.deps.inline=["@workloom/ui"]：该共享 UI 制品以无扩展名相对导入发布
 *    （dist/index.js → "./language"），Node ESM 无法解析；默认外部化会把它交给 Node 加载而失败。
 *    内联后由 Vite 解析器处理，与生产构建的解析路径一致。
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
