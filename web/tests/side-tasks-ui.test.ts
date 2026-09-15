import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("../src/components/tasks/SideTasksPanel.vue", import.meta.url), "utf8");
const diffCard = readFileSync(new URL("../src/components/tasks/SideTaskDiffCard.vue", import.meta.url), "utf8");
const tabs = readFileSync(new URL("../src/components/chat/AgentPaneTabs.vue", import.meta.url), "utf8");
const projectView = readFileSync(new URL("../src/views/ProjectView.vue", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("P3 side-task UI contract", () => {
  test("embeds Side Agents in the right pane as an embedded region", () => {
    expect(component).toContain('role="region"');
    expect(component).toContain('aria-label="探索任务"');
    expect(component).not.toContain("dialog");
    expect(component).not.toContain("returnFocus");
    expect(component).not.toContain("keydown.esc");
    expect(projectView).toContain("<SideTasksPanel");
    expect(projectView).toContain("<AgentPaneTabs");
    expect(projectView).toContain("activeAgentPane");
    expect(component).toContain("embedded");
    expect(tabs).toContain("主线");
    expect(tabs).toContain("添加 Side Agent");
  });

  test("renders creation, unadopted, result, diff, conflict, and manual adoption states", () => {
    for (const label of [
      "添加 Side Agent",
      "允许写入的精确路径",
      "最多 32 个",
      "单条最多 512 个 UTF-8 字节、32 层",
      "未采纳的内容不会进入主工作区或正式阶段",
      "结果摘要",
      "探索对话",
      "内容来自 Core 的持久化事件",
      "补充信息",
      "发送并继续探索",
    ]) {
      expect(component, label).toContain(label);
    }
    for (const label of [
      "文本差异",
      "探索起点哈希",
      "候选内容哈希",
      "当前主线哈希",
      "有冲突",
      "此文件不会被选入采纳",
      "人工采纳理由",
      "确认人工采纳",
      "任一选中文件冲突时整批不会写入",
    ]) {
      expect(diffCard, label).toContain(label);
    }
    expect(component).toContain("<SideTaskDiffCard");
    expect(diffCard).toContain(":disabled=\"file.adopted || file.conflict_reason !== null || operating\"");
    expect(diffCard).toContain("formatSideTaskHash(file.current_target_hash)");
  });

  test("deep links and failed writes stay behind the main/side isolation boundary", () => {
    expect(projectView).toContain("const currentAgentId = ref<string | null>(null)");
    expect(projectView).toContain("resolveMainTaskId(preferredTaskId, agents.value)");
    expect(projectView).toContain("prepareSideTaskCreateAttempt");
    expect(projectView).toContain("prepareSideTaskAdoptionAttempt");
    expect(projectView).toContain("getSideTaskEvents");
    expect(projectView).toContain("sideTaskMessageAttempt");
    expect(projectView).toContain("prepareTaskAbortAttempt(mainTaskAbortAttempt, currentAgentId.value)");
    expect(projectView).toContain("await abortAgent(api, projectId, attempt.taskId, attempt.idempotencyKey)");
    expect(projectView).toContain("mainTaskAbortAttempt = null");
    expect(projectView).toContain("await sendMessage(api, projectId, taskId, attempt.text, attempt.key)");
    expect(projectView).toContain("POST 失败时保留完整请求体和幂等键，原样重试");
    expect(projectView).toContain("POST 失败时保留完整请求体、adoption_id 和幂等键，原样重试");
    expect(projectView).toContain("此后的读取失败不能再表述为“创建失败”");
    expect(projectView).toContain("此后的读取失败不能再表述为“采纳失败”");
    expect(projectView).toContain("探索任务已创建，但最新状态刷新失败");
    expect(projectView).toContain("采纳已成功，但部分页面数据刷新失败");
    expect(component).toContain('"cancel-create": []');
    expect(projectView).not.toContain("探索任务隔离将在后续版本开放");
    expect(projectView).toContain("onAddSideAgent");
    expect(projectView).toContain("onArchiveSideAgent");
  });

  test("polls active side tasks only while a Side Agent pane is open", () => {
    expect(projectView).toContain("let sideTaskPoller: Poller | null = null");
    expect(projectView).toContain("shouldPollSideTasks(sideTasksOpen.value, sideTasks.value)");
    expect(projectView).toContain("void loadSideTasks(selectedSideTaskId.value ?? undefined)");
    expect(projectView).not.toContain("void refresh();\n    if (!shouldPollSideTasks");
  });

  test("keeps the embedded one-column layout; drawer breakpoints stay deleted", () => {
    expect(component).toContain("grid min-h-0 flex-1 grid-cols-1");
    expect(component).not.toContain("max-[720px]:w-screen");
    expect(component).not.toContain("max-[720px]:max-h-[190px]");
    expect(diffCard).toContain("max-[720px]:grid-cols-1");
  });

  test("mock explicitly enables the slice while normal dev/build stay default-off", () => {
    expect(packageJson.scripts["dev:mock"]).toContain("VITE_FEATURE_SIDE_TASKS=1");
    expect(packageJson.scripts.dev).not.toContain("VITE_FEATURE_SIDE_TASKS");
    expect(packageJson.scripts.build).not.toContain("VITE_FEATURE_SIDE_TASKS");
  });

  test("entry remains feature-gated for both recognized project types", () => {
    expect(projectView).toContain("sideTasksEnabled");
    expect(projectView).toContain(":can-create-side-agent=\"sideTasksEnabled");
    expect(projectView).toContain("shouldShowSideTasks");
  });
});
