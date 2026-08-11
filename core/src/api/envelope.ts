/**
 * Synthia Core API — unified response envelope (IF-001 §2 / §7)
 *
 * Every response is one of:
 *   - success:  { "data": <payload>, "correlation_id": "<id>" }
 *   - error:    { "error": { code, message, retryable, details, correlation_id } }
 *
 * `correlation_id` is taken from the `X-Correlation-Id` request header when
 * present (passthrough) and otherwise generated. The same value is echoed on
 * every response, including errors, so a caller can trace a request end to end.
 */

import { randomUUID } from "node:crypto";
import type { ApiError } from "./errors.ts";

export interface ApiSuccessEnvelope<T> {
  readonly data: T;
  readonly correlation_id: string;
}

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details: unknown;
    readonly correlation_id: string;
  };
}

export function successEnvelope<T>(data: T, correlationId: string): ApiSuccessEnvelope<T> {
  return { data, correlation_id: correlationId };
}

export function errorEnvelope(err: ApiError, correlationId: string): ApiErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      details: err.details,
      correlation_id: correlationId,
    },
  };
}

/** Resolve the correlation id: passthrough a non-empty header, else generate. */
export function resolveCorrelationId(header: string | null | undefined): string {
  const trimmed = (header ?? "").trim();
  return trimmed.length > 0 ? trimmed : randomUUID();
}
