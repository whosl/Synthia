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
export {
  createTaskHandler,
  getTaskHandler,
  listTasksHandler,
  HttpRuntimeClient,
  createRuntimeClientFromEnv,
  RuntimeClientError,
} from "./task-proxy.ts";
export type {
  RuntimeClient,
  RuntimeDocRef,
  RuntimeRunSummary,
  RuntimeRunDetail,
  RuntimeListResponse,
  RuntimeCreateResponse,
  RuntimeTaskStatus,
  RuntimeAuditEntry,
  RuntimeEvidenceEntry,
  RuntimeEnvOptions,
} from "./task-proxy.ts";
export type { SynthiaServer } from "./server.ts";
export type { SynthiaServerOptions } from "./server.ts";
export type {
  ConnectorPort,
  ConnectorDiscovery,
  ConnectorJobSnapshot,
  EvidenceManifest,
  EvidenceEntry,
  SubmitJobParams,
  JobParameters,
  SourceInput,
  DiscoveredCapability,
} from "./connector-port.ts";
export { ConnectorError, CAPABILITY_UNAVAILABLE_CODES, CONNECTOR_NOT_FOUND_CODES } from "./connector-port.ts";
export { createConnectorFromEnv, RemoteConnectorAdapter, toConnectorError } from "./connector-adapter.ts";
export type { ConnectorEnvOptions } from "./connector-adapter.ts";
