#!/usr/bin/env node
/** JSON CLI for Edit's product-owned agent bridge. Runner configuration is environment-only. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityError } from "./agent-capabilities.mjs";
import { EDIT_AGENT_ROOT, editAgentError, editAgentList, invokeEditAgent, loadEditAgentCatalog } from "./tools/lib/edit-agent-catalog.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const USAGE = "node scripts/edit-agent.mjs list | describe <id> | invoke <id> [--input-file <JSON文件或->]";

export function parseEditAgentArgs(argv) {
  const [command, id, ...rest] = argv;
  if (command === "list" && argv.length === 1) return { command };
  if (!["describe", "invoke"].includes(command) || typeof id !== "string" || !/^[a-z][a-z0-9_.]+$/u.test(id)) {
    throw new CapabilityError("USAGE", USAGE, 2);
  }
  if (command === "describe" && rest.length === 0) return { command, id };
  if (command === "invoke" && (rest.length === 0 || rest.length === 2 && rest[0] === "--input-file"
      && rest[1] && !rest[1].startsWith("--"))) return { command, id, inputFile: rest[1] };
  throw new CapabilityError("USAGE", USAGE, 2);
}

export async function readEditAgentInput(file, input = process.stdin) {
  if (!file) return {};
  let bytes;
  try {
    if (file === "-") {
      const chunks = []; let size = 0;
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_INPUT_BYTES) throw new CapabilityError("INPUT_TOO_LARGE", "输入超过上限", 2);
        chunks.push(buffer);
      }
      bytes = Buffer.concat(chunks, size);
    } else {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new CapabilityError("INPUT_TOO_LARGE", "输入须为上限内的普通文件", 2);
        bytes = await handle.readFile();
        if (bytes.length > MAX_INPUT_BYTES) throw new CapabilityError("INPUT_TOO_LARGE", "输入超过上限", 2);
      } finally { await handle.close(); }
    }
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("INPUT_READ_FAILED", "无法读取 JSON 输入", 2);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CapabilityError("INVALID_INPUT", "输入不是合法 UTF-8 JSON", 2); }
}

export async function runEditAgentCli(argv, { env = process.env, input = process.stdin } = {}) {
  const args = parseEditAgentArgs(argv);
  const root = env.WORKLOOM_PRODUCT_ROOT ?? EDIT_AGENT_ROOT;
  const catalog = await loadEditAgentCatalog(root);
  if (args.command === "list") return editAgentList(catalog);
  if (args.command === "describe") {
    const descriptor = catalog.entries.get(args.id);
    if (!descriptor) throw new CapabilityError("NOT_FOUND", "能力不存在", 2);
    return descriptor;
  }
  return invokeEditAgent(catalog, args.id, await readEditAgentInput(args.inputFile, input), { env });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runEditAgentCli(process.argv.slice(2))) + "\n"); }
  catch (error) {
    process.stderr.write(JSON.stringify(editAgentError(error)) + "\n");
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
  }
}
