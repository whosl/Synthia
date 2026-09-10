/**
 * 测试环境 DOM 注册（bunfig.toml 的 [test].preload 引入，先于所有测试文件执行）。
 *
 * 存在的原因：domain/markdown.ts 在源头用 DOMPurify 净化输出，而 DOMPurify 在
 * 模块求值时就绑定 window——ESM import 提升会让"测试文件内再注册 DOM"来不及生效，
 * 必须在 preload 阶段完成注册，净化逻辑才能被真正测到而不是被静默跳过。
 *
 * 用 jsdom 而非 happy-dom：happy-dom 下 DOMPurify 会误删 <p>/<a> 等正常标签，
 * 且不剥离 javascript: 协议，测出来的行为不代表浏览器真实行为。jsdom 是
 * DOMPurify 官方支持的环境，实测与浏览器一致。
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as unknown as { window: unknown; document: unknown };
g.window = dom.window;
g.document = dom.window.document;
