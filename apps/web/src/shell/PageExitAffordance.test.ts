/**
 * 出口按钮全量回归（可用性门禁）。
 *
 * 背景：工作台主壳有常驻左侧导航，但**裸页**（/dev、/onboarding、/login、/activate、/invite）
 * 没有导航；二级页（任务详情、代理详情、行业扩展页、控制台页）也应当有明确的回退路径。
 * 曾经出现"进得来出不去"的尴尬页面，因此这里用静态检查把规则固化：
 *   1) 裸页清单直接从 App.tsx 的 bare 表达式解析——新增裸页会被自动纳入检查；
 *   2) 详情路由（含 : 参数）必须有返回控件；
 *   3) 行业内所有扩展页面必须有返回/关闭控件；
 *   4) 酒店获客控制台 11 页通过 ConsoleShell 统一渲染出口。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(SRC, "App.tsx");
/**
 * 出口证据：统一控件、返回/退出/关闭文案、显式导航/关闭回调，
 * 或使用已证明会渲染出口的页面套件（ConsoleShell，见本文件第 4 条用例）。
 */
const EXIT = /PageExitLink|返回|退出|关闭|onClose|useNavigate|navigate\(|ConsoleShell/;

function walk(dir: string, filter: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, filter, out);
    else if (filter(path)) out.push(path);
  }
  return out;
}

/** 从 App.tsx 的 bare 表达式解析"没有常驻导航"的路由前缀 */
function bareRoutes(): string[] {
  const source = readFileSync(APP, "utf8");
  const match = /const bare = ([^;]+);/.exec(source);
  expect(match, "App.tsx 必须保留 bare 表达式（无导航页面清单）").toBeTruthy();
  const expression = match![1]!;
  return [...expression.matchAll(/pathname\s*===\s*"([^"]+)"/g)].map((m) => m[1]!)
    .concat([...expression.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]!));
}

/**
 * 路由 path → 页面组件文件。
 * 兼容 App.tsx 里的**本地包装组件**（如 UiDiagnosticsRoute 包着 DevMatrix）：
 * 先找 import 的组件；找不到就进入本地函数体再找一层。
 */
