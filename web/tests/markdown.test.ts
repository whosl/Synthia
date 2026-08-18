import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/domain/markdown.ts";

describe("renderMarkdown", () => {
  test("渲染标题与段落", () => {
    expect(renderMarkdown("# 标题\n\n段落文本。")).toBe("<h1>标题</h1>\n<p>段落文本。</p>\n");
  });

  test("渲染无序列表", () => {
    expect(renderMarkdown("- a\n- b\n")).toBe("<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n");
  });

  test("围栏代码块保留语言 class（供后续语法高亮挂钩）", () => {
    expect(renderMarkdown("```verilog\nmodule x;\n```\n")).toBe(
      '<pre><code class="language-verilog">module x;\n</code></pre>\n',
    );
  });

  test("gfm 开启：渲染表格", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  test("gfm 开启：渲染链接", () => {
    expect(renderMarkdown("[link](https://example.com)")).toBe(
      '<p><a href="https://example.com">link</a></p>\n',
    );
  });

  test("breaks 关闭：段内单个换行不转成 <br>", () => {
    expect(renderMarkdown("line1\nline2\n")).toBe("<p>line1\nline2</p>\n");
  });

  test("加粗与斜体", () => {
    expect(renderMarkdown("**粗体** 和 *斜体*")).toBe("<p><strong>粗体</strong> 和 <em>斜体</em></p>\n");
  });

  test("空字符串返回空串", () => {
    expect(renderMarkdown("")).toBe("");
  });

  test("同步返回 string（不是 Promise）", () => {
    const result = renderMarkdown("hi");
    expect(typeof result).toBe("string");
  });

  test("净化：脚本标签被剥除（spec §5.1，源头 sanitize）", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script");
  });

  test("净化：内联事件处理器被剥除", () => {
    expect(renderMarkdown('<img src="x" onerror="alert(1)">')).not.toContain("onerror");
  });

  test("净化：javascript: 协议链接被剥除", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
  });

  test("净化不误伤正常内容：代码块语言 class 与表格结构保留", () => {
    expect(renderMarkdown("```verilog\nmodule x;\n```\n")).toContain('class="language-verilog"');
    expect(renderMarkdown("| a |\n| - |\n| 1 |\n")).toContain("<td>1</td>");
  });
});
