<script setup lang="ts">
import { computed } from "vue";
import {
  GATES,
  GATE_REVIEW_NAMES,
  GATE_LANE_STATE_TEXT,
  currentGate,
  type GateId,
  type GateLaneState,
} from "../domain/gates.ts";
import StatusBadge from "./StatusBadge.vue";

/**
 * G0~G9 门禁泳道。状态由父组件从 gate_submissions + baselines 推导传入；
 * 当前门（第一个未批准的门）高亮。
 */
const props = defineProps<{ lanes: Record<GateId, GateLaneState> }>();

const current = computed(() => currentGate(props.lanes));

const STATE_BADGE_KIND: Record<GateLaneState, "plain" | "warn" | "ok" | "danger"> = {
  not_started: "plain",
  in_review: "warn",
  approved: "ok",
  rejected: "danger",
};
</script>

<template>
  <div class="lanes">
    <template v-for="(gate, i) in GATES" :key="gate">
      <div class="lane" :class="{ current: gate === current }" :title="gate">
        <div class="gate-name">{{ GATE_REVIEW_NAMES[gate] }}</div>
        <StatusBadge :text="GATE_LANE_STATE_TEXT[lanes[gate]]" :kind="STATE_BADGE_KIND[lanes[gate]]" />
        <span v-if="i < GATES.length - 1" class="arrow">›</span>
      </div>
    </template>
  </div>
</template>
