import { createHash } from "node:crypto";
import {
  EVOLUTION_EVAL_LIMITS,
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
  portablePathKey,
  validateEvolutionEvalParameters,
  vivadoMediaTypeForPath,
  type EvolutionEvalWorkspaceManifestFileV1,
  type EvolutionEvalWorkspaceManifestV1,
} from "../domain/evolution-eval.ts";
import { withTransaction, type TransactionClient } from "../db/repository.ts";
import type {
  CoreIssuedEvalBinding,
  SealedEvalInput,
} from "./evolution-eval-connector-port.ts";
import { scanEvolutionEvalXdc } from "./evolution-eval-xdc-scan.ts";

type Row = Record<string, unknown>;

/**
 * Rebuilds the exact sealed workspace from durable Core facts. No Host path is
 * accepted or returned. All bytes are copied before the transaction commits,
 * then exposed as bounded async streams for the post-commit Connector RPC.
 */
export async function loadEvolutionEvalSealedInput(
  client: TransactionClient,
  binding: CoreIssuedEvalBinding,
): Promise<SealedEvalInput> {
  const snapshot = await withTransaction(client, async (tx) => {
    const lookup = await tx.query(
      "SELECT curator_run_id,tool_run_id FROM evolution_eval_job WHERE id=$1",
      [binding.dispatch.eval_job_id],
    );
    const identity = lookup.rows[0] as Row | undefined;
    if (!identity) throw invalid("job binding is missing");

    // Preserve the dispatcher-wide lock order even though this function never
    // mutates state. This prevents a loader/cancel/deadline deadlock triangle.
    const curator = await tx.query(
      "SELECT id FROM curator_run WHERE id=$1 FOR UPDATE",
      [identity.curator_run_id],
    );
    const run = await tx.query(
      "SELECT curator_run_id FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
      [identity.curator_run_id],
    );
    const jobResult = await tx.query(
      `SELECT job.id,job.project_id,job.tool_run_id,job.connector_job_id,
              job.connector_idempotency_key,job.eval_input_ref,
              job.input_manifest_hash,job.workspace_id,job.operation,job.parameters,
              input.part,input.toolchain_profile_hash,job.deadline_at
         FROM evolution_eval_job job
         JOIN evolution_eval_input input ON input.eval_input_ref=job.eval_input_ref
        WHERE job.id=$1 FOR UPDATE OF job`,
      [binding.dispatch.eval_job_id],
    );
    if (curator.rows.length !== 1 || run.rows.length !== 1 || jobResult.rows.length !== 1) {
      throw invalid("run/job binding is incomplete");
    }
    const job = jobResult.rows[0] as Row;
    const toolResult = await tx.query(
      "SELECT state::text FROM tool_run WHERE id=$1 FOR UPDATE",
      [job.tool_run_id],
    );
    const tool = toolResult.rows[0] as Row | undefined;
    if (!tool) throw invalid("tool run binding is missing");
    const dispatchResult = await tx.query(
      `SELECT workspace_id,workspace_revision,workspace_manifest_hash,
              sealed_input_projection_hash,dispatch_request_hash,
              requested_timeout_ms,operation_cap_ms,deadline_at
         FROM evolution_eval_dispatch WHERE eval_job_id=$1 FOR UPDATE`,
      [binding.dispatch.eval_job_id],
    );
    await tx.query(
      "SELECT eval_job_id FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1 FOR UPDATE",
      [binding.dispatch.eval_job_id],
    );
    const dispatch = dispatchResult.rows[0] as Row | undefined;
    if (!dispatch) throw invalid("sealed dispatch is missing");
    assertBinding(job, dispatch, binding);
    if (tool.state !== "running") throw invalid("sealed input may only be loaded after the running fence");

    const projectionResult = await tx.query(
      `SELECT projection.current_revision,projection.sealed_at,projection.discarded_at,
              revision.manifest,revision.manifest_hash,revision.file_count,revision.total_bytes,
              revision.source_files,revision.source_bytes,revision.skill_files,
              revision.skill_bytes,revision.overlay_files,revision.overlay_bytes
         FROM evolution_eval_workspace_projection projection
         JOIN evolution_eval_workspace_revision revision
           ON revision.workspace_id=projection.workspace_id
          AND revision.revision=projection.current_revision
        WHERE projection.workspace_id=$1 FOR UPDATE OF projection,revision`,
      [binding.dispatch.workspace_id],
    );
    const revision = projectionResult.rows[0] as Row | undefined;
    if (
      !revision
      || revision.sealed_at === null
      || revision.discarded_at !== null
      || Number(revision.current_revision) !== binding.dispatch.workspace_revision
      || revision.manifest_hash !== binding.dispatch.workspace_manifest_hash
    ) throw invalid("workspace is not the exact durable sealed revision");
    validateBudgetCounters(revision);

    const filesResult = await tx.query(
      `SELECT path,sha256,size_bytes,media_type,layer,read_only,managed_content
         FROM evolution_eval_workspace_file
        WHERE workspace_id=$1 AND revision=$2
        ORDER BY translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",path COLLATE "C"
        FOR SHARE`,
      [binding.dispatch.workspace_id, binding.dispatch.workspace_revision],
    );
    const files = (filesResult.rows as Row[]).map(copyFile);
    if (files.length !== Number(revision.file_count)) throw invalid("workspace file count drifted");
    validateFiles(files, revision);
    const manifest = manifestFromFiles(binding.dispatch.workspace_id, binding.dispatch.workspace_revision, files);
    const canonical = canonicalEvolutionEvalWorkspaceManifest(manifest);
    const storedCanonical = canonicalEvolutionEvalWorkspaceManifest(
      revision.manifest as EvolutionEvalWorkspaceManifestV1,
    );
    if (
      canonical.sha256 !== binding.dispatch.workspace_manifest_hash
      || canonical.sha256 !== revision.manifest_hash
      || storedCanonical.sha256 !== canonical.sha256
    ) throw invalid("workspace manifest hash drifted");
    const projectionHash = canonicalEvolutionEvalSealedInputProjection(canonical.manifest).sha256;
    if (
      projectionHash !== dispatch.sealed_input_projection_hash
      || projectionHash !== binding.dispatch.sealed_input_projection_hash
    ) throw invalid("sealed input projection hash drifted");
    validateVivadoInputs(binding, files);
    return { manifest: canonical.manifest, files };
  });

  return {
    // The wire manifest is the source/overlay projection: the Worker's frozen
    // sealed-input contract forbids skill-layer entries on the remote manifest,
    // and the projected hash is what the dispatch binding pins.
    manifest: canonicalEvolutionEvalSealedInputProjection(snapshot.manifest).projection.manifest,
    files: (async function* () {
      for (const file of snapshot.files) {
        if (file.layer === "skill") continue;
        const bytes = new Uint8Array(file.content);
        yield {
          path: file.path,
          sha256: file.sha256,
          size_bytes: file.sizeBytes,
          media_type: file.mediaType,
          content: (async function* () { yield bytes; })(),
        };
      }
    })(),
  };
}

