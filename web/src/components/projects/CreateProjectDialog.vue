<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight, Cpu, Sparkles, X } from "lucide-vue-next";
import { api } from "../../api/service.ts";
import {
  createProject,
  listProcessVersions,
  type CreateProjectRequest,
} from "../../api/index.ts";
import type { ProcessVersion } from "../../api/types.ts";
import {
  validateCreateProject,
  type ProjectType,
} from "../../domain/project.ts";
import {
  prepareWriteAttempt,
  type WriteAttempt,
} from "../../domain/write-attempt.ts";
import ErrorNotice from "../ErrorNotice.vue";
import Button from "../ui/AppButton.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const emit = defineEmits<{ close: []; created: [projectId: string] }>();
const name = ref("");
const type = ref<ProjectType | null>(null);
const profileId = ref("");
const part = ref("");
const versions = ref<ProcessVersion[]>([]);
const versionsLoading = ref(false);
const versionsError = ref<unknown>(null);
const creating = ref(false);
const error = ref<unknown>(null);
let attempt: WriteAttempt<CreateProjectRequest> | null = null;
const availableIds = computed(() =>
  versions.value.map((version) => version.id),
);
const disabled = computed(
  () =>
    creating.value ||
    !type.value ||
    !name.value.trim() ||
    (type.value === "engineering" &&
      (versionsLoading.value ||
        !!versionsError.value ||
        !availableIds.value.includes(profileId.value))),
);

// 单选卡片与表单字段的共享样式（原 portal.css 的 .form-field 与本组件 scoped 样式）
const typeOptionClass =
  "relative grid cursor-pointer gap-2 rounded-[12px] border p-[18px] max-[480px]:p-3.5";
const fieldClass = "grid gap-2 text-xs";
const inputClass =
  "w-full rounded-[8px] border border-line-strong bg-base px-3 py-[11px] disabled:opacity-60";

async function loadVersions() {
  if (versionsLoading.value) return;
  versionsLoading.value = true;
  versionsError.value = null;
  try {
    versions.value = await listProcessVersions(api);
  } catch (cause) {
    versionsError.value = cause;
  } finally {
    versionsLoading.value = false;
  }
}

function close() {
  if (!creating.value) emit("close");
}

// Esc / 点击遮罩时 Reka 会请求关闭；创建中保持打开（同原生 dialog 的 cancel 守卫）
function handleOpenChange(open: boolean) {
  if (!open) close();
}

async function submit() {
  if (creating.value) return;
  const validation = validateCreateProject({
    name: name.value,
    projectType: type.value,
    processProfileId: profileId.value,
    targetPart: part.value,
    availableProcessProfileIds: availableIds.value,
  });
  if (validation) {
    error.value = new Error(validation);
    return;
  }
  const input = {
    name: name.value.trim(),
    project_type: type.value!,
    target_part: part.value.trim(),
    process_profile_id: type.value === "engineering" ? profileId.value : null,
  };
  attempt = prepareWriteAttempt(attempt, JSON.stringify(input), () => ({
    id: `proj-${crypto.randomUUID()}`,
    name: input.name,
    data_classification: "D1",
    ...(input.target_part ? { target_part: input.target_part } : {}),
    ...(input.project_type === "engineering"
      ? {
          project_type: "engineering",
          process_profile_id: input.process_profile_id!,
        }
      : { project_type: "free" }),
  }));
  creating.value = true;
  error.value = null;
  try {
    const project = await createProject(api, attempt.body, attempt.key);
    emit("created", project.id);
  } catch (cause) {
    error.value = cause;
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  void loadVersions();
});
</script>

