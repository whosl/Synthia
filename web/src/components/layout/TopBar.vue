<script setup lang="ts">
/**
 * 顶栏（spec §3.1）：返回按钮 + 项目名 + 进度摘要插槽 + 主题切换 + 用户区。
 * progress 插槽由 ProjectView 注入阶段状态 chip（StageStatusChip：门链 +
 * 物理实现的合并摘要，详情在悬浮面板），TopBar 自身不感知进度数据。
 *
 * 受控组件：只吃 TopBarProps，只吐 TopBarEmits（views/project-view-contract.ts）。
 * 返回项目列表是纯本地导航，不跨栏耦合数据，因此不走 emit，直接用 router 完成。
 */
import { useRouter } from "vue-router";
import { Inbox, LogOut, Moon, Sparkles, Sun } from "lucide-vue-next";
import type { TopBarEmits, TopBarProps } from "../../views/project-view-contract.ts";
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
  <div
    class="flex h-full items-center gap-3 px-3 text-fg max-[700px]:flex-wrap max-[700px]:content-center max-[700px]:gap-1 max-[700px]:px-2 max-[700px]:py-1.5"
  >
    <div class="flex flex-none items-center gap-2 min-w-0 max-[700px]:flex-1 max-[700px]:gap-[3px]">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="返回项目列表" @click="onBack">←</Button>
        </TooltipTrigger>
        <TooltipContent>返回项目列表</TooltipContent>
      </Tooltip>
      <strong class="max-w-[220px] truncate text-[13px] max-[700px]:max-w-[110px] max-[700px]:text-xs">{{ props.projectName || "（项目）" }}</strong>

      <!-- <1024px：文件树抽屉化，顶栏露出汉堡按钮（spec R3） -->
      <button
        type="button"
        class="hidden size-8 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-[13px] text-fg-secondary hover:bg-hover hover:text-fg max-[1023px]:inline-flex"
        aria-label="展开文件树"
        :aria-pressed="props.treeDrawerOpen"
        @click="emit('toggle-tree-drawer')"
      >
        ☰
      </button>
    </div>

    <!-- 不能加 overflow-hidden——摘要 chip 的悬浮面板是绝对定位子元素，会被裁掉 -->
    <div
      class="flex min-w-0 flex-1 items-center gap-2 max-[700px]:order-3 max-[700px]:h-auto max-[700px]:flex-[1_1_100%] max-[700px]:overflow-visible max-[700px]:px-2 max-[700px]:pt-[2px] max-[700px]:pb-1.5"
    >
      <slot name="progress" />
    </div>

    <div class="flex flex-none items-center gap-2 max-[700px]:gap-[2px]">
      <router-link
        class="grid size-[30px] place-items-center rounded-md text-fg-secondary hover:bg-hover hover:text-brand"
        to="/approvals"
        aria-label="审批中心"
        title="审批中心"
      ><Inbox :size="17" /></router-link>
      <!-- <1280px：对话栏浮层化，顶栏露出对话按钮（spec R3） -->
      <button
        type="button"
        class="hidden size-8 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-[13px] text-fg-secondary hover:bg-hover hover:text-fg max-[1279px]:inline-flex"
        aria-label="展开对话栏"
        :aria-pressed="props.chatOverlayOpen"
        @click="emit('toggle-chat-overlay')"
      >
        <Sparkles :size="17" />
      </button>

      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="切换主题" @click="emit('toggle-theme')">
            <Sun v-if="props.theme === 'dark'" :size="17" />
            <Moon v-else :size="17" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{{ props.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题' }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" aria-label="退出登录" @click="emit('logout')"><LogOut :size="17" /></Button>
        </TooltipTrigger>
        <TooltipContent side="left">退出登录</TooltipContent>
      </Tooltip>
    </div>
  </div>
</template>
