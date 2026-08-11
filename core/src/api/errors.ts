/**
 * Synthia Core API — stable error model (IF-001 §7)
 *
 * Six stable error codes with explicit HTTP status mapping
 * (400 / 401 / 403 / 404 / 409 / 503 / 500). `authorization` covers both
 * unauthenticated (401 — missing / unknown / expired / revoked token) and
 * forbidden (403 — authenticated but operation not permitted, e.g. a service
 * identity attempting a human-exclusive approval). Every error carries a
 * stable code, an objective message, a retryability flag and objective details.
 */

import type { DatabaseError } from "pg";

export type ApiErrorCode =
  | "validation"
  | "authorization"
  | "conflict"
  | "not_found"
  | "capability_unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly retryable: boolean = false,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function validationError(message: string, details?: unknown): ApiError {
  return new ApiError("validation", 400, message, false, details);
}

/** 401 — no / malformed / unknown / expired / revoked bearer token. */
export function unauthorizedError(message: string, details?: unknown): ApiError {
  return new ApiError("authorization", 401, message, false, details);
}

/** 403 — authenticated identity lacks permission for this operation. */
export function forbiddenError(message: string, details?: unknown): ApiError {
  return new ApiError("authorization", 403, message, false, details);
}

export function conflictApiError(message: string, details?: unknown, retryable = false): ApiError {
  return new ApiError("conflict", 409, message, retryable, details);
}

export function notFoundError(message: string, details?: unknown): ApiError {
  return new ApiError("not_found", 404, message, false, details);
}

export function capabilityUnavailableError(message: string, details?: unknown): ApiError {
  return new ApiError("capability_unavailable", 503, message, true, details);
}

export function internalError(message: string, details?: unknown): ApiError {
  return new ApiError("internal", 500, message, true, details);
}



/** Detect a PostgreSQL unique-violation (SQLSTATE 23505) from a node-pg error. */
export function isPgUniqueViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as DatabaseError).code === "23505";
}
