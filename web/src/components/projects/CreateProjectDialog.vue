<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight, Cpu, Sparkles } from "lucide-vue-next";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

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

// 单选卡片与表单字段的共享样式
const typeOptionClass =
  "relative grid cursor-pointer gap-2 rounded-xl border p-4 transition-colors max-[480px]:p-3.5";
const fieldClass = "grid gap-2 text-xs";

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

// Esc / 点击遮罩 / 内建关闭按钮时 Reka 会请求关闭；创建中保持打开（同原生 dialog 的 cancel 守卫）
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
      class="max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-32px))] gap-0 overflow-y-auto rounded-xl border-line bg-panel p-0 shadow-[0_24px_80px_var(--shadow-color)] sm:max-w-[min(560px,calc(100vw-32px))]"
    >
      <form class="grid gap-5 p-7 max-[480px]:p-5" @submit.prevent="submit">
        <div>
          <p
            class="m-0 mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-brand uppercase"
          >
            New Project
          </p>
          <DialogTitle class="m-0 mt-1 text-2xl leading-normal font-semibold"
            >从一个新项目开始</DialogTitle
          >
        </div>
        <DialogDescription class="m-0 text-[13px] leading-[1.7] text-fg-secondary"
          >选择适合的工作方式，接下来交给你和 Agent。</DialogDescription
        >
        <ErrorNotice v-if="error" :error="error" />
        <div>
          <p class="m-0 mb-3 text-xs">
            项目类型 <span class="leading-[1.7] text-fg-secondary">· 必选</span>
          </p>
          <RadioGroup
            v-model="type"
            class="grid grid-cols-2 gap-3"
            :disabled="creating"
          >
            <Label
              for="ptype-free"
              :class="[
                typeOptionClass,
                type === 'free'
                  ? 'border-brand bg-brand-subtle'
                  : 'border-line-strong hover:border-fg-muted',
              ]"
              ><RadioGroupItem
                id="ptype-free"
                value="free"
                class="absolute top-4 right-4"
              /><Sparkles :size="22" /><strong>自由项目</strong
              ><span class="text-xs leading-[1.6] text-fg-secondary"
                >快速验证想法、排查问题，无固定阶段。</span
              ></Label
            >
            <Label
              for="ptype-engineering"
              :class="[
                typeOptionClass,
                type === 'engineering'
                  ? 'border-brand bg-brand-subtle'
                  : 'border-line-strong hover:border-fg-muted',
              ]"
              ><RadioGroupItem
                id="ptype-engineering"
                value="engineering"
                class="absolute top-4 right-4"
              /><Cpu :size="22" /><strong>工程项目</strong
              ><span class="text-xs leading-[1.6] text-fg-secondary"
                >按流程推进，从需求确认到正式交付。</span
              ></Label
            >
          </RadioGroup>
        </div>
        <Label :class="fieldClass"
          ><span
            >项目名称
            <span class="leading-[1.7] text-fg-secondary">· 必填</span></span
          ><Input
            v-model="name"
            required
            maxlength="200"
            placeholder="例如：星载图像处理模块"
            :disabled="creating"
        /></Label>
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
          <div v-else :class="fieldClass">
            <Label for="process-version">流程版本 · 必选</Label>
            <Select v-model="profileId" :disabled="creating">
              <SelectTrigger id="process-version" class="w-full">
                <SelectValue placeholder="选择流程版本" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="version in versions"
                  :key="version.id"
                  :value="version.id"
                >
                  {{ version.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </template>
        <Label :class="fieldClass"
          ><span
            >目标器件
            <span class="leading-[1.7] text-fg-secondary">· 可稍后填写</span></span
          ><Input
            v-model="part"
            placeholder="例如：xc7a35tcpg236-1"
            :disabled="creating"
        /></Label>
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
