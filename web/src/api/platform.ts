/**
 * 平台预览模式（`VITE_PLATFORM_PREVIEW=1` 构建）：
 *
 * 应用被托管在**动态子路径** `{previewRoot}/`（预览代理生成，task id 构建
 * 期不可知），因此：
 *  - 资产用相对 base（vite `base: './'`），路由切 hash（刷新不逃出预览根）；
 *  - API 前缀 `{previewRoot}/__backend` 只能在**运行时**从 document 位置解析
 *    ——平台代理把 `{previewRoot}/__backend/*` 剥前缀后转发到后端 :8000，
 *    后端路径保持 `/api/...` 不变。
 *
 * 默认（未开 flag）一切行为与现网相同：同源、绝对路径 `/api/v1`、history 路由。
 */
export const PLATFORM_PREVIEW = import.meta.env.VITE_PLATFORM_PREVIEW === "1";

/**
 * API 基址：常规部署返回 ""（同源，`/api/v1` 绝对路径）；平台预览模式返回
 * `{previewRoot}/__backend`（绝对路径、无尾斜杠——调用方一律拼带头斜杠的路径）。
 */
export function apiBase(): string {
  if (!PLATFORM_PREVIEW || typeof document === "undefined") return "";
  try {
    return new URL("__backend", document.baseURI).pathname;
  } catch {
    return "";
  }
}

/** 从（可能带 `__backend` 前缀的）路径还原 mock 路由用的 `/api/v1/...`。 */
export function stripBackendPrefix(pathname: string): string {
  const marker = "/__backend";
  if (pathname.startsWith(`${marker}/api/v1`)) return pathname.slice(marker.length);
  return pathname;
}
