<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const paths: Record<string, string> = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  check: "m5 12 4 4L19 6",
  inbox: "M4 4h16l2 11v5H2v-5L4 4Z M2 15h6l2 3h4l2-3h6",
  plus: "M12 5v14 M5 12h14",
  arrow: "M5 12h14 m-5-5 5 5-5 5",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6 5a8 8 0 0 1 13 3 M18 19A8 8 0 0 1 5 16",
  chip: "M6 6h12v12H6z M9 9h6v6H9z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1",
  moon: "M20 14a8 8 0 0 1-10-10 9 9 0 1 0 10 10Z",
  logout: "M10 3H4v18h6 M10 12h11 m-4-4 4 4-4 4",
  close: "m6 6 12 12 M18 6 6 18",
  folder: "M3 5h7l2 3h9v12H3V5Z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
};
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.grid" />
  </svg>
</template>