<template>
  <Dialog :open="true" @update:open="handleOpenChange">
    <DialogContent
      :show-close-button="false"
      class="max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-32px))] gap-0 overflow-y-auto rounded-[20px] border-line bg-panel p-0 shadow-[0_24px_80px_var(--shadow-color)] sm:max-w-[min(560px,calc(100vw-32px))]"
    >
      <form class="grid gap-5 p-7 max-[480px]:p-5" @submit.prevent="submit">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p
              class="m-0 mb-2.5 text-[10px] font-semibold tracking-[2px] text-brand"
            >
              NEW PROJECT
            </p>
            <DialogTitle class="m-0 mt-1 text-2xl leading-normal font-semibold"
              >从一个新项目开始</DialogTitle
            >
          </div>
          <button
            class="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-fg-secondary hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            aria-label="关闭新建项目"
            :disabled="creating"
            @click="close"
          >
            <X :size="18" />
          </button>
        </div>
        <DialogDescription class="m-0 text-[13px] leading-[1.7] text-fg-secondary"
          >选择适合的工作方式，接下来交给你和 Agent。</DialogDescription
        >
        <ErrorNotice v-if="error" :error="error" />
        <fieldset class="m-0 grid grid-cols-2 gap-3 border-0 p-0" :disabled="creating">
          <legend class="mb-3">
            项目类型 <span class="leading-[1.7] text-fg-secondary">· 必选</span>
          </legend>
          <label
            :class="[
              typeOptionClass,
              type === 'free' ? 'border-brand bg-brand-subtle' : 'border-line-strong',
            ]"
            ><input
              v-model="type"
              type="radio"
              value="free"
              class="absolute top-4 right-4 accent-brand"
            /><Sparkles :size="22" /><strong>自由项目</strong
            ><span class="text-xs leading-[1.6] text-fg-secondary"
              >快速验证想法、排查问题，无固定阶段。</span
            ></label
          >
          <label
            :class="[
              typeOptionClass,
              type === 'engineering'
                ? 'border-brand bg-brand-subtle'
                : 'border-line-strong',
            ]"
            ><input
              v-model="type"
              type="radio"
              value="engineering"
              class="absolute top-4 right-4 accent-brand"
            /><Cpu :size="22" /><strong>工程项目</strong
            ><span class="text-xs leading-[1.6] text-fg-secondary"
              >按流程推进，从需求确认到正式交付。</span
            ></label
          >
        </fieldset>
        <label :class="fieldClass"
          ><span
            >项目名称
            <span class="leading-[1.7] text-fg-secondary">· 必填</span></span
          ><input
            v-model="name"
            required
            maxlength="200"
            placeholder="例如：星载图像处理模块"
            :disabled="creating"
            :class="inputClass"
        /></label>
        <template v-if="type === 'engineering'">
          <p
            v-if="versionsLoading"
            class="m-0 leading-[1.7] text-fg-secondary"
            role="status"
          >
            正在加载可用流程…
          </p>
          <div v-else-if="versionsError">
            <ErrorNotice :error="versionsError" /><Button
              :disabled="creating"
              @click="loadVersions"
              >重新加载流程</Button
            >
          </div>
          <p v-else-if="!versions.length" class="m-0 leading-[1.6] text-warn" role="alert">
            当前没有可用的工程流程，请联系管理员后重试。
          </p>
          <label v-else :class="fieldClass"
            ><span>流程版本 · 必选</span
            ><select
              v-model="profileId"
              required
              :disabled="creating"
              :class="inputClass"
            >
              <option disabled value="">选择流程版本</option>
              <option
                v-for="version in versions"
                :key="version.id"
                :value="version.id"
              >
                {{ version.name }}
              </option>
            </select></label
          >
        </template>
        <label :class="fieldClass"
          ><span
            >目标器件
            <span class="leading-[1.7] text-fg-secondary">· 可稍后填写</span></span
          ><input
            v-model="part"
            placeholder="例如：xc7a35tcpg236-1"
            :disabled="creating"
            :class="inputClass"
        /></label>
        <div class="flex justify-end gap-2 pt-2">
          <Button class="h-[38px]" :disabled="creating" @click="close"
            >取消</Button
          ><Button
            type="submit"
            variant="primary"
            class="h-[38px]"
            :disabled="disabled"
            :loading="creating"
            >创建并进入项目<ArrowRight :size="16"
          /></Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