function pageFileFor(routePath: string): string | null {
  const source = readFileSync(APP, "utf8");
  const imports = new Map<string, string>();
  for (const m of source.matchAll(/import\s+([A-Z]\w+)\s+from\s+"([^"]+)"/g)) {
    imports.set(m[1]!, m[2]!);
  }
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchor = new RegExp(`<Route\\s+path="${escaped}"`).exec(source);
  if (!anchor) return null;
  // 窗口限定在本条 <Route> 声明内（遇到下一条 <Route 即截断），避免把后续页面算进本条
  const rest = source.slice(anchor.index);
  const next = rest.indexOf("<Route", 10);
  const window = rest.slice(0, next > 0 ? next : 900);
  const components = [...window.matchAll(/<([A-Z]\w+)/g)]
    .map((m) => m[1]!)
    .filter((name) => !["Route", "Routes", "IndustryRouteBoundary", "IndustryLegacyRedirect", "Navigate"].includes(name));
  const resolved: string[] = [];
  for (const component of components) {
    const specifier = imports.get(component);
    if (specifier) { resolved.push(resolvePageFile(join(SRC, specifier.replace(/^\.\//, "")))); continue; }
    // 本地包装组件：进入其函数体再找一层页面组件
    const local = new RegExp(`function ${component}\\([^)]*\\)[\\s\\S]{0,800}?\\}|const ${component} = [\\s\\S]{0,800}?;`).exec(source);
    if (!local) continue;
    for (const nested of [...local[0].matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]!)) {
      const nestedSpecifier = imports.get(nested);
      if (nestedSpecifier) { resolved.push(resolvePageFile(join(SRC, nestedSpecifier.replace(/^\.\//, "")))); break; }
    }
  }
  if (resolved.length > 0) return resolved[0]!;
  // 纯跳转路由（LegacyXxxRedirect 等）：自身不渲染页面，立即 navigate 离开，不需要出口
  return null;
}

/** 补全 import 省略的扩展名（导入写 "./pages/p2/P2"，实际文件是 P2.tsx） */
function resolvePageFile(base: string): string {
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return `${base}.tsx`;
}

/**
 * 纯跳转路由（LegacyXxxRedirect / Navigate）：进入即离开，不渲染页面 UI，因此豁免出口要求。
 * 例如 /p2/:threadId → LegacyTaskRedirect → /tasks/:threadId。
 */
function isRedirectRoute(routePath: string): boolean {
  const source = readFileSync(APP, "utf8");
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchor = new RegExp(`<Route\\s+path="${escaped}"`).exec(source);
  if (!anchor) return false;
  const rest = source.slice(anchor.index);
  const next = rest.indexOf("<Route", 10);
  const window = rest.slice(0, next > 0 ? next : 900);
  const names = [...window.matchAll(/<([A-Z]\w+)/g)]
    .map((m) => m[1]!)
    .filter((name) => !["Route", "Routes", "IndustryRouteBoundary", "IndustryLegacyRedirect"].includes(name));
  return names.length > 0 && names.every((name) => /Redirect|Navigate/.test(name));
}

describe("页面出口（返回/关闭/退出）全量覆盖", () => {
  it("裸页（无左侧导航）必须有本页出口", () => {
    const routes = bareRoutes();
    expect(routes.length, "裸页清单不应为空").toBeGreaterThanOrEqual(4);
    const missing: string[] = [];
    for (const route of routes) {
      if (isRedirectRoute(route)) continue; // 纯跳转页：进入即离开，无需出口
      const file = pageFileFor(route);
      if (!file) { missing.push(`${route}（未解析到页面文件）`); continue; }
      const source = readFileSync(file, "utf8");
      if (!EXIT.test(source)) missing.push(`${route} → ${relative(SRC, file)}`);
    }
    expect(missing, `裸页缺少出口控件：${missing.join("、")}`).toEqual([]);
  });

  it("详情路由（含参数）必须有返回控件", () => {
    const source = readFileSync(APP, "utf8");
    const detailPaths = [...source.matchAll(/<Route\s+path="([^"]*:[^"]*)"/g)].map((m) => m[1]!);
    expect(detailPaths.length).toBeGreaterThanOrEqual(2);
    const missing: string[] = [];
    for (const route of detailPaths) {
      if (isRedirectRoute(route)) continue; // /p2/:threadId → LegacyTaskRedirect 等历史别名
      const file = pageFileFor(route);
      if (!file) { missing.push(`${route}（未解析到页面文件）`); continue; }
      if (!EXIT.test(readFileSync(file, "utf8"))) missing.push(`${route} → ${relative(SRC, file)}`);
    }
    expect(missing, `详情页缺少返回控件：${missing.join("、")}`).toEqual([]);
  });

  it("行业扩展页面（行业包自带页面）必须有返回/关闭控件", () => {
    const pages = walk(join(SRC, "extensions"), (file) => /\/pages\/.*\.tsx$/.test(file));
    expect(pages.length, "行业扩展页面数量不应缩水").toBeGreaterThanOrEqual(16);
    const missing = pages.filter((file) => !EXIT.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file));
    expect(missing, `扩展页面缺少出口：${missing.join("、")}`).toEqual([]);
  });

  it("获客控制台 11 页统一经 ConsoleShell 渲染出口", () => {
    const kit = readFileSync(join(SRC, "extensions/hotel/console.tsx"), "utf8");
    expect(kit, "控制台套件必须渲染统一出口控件").toContain("PageExitLink");
    const consolePages = walk(join(SRC, "extensions/hotel/pages"), (file) => file.endsWith(".tsx"));
    expect(consolePages.length).toBe(11);
    const missing = consolePages
      .filter((file) => !readFileSync(file, "utf8").includes("ConsoleShell"))
      .map((file) => relative(SRC, file));
    expect(missing, `控制台页面未使用统一套件（会丢出口）：${missing.join("、")}`).toEqual([]);
  });
});
