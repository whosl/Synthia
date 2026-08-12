/**
 * 轻量 Markdown 渲染（marked 单依赖）。输出供 v-html 使用。
 *
 * 说明：内容源为内网受控环境中的 Agent 产物（候选修订），非任意用户输入；
 * 平台切片一期运行在内网可信域（core router 注释 B4），故不额外引入 sanitize 依赖。
 * mangle/headerIds 关闭以避免生成附带锚点。
 */

import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderMarkdown(source: string): string {
  // async: false 保证同步返回 string（类型签名仍含 Promise，窄化为 string）
  return marked.parse(source, { async: false }) as string;
}
