/**
 * 主题状态与持久化（D15 双主题可切换；D20/D22 Claude 风格色板 + IDE 密度）。
 *
 * - 记忆优先：用户手动切换过 → localStorage 记住选择，之后不再跟随系统；
 * - 未手动切换过 → 跟随系统 `prefers-color-scheme: dark`；
 * - 纯逻辑函数（resolveTheme / systemTheme / toggleTheme 的判定部分）不碰真实
 *   DOM/localStorage，storage / media / root 均可注入 mock，便于单测；
 * - `applyTheme` 把主题写到 `<html data-theme="dark|light">`，style.css 按该属性
 *   选择对应色板变量集。
 */

export type Theme = "dark" | "light";

/** localStorage 存储键。 */
export const THEME_STORAGE_KEY = "synthia.theme";

/** 可注入的存储接口（真实环境用 window.localStorage，单测用内存 mock）。 */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 可注入的媒体查询接口（真实环境用 window.matchMedia 结果，单测用字面量 mock）。 */
export interface ThemeMedia {
  readonly matches: boolean;
}

/** 可注入的挂载根（真实环境用 document.documentElement，单测用假对象）。 */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

function isTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light";
}

/** 系统主题偏好：`prefers-color-scheme: dark` 命中 → dark，否则 light。 */
export function systemTheme(media: ThemeMedia): Theme {
  return media.matches ? "dark" : "light";
}

/**
 * 解析当前应生效的主题：localStorage 已记忆手动选择时优先生效，
 * 否则跟随系统偏好。纯函数，不产生副作用。
 */
export function resolveTheme(storage: ThemeStorage, media: ThemeMedia): Theme {
  const stored = storage.getItem(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : systemTheme(media);
}

/** 把主题写入挂载根的 `data-theme` 属性（style.css 的色板选择器依赖此属性）。 */
export function applyTheme(theme: Theme, root: ThemeRoot = document.documentElement): void {
  root.setAttribute("data-theme", theme);
}

/**
 * 切换主题：取反当前主题，写入 localStorage（记住手动选择）并应用到 DOM。
 * 返回切换后的主题，供调用方更新自身响应式状态。
 */
export function toggleTheme(current: Theme, storage: ThemeStorage, root: ThemeRoot = document.documentElement): Theme {
  const next: Theme = current === "dark" ? "light" : "dark";
  storage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next, root);
  return next;
}

/**
 * 页面启动初始化（main.ts / App.vue 调用一次）：解析生效主题（记忆优先，
 * 否则跟随系统）并写入 DOM，返回生效主题供应用状态使用。
 * 省略参数时使用真实浏览器环境（window.localStorage / matchMedia）。
 */
export function initTheme(
  storage: ThemeStorage = window.localStorage,
  media: ThemeMedia = window.matchMedia("(prefers-color-scheme: dark)"),
): Theme {
  const theme = resolveTheme(storage, media);
  applyTheme(theme);
  return theme;
}
