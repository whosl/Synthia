<script setup lang="ts">
/**
 * 顶栏阶段进度条（spec §3.1，D18）。
 *
 * - PC 端（≥768px）：三段渲染，段与段之间用里程碑门（实心菱形）连接。段内的
 *   中间节点默认折叠成一条带进度的短轨（如「设计 3/4」），hover/focus 展开浮层
 *   列出该段全部节点及状态；菱形门节点常驻展示，hover 显示门编号与门名。
 * - 移动端（<768px）：只渲染一行摘要「③ RTL 生成 · 进行中 · 8/15」，点击展开
 *   全屏弹层看完整阶段图（全部 15 节点纵向列表）。
 * - 点击任意阶段/门节点 → emit `select-stage`，由 ProjectView 联动左栏切「阶段」
 *   视图并定位到该阶段产物组（spec §3.1 末条）。
 */
import { computed, ref } from "vue";
import type { StageChainNode, StageNodeStatus } from "../../domain/tasks.ts";
import { STAGE_NODE_STATUS_TEXT } from "../../domain/tasks.ts";
import {
  currentStageSummary,
  gateNode,
  segmentProgress,
  segmentStatus,
  STAGE_SEGMENTS,
  type StageSegment,
} from "../../domain/process-profile.ts";

const props = defineProps<{
  /** `deriveStageChain` 的输出；null=当前项目不展示新版工程阶段条。 */
  readonly stageChain: readonly StageChainNode[] | null;
  readonly emptyText: string;
}>();

const emit = defineEmits<{
  "select-stage": [stageId: string];
}>();

const CIRCLED_INDEX = ["①", "②", "③"] as const;

function chainNode(id: string): StageChainNode | undefined {
  return props.stageChain?.find((c) => c.node.id === id);
}

const segments = computed(() => {
  const chain = props.stageChain;
  if (!chain) return [];
  return STAGE_SEGMENTS.map((segment) => ({
    segment,
    progress: segmentProgress(segment, chain),
    status: segmentStatus(segment, chain),
    gate: gateNode(segment.gateId),
    gateStatus: chainNode(segment.gateId)?.status ?? "pending",
    middleNodes: segment.middleNodeIds.map((id) => chainNode(id)).filter((n): n is StageChainNode => !!n),
  }));
});

const summary = computed(() => currentStageSummary(props.stageChain));

const hoveredSegmentIndex = ref<number | null>(null);
const mobileOverlayOpen = ref(false);

function onHoverSegment(segment: StageSegment, hovering: boolean): void {
  if (hovering) {
    hoveredSegmentIndex.value = segment.index;
  } else if (hoveredSegmentIndex.value === segment.index) {
    hoveredSegmentIndex.value = null;
  }
}

function toggleSegmentFlyout(segment: StageSegment): void {
  hoveredSegmentIndex.value = hoveredSegmentIndex.value === segment.index ? null : segment.index;
}

function onSelectNode(nodeId: string): void {
  emit("select-stage", nodeId);
  hoveredSegmentIndex.value = null;
}

function statusText(status: StageNodeStatus): string {
  return STAGE_NODE_STATUS_TEXT[status];
}

</script>

