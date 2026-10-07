/** Fixed, repository-local video guidance for desktop AI workbenches. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CapabilityError } from "../../../scripts/agent-capabilities.mjs";

export const GUIDE_CAPABILITY_ID = "growth.video.workbench.guide";
export const GUIDE_PATH = "docs/ai-video-workbench-guide.md";
export const MAX_GUIDE_BYTES = 128 * 1024;
const REPOSITORY = "workloom-ai/WorkLoom-growth";
const PRODUCT_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readFixedFile(relativePath, maxBytes, label) {
  let handle;
  try {
    const root = realpathSync(PRODUCT_ROOT);
    const file = join(root, relativePath);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || !within(root, realpathSync(file))) {
      throw new CapabilityError("GUIDE_UNAVAILABLE", `${label} 不是本仓普通文件`, 2);
    }
    handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size === 0 || opened.size > maxBytes) {
      throw new CapabilityError("GUIDE_UNAVAILABLE", `${label} 为空、不是普通文件或超过读取上限`, 2);
    }
    const bytes = readFileSync(handle);
    if (bytes.length === 0 || bytes.length > maxBytes) {
      throw new CapabilityError("GUIDE_UNAVAILABLE", `${label} 为空或超过读取上限`, 2);
    }
    return bytes;
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("GUIDE_UNAVAILABLE", `${label} 无法完整读取，请恢复本仓固定文件后重试`, 2);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function utf8(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CapabilityError("GUIDE_UNAVAILABLE", `${label} 不是有效 UTF-8`, 2); }
}

export function workbenchGuide(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
    throw new CapabilityError("INVALID_INPUT", "视频指南只接受空对象，不接受调用方路径或参数", 2);
  }
  const bytes = readFixedFile(GUIDE_PATH, MAX_GUIDE_BYTES, "视频调用指南");
  const markdown = utf8(bytes, "视频调用指南");
  const guideVersion = markdown.match(/^> guideVersion: (\d{4}-\d{2}-\d{2}\.\d+)\s*$/mu)?.[1];
  if (!guideVersion) throw new CapabilityError("GUIDE_UNAVAILABLE", "视频调用指南缺少有效版本", 2);
  let product;
  try { product = JSON.parse(utf8(readFixedFile("product.manifest.json", 64 * 1024, "产品清单"), "产品清单")); }
  catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("GUIDE_UNAVAILABLE", "产品清单不是合法 JSON", 2);
  }
  if (product?.schemaVersion !== "workloom.product/v1" || product.repository !== REPOSITORY
      || product.defaultBundle !== "geo-growth" || typeof product.productId !== "string" || !product.productId) {
    throw new CapabilityError("GUIDE_UNAVAILABLE", "视频指南与本仓产品身份不一致", 2);
  }
  return {
    schemaVersion: "workloom.video-workbench-guide/v1",
    guideVersion,
    path: GUIDE_PATH,
    repository: product.repository,
    productId: product.productId,
    displayName: product.displayName,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.length,
    markdown,
    limitations: [
      "只读固定指南，不创建项目、不调用模型或供应商、不执行渲染与后期。",
      "Growth 当前没有 Growthtest 的 standard-post 或 nativeaudio 专用契约。",
      "普通 voice 阶段可能补 TTS；原生声音或指定声线不得被静默替代。",
      "production.plan 的 ready 只是本地前置清单结果，不代表正式生产资格或交付。",
      "成片交付与社交平台发布须分别核验真实回执。",
    ],
  };
}
