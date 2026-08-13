<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../main.ts";
import { getRevisionContent, listArtifacts, listRevisions } from "../api/index.ts";
import type { Artifact, ArtifactRevision, RevisionContent } from "../api/types.ts";
import { REVISION_STATE_TEXT } from "../domain/gates.ts";
import { ARTIFACT_GROUP_ORDER, artifactDocName, artifactGroupName } from "../domain/artifacts.ts";
import { renderMarkdown } from "../domain/markdown.ts";
import ErrorNotice from "../components/ErrorNotice.vue";
import StatusBadge from "../components/StatusBadge.vue";

interface ArtifactGroup {
  readonly type: string;
  readonly artifacts: Artifact[];
}

const route = useRoute();
const projectId = String(route.params.id);

const groups = ref<ArtifactGroup[]>([]);
const loading = ref(true);
const error = ref<unknown>(null);

// 展开的产物 → 版本列表
const expandedId = ref<string | null>(null);
const revisions = ref<ArtifactRevision[]>([]);
const revisionsLoading = ref(false);
const revisionsError = ref<unknown>(null);

// 选中的修订 → 内容
const selectedRev = ref<ArtifactRevision | null>(null);
const content = ref<RevisionContent | null>(null);
const contentHtml = ref<string | null>(null);
const contentLoading = ref(false);
const contentError = ref<unknown>(null);

function stateBadgeKind(state: string): "accent" | "warn" | "ok" | "danger" | "plain" {
  switch (state) {
    case "candidate": return "accent";
    case "in_review": return "warn";
    case "approved": return "ok";
    case "rejected":
    case "invalidated": return "danger";
    default: return "plain";
  }
}

async function toggle(artifact: Artifact) {
  selectedRev.value = null;
  content.value = null;
  contentHtml.value = null;
  if (expandedId.value === artifact.id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = artifact.id;
  revisions.value = [];
  revisionsLoading.value = true;
  revisionsError.value = null;
  try {
    revisions.value = await listRevisions(api, projectId, artifact.id);
  } catch (err) {
    revisionsError.value = err;
  } finally {
    revisionsLoading.value = false;
  }
}

async function viewContent(rev: ArtifactRevision) {
  if (!expandedId.value) return;
  selectedRev.value = rev;
  content.value = null;
  contentHtml.value = null;
  contentLoading.value = true;
  contentError.value = null;
  try {
    const data = await getRevisionContent(api, projectId, expandedId.value, rev.id);
    content.value = data;
    contentHtml.value = renderMarkdown(data.content);
  } catch (err) {
    contentError.value = err;
  } finally {
    contentLoading.value = false;
  }
}

/** 当前展开的产物（预览头部取 GJB 文档名用）。 */
const expandedArtifact = computed(() => {
  if (!expandedId.value) return null;
  for (const group of groups.value) {
    const found = group.artifacts.find((a) => a.id === expandedId.value);
    if (found) return found;
  }
  return null;
});

const selectedGroupCount = computed(() => groups.value.reduce((n, g) => n + g.artifacts.length, 0));

onMounted(async () => {
  try {
    const artifacts = await listArtifacts(api, projectId);
    const byGroup = new Map<string, Artifact[]>();
    for (const artifact of artifacts) {
      const group = artifactGroupName(artifact.artifact_type);
      const list = byGroup.get(group) ?? [];
      list.push(artifact);
      byGroup.set(group, list);
    }
    groups.value = ARTIFACT_GROUP_ORDER.filter((name) => byGroup.has(name)).map((name) => ({
      type: name,
      artifacts: [...byGroup.get(name)!].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    }));
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <h1 class="page-title">产物库 <span class="mono muted">{{ projectId }}</span></h1>
  <p class="page-sub">只读视图。Agent 产物均为「候选」，批准仅通过审批中心进行。</p>

  <ErrorNotice v-if="error" :error="error" />
  <div v-if="loading" class="muted">加载中…</div>

  <template v-else>
    <div v-if="groups.length === 0" class="panel muted">该项目暂无产物。</div>

    <div v-for="group in groups" :key="group.type" class="panel">
      <h2>{{ group.type }} <span class="muted" style="font-weight: 400">（{{ group.artifacts.length }}）</span></h2>
      <table class="data">
        <thead>
          <tr>
            <th>文档</th>
            <th>创建时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="artifact in group.artifacts" :key="artifact.id">
            <tr>
              <td>《{{ artifactDocName(artifact.artifact_type) }}》</td>
              <td class="muted">{{ new Date(artifact.created_at).toLocaleString("zh-CN") }}</td>
              <td>
                <a href="#" @click.prevent="toggle(artifact)">
                  {{ expandedId === artifact.id ? "收起版本" : "查看版本" }}
                </a>
              </td>
            </tr>
            <tr v-if="expandedId === artifact.id">
              <td colspan="3" style="background: #fbfcfd">
                <ErrorNotice v-if="revisionsError" :error="revisionsError" />
                <div v-if="revisionsLoading" class="muted">版本加载中…</div>
                <template v-else>
                  <table class="data" v-if="revisions.length > 0">
                    <thead>
                      <tr>
                        <th>版本</th>
                        <th>状态</th>
                        <th>标题</th>
                        <th>创建时间</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="rev in revisions" :key="rev.id">
                        <td>v{{ rev.version }}</td>
                        <td>
                          <StatusBadge
                            :text="REVISION_STATE_TEXT[rev.state] ?? rev.state"
                            :kind="stateBadgeKind(rev.state)"
                          />
                        </td>
                        <td>{{ rev.title || "—" }}</td>
                        <td class="muted">{{ new Date(rev.created_at).toLocaleString("zh-CN") }}</td>
                        <td>
                          <a href="#" @click.prevent="viewContent(rev)">
                            {{ selectedRev?.id === rev.id ? "刷新内容" : "查看内容" }}
                          </a>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else class="muted">无版本。</div>

                  <div v-if="selectedRev" class="panel" style="margin: 12px 0 0; background: #fff">
                    <h2>
                      《{{ expandedArtifact ? artifactDocName(expandedArtifact.artifact_type) : "工程文档" }}》
                      <span class="muted" style="font-weight: 400; font-size: 13px">
                        v{{ selectedRev.version }} · {{ new Date(selectedRev.created_at).toLocaleString("zh-CN") }}
                      </span>
                      <StatusBadge
                        :text="REVISION_STATE_TEXT[selectedRev.state] ?? selectedRev.state"
                        :kind="stateBadgeKind(selectedRev.state)"
                      />
                    </h2>
                    <ErrorNotice v-if="contentError" :error="contentError" />
                    <div v-if="contentLoading" class="muted">内容加载中…</div>
                    <template v-else-if="contentHtml">
                      <div class="markdown-body" v-html="contentHtml"></div>
                      <div class="mono muted" style="font-size: 11px; margin-top: 10px">
                        content_hash {{ content?.content_hash }}
                      </div>
                    </template>
                  </div>
                </template>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="muted" style="font-size: 12px">共 {{ selectedGroupCount }} 个产物。</p>
  </template>
</template>
