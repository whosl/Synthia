import {
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import { evolutionEvalCanonicalHash } from "../domain/evolution-eval.ts";
import {
  M4F_CANARY_BINDING_ISSUED_SCHEMA,
  buildM4fCanaryBinding,
  parseM4fCanaryBootstrapRequest,
  type M4fCanaryBootstrapRequestV1,
} from "../services/evolution-eval-canary-bootstrap.ts";
import {
  conflictApiError,
  forbiddenError,
  validationError,
} from "./errors.ts";
import type { HandlerResult, RequestContext } from "./handlers.ts";

interface CanaryRow {
  readonly database_name: string;
  readonly gate_id: string;
  readonly scenario: string;
  readonly project_id: string;
  readonly request_hash: string;
  readonly binding_hash: string;
  readonly binding: unknown;
  readonly issued_at: Date | string;
}

function parseRequest(value: unknown): M4fCanaryBootstrapRequestV1 {
  try {
    return parseM4fCanaryBootstrapRequest(value);
  } catch (error) {
    throw validationError(
      error instanceof Error ? error.message : "M4-F canary bootstrap request is invalid",
    );
  }
}

function assertAdmin(ctx: RequestContext): void {
  if (ctx.identity.actorType !== "human" || !ctx.identity.scopes.includes("core:admin")) {
    throw forbiddenError("M4F_CANARY_BOOTSTRAP_REQUIRES_HUMAN_ADMIN");
  }
}

function response(row: CanaryRow, replayed: boolean): Record<string, unknown> {
  return {
    schema: M4F_CANARY_BINDING_ISSUED_SCHEMA,
    database_name: row.database_name,
    gate_id: row.gate_id,
    scenario: row.scenario,
    project_id: row.project_id,
    binding_hash: row.binding_hash,
    binding: row.binding,
    issued_at: new Date(row.issued_at).toISOString(),
    replayed,
  };
}

async function assertDedicatedEmptyGate(
  tx: TransactionClient,
  request: M4fCanaryBootstrapRequestV1,
): Promise<void> {
  const database = await tx.query("SELECT current_database() AS name");
  const databaseName = String((database.rows[0] as { name?: unknown } | undefined)?.name ?? "");
  if (databaseName !== request.database_name) {
    throw validationError("database_name differs from the Core database");
  }

  const projects = await tx.query(
    `SELECT id,project_type,target_part,toolchain_profile_ref,status
       FROM project
      ORDER BY id
      FOR UPDATE`,
  );
  const project = projects.rows[0] as Record<string, unknown> | undefined;
  if (projects.rows.length !== 1) {
    throw conflictApiError("M4F_CANARY_DATABASE_MUST_HAVE_EXACTLY_ONE_PROJECT");
  }
  if (
    project?.id !== request.project_id
    || project.project_type !== "free"
    || project.target_part !== request.target_part
    || project.toolchain_profile_ref !== request.toolchain_profile_hash
    || project.status !== "active"
  ) {
    throw conflictApiError("M4F_CANARY_PROJECT_IDENTITY_MISMATCH");
  }
}

async function assertNoBusinessEvolutionState(tx: TransactionClient): Promise<void> {
  const result = await tx.query(
    `SELECT
       (SELECT count(*)::int FROM evolution_eval_job) AS eval_jobs,
       (SELECT count(*)::int FROM skill_application) AS applications,
       (SELECT count(*)::int FROM curator_run) AS curator_runs,
       (SELECT count(*)::int FROM distillation_run) AS distillation_runs`,
  );
  const counts = result.rows[0] as Record<string, unknown> | undefined;
  if (
    !counts
    || Number(counts.eval_jobs) !== 0
    || Number(counts.applications) !== 0
    || Number(counts.curator_runs) !== 0
    || Number(counts.distillation_runs) !== 0
  ) {
    throw conflictApiError("M4F_CANARY_DATABASE_ALREADY_HAS_BUSINESS_EVOLUTION_STATE");
  }
}

function assertStoredCanary(row: CanaryRow, request: M4fCanaryBootstrapRequestV1): void {
  const expected = buildM4fCanaryBinding(request);
  if (
    row.database_name !== request.database_name
    || row.gate_id !== request.gate_id
    || row.scenario !== request.scenario
    || row.project_id !== request.project_id
    || row.request_hash !== expected.requestHash
    || row.binding_hash !== expected.bindingHash
    || evolutionEvalCanonicalHash(row.binding) !== expected.bindingHash
    || evolutionEvalCanonicalHash(row.binding) !== evolutionEvalCanonicalHash(expected.binding)
  ) {
    throw conflictApiError("M4F_CANARY_BINDING_ALREADY_ISSUED_FOR_DIFFERENT_REQUEST");
  }
}

/**
 * Issue the singleton, never-submittable M4-F certification binding.
 *
 * Project creation remains on POST /projects. This endpoint only freezes the
 * Core-authored remote binding after proving that the dedicated Gate database
 * contains exactly that one free project and no business evolution state.
 */
export async function issueM4fEvolutionEvalCanaryHandler(
  ctx: RequestContext,
): Promise<HandlerResult> {
  assertAdmin(ctx);
  if (ctx.url.search.length > 0) {
    throw validationError("M4-F canary bootstrap does not accept query parameters");
  }
  const request = parseRequest(ctx.body);
  const connection = await ctx.pool.connect();
  try {
    return await withTransaction(connection as unknown as TransactionClient, async (tx) => {
      // Serialize the singleton check and project snapshot even if two
      // administrators accidentally run the CLI concurrently.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('synthia-m4f-canary-bootstrap',0))");
      // The advisory lock only serializes this issuer. These table locks also
      // exclude the ROW EXCLUSIVE locks taken by ordinary INSERTs, freezing
      // the empty-Gate snapshot until the canary row commits.
      await tx.query(
        `LOCK TABLE project,
                    evolution_eval_job,
                    skill_application,
                    curator_run,
                    distillation_run
           IN SHARE MODE`,
      );
      await assertDedicatedEmptyGate(tx, request);

      const existing = await tx.query(
        "SELECT * FROM evolution_eval_canary_binding WHERE singleton_id='m4f-canary'",
      );
      const existingRow = existing.rows[0] as CanaryRow | undefined;
      if (existingRow) {
        assertStoredCanary(existingRow, request);
        return { status: 200, data: response(existingRow, true) };
      }

      await assertNoBusinessEvolutionState(tx);
      const built = buildM4fCanaryBinding(request);
      const inserted = await tx.query(
        `INSERT INTO evolution_eval_canary_binding
          (singleton_id,database_name,gate_id,scenario,project_id,request_hash,
           binding_hash,binding,issued_by_type,issued_by,correlation_id)
         VALUES ('m4f-canary',$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         RETURNING database_name,gate_id,scenario,project_id,request_hash,
                   binding_hash,binding,issued_at`,
        [
          request.database_name,
          request.gate_id,
          request.scenario,
          request.project_id,
          built.requestHash,
          built.bindingHash,
          JSON.stringify(built.binding),
          ctx.identity.actorType,
          ctx.identity.actorId,
          ctx.correlationId,
        ],
      );
      const row = inserted.rows[0] as CanaryRow | undefined;
      if (!row) throw new Error("M4-F canary binding insert returned no row");
      return { status: 201, data: response(row, false) };
    });
  } finally {
    connection.release();
  }
}
