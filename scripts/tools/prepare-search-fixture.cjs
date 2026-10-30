#!/usr/bin/env node
/**
 * Prepare an exact-query search fixture from one reviewed official URL.
 *
 * This is for deterministic pressure tests: the Jenny plan's real query matrix
 * is generated from the current vendor, and every exact query is bound to the
 * same official public page. It does not invent product facts or reviews.
 */
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const name = arg("--product");
const brand = arg("--brand", name);
const category = arg("--category");
const url = arg("--url");
const out = resolve(arg("--out"));
if (!name || !brand || !category || !url || !out) {
  console.error("用法：prepare-search-fixture.cjs --product <名称> --brand <品牌> --category <品类> --url <官方公开URL> --out <fixture.json>");
  process.exit(2);
}
let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error(`--url 非法：${url}`);
  process.exit(2);
}
if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
  console.error("--url 必须是无凭据的 HTTP(S) 公开地址");
  process.exit(2);
}

const { JennyLoomEngine } = require(resolve(
  __dirname,
  "../../vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js",
));
const engine = new JennyLoomEngine({ mode: "api", storeRoot: resolve(dirname(out), ".plan") });
const plan = engine.plan({ name, brand, category });
const queries = [...new Set(Object.values(plan.plans).flatMap((stage) =>
  [...(stage.queries ?? []), ...(stage.discovery_queries ?? [])].map((item) => item.q).filter(Boolean),
))];
const title = arg("--title", `${name} — official public source`);
const snippet = arg("--snippet", `Official public source supplied for the current pressure test: ${url}`);
const fixture = {
  queries: Object.fromEntries(queries.map((query) => [query, [{ title, url: parsed.href, snippet }]])),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ out, queries: queries.length, productId: plan.product_id }, null, 2)}\n`);
