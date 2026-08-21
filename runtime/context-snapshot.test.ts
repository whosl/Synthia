import { describe, expect, test } from "bun:test";
import { buildContextSnapshot } from "./context-snapshot.ts";
import { MockGovernanceClient } from "./governance-client.ts";
import type { ProjectInfo } from "./types.ts";

class SnapshotGovernance extends MockGovernanceClient {
  readProjectInfoCount = 0;

  constructor(private readonly info: ProjectInfo) {
    super();
  }

  override async getProjectInfo(_projectId: string): Promise<ProjectInfo> {
    this.readProjectInfoCount++;
    return this.info;
  }
}

function baseProjectInfo(overrides: Partial<ProjectInfo>): ProjectInfo {
  return {
    id: "p1",
    name: "Project",
    status: "active",
    scope: "",
    dataClassification: "D1",
    targetPart: "",
    standardVersion: "",
    processInstances: [],
    ...overrides,
  };
}

describe("buildContextSnapshot project process profile rendering", () => {
  test("free projects do not force GJB standard or milestone sections", async () => {
    const snapshot = await buildContextSnapshot(new SnapshotGovernance(baseProjectInfo({
      id: "p-free",
      name: "Free exploration",
      projectType: "free",
      standardVersion: "GB/T 33781-2017",
      processInstances: [{ id: "pi-free", currentGate: "G0", gateProfileVersion: "flow-v1" }],
    })), "p-free");

    expect(snapshot).toContain("类型：自由");
    expect(snapshot).toContain("流程实例：pi-free");
    expect(snapshot).not.toContain("标准：");
    expect(snapshot).not.toContain("### 里程碑");
    expect(snapshot).not.toContain("### 门禁提交");
    expect(snapshot).not.toContain("当前门禁");
  });

  test("engineering projects render GJB_REF_V1 profile and G0 as preparation", async () => {
    const snapshot = await buildContextSnapshot(new SnapshotGovernance(baseProjectInfo({
      id: "p-eng",
      name: "Engineering project",
      projectType: "engineering",
      targetPart: "xc7a100tcsg324-1",
      standardVersion: "GB/T 33781-2017",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
      processProfileVersion: "GJB_REF_V1",
      processInstances: [{ id: "pi-eng", currentGate: "G0", gateProfileVersion: "flow-v1" }],
    })), "p-eng");

    expect(snapshot).toContain("类型：工程");
    expect(snapshot).toContain("GJB_REF_V1");
    expect(snapshot).toContain("G0（项目准备）");
    expect(snapshot).toContain("当前阶段：项目准备中（G0），下一步推进 G1");
    expect(snapshot).toContain("标准：GB/T 33781-2017");
  });

  test("LEGACY_COMPAT is labelled but never rendered as the new GJB flow", async () => {
    const snapshot = await buildContextSnapshot(new SnapshotGovernance(baseProjectInfo({
      id: "p-legacy",
      name: "Legacy project",
      projectType: "engineering",
      processVersionId: "LEGACY_COMPAT",
      processProfileId: "LEGACY_COMPAT",
      processProfileName: "兼容旧流程",
      processProfileVersion: "LEGACY_COMPAT",
      processInstances: [{ id: "pi-legacy", currentGate: "G0", gateProfileVersion: "flow-v1" }],
    })), "p-legacy");

    expect(snapshot).toContain("兼容旧流程");
    expect(snapshot).not.toContain("### 里程碑");
    expect(snapshot).not.toContain("### 门禁提交");
  });

  test("incomplete or conflicting GJB facts fail closed without flow sections", async () => {
    const incomplete = await buildContextSnapshot(new SnapshotGovernance(baseProjectInfo({
      id: "p-incomplete",
      projectType: "engineering",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
      processProfileVersion: "GJB_REF_V1",
    })), "p-incomplete");
    const conflicting = await buildContextSnapshot(new SnapshotGovernance(baseProjectInfo({
      id: "p-conflicting",
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
      processProfileVersion: "LEGACY_COMPAT",
    })), "p-conflicting");

    for (const snapshot of [incomplete, conflicting]) {
      expect(snapshot).not.toContain("### 里程碑");
      expect(snapshot).not.toContain("### 门禁提交");
    }
  });

  test("missing project facts fail closed without injecting GJB milestones", async () => {
    class UnavailableProjectGovernance extends MockGovernanceClient {
      override async getProjectInfo(): Promise<ProjectInfo> {
        throw new Error("Core unavailable");
      }
    }
    const snapshot = await buildContextSnapshot(new UnavailableProjectGovernance(), "p-unavailable");
    expect(snapshot).toContain("项目元信息：获取失败");
    expect(snapshot).not.toContain("### 里程碑");
    expect(snapshot).not.toContain("### 门禁提交");
  });

  test("pinned session facts prevent a second Core read from injecting GJB", async () => {
    const governance = new SnapshotGovernance(baseProjectInfo({
      id: "p-flipped",
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
      processProfileVersion: "GJB_REF_V1",
    }));
    const resolvedFree = baseProjectInfo({
      id: "p-flipped",
      name: "Resolved free project",
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    });

    const snapshot = await buildContextSnapshot(governance, "p-flipped", {
      projectInfo: resolvedFree,
    });

    expect(governance.readProjectInfoCount).toBe(0);
    expect(snapshot).toContain("类型：自由");
    expect(snapshot).not.toContain("GJB_REF_V1");
    expect(snapshot).not.toContain("### 里程碑");
    expect(snapshot).not.toContain("### 门禁提交");
  });
});
