/**
 * 流式渲染单测：markdown-stream 投影 + task-stream SSE 帧解析与状态归并。
 */

import { describe, expect, test } from "bun:test";
import { project, type Projection } from "../src/domain/markdown-stream.ts";
import {
  applyStreamEvent,
  parseSSEFrames,
  type StreamFeedPart,
} from "../src/domain/task-stream.ts";

describe("markdown-stream project（流式 Markdown 块投影）", () => {
  test("纯文本流式追加：live 尾块；新增段落时前段稳定为 full", () => {
    let p: Projection | undefined;
    p = project(p, "第一段", true);
    // 单一段落仍在流式：live（段落未结束，无法确认稳定）
    expect(p.blocks.map((b) => b.mode)).toEqual(["live"]);
    p = project(p, "第一段\n\n第二段", true);
    // 前段已稳定（后续出现新段落），尾段 live
    expect(p.blocks.map((b) => b.mode)).toEqual(["full", "live"]);
    expect(p.blocks[0]!.raw).toBe("第一段\n\n");
  });

  test("代码围栏增量续写不重排：同一 code 块只追加 src", () => {
    let p: Projection | undefined;
    p = project(p, "说明：\n\n```verilog\nmodule c", true);
    expect(p.blocks.map((b) => b.mode)).toEqual(["full", "code"]);
    const codeBefore = p.blocks[1]!;
    expect(codeBefore.complete).toBeUndefined(); // 未闭合
    p = project(p, "说明：\n\n```verilog\nmodule counter(", true);
    const codeAfter = p.blocks[1]!;
    // 稳定块引用不变（不重排），src 纯追加
    expect(p.blocks.length).toBe(2);
    expect(codeAfter.src.startsWith(codeBefore.src)).toBe(true);
    expect(codeAfter.src).toBe("module counter(");
  });

  test("围栏闭合后：code 块 complete=true，后续文本成 live 尾块", () => {
    let p: Projection | undefined;
    p = project(p, "```verilog\nmodule c;\nendmodule\n```\n\n结尾", true);
    expect(p.blocks.map((b) => b.mode)).toEqual(["code", "live"]);
    expect(p.blocks[0]!.complete).toBe(true);
    expect(p.blocks[0]!.language).toBe("verilog");
  });

  test("live=false 定稿：live → full，code 补 complete", () => {
    let p: Projection | undefined;
    p = project(p, "```verilog\nmodule c", true);
    const done = project(p, "```verilog\nmodule c", false);
    expect(done.blocks[0]!.mode).toBe("code");
    expect(done.blocks[0]!.complete).toBe(true);
  });

  test("文本收缩（非追加）时全量重投影不抛错", () => {
    const p = project(undefined, "abc", true);
    const q = project(p, "xyz", true);
    expect(q.blocks[0]!.mode).toBe("live");
    expect(q.text).toBe("xyz");
  });
});

describe("task-stream parseSSEFrames", () => {
  test("解析 event/id/data 帧（含注释行跳过）", () => {
    const frames = parseSSEFrames(
      ": hb\n\nevent: part\nid: 2\ndata: {\"part\":{\"kind\":\"text\",\"id\":\"sp-1\",\"state\":\"streaming\",\"text\":\"\"}}\n\n" +
      "event: delta\nid: 3\ndata: {\"partId\":\"sp-1\",\"text\":\"你\"}\n\n",
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]!.event).toBe("part");
    expect(frames[0]!.id).toBe(2);
    expect((frames[0]!.data as { part: { id: string } }).part.id).toBe("sp-1");
    expect(frames[1]!.event).toBe("delta");
  });

  test("畸形 data 不抛错（data=null）", () => {
    const frames = parseSSEFrames("event: x\ndata: not-json\n\n");
    expect(frames[0]!.data).toBeNull();
  });
});

describe("applyStreamEvent（流式 feed 状态归并）", () => {
  test("part upsert + delta 追加 + done 定稿", () => {
    let feed: StreamFeedPart[] = [];
    feed = applyStreamEvent(feed, { type: "part", part: { kind: "text", id: "sp-1", state: "streaming", text: "" } });
    feed = applyStreamEvent(feed, { type: "delta", partId: "sp-1", text: "你好" });
    feed = applyStreamEvent(feed, { type: "delta", partId: "sp-1", text: "，世界" });
    expect(feed).toEqual([{ kind: "text", id: "sp-1", state: "streaming", text: "你好，世界" }]);
    feed = applyStreamEvent(feed, { type: "part", part: { kind: "text", id: "sp-1", state: "done", text: "你好，世界" } });
    expect(feed[0]!.state).toBe("done");
    // done 后 delta 不再追加
    feed = applyStreamEvent(feed, { type: "delta", partId: "sp-1", text: "x" });
    expect(feed[0]!.text).toBe("你好，世界");
  });

  test("未知 partId 的 delta 被忽略（轮询兜底）", () => {
    let feed: StreamFeedPart[] = [];
    feed = applyStreamEvent(feed, { type: "delta", partId: "ghost", text: "x" });
    expect(feed).toEqual([]);
  });

  test("reset 清空 feed", () => {
    let feed = applyStreamEvent([], { type: "part", part: { kind: "text", id: "sp-1", state: "streaming", text: "a" } });
    feed = applyStreamEvent(feed, { type: "reset" });
    expect(feed).toEqual([]);
  });
});
