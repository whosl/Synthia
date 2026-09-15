/**
 * 时间展示工具：统一 zh-CN 24 小时制。
 * - formatTime：短格式「MM/DD HH:mm」，用于列表项、版本条、动态行；
 * - formatDateTime：完整格式，用于面板详情；空值/无效输入回退为 fallback。
 * 此前两个变体在五处组件里各自重复实现，此处为唯一实现。
 */

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toLocaleString("zh-CN", { hour12: false });
}
