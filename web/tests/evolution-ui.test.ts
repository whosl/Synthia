import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../src/views/EvolutionView.vue", import.meta.url), "utf8");
const summary = readFileSync(new URL("../src/components/evolution/EvolutionSummary.vue", import.meta.url), "utf8");
const detail = readFileSync(new URL("../src/components/evolution/LearnedSkillDetail.vue", import.meta.url), "utf8");
const list = readFileSync(new URL("../src/components/evolution/LearnedSkillList.vue", import.meta.url), "utf8");
const router = readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
const pageShell = readFileSync(new URL("../src/components/layout/PageShell.vue", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("self-evolution global UI contract", () => {
  test("global route and shell-nav entry are feature-gated", () => {
    expect(router).toContain('{ path: "/evolution", name: "evolution", component: EvolutionView }');
    expect(pageShell).toContain('v-if="SELF_EVOLUTION_FEATURE_ENABLED"');
    expect(pageShell).toContain('to="/evolution"');
    expect(packageJson.scripts["dev:mock"]).toContain("VITE_FEATURE_SELF_EVOLUTION=1");
    expect(packageJson.scripts.dev).not.toContain("VITE_FEATURE_SELF_EVOLUTION");
    expect(packageJson.scripts.build).not.toContain("VITE_FEATURE_SELF_EVOLUTION");
    expect(packageJson.scripts["build:golden"]).toContain("VITE_FEATURE_SELF_EVOLUTION=1");
  });

  test("Web consumes Core only and freezes retries instead of directly invoking Runtime", () => {
    expect(view).toContain('import { api } from "../api/service.ts"');
    expect(view).toContain("freezeWriteAttempt");
    expect(view).toContain("expected_revision: current.settings_revision");
    expect(view).toContain("expected_control_revision: detail.control_revision");
    expect(view).toContain("manual_key: crypto.randomUUID()");
    expect(view).not.toContain("runtime/");
    expect(view).not.toContain("fetch(");
  });

  test("overview exposes pause, disable, Run Curator now, dry-run, and fixed schedule facts", () => {
    for (const label of [
      "暂停学习",
      "禁用 Learned Skills",
      "Run Curator now",
      "Dry-run",
      "控制原因（写操作必填）",
      "失败重试会复用同一请求体和幂等键",
    ]) {
      expect(summary, label).toContain(label);
    }
    expect(summary).toContain("overview.curator.schedule_days");
    expect(summary).toContain("overview.curator.max_vivado_jobs");
  });

  test("rollout-off uses action-level availability and retains only emergency disable", () => {
    expect(summary).toContain("canToggleLearning");
    expect(summary).toContain("canToggleLearnedSkills");
    expect(summary).toContain("canRunCurator");
    expect(summary).toContain("仅保留全局和单 Skill 的紧急禁用");
    expect(detail).toContain("!detail.enabled && !rolloutEnabled");
    expect(detail).toContain("rollout 关闭期间仅保留紧急禁用");
    expect(view).toContain("canControlLearnedSkill");
    expect(view).toContain("Pin/Unpin、Archive/Restore 与恢复均保持锁定");
    expect(view).toContain("Core rollout 未启用；Curator run 与 dry-run 均保持锁定");
  });

  test("Skill user controls expose Pin/Unpin and Archive/Restore with one frozen CAS reason", () => {
    for (const label of [
      "Pinned · 自动修改锁定",
      "Archived · 普通搜索隐藏",
      "Unpin",
      "Pin",
      "Restore",
      "Archive",
      "普通 Agent 搜索将隐藏它，固定 application 仍可查看和关闭",
    ]) {
      expect(`${view}\n${detail}`, label).toContain(label);
    }
    expect(detail).toContain("controlReason.trim()");
    expect(view).toContain("expected_control_revision: detail.control_revision");
    expect(view).toContain("skillControlAttempt.body");
    expect(view).toContain("skillControlAttempt.idempotencyKey");
    expect(view).toContain("replaceSkill(next)");
  });

  test("Skill details show immutable versions, assets, unknown metrics and the full supersede history", () => {
    for (const label of [
      "提升未知",
      "首次解决问题族",
      "不可变版本与资产",
      "适用条件（供 Agent 自由判断）",
      "局部结果契约",
      "真实调用记录",
      "完整 evaluation / supersede 历史",
      "主 Agent 声明（非权威）",
      "受权限保护",
    ]) {
      expect(detail, label).toContain(label);
    }
    expect(detail).toContain("version.version.files");
    expect(detail).toContain("application.evaluations");
    expect(detail).toContain("currentEvaluationSet");
    expect(list).toContain("successRateText(skill.metrics)");
    expect(list).toContain("turn / 任务片段封存后");
    expect(list).toContain("仍有更多结果未加载");
    expect(detail).toContain("applicationsTruncated");
    expect(detail).toContain("仍有更多结果未加载");
    expect(detail).toContain('detail.metrics.first_solved_problem_families ?? "未知"');
  });

  test("desktop content collapses to one column and remains usable at 320/390 widths", () => {
    expect(view).toContain("max-[980px]:grid-cols-1");
    expect(view).toContain("max-[560px]:");
    expect(detail).toContain("max-[560px]:");
    expect(detail).toContain("max-[900px]:grid-cols-1");
    expect(summary).toContain("max-[560px]:");
    // 标题行的换行与长名约束（原 scoped CSS 的 Tailwind 等价物：flex-wrap + min-w-0/max-w-full + wrap-anywhere）
    expect(detail).toContain('class="flex min-w-0 flex-wrap items-center gap-2"');
    expect(detail).toContain('class="m-0 min-w-0 max-w-full wrap-anywhere"');
    expect(detail).toContain('class="min-w-0 max-w-full"');
  });
});
