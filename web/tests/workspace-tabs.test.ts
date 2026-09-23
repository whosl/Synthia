import { describe, expect, test } from "bun:test";
import { createFileTab, tabAfterClose } from "../src/domain/workspace-tabs.ts";
import type { FileTreeEntry } from "../src/views/project-view-contract.ts";

const revision = (id: string, version: number) => ({ id, version, state: "candidate", content_hash: id, content_location: id, created_at: "2026-09-24T00:00:00Z" });
const old = revision("rev-1", 1);
const latest = revision("rev-2", 2);
const entry: FileTreeEntry = {
  artifactId: "rtl", artifactType: "RTL_SOURCE_SET", createdAt: old.created_at,
  path: "src/top.v", status: "registered", phase: null,
  revisions: [old, latest], latestRevision: latest,
};

describe("workspace documents", () => {
  test("opening a file again targets the existing workspace tab", () => {
    expect(createFileTab(entry)!.id).toBe(createFileTab({ ...entry })!.id);
    expect(createFileTab(entry)!.source).toBe("workspace");
  });
  test("workspace, frozen versions and comparisons never share a tab", () => {
    const tabs = [createFileTab(entry), createFileTab(entry, old.id), createFileTab(entry, latest.id), createFileTab(entry, latest.id, old.id)];
    expect(new Set(tabs.map((tab) => tab!.id)).size).toBe(4);
    expect(tabs[1]!.revisionId).toBe(old.id);
    expect(tabs[1]!.description).toContain("快照 · 只读");
  });
  test("a missing approval revision cannot fall back to the latest version", () => {
    expect(createFileTab(entry, "missing")).toBeNull();
    expect(createFileTab(entry, latest.id, "missing")).toBeNull();
  });
  test("registering a workspace path does not duplicate its open tab", () => {
    const unregistered = { ...entry, artifactId: "ws:src/top.v", latestRevision: null, revisions: [] };
    expect(createFileTab(unregistered)!.id).toBe(createFileTab(entry)!.id);
  });
  test("artifacts outside the workspace use their exact revision", () => {
    const tab = createFileTab({ ...entry, status: null });
    expect(tab!.source).toBe("revision");
    expect(tab!.revisionId).toBe(latest.id);
  });
  test("different paths with identical basenames remain distinct", () => {
    expect(createFileTab(entry)!.id).not.toBe(createFileTab({ ...entry, path: "test/top.v" })!.id);
  });
});

describe("closing workspace tabs", () => {
  const ids = ["overview", "reviews", "a", "b", "c"];
  test("closing an inactive file keeps the selected document", () => {
    expect(tabAfterClose(ids, "a", "c")).toBe("a");
  });
  test("closing the selected file chooses the next neighbor, then the previous", () => {
    expect(tabAfterClose(ids, "b", "b")).toBe("c");
    expect(tabAfterClose(ids, "c", "c")).toBe("b");
    expect(tabAfterClose(["overview", "a"], "a", "a")).toBe("overview");
  });
});
