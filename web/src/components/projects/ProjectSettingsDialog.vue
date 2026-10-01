<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ApiClient } from "../../api/client.ts";
import { ApiError } from "../../api/client.ts";
import { getProjectSettings, updateProjectSettings, type ProjectSettings, type SettingsUpdate } from "../../api/project-settings.ts";
import Button from "../ui/AppButton.vue";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

const props = defineProps<{ client: ApiClient; projectId: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const settings = ref<ProjectSettings | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const name = ref("");
const description = ref("");
const part = ref("");
const frequency = ref("");
const constraints = ref<{ path: string; content: string }[]>([]);
const busy = computed(() => (settings.value?.blockers.length ?? 0) > 0);
const verificationDisabled = computed(() => busy.value || settings.value?.verification_edit_supported === false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    settings.value = await getProjectSettings(props.client, props.projectId);
    name.value = settings.value.name;
    description.value = settings.value.scope;
    part.value = settings.value.configuration.target_part ?? "";
    frequency.value = settings.value.configuration.target_frequency_mhz?.toString() ?? "";
    constraints.value = settings.value.configuration.constraints.map((file) => ({ ...file }));
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "读取项目设置失败";
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!settings.value || saving.value) return;
  const update: SettingsUpdate = { expected_revision: settings.value.settings_revision, name: name.value, description: description.value };
  if (!verificationDisabled.value) {
    const configuration = settings.value.configuration;
    if (part.value !== (configuration.target_part ?? "")) update.target_part = part.value;
    const nextFrequency = frequency.value === "" ? null : Number(frequency.value);
    if (nextFrequency !== configuration.target_frequency_mhz) update.target_frequency_mhz = nextFrequency;
    if (JSON.stringify(constraints.value) !== JSON.stringify(configuration.constraints)) update.constraints = constraints.value;
  }
  saving.value = true;
  error.value = "";
  try {
    await updateProjectSettings(props.client, props.projectId, update);
    emit("saved");
    emit("close");
  } catch (failure) {
    error.value = failure instanceof ApiError && failure.code === "conflict"
      ? "项目状态或设置已变化，请重新加载后再保存。" : failure instanceof Error ? failure.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Dialog :open="true" @update:open="!$event && !saving && emit('close')">
      <DialogContent :aria-describedby="undefined" class="max-h-[90vh] sm:max-w-2xl overflow-auto rounded-xl border-line bg-panel text-fg">
        <DialogTitle class="text-lg font-semibold">项目设置</DialogTitle>
        <p v-if="loading" role="status" class="animate-pulse py-8 text-fg-secondary">正在加载项目设置…</p>
        <p v-if="error" role="alert" class="my-3 text-sm text-danger">{{ error }}</p>
        <form v-if="settings && !loading" class="grid gap-4" @submit.prevent="save">
          <p class="text-xs text-fg-secondary">当前配置版本 {{ settings.config_epoch }}。修改器件、频率或约束后，需要重新验证；旧报告继续保留。</p>
          <label class="grid gap-1 text-sm">项目名称<input v-model="name" required maxlength="256" class="rounded border border-line bg-base p-2" /></label>
          <label class="grid gap-1 text-sm">项目描述<textarea v-model="description" maxlength="20000" rows="3" class="rounded border border-line bg-base p-2" /></label>
          <div v-if="busy" role="status" class="rounded border border-line p-3 text-sm text-fg-secondary">
            任务结束并确认结果后可修改验证配置。名称和描述仍可保存。
            <ul class="mt-2 list-disc pl-4"><li v-for="blocker in settings.blockers" :key="blocker.id">{{ blocker.kind === 'job' ? '工具任务' : 'Agent 回合' }} · {{ blocker.id }} · {{ blocker.state }}</li></ul>
          </div>
          <p v-if="settings.verification_edit_supported === false" class="text-sm text-fg-secondary">当前部署暂不支持修改验证配置，名称和描述仍可保存。</p>
          <fieldset :disabled="verificationDisabled || saving" class="grid gap-3 border-0 p-0 disabled:opacity-60">
            <label class="grid gap-1 text-sm">器件型号<input v-model="part" placeholder="例如 xc7k160tffg676-2" class="rounded border border-line bg-base p-2" /></label>
            <label class="grid gap-1 text-sm">目标频率（MHz）<input v-model="frequency" type="number" min="0.001" max="10000" step="any" placeholder="未设置" class="rounded border border-line bg-base p-2" /></label>
            <div v-for="(file, index) in constraints" :key="index" class="grid gap-2 rounded border border-line p-3">
              <label class="grid gap-1 text-sm">约束文件名<input v-model="file.path" required class="rounded border border-line bg-base p-2" /></label>
              <label class="grid gap-1 text-sm">约束内容<textarea v-model="file.content" rows="5" class="rounded border border-line bg-base p-2 font-mono text-xs" /></label>
              <Button type="button" size="sm" @click="constraints.splice(index, 1)">移除约束</Button>
            </div>
            <Button type="button" size="sm" :disabled="constraints.length >= 32" @click="constraints.push({ path: `constraints/config-${constraints.length + 1}.xdc`, content: '' })">添加约束文件</Button>
          </fieldset>
          <details class="text-sm"><summary>历史配置（{{ settings.history.length }}）</summary><ol class="mt-2 grid gap-2"><li v-for="snapshot in settings.history" :key="snapshot.epoch">配置版本 {{ snapshot.epoch }} · {{ snapshot.target_part ?? '未设器件' }} · {{ snapshot.target_frequency_mhz ?? '未设' }} MHz · {{ snapshot.created_at }}</li></ol></details>
          <div class="flex justify-end gap-2"><Button type="button" size="sm" :disabled="saving" @click="load">重新加载</Button><Button type="submit" :disabled="saving || !name.trim()">{{ saving ? '保存中…' : '保存设置' }}</Button></div>
        </form>
        <Button v-else-if="!loading" size="sm" @click="load">重试加载</Button>
      </DialogContent>
  </Dialog>
</template>
