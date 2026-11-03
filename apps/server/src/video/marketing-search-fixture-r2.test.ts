import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearch, searchCacheKey } from "./data-mining-executor.js";

const query = "Fixture Model";
const booked = { title: "Fixture Model source", url: "https://example.com/booked", snippet: "Booked source" };
let dir: string;

beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "marketing-fixture-r2-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function runner(cacheFile: string, fixtureOnly: boolean) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    results: [{ title: "Fixture Model online", url: "https://example.com/online", content: "Online source" }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  return { fetchImpl, search: createWebSearch({
    cacheFile, fixtureOnly, providers: ["api"], paceMs: 0,
    api: { provider: "generic", apiUrl: "https://search.example.com/search", apiKey: "test-only", fetchImpl },
  }) };
}

describe("booked search stays offline", () => {
  it.each(["absent", "empty", "expired", "corrupt"] as const)("makes zero online calls with an %s fixture", async (kind) => {
    const cacheFile = path.join(dir, "search.json");
    if (kind === "corrupt") await writeFile(cacheFile, "{invalid", "utf8");
    else if (kind !== "absent") await writeFile(cacheFile, JSON.stringify({
      version: 1,
      entries: { [searchCacheKey("fixture", query)]: {
        at: kind === "expired" ? "2020-01-01T00:00:00.000Z" : new Date().toISOString(),
        hits: kind === "empty" ? [] : [booked],
      } },
    }), "utf8");
    const { fetchImpl, search } = runner(cacheFile, true);
    expect(await search(query, 3)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses booked hits and keeps the normal online search path available", async () => {
    const cacheFile = path.join(dir, "search.json");
    await writeFile(cacheFile, JSON.stringify({
      version: 1, entries: { [searchCacheKey("fixture", query)]: { at: new Date().toISOString(), hits: [booked] } },
    }), "utf8");
    const offline = runner(cacheFile, true);
    expect(await offline.search(query, 3)).toEqual([booked]);
    expect(offline.fetchImpl).not.toHaveBeenCalled();
    const online = runner(path.join(dir, "unbooked.json"), false);
    expect(await online.search(query, 3)).toEqual([
      { title: "Fixture Model online", url: "https://example.com/online", snippet: "Online source" },
    ]);
    expect(online.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
