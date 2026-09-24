import { parseVcd } from "../../domain/vcd.ts";
self.onmessage = (event: MessageEvent<string>) => {
  try { self.postMessage({ data: parseVcd(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "波形解析失败" }); }
};
