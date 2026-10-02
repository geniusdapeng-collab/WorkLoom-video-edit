// Register workspace exports without moving their source files. Moving a package into
// node_modules breaks repo-relative imports and creates a second copy of its state.
// Real ESM facades survive Windows ZIP extraction without junctions or symlinks.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloadPolicy } from "./payload-policy.mjs";

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function registerWorkspaceModules(runtimeRoot) {
  const root = realpathSync(resolve(runtimeRoot));
  const policy = loadPayloadPolicy(root);
  const sources = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(root, "packages", entry.name)).sort();
  if (policy.includePlatformOps) sources.push(join(root, "platform-ops"));
  const names = new Set();
  const plans = [];
  for (const source of sources) {
    const manifestPath = join(source, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const name = manifest.name;
    if (typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)
      || name.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`工作区包名称无效：${manifestPath}`);
    }
    if (names.has(name)) throw new Error(`工作区包名称重复：${name}`);
    names.add(name);
    if (manifest.type !== "module" || !manifest.exports) {
      throw new Error(`工作区包必须声明 ESM exports：${name}`);
    }
    const destination = join(root, "node_modules", name);
    const files = [];
    const targets = new Map();
    const rewrite = (value) => {
      if (value === null) return null;
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
          if (key.includes("*")) throw new Error(`工作区包通配 exports 尚未支持：${name}.${key}`);
          return [key, rewrite(child)];
        }));
      }
      if (typeof value !== "string" || !value.startsWith("./") || value.includes("*") || value.includes("\\")) {
        throw new Error(`工作区包 exports 目标无效：${name} ${String(value)}`);
      }
      const target = resolve(source, value);
      if (!inside(source, target) || !existsSync(target) || !statSync(target).isFile()
        || !inside(root, realpathSync(target))) {
        throw new Error(`工作区包 exports 文件缺失或越界：${name} ${value}`);
      }
      if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(target) || /\.c(?:js|ts)$/u.test(target)) {
        throw new Error(`工作区包 exports 必须使用 ESM 源码：${name} ${value}`);
      }
      // Current workspace APIs expose named exports. Refuse a new default API rather
      // than silently losing it in a facade; support can then be added deliberately.
      const text = readFileSync(target, "utf8");
      if (/\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/su.test(text)) {
        throw new Error(`工作区包默认导出需要显式注册支持：${name} ${value}`);
      }
      if (!targets.has(value)) {
        const filename = `entry-${targets.size}${value.endsWith(".d.ts") ? ".d.ts" : ".mjs"}`;
        let specifier = relative(destination, target).split(sep).join("/");
        if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        files.push([filename, `// Canonical workspace source; do not relocate.\nexport * from ${JSON.stringify(specifier)};\n`]);
        targets.set(value, `./${filename}`);
      }
      return targets.get(value);
    };
    plans.push({ name, destination, files, manifest: { name, version: manifest.version, private: true, type: "module", exports: rewrite(manifest.exports) } });
  }
  for (const { destination, files, manifest } of plans) {
    const parent = dirname(destination);
    mkdirSync(parent, { recursive: true });
    if (!inside(root, realpathSync(parent))) throw new Error(`工作区注册目录越界：${parent}`);
    rmSync(destination, { force: true, recursive: true });
    mkdirSync(destination);
    writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [filename, content] of files) writeFileSync(join(destination, filename), content);
  }
  return plans.map(({ name }) => name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("用法：node scripts/pack-workspace-modules.mjs <runtime目录>");
    const names = registerWorkspaceModules(process.argv[2]);
    console.log(`✓ ${names.length} 个工作区包已注册为实体 ESM 入口：${names.join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
