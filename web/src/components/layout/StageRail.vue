<script setup lang="ts">
/** Core-owned G0-G4 rail. Node order and copy are supplied by process-profile.v1. */
import { computed, ref } from "vue";
import type { ProcessGateView, ProcessGateStatus } from "../../domain/process-profile.ts";
import {
  currentProcessGate,
  processProgress,
  PROCESS_GATE_STATUS_TEXT,
} from "../../domain/process-profile.ts";

const props = defineProps<{
  readonly stageChain: readonly ProcessGateView[] | null;
  readonly emptyText: string;
}>();

const emit = defineEmits<{ "select-stage": [stageId: string] }>();
const mobileOverlayOpen = ref(false);
const current = computed(() => currentProcessGate(props.stageChain));
const progress = computed(() => props.stageChain ? processProgress(props.stageChain) : { done: 0, total: 0 });

function statusText(status: ProcessGateStatus): string {
  return PROCESS_GATE_STATUS_TEXT[status];
}

function select(stageId: string): void {
  emit("select-stage", stageId);
}
</script>

<template>
  <div class="stage-rail" aria-label="G0 至 G4 工程流程">
    <div v-if="!stageChain" class="stage-rail-empty">{{ emptyText }}</div>
    <template v-else>
      <ol class="stage-rail-desktop">
        <li v-for="(entry, index) in stageChain" :key="entry.node.id" class="stage-rail-step">
          <span v-if="index > 0" class="stage-rail-line" :class="`state-${entry.status}`" aria-hidden="true" />
          <button
            type="button"
            class="stage-rail-node"
            :class="`state-${entry.status}`"
            :aria-current="entry.status === 'current' || entry.status === 'gated' || entry.status === 'failed' ? 'step' : undefined"
            :title="`${entry.node.id} · ${entry.node.name} · ${statusText(entry.status)}\n${entry.node.goal}`"
            @click="select(entry.node.id)"
          >
            <span class="stage-rail-dot" aria-hidden="true" />
            <span class="stage-rail-code">{{ entry.node.id }}</span>
            <span class="stage-rail-name">{{ entry.node.name }}</span>
          </button>
        </li>
      </ol>

      <button type="button" class="stage-rail-mobile-summary" @click="mobileOverlayOpen = true">
        <template v-if="current">
          {{ current.node.id }} {{ current.node.name }} · {{ statusText(current.status) }} · {{ progress.done }}/{{ progress.total }}
        </template>
      </button>

      <Teleport to="body">
        <div v-if="mobileOverlayOpen" class="stage-rail-overlay" @click.self="mobileOverlayOpen = false">
          <section class="stage-rail-overlay-panel" aria-modal="true" role="dialog" aria-label="工程流程详情">
            <header class="stage-rail-overlay-header">
              <div>
                <strong>G0–G4 工程流程</strong>
                <p>{{ progress.done }}/{{ progress.total }} 已完成</p>
              </div>
              <button type="button" class="stage-rail-overlay-close" @click="mobileOverlayOpen = false">关闭</button>
            </header>
            <ol class="stage-rail-overlay-list">
              <li v-for="entry in stageChain" :key="entry.node.id">
                <button
                  type="button"
                  class="stage-rail-overlay-row"
                  :class="`state-${entry.status}`"
                  @click="select(entry.node.id); mobileOverlayOpen = false"
                >
                  <span class="stage-rail-overlay-code">{{ entry.node.id }}</span>
                  <span class="stage-rail-overlay-copy">
                    <strong>{{ entry.node.name }}</strong>
                    <small>{{ entry.node.goal }}</small>
                  </span>
                  <span class="stage-rail-overlay-status">{{ statusText(entry.status) }}</span>
                </button>
              </li>
            </ol>
          </section>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.stage-rail {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 100%;
}

.stage-rail-empty {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.stage-rail-desktop {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stage-rail-step {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  min-width: 0;
}

.stage-rail-line {
  flex: 1 1 16px;
  height: 2px;
  background: var(--border-strong);
}

.stage-rail-line.state-done {
  background: var(--state-success);
}

.stage-rail-node {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-rows: auto auto;
  column-gap: 5px;
  min-width: 0;
  padding: 2px 5px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  cursor: pointer;
}

.stage-rail-node:hover,
.stage-rail-node:focus-visible {
  background: var(--surface-hover);
}

.stage-rail-dot {
  grid-row: 1 / 3;
  align-self: center;
  width: 9px;
  height: 9px;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
}

.stage-rail-node.state-done .stage-rail-dot {
  border-color: var(--state-success);
  background: var(--state-success);
}

.stage-rail-node.state-current .stage-rail-dot {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-subtle);
}

.stage-rail-node.state-gated .stage-rail-dot {
  border-color: var(--state-warning);
  background: var(--state-warning);
}

.stage-rail-node.state-failed .stage-rail-dot {
  border-color: var(--state-danger);
  background: var(--state-danger);
}

.stage-rail-code {
  color: inherit;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.stage-rail-name {
  max-width: 92px;
  overflow: hidden;
  color: inherit;
  font-size: 11px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-rail-node.state-done,
.stage-rail-node.state-current {
  color: var(--text-primary);
}

.stage-rail-node.state-gated {
  color: var(--state-warning);
}

.stage-rail-node.state-failed {
  color: var(--state-danger);
}

.stage-rail-mobile-summary {
  display: none;
  width: 100%;
  padding: 5px var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
}

.stage-rail-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.48);
}

.stage-rail-overlay-panel {
  width: 100%;
  max-height: 88vh;
  padding: var(--space-4);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--surface-panel);
  overflow: auto;
}

.stage-rail-overlay-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.stage-rail-overlay-header p {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.stage-rail-overlay-close {
  border: 0;
  background: transparent;
  color: var(--accent);
}

.stage-rail-overlay-list {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  padding: 0;
  list-style: none;
}

.stage-rail-overlay-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-base);
  color: var(--text-primary);
  text-align: left;
}

.stage-rail-overlay-row.state-current,
.stage-rail-overlay-row.state-gated {
  border-color: var(--accent);
}

.stage-rail-overlay-row.state-failed {
  border-color: var(--state-danger);
}

.stage-rail-overlay-code,
.stage-rail-overlay-status {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 700;
}

.stage-rail-overlay-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.stage-rail-overlay-copy small {
  color: var(--text-muted);
  line-height: 1.35;
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
