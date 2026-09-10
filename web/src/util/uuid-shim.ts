/**
 * crypto.randomUUID 的非安全上下文兜底。
 *
 * Web Crypto 把 randomUUID 限制在 secure context（HTTPS 或 localhost）；
 * 局域网纯 HTTP 部署（http://192.168.x.x:4173）里它是 undefined，所有依赖
 * 它生成幂等键的发送/创建操作会在客户端本地抛 TypeError，被 UI 兜底成
 * 「发送请求失败」。在入口 import 一次，缺失时用 getRandomValues 补一个
 * 等价的 RFC 4122 v4 生成器，全部现有 crypto.randomUUID() 调用点无需改动。
 */

if (typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", {
    value: (): string => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // variant 10
      const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    configurable: true,
    writable: true,
  });
}

export {};
