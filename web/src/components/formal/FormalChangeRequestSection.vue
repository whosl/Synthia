<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  ChangeRequestV1,
  CreateChangeRequestV1,
  DeliveryReleaseSummaryV1,
  P4GateId,
} from "../../api/types.ts";
import { changeImpactGateOptions } from "../../domain/formal-delivery.ts";
import Badge from "../ui/AppBadge.vue";
import Button from "../ui/AppButton.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

const props = defineProps<{
  readonly changeRequests: readonly ChangeRequestV1[];
  readonly currentRelease: DeliveryReleaseSummaryV1 | null;
  readonly operating: boolean;
}>();

const emit = defineEmits<{
  "create-change-request": [body: CreateChangeRequestV1];
  "withdraw-change-request": [changeRequestId: string, reason: string];
}>();

const changeReason = ref("");
const affectedPaths = ref("");
const impactGate = ref<Exclude<P4GateId, "G0">>("G4");
const withdrawReason = ref("");

const openChangeRequest = computed(() => props.changeRequests.find((change) => change.state === "open") ?? null);

function submitChangeRequest(): void {
  const release = props.currentRelease;
  const paths = affectedPaths.value.split(/\r?\n|,/).map((path) => path.trim()).filter(Boolean);
  if (!release || !changeReason.value.trim() || paths.length === 0) return;
  emit("create-change-request", {
    id: `cr-${crypto.randomUUID()}`,
    work_version_id: `wv-${crypto.randomUUID()}`,
    base_delivery_release_id: release.id,
    reason: changeReason.value.trim(),
    affected_paths: paths,
    impact_gate: impactGate.value,
  });
}

function withdrawChange(): void {
  const change = openChangeRequest.value;
  const reason = withdrawReason.value.trim();
  if (!change || !reason || props.operating) return;
  emit("withdraw-change-request", change.id, reason);
}
</script>

<template>
  <section class="grid min-w-0 gap-3 rounded-lg border border-line bg-base p-4 max-[720px]:p-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="m-0 text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase">发布后修改</p>
        <h3 class="m-0">变更请求与新工作版本</h3>
      </div>
    </div>
    <ul v-if="changeRequests.length" class="m-0 grid list-none gap-2 p-0">
      <li v-for="change in changeRequests" :key="change.id" class="flex items-center gap-3 rounded-md border border-line p-2">
        <Badge size="sm" class="font-bold" :tone="change.state === 'open' ? 'warn' : 'ok'">{{ change.state === "open" ? "进行中" : change.state === "released" ? "已发布" : "已撤回" }}</Badge>
        <div class="grid min-w-0 flex-1 gap-[2px]">
          <strong>{{ change.reason }}</strong>
          <small class="text-fg-muted">从 {{ change.impact_gate }} 重跑 · {{ change.affected_paths.length }} 个路径</small>
        </div>
      </li>
    </ul>
    <form v-if="openChangeRequest" class="grid gap-3" @submit.prevent="withdrawChange">
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        撤回原因
        <Textarea v-model="withdrawReason" rows="2" placeholder="说明为什么终止本次变更" class="resize-y bg-panel" />
      </label>
      <Button type="submit" variant="ghost" class="w-max rounded-sm border border-brand px-2 text-brand hover:bg-brand-subtle hover:text-brand" :disabled="operating || !withdrawReason.trim()">撤回变更并恢复已发布版本</Button>
    </form>
    <form v-else-if="currentRelease" class="grid gap-3" @submit.prevent="submitChangeRequest">
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        变更原因
        <Textarea v-model="changeReason" rows="2" placeholder="说明为什么要修改已发布结果" class="resize-y bg-panel" />
      </label>
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        影响路径
        <Textarea v-model="affectedPaths" rows="3" placeholder="每行一个相对路径" class="resize-y bg-panel" />
      </label>
      <label class="grid gap-[5px] text-xs text-fg-secondary">
        最早重跑阶段
        <Select v-model="impactGate">
          <SelectTrigger class="w-full">
            <SelectValue>{{ impactGate }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="gate in changeImpactGateOptions()" :key="gate" :value="gate">{{ gate }}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <Button type="submit" variant="primary" class="h-9 w-full font-bold" :disabled="operating || !changeReason.trim() || !affectedPaths.trim()">发起变更并创建新工作版本</Button>
    </form>
    <p v-else-if="!currentRelease && changeRequests.length === 0" class="m-0 p-4 text-center text-fg-muted">首个正式版本发布后，所有修改都必须从这里发起。</p>
  </section>
</template>
