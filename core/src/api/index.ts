/**
 * Synthia Core API — public surface (IF-001 first slice)
 */
export type { AuthenticatedIdentity, IdentityActorType } from "./auth.ts";
export { authenticate } from "./auth.ts";
export type { ApiSuccessEnvelope, ApiErrorEnvelope } from "./envelope.ts";
export { successEnvelope, errorEnvelope, resolveCorrelationId } from "./envelope.ts";
export type { ApiError, ApiErrorCode } from "./errors.ts";
export {
  ApiError as ApiErrorClass,
  validationError,
  unauthorizedError,
  forbiddenError,
  conflictApiError,
  notFoundError,
  capabilityUnavailableError,
  internalError,
} from "./errors.ts";
export { routeApi } from "./router.ts";
export { startSynthiaServer } from "./server.ts";
export type { SynthiaServer } from "./server.ts";
