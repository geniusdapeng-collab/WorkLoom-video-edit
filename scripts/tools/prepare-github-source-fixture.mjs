#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const url = new URL(arg("--url"));
const out = resolve(arg("--out"));
if (url.protocol !== "https:" || url.hostname !== "github.com") {
  throw new Error("--url 必须是 https://github.com/<owner>/<repo>");
}
const parts = url.pathname.split("/").filter(Boolean);
if (parts.length !== 2) throw new Error("--url 必须精确指向 GitHub 仓库根");
if (!out) throw new Error("缺少 --out");
const [owner, repo] = parts;
const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "WorkLoom-BookingSource/1.0",
  "x-github-api-version": "2022-11-28",
};
async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

const repository = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
const readme = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`);
const readmeText = Buffer.from(String(readme.content ?? "").replace(/\s+/gu, ""), "base64").toString("utf8").trim();
if (!readmeText) throw new Error("README API 未返回正文");
const license = repository.license?.spdx_id ? `License: ${repository.license.spdx_id}` : "";
const topics = Array.isArray(repository.topics) && repository.topics.length ? `Topics: ${repository.topics.join(", ")}` : "";
const rawText = [
  `Repository: ${repository.full_name}`,
  `Description: ${String(repository.description ?? "")}`,
  `Default branch: ${repository.default_branch}`,
  `Repository URL: ${repository.html_url}`,
  license,
  topics,
  "",
  readmeText,
].filter((line, index, lines) => line || index === lines.length - 2).join("\n").trim();
const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const decoded = rawText.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (all, entity) => {
  if (entity.startsWith("#")) {
    const value = Number.parseInt(entity.slice(/^#x/iu.test(entity) ? 2 : 1), /^#x/iu.test(entity) ? 16 : 10);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : all;
  }
  return named[entity.toLowerCase()] ?? all;
});
const text = decoded.replace(/\r\n?/gu, "\n").replace(/[\t \f]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
if (Buffer.byteLength(text) > 64_000) throw new Error(`官方来源正文超过 64000 字节：${owner}/${repo}`);
const digest = createHash("sha256").update(text).digest("hex");
const fixture = {
  schemaVersion: "workloom.booking-source/v1",
  requestedUrl: url.href,
  finalUrl: repository.html_url,
  contentType: "text/plain",
  text,
  fetchedAt: new Date().toISOString(),
  rawSha256: digest,
  textSha256: digest,
  bytes: Buffer.byteLength(text),
  repository: repository.full_name,
  defaultBranch: repository.default_branch,
  repositoryApiUrl: `https://api.github.com/repos/${repository.full_name}`,
  readmeApiUrl: `https://api.github.com/repos/${repository.full_name}/readme`,
  readmeSha: readme.sha,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ out, repository: fixture.repository, branch: fixture.defaultBranch, readmeSha: fixture.readmeSha, bytes: fixture.bytes, sha256: digest }, null, 2)}\n`);