<template>
  <div class="stage-rail">
    <div v-if="!stageChain" class="stage-rail-empty">{{ emptyText }}</div>

    <template v-else>
      <!-- PC 端：三段 + 里程碑门 -->
      <div class="stage-rail-desktop" role="group" aria-label="阶段进度">
        <template v-for="item in segments" :key="item.segment.gateId">
          <div
            class="stage-segment"
            :class="`state-${item.status}`"
            @mouseenter="onHoverSegment(item.segment, true)"
            @mouseleave="onHoverSegment(item.segment, false)"
          >
            <button type="button" class="stage-segment-track" @click="toggleSegmentFlyout(item.segment)">
              <span class="stage-segment-label">{{ item.progress.label }}</span>
              <span class="stage-segment-bar">
                <span
                  class="stage-segment-bar-fill"
                  :style="{ width: item.progress.total ? `${(item.progress.done / item.progress.total) * 100}%` : '0%' }"
                />
              </span>
              <span class="stage-segment-count">{{ item.progress.done }}/{{ item.progress.total }}</span>
            </button>

            <!-- hover/点击展开：该段全部中间节点及状态 -->
            <div v-if="hoveredSegmentIndex === item.segment.index" class="stage-segment-flyout" role="menu">
              <button
                v-for="node in item.middleNodes"
                :key="node.node.id"
                type="button"
                class="stage-flyout-row"
                :class="`state-${node.status}`"
                role="menuitem"
                @click="onSelectNode(node.node.id)"
              >
                <span class="stage-flyout-dot" aria-hidden="true" />
                <span class="stage-flyout-name">{{ node.node.name }}</span>
                <span class="stage-flyout-status">{{ statusText(node.status) }}</span>
              </button>
            </div>
          </div>

          <!-- 里程碑门：实心菱形，hover 显示编号与门名 -->
          <button
            type="button"
            class="stage-gate"
            :class="`state-${item.gateStatus}`"
            :title="`${item.gate.id} · ${item.gate.name} · ${statusText(item.gateStatus)}`"
            @click="onSelectNode(item.gate.id)"
          >
            <span class="stage-gate-diamond" aria-hidden="true" />
            <span class="stage-gate-label">{{ item.gate.id }}</span>
          </button>
        </template>
      </div>

      <!-- 移动端：一行摘要，点击开全屏弹层 -->
      <button type="button" class="stage-rail-mobile-summary" @click="mobileOverlayOpen = true">
        <template v-if="summary">
          {{ CIRCLED_INDEX[summary.segmentIndex - 1] }} {{ summary.node.name }} · {{ statusText(summary.status) }} ·
          {{ summary.done }}/{{ summary.total }}
        </template>
      </button>

      <Teleport to="body">
        <div v-if="mobileOverlayOpen" class="stage-rail-overlay" @click.self="mobileOverlayOpen = false">
          <div class="stage-rail-overlay-panel">
            <header class="stage-rail-overlay-header">
              <strong>阶段进度</strong>
              <button type="button" class="stage-rail-overlay-close" @click="mobileOverlayOpen = false">关闭</button>
            </header>
            <ul class="stage-rail-overlay-list">
              <li v-for="entry in stageChain" :key="entry.node.id">
                <button
                  type="button"
                  class="stage-rail-overlay-row"
                  :class="[`state-${entry.status}`, entry.node.kind === 'gate' ? 'is-gate' : '']"
                  @click="onSelectNode(entry.node.id); mobileOverlayOpen = false"
                >
                  <span class="stage-flyout-dot" aria-hidden="true" />
                  <span class="stage-flyout-name">{{ entry.node.name }}<template v-if="entry.node.kind === 'gate'"> ({{ entry.node.id }})</template></span>
                  <span class="stage-flyout-status">{{ statusText(entry.status) }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.stage-rail {
  display: flex;
  align-items: center;
  height: 100%;
  min-width: 0;
}

.stage-rail-empty {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

/* ─── PC 端 ─────────────────────────────────────────────────────────── */

.stage-rail-desktop {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.stage-segment {
  position: relative;
}

.stage-segment-track {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: var(--surface-hover);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
  transition: background-color var(--duration) var(--ease-out);
}

.stage-segment-track:hover {
  background: var(--border-subtle);
}

.stage-segment-label {
  white-space: nowrap;
}

.stage-segment-bar {
  position: relative;
  width: 40px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--border-subtle);
  overflow: hidden;
}

.stage-segment-bar-fill {
  position: absolute;
  inset: 0;
  width: 0;
  background: var(--text-muted);
  transition: width var(--duration-slow) var(--ease-out);
}

.stage-segment.state-done .stage-segment-bar-fill {
  background: var(--state-ok);
}

.stage-segment.state-running .stage-segment-bar-fill {
  background: var(--accent);
}

.stage-segment.state-waiting .stage-segment-bar-fill {
  background: var(--state-warn);
}

.stage-segment.state-failed .stage-segment-bar-fill {
  background: var(--state-danger);
}

.stage-segment-count {
  color: var(--text-muted);
  white-space: nowrap;
}

.stage-segment.state-running .stage-segment-label,
.stage-segment.state-running .stage-segment-count {
  color: var(--accent);
}

.stage-segment.state-waiting .stage-segment-label,
.stage-segment.state-waiting .stage-segment-count {
  color: var(--state-warn);
}

.stage-segment.state-failed .stage-segment-label,
.stage-segment.state-failed .stage-segment-count {
  color: var(--state-danger);
}

.stage-segment-flyout {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-dropdown);
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 200px;
  padding: var(--space-1);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px var(--shadow-color);
}

.stage-flyout-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  text-align: left;
}

.stage-flyout-row:hover {
  background: var(--surface-hover);
}

.stage-flyout-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stage-flyout-status {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
}

.stage-flyout-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--border-strong);
}

.stage-flyout-row.state-done .stage-flyout-dot {
  background: var(--state-ok);
}

.stage-flyout-row.state-running .stage-flyout-dot {
  background: var(--accent);
}

.stage-flyout-row.state-waiting .stage-flyout-dot {
  background: var(--state-warn);
}

.stage-flyout-row.state-failed .stage-flyout-dot {
  background: var(--state-danger);
}

/* 里程碑门：实心菱形加重 */
.stage-gate {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.stage-gate-diamond {
  width: 9px;
  height: 9px;
  flex: none;
  background: var(--border-strong);
  transform: rotate(45deg);
  border-radius: 2px;
}

.stage-gate.state-done .stage-gate-diamond {
  background: var(--state-ok);
}

.stage-gate.state-running .stage-gate-diamond {
  background: var(--accent);
}

.stage-gate.state-waiting .stage-gate-diamond {
  background: var(--state-warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--state-warn) 22%, transparent);
}

.stage-gate.state-failed .stage-gate-diamond {
  background: var(--state-danger);
}

.stage-gate-label {
  font-size: 11px;
  font-family: var(--font-mono);
}

.stage-gate.state-done .stage-gate-label,
.stage-gate.state-running .stage-gate-label,
.stage-gate.state-waiting .stage-gate-label,
.stage-gate.state-failed .stage-gate-label {
  color: var(--text-secondary);
}

/* ─── 移动端摘要 + 全屏弹层 ─────────────────────────────────────────── */

.stage-rail-mobile-summary {
  display: none;
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius);
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.stage-rail-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: color-mix(in srgb, black 45%, transparent);
  padding: var(--space-6) var(--space-3);
}

.stage-rail-overlay-panel {
  width: 100%;
  max-width: 420px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-panel);
  border-radius: var(--radius);
  box-shadow: 0 16px 40px var(--shadow-color);
  overflow: hidden;
}

.stage-rail-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
}

.stage-rail-overlay-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-sm);
}

.stage-rail-overlay-list {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
}

.stage-rail-overlay-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-size-base);
  text-align: left;
}

.stage-rail-overlay-row:hover {
  background: var(--surface-hover);
}

.stage-rail-overlay-row.is-gate .stage-flyout-name {
  font-weight: 600;
}

@media (max-width: 767px) {
  .stage-rail-desktop {
    display: none;
  }

  .stage-rail-mobile-summary {
    display: block;
  }
}
</style>