interface CopiedFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly layer: "source" | "skill" | "overlay";
  readonly readOnly: boolean;
  readonly content: Uint8Array;
}

function copyFile(row: Row): CopiedFile {
  if (row.layer !== "source" && row.layer !== "skill" && row.layer !== "overlay") {
    throw invalid("workspace layer is invalid");
  }
  const source = row.managed_content;
  if (!(source instanceof Uint8Array)) throw invalid("workspace content is invalid");
  return {
    path: String(row.path),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    mediaType: String(row.media_type),
    layer: row.layer,
    readOnly: row.read_only === true,
    content: new Uint8Array(source),
  };
}

function manifestFromFiles(
  workspaceId: string,
  revision: number,
  files: readonly CopiedFile[],
): EvolutionEvalWorkspaceManifestV1 {
  return {
    schema: "evolution-eval-workspace-manifest.v1",
    workspace_id: workspaceId,
    revision,
    files: files.map((file): EvolutionEvalWorkspaceManifestFileV1 => ({
      path: file.path,
      sha256: file.sha256,
      size_bytes: file.sizeBytes,
      media_type: file.mediaType,
      layer: file.layer,
      read_only: file.readOnly,
    })),
  };
}

function validateFiles(files: readonly CopiedFile[], revision: Row): void {
  const totals = {
    source: { files: 0, bytes: 0 },
    skill: { files: 0, bytes: 0 },
    overlay: { files: 0, bytes: 0 },
  };
  const keys = new Set<string>();
  for (const file of files) {
    const key = portablePathKey(file.path);
    if (keys.has(key)) throw invalid("workspace contains a portable path collision");
    keys.add(key);
    if ((file.layer === "overlay") === file.readOnly) throw invalid("workspace layer/read-only drifted");
    const limit = EVOLUTION_EVAL_LIMITS[file.layer];
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > limit.fileBytes) {
      throw invalid("workspace file budget is invalid");
    }
    if (file.content.byteLength !== file.sizeBytes) throw invalid("workspace file size drifted");
    if (createHash("sha256").update(file.content).digest("hex") !== file.sha256) {
      throw invalid("workspace file hash drifted");
    }
    totals[file.layer].files += 1;
    totals[file.layer].bytes += file.sizeBytes;
  }
  for (const layer of ["source", "skill", "overlay"] as const) {
    const limit = EVOLUTION_EVAL_LIMITS[layer];
    if (totals[layer].files > limit.files || totals[layer].bytes > limit.bytes) {
      throw invalid(`workspace ${layer} budget exceeded`);
    }
    if (
      totals[layer].files !== Number(revision[`${layer}_files`])
      || totals[layer].bytes !== Number(revision[`${layer}_bytes`])
    ) throw invalid(`workspace ${layer} counters drifted`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (files.length > EVOLUTION_EVAL_LIMITS.workspace.files || totalBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes) {
    throw invalid("workspace total budget exceeded");
  }
  if (totalBytes !== Number(revision.total_bytes)) throw invalid("workspace total counters drifted");
}

function validateBudgetCounters(revision: Row): void {
  const integerNames = [
    "file_count", "total_bytes", "source_files", "source_bytes",
    "skill_files", "skill_bytes", "overlay_files", "overlay_bytes",
  ] as const;
  for (const name of integerNames) {
    if (!Number.isSafeInteger(Number(revision[name])) || Number(revision[name]) < 0) {
      throw invalid("workspace budget counter is invalid");
    }
  }
}

function validateVivadoInputs(
  binding: CoreIssuedEvalBinding,
  files: readonly CopiedFile[],
): void {
  const parameters = validateEvolutionEvalParameters(
    binding.dispatch.operation,
    binding.dispatch.parameters,
  );
  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected = [
    ...parameters.source_paths,
    ...(parameters.operation === "implement" ? parameters.constraint_paths : []),
  ];
  for (const path of selected) {
    const file = byPath.get(path);
    if (!file || file.layer === "skill") throw invalid("Skill assets cannot be Vivado inputs");
    if (file.mediaType !== vivadoMediaTypeForPath(path)) throw invalid("Vivado input media type drifted");
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
      if (file.mediaType === "application/x-xdc" && scanEvolutionEvalXdc(content).decision !== "pass") {
        throw invalid("XDC policy rejected sealed input");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("EVOLUTION_EVAL_SEALED_INPUT_INVALID")) throw error;
      throw invalid("Vivado input is not valid UTF-8");
    }
  }
}

