<script setup lang="ts">
/**
 * 顶栏（spec §3.1）：返回按钮 + 项目名 + 进度摘要插槽 + 主题切换 + 用户区。
 * progress 插槽由 ProjectView 注入两个摘要 chip（项目门链 / 物理实现），
 * TopBar 自身不感知进度数据。
 *
 * 受控组件：只吃 TopBarProps，只吐 TopBarEmits（views/project-view-contract.ts）。
 * 返回项目列表是纯本地导航，不跨栏耦合数据，因此不走 emit，直接用 router 完成。
 */
import { useRouter } from "vue-router";
import type { TopBarEmits, TopBarProps } from "../../views/project-view-contract.ts";
import Icon from "../ui/Icon.vue";
import Button from "../ui/AppButton.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

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
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="返回项目列表" @click="onBack">←</Button>
        </TooltipTrigger>
        <TooltipContent>返回项目列表</TooltipContent>
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

    <div class="topbar-progress">
      <slot name="progress" />
    </div>

    <div class="topbar-right">
      <router-link class="topbar-inbox" to="/approvals" aria-label="审批中心" title="审批中心"><Icon name="inbox" :size="17" /></router-link>
      <button
        type="button"
        class="topbar-chat-toggle"
        aria-label="展开对话栏"
        :aria-pressed="props.chatOverlayOpen"
        @click="emit('toggle-chat-overlay')"
      >
        <Icon name="spark" :size="17" />
      </button>

      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="切换主题" @click="emit('toggle-theme')">
            <Icon :name="props.theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{{ props.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题' }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="退出登录" @click="emit('logout')"><Icon name="logout" :size="17" /></Button>
        </TooltipTrigger>
        <TooltipContent side="left">退出登录</TooltipContent>
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

.topbar-progress {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  /* 不能加 overflow: hidden —— 摘要 chip 的悬浮面板是绝对定位子元素，会被裁掉 */
}

.topbar-project-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
  font-size: var(--font-size-base);
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
  width: 32px;
  height: 32px;
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
.topbar-inbox { display: grid; place-items: center; width: 30px; height: 30px; color: var(--text-secondary); border-radius: 6px; }
.topbar-inbox:hover { background: var(--surface-hover); color: var(--accent); }
@media (max-width: 700px) {
  .topbar { gap: 4px; padding: 6px 8px; flex-wrap: wrap; align-content: center; }
  .topbar-left { flex: 1; gap: 3px; }
  .topbar-project-name { max-width: 110px; font-size: 12px; }
  .topbar-right { gap: 2px; }
  .topbar-progress { order: 3; flex: 1 1 100%; height: auto; padding: 2px 8px 6px; overflow: visible; }
  .topbar-right :deep(.task-switcher-trigger) { max-width: 85px; }
}
</style>
