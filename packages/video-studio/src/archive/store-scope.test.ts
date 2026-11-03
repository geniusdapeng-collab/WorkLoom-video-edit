import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveStore } from "./store.js";

describe("archive storage scope", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "archive-scope-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each(["../other/project", "/tmp/project", "..", ".", "other\\project", "C:\\project", "bad\0id"])(
    "rejects a project identity that is not one path component: %s", (projectId) => {
      expect(() => new ArchiveStore(directory, "own", projectId)).toThrow(/ARCHIVE_(?:IDENTITY|PATH)_INVALID/);
    },
  );

  it("checks the workspace component as well as the project component", () => {
    expect(() => new ArchiveStore(directory, "../other", "project")).toThrow(/ARCHIVE_(?:IDENTITY|PATH)_INVALID/);
  });

  it("preserves ordinary and non-ASCII single-component identities", async () => {
    const store = new ArchiveStore(directory, "工作区一", "影片-一");
    await store.ensure();
    await store.writeJsonAtomic("stages/preproduction/attempt-1.output.json", { value: "original" });
    expect((await store.readManifest())?.workspaceId).toBe("工作区一");
    expect(await store.readJson("stages/preproduction/attempt-1.output.json")).toEqual({ value: "original" });
  });

  it("does not read or overwrite a project reached through a directory link", async () => {
    const other = new ArchiveStore(directory, "other", "project");
    await other.ensure();
    const original = await readFile(path.join(other.root, "manifest.json"), "utf8");
    await mkdir(path.join(directory, "archive", "own"), { recursive: true });
    await symlink(other.root, path.join(directory, "archive", "own", "project"), "dir");
    const store = new ArchiveStore(directory, "own", "project");
    await expect(store.readManifest()).rejects.toThrow(/ARCHIVE_(?:PATH|SCOPE)_INVALID/);
    await expect(store.ensure()).rejects.toThrow(/ARCHIVE_(?:PATH|SCOPE)_INVALID/);
    expect(await readFile(path.join(other.root, "manifest.json"), "utf8")).toBe(original);
  });

  it("rejects linked files and nested directories for both reads and writes", async () => {
    const store = new ArchiveStore(directory, "own", "project");
    await store.ensure();
    const external = path.join(directory, "external.json");
    await writeFile(external, '{"value":"original"}');
    await symlink(external, path.join(store.root, "linked.json"));
    await expect(store.readJson("linked.json")).rejects.toThrow(/ARCHIVE_PATH_INVALID/);
    await expect(store.appendJsonl("linked.json", { changed: true })).rejects.toThrow(/ARCHIVE_PATH_INVALID/);
    await mkdir(path.join(directory, "outside"));
    await symlink(path.join(directory, "outside"), path.join(store.root, "nested"), "dir");
    await expect(store.writeJsonAtomic("nested/new.json", {})).rejects.toThrow(/ARCHIVE_PATH_INVALID/);
    expect(await readFile(external, "utf8")).toBe('{"value":"original"}');
  });

  it("refuses a manifest whose identity differs, including ensure's existing-manifest path", async () => {
    const store = new ArchiveStore(directory, "own", "project");
    await store.ensure();
    const manifestPath = path.join(store.root, "manifest.json");
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    const wrong = JSON.stringify({ ...current, workspaceId: "other" });
    await writeFile(manifestPath, wrong);
    await expect(store.readManifest()).rejects.toThrow(/ARCHIVE_SCOPE_INVALID/);
    await expect(store.ensure()).rejects.toThrow(/ARCHIVE_SCOPE_INVALID/);
    expect(await readFile(manifestPath, "utf8")).toBe(wrong);
  });
});
