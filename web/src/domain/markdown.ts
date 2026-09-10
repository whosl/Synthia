/**
 * 轻量 Markdown 渲染（marked + DOMPurify）。输出供 v-html 使用，**已净化**。
 *
 * 内容源是 Agent 产物与对话文本，不是绝对可信的静态资源；这里在源头统一净化，
 * 调用方无需（也不应）各自再接一层 sanitize——避免出现"某个新调用点忘了净化"
 * 的缺口（spec §5.1）。
 *
 * mangle/headerIds 关闭以避免生成附带锚点。
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderMarkdown(source: string): string {
  // async: false 保证同步返回 string（类型签名仍含 Promise，窄化为 string）
  const html = marked.parse(source, { async: false }) as string;
  return sanitize(html);
}

/**
 * DOMPurify 依赖 DOM。浏览器里恒可用；无 DOM 环境（如未注册 DOM 的单测）直接抛错，
 * 而不是降级返回原始 HTML——静默放行会让"以为净化过了"的假设无声失效。
 */
function sanitize(html: string): string {
  if (typeof DOMPurify.sanitize !== "function") {
    throw new Error("renderMarkdown 需要 DOM 环境：DOMPurify 在当前运行时不可用");
  }
  return DOMPurify.sanitize(html);
}