function assertBinding(job: Row, dispatch: Row, binding: CoreIssuedEvalBinding): void {
  const request = binding.dispatch;
  const exact: readonly [unknown, unknown][] = [
    [job.id, request.eval_job_id],
    [job.project_id, binding.project_id],
    [job.connector_job_id, request.connector_job_id],
    [job.connector_idempotency_key, request.connector_idempotency_key],
    [job.eval_input_ref, request.eval_input_ref],
    [job.input_manifest_hash, request.input_manifest_hash],
    [job.workspace_id, request.workspace_id],
    [job.operation, request.operation],
    [job.part ?? null, request.part],
    [job.toolchain_profile_hash, request.toolchain_profile_hash],
    [dispatch.workspace_id, request.workspace_id],
    [Number(dispatch.workspace_revision), request.workspace_revision],
    [dispatch.workspace_manifest_hash, request.workspace_manifest_hash],
    [dispatch.sealed_input_projection_hash, request.sealed_input_projection_hash],
    [dispatch.dispatch_request_hash, binding.dispatch_request_hash],
    [Number(dispatch.requested_timeout_ms), request.requested_timeout_ms],
    [Number(dispatch.operation_cap_ms), request.operation_cap_ms],
    [new Date(dispatch.deadline_at as string | Date).toISOString(), request.deadline_at],
  ];
  if (exact.some(([left, right]) => left !== right)) throw invalid("Core-issued binding drifted");
  if (JSON.stringify(job.parameters) !== JSON.stringify(request.parameters)) {
    throw invalid("typed parameters drifted");
  }
}

function invalid(reason: string): Error {
  return new Error(`EVOLUTION_EVAL_SEALED_INPUT_INVALID: ${reason}`);
}
