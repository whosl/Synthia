/**
 * Standalone host for the self-evolution workers (Distiller + Curator).
 *
 * The workers themselves are capability-narrow (strict-JSON model + Core
 * client, nothing else); something still has to call runOnce(). This host
 * polls distillation runs continuously and drives the Curator through the
 * idle-gated scheduler cadence, using the same conversational model env the
 * Runtime uses (SYNTHIA_MODEL_URL/KEY/NAME, anthropic-messages for GLM).
 *
 * Env:
 *   SYNTHIA_CORE_URL                    Core base URL (default http://127.0.0.1:5130)
 *   SYNTHIA_EVOLUTION_DISTILLER_TOKEN   core:evolution-distiller service token
 *   SYNTHIA_EVOLUTION_CURATOR_TOKEN     core:evolution-curator service token
 *   SYNTHIA_EVOLUTION_WORKER_ID         stable worker id suffix (default hostname+pid)
 *   SYNTHIA_EVOLUTION_POLL_MS           distiller poll interval (default 5000)
 *   SYNTHIA_MODEL_*                     model env, same contract as runtime/server.ts
 *
 * Usage: bun run scripts/run-evolution-workers.ts
 */
import { hostname } from "node:os";
import { createRuntimeModelFromEnv } from "../runtime/pi-responses-model.ts";
import { EvolutionModelAdapter } from "../runtime/evolution-model-adapter.ts";
import {
  CoreCuratorEvolutionClient,
  CoreDistillerEvolutionClient,
  CoreSchedulerEvolutionClient,
} from "../runtime/evolution-worker-client.ts";
import { CuratorWorker, DistillerWorker } from "../runtime/evolution-workers.ts";
import { EvolutionScheduler } from "../runtime/evolution-scheduler.ts";

const coreUrl = process.env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:5130";
const distillerToken = required("SYNTHIA_EVOLUTION_DISTILLER_TOKEN");
const curatorToken = required("SYNTHIA_EVOLUTION_CURATOR_TOKEN");
const workerId = process.env.SYNTHIA_EVOLUTION_WORKER_ID
  ?? `evolution-${hostname()}-${process.pid}`;
const pollMs = Number(process.env.SYNTHIA_EVOLUTION_POLL_MS ?? 5_000);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const model = new EvolutionModelAdapter(
  createRuntimeModelFromEnv({
    ...(process.env.SYNTHIA_EVOLUTION_MODEL_NAME !== undefined
      ? { SYNTHIA_MODEL_NAME: process.env.SYNTHIA_EVOLUTION_MODEL_NAME }
      : {}),
    ...(process.env.SYNTHIA_EVOLUTION_MODEL_API !== undefined
      ? { SYNTHIA_MODEL_API: process.env.SYNTHIA_EVOLUTION_MODEL_API }
      : {}),
  }),
  process.env.SYNTHIA_EVOLUTION_MODEL_NAME ?? process.env.SYNTHIA_MODEL_NAME ?? "evolution-json",
);

const distiller = new DistillerWorker(new CoreDistillerEvolutionClient({
  baseUrl: coreUrl,
  distillerToken,
}), model, { workerId: `${workerId}-distiller`, leaseSeconds: 300 });

const curator = new CuratorWorker(new CoreCuratorEvolutionClient({
  baseUrl: coreUrl,
  curatorToken,
}), model, { workerId: `${workerId}-curator`, leaseSeconds: 900 });

let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stopped = true; });
}

const scheduler = new EvolutionScheduler({
  enabled: true,
  clock: { now: () => Date.now() },
  idleProbe: { isIdle: () => true },
  distillerWorker: distiller,
  curatorWorker: curator,
  curatorScheduleEnqueuer: new CoreSchedulerEvolutionClient({
    baseUrl: coreUrl,
    schedulerToken: curatorToken,
  }),
});

async function main(): Promise<void> {
  process.stdout.write(`[evolution-workers] host ${workerId} core=${coreUrl}\n`);
  while (!stopped) {
    try {
      const result = await scheduler.tick();
      for (const lane of ["distiller", "curator"] as const) {
        const r = result[lane];
        if (r.state === "failed") {
          process.stderr.write(`[evolution-workers] ${lane} failed: ${JSON.stringify(r).slice(0, 600)}\n`);
        }
      }
    } catch (error) {
      process.stderr.write(
        `[evolution-workers] tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  process.stdout.write("[evolution-workers] stopped\n");
}

void main();
