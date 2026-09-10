import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("../src/components/formal/FormalDeliveryPanel.vue", import.meta.url), "utf8");
const projectView = readFileSync(new URL("../src/views/ProjectView.vue", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("P4 formal-delivery UI contract", () => {
  test("incomplete confirmed readiness remains revisable before formal input", () => {
    expect(component).toContain('v-if="shouldPrepareReadiness(state)"');
    expect(component).toContain("当前 G0 已完成，但工程约束仍不完整");
    expect(projectView).toContain("readinessPrepareAttempt");
  });

  test("Runtime is the only four-operation orchestrator and Web shows persisted progress", () => {
    expect(component).toContain("四项正式运行由绑定的主 Runtime 自动编排");
    expect(component).toContain("formalProgress?.jobs?.[operation]");
    expect(projectView).toContain("formalFlowProgress");
    expect(component).not.toContain("run-formal");
    expect(projectView).not.toContain("onRunFormalJob");
    expect(component).toContain('if (props.state?.completed) return "已完成"');
  });

  test("modern approvals bind Core evaluation and the planned G4 release identity", () => {
    expect(projectView).toContain("latestPassedEvaluation(evaluations, sub.snapshot_id)");
    expect(projectView).toContain("check_results_hash: evaluation.result_hash");
    expect(projectView).toContain("delivery_release_id: evaluation.delivery_release_id");
    expect(projectView).toContain('if (sub.gate === "G4") selectedDeliveryReleaseId.value = null;');
    expect(projectView).not.toContain("delivery_release_id: `rel-${crypto.randomUUID()}`");
  });

  test("change requests freeze both request and new work-version identities", () => {
    expect(component).toContain('work_version_id: `wv-${crypto.randomUUID()}`');
    expect(projectView).toContain("work_version_id: body.work_version_id");
    expect(projectView).toContain("changeRequestAttempt");
    expect(component).toContain("撤回变更并恢复已发布版本");
    expect(projectView).toContain("withdrawChangeRequestAttempt");
  });

  test("capability stays default-off and has explicit failure and narrow-screen states", () => {
    expect(packageJson.scripts["dev:mock"]).toContain("VITE_FEATURE_FORMAL_DELIVERY=1");
    expect(packageJson.scripts.dev).not.toContain("VITE_FEATURE_FORMAL_DELIVERY");
    expect(packageJson.scripts.build).not.toContain("VITE_FEATURE_FORMAL_DELIVERY");
    expect(component).toContain("正式能力未就绪");
    expect(component).toContain("width: 100vw");
    expect(component).toContain("grid-template-columns: 1fr");
  });

  test("narrow formal input and release rows cannot widen the delivery panel", () => {
    expect(component).toContain(".formal-section {\n  display: grid;\n  gap: var(--space-3);\n  min-width: 0;");
    expect(component).toContain(".formal-file-row { grid-template-columns: minmax(0, 1fr) auto; }");
    expect(component).toContain(".formal-file-row .formal-file-path,\n  .formal-file-row .mono { grid-column: 1 / -1; }");
    expect(component).toContain(".formal-delivery-path { min-width: 0; overflow: hidden; text-overflow: ellipsis;");
  });
});
