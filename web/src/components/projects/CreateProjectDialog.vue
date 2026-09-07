<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
import Button from "../ui/Button.vue";
import Icon from "../ui/Icon.vue";

const emit = defineEmits<{ close: []; created: [projectId: string] }>();
const dialog = ref<HTMLDialogElement | null>(null);
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
  dialog.value?.showModal();
  void loadVersions();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="create-dialog"
    aria-labelledby="create-title"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
  >
    <form class="create-form" @submit.prevent="submit">
      <div class="dialog-heading">
        <div>
          <p class="eyebrow">NEW PROJECT</p>
          <h2 id="create-title">从一个新项目开始</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="关闭新建项目"
          :disabled="creating"
          @click="close"
        >
          <Icon name="close" />
        </button>
      </div>
      <p class="secondary-text">选择适合的工作方式，接下来交给你和 Agent。</p>
      <ErrorNotice v-if="error" :error="error" />
      <fieldset class="project-type-options" :disabled="creating">
        <legend>项目类型 <span class="secondary-text">· 必选</span></legend>
        <label :class="{ checked: type === 'free' }"
          ><input v-model="type" type="radio" value="free" /><Icon
            name="spark"
            :size="22"
          /><strong>自由项目</strong
          ><span>快速验证想法、排查问题，无固定阶段。</span></label
        >
        <label :class="{ checked: type === 'engineering' }"
          ><input v-model="type" type="radio" value="engineering" /><Icon
            name="chip"
            :size="22"
          /><strong>工程项目</strong
          ><span>按流程推进，从需求确认到正式交付。</span></label
        >
      </fieldset>
      <label class="form-field"
        ><span>项目名称 <span class="secondary-text">· 必填</span></span
        ><input
          v-model="name"
          required
          maxlength="200"
          placeholder="例如：星载图像处理模块"
          :disabled="creating"
      /></label>
      <template v-if="type === 'engineering'">
        <p v-if="versionsLoading" class="secondary-text" role="status">
          正在加载可用流程…
        </p>
        <div v-else-if="versionsError">
          <ErrorNotice :error="versionsError" /><Button
            :disabled="creating"
            @click="loadVersions"
            >重新加载流程</Button
          >
        </div>
        <p v-else-if="!versions.length" class="form-warning" role="alert">
          当前没有可用的工程流程，请联系管理员后重试。
        </p>
        <label v-else class="form-field"
          ><span>流程版本 · 必选</span
          ><select v-model="profileId" required :disabled="creating">
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
      <label class="form-field"
        ><span>目标器件 <span class="secondary-text">· 可稍后填写</span></span
        ><input
          v-model="part"
          placeholder="例如：xc7a35tcpg236-1"
          :disabled="creating"
      /></label>
      <div class="dialog-footer">
        <Button :disabled="creating" @click="close">取消</Button
        ><Button
          type="submit"
          variant="primary"
          :disabled="disabled"
          :loading="creating"
          >创建并进入项目<Icon name="arrow" :size="16"
        /></Button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.create-dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 20px;
  background: var(--surface-panel);
  color: var(--text-primary);
  box-shadow: 0 24px 80px var(--shadow-color);
}
.create-dialog::backdrop {
  background: #11121680;
  backdrop-filter: blur(5px);
}
.create-form {
  padding: 28px;
  display: grid;
  gap: 20px;
}
.dialog-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.dialog-heading h2 {
  font-size: 24px;
  margin: 4px 0 0;
  font-weight: 600;
}
.create-form p {
  margin: 0;
}
.project-type-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 0;
  border: 0;
  margin: 0;
}
.project-type-options legend {
  margin-bottom: 12px;
}
.project-type-options label {
  position: relative;
  display: grid;
  gap: 8px;
  padding: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  cursor: pointer;
}
.project-type-options label.checked {
  border-color: var(--accent);
  background: var(--accent-subtle);
}
.project-type-options input {
  position: absolute;
  top: 16px;
  right: 16px;
  accent-color: var(--accent);
}
.project-type-options span {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
}
.dialog-footer :deep(.ui-button) {
  height: 38px;
}
@media (max-width: 480px) {
  .create-form {
    padding: 20px;
  }
  .project-type-options label {
    padding: 14px;
  }
}
</style>
