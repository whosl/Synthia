import { describe, expect, test } from "bun:test";
import { ApiError, unwrapEnvelope } from "../src/api/client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("unwrapEnvelope 信封处理", () => {
  test("成功响应取 data 字段", async () => {
    const data = await unwrapEnvelope<{ id: string }[]>(
      jsonResponse(200, { data: [{ id: "p1" }], correlation_id: "c-1" }),
    );
    expect(data).toEqual([{ id: "p1" }]);
  });

  test("错误响应抛 ApiError，携带 code/retryable/correlation_id", async () => {
    const body = {
      error: {
        code: "authorization",
        message: "insufficient scope for this operation",
        retryable: false,
        details: { requiredScope: "core:approve" },
        correlation_id: "c-403",
      },
    };
    try {
      await unwrapEnvelope(jsonResponse(403, body));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.code).toBe("authorization");
      expect(apiErr.correlationId).toBe("c-403");
      expect(apiErr.body.retryable).toBe(false);
    }
  });

  test("成功但缺少 data 信封 → 抛 ApiError", async () => {
    try {
      await unwrapEnvelope(jsonResponse(200, { hello: "world" }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });

  test("非 JSON 错误响应 → 抛兜底 ApiError 而非 SyntaxError", async () => {
    const res = new Response("bad gateway", { status: 502 });
    try {
      await unwrapEnvelope(res);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(502);
    }
  });
});
