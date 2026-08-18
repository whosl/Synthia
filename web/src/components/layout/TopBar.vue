<script setup lang="ts">
/**
 * 顶栏（spec §3.1）：返回按钮 + 项目名 + 阶段进度条 + 任务切换器 + 主题切换 + 用户区。
 *
 * 受控组件：只吃 TopBarProps，只吐 TopBarEmits（views/project-view-contract.ts）。
 * 返回项目列表是纯本地导航，不跨栏耦合数据，因此不走 emit，直接用 router 完成。
 */
import { useRouter } from "vue-router";
import type { TopBarEmits, TopBarProps } from "../../views/project-view-contract.ts";
import StageRail from "./StageRail.vue";
import TaskSwitcher from "./TaskSwitcher.vue";
import Button from "../ui/Button.vue";
import Tooltip from "../ui/Tooltip.vue";

const props = defineProps<TopBarProps>();
const emit = defineEmits<TopBarEmits>();

const router = useRouter();

function onBack(): void {
  void router.push({ name: "projects" });
}
</script>

<template>
  <div class="topbar">
    <div class="topbar-left">
      <Tooltip text="返回项目列表">
        <Button variant="ghost" size="sm" aria-label="返回项目列表" @click="onBack">←</Button>
      </Tooltip>
      <strong class="topbar-project-name">{{ props.projectName || "（项目）" }}</strong>

      <button
        type="button"
        class="topbar-hamburger"
        aria-label="展开文件树"
        :aria-pressed="props.treeDrawerOpen"
        @click="emit('toggle-tree-drawer')"
      >
        ☰
      </button>
    </div>

    <div class="topbar-center">
      <StageRail :stage-chain="props.stageChain" @select-stage="(id) => emit('select-stage', id)" />
    </div>

    <div class="topbar-right">
      <TaskSwitcher :runs="props.runs" :current-run="props.currentRun" @select-run="(id) => emit('select-run', id)" />

      <button
        type="button"
        class="topbar-chat-toggle"
        aria-label="展开对话栏"
        :aria-pressed="props.chatOverlayOpen"
        @click="emit('toggle-chat-overlay')"
      >
        💬
      </button>

      <Tooltip :text="props.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'">
        <Button variant="ghost" size="sm" aria-label="切换主题" @click="emit('toggle-theme')">
          {{ props.theme === "dark" ? "☾" : "☀" }}
        </Button>
      </Tooltip>

      <Tooltip text="退出登录">
        <Button variant="ghost" size="sm" aria-label="退出登录" @click="emit('logout')">⎋</Button>
      </Tooltip>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 100%;
  padding: 0 var(--space-3);
  color: var(--text-primary);
}

.topbar-left {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.topbar-project-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
  font-size: var(--font-size-base);
}

.topbar-center {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.topbar-right {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.topbar-hamburger,
.topbar-chat-toggle {
  display: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-base);
}

.topbar-hamburger:hover,
.topbar-chat-toggle:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

/* <1024px：文件树抽屉化，顶栏露出汉堡按钮（spec R3） */
@media (max-width: 1023px) {
  .topbar-hamburger {
    display: inline-flex;
  }
}

/* <1280px：对话栏浮层化，顶栏露出对话按钮（spec R3） */
@media (max-width: 1279px) {
  .topbar-chat-toggle {
    display: inline-flex;
  }
}
</style>
