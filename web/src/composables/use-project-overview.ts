import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ApiClient } from "../api/client.ts";
import {
  activeMainTasks,
  loadProjectOverview,
  pendingReviews,
  type ProjectOverview,
} from "../domain/project-overview.ts";

export function useProjectOverview(client: ApiClient, progressive = false) {
  const rows = ref<readonly ProjectOverview[]>([]);
  const loading = ref(true);
  const refreshing = ref(false);
  const error = ref<unknown>(null);
  const lastUpdated = ref<string | null>(null);
  let disposed = false;

  async function reload(): Promise<void> {
    if (refreshing.value || disposed) return;
    refreshing.value = true;
    error.value = null;
    try {
      const firstLoad = loading.value;
      const result = await loadProjectOverview(client, {
        isDisposed: () => disposed,
        onProgress: progressive && firstLoad ? (nextRows) => {
          if (disposed) return;
          rows.value = nextRows;
          loading.value = false;
        } : undefined,
      });
      if (disposed) return;
      rows.value = result;
      lastUpdated.value = new Date().toISOString();
    } catch (cause) {
      if (!disposed) error.value = cause;
    } finally {
      if (!disposed) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  onMounted(() => {
    void reload();
    window.addEventListener("focus", reload);
  });
  onBeforeUnmount(() => {
    disposed = true;
    window.removeEventListener("focus", reload);
  });

  return {
    rows,
    loading,
    refreshing,
    detailsLoading: computed(() => loading.value || rows.value.some((row) => row.pending)),
    error,
    lastUpdated,
    reload,
    reviews: computed(() => pendingReviews(rows.value)),
    activeTasks: computed(() => activeMainTasks(rows.value)),
    incompleteRows: computed(() =>
      rows.value.filter((row) => row.issues.length > 0),
    ),
  };
}
