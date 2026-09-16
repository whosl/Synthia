/**
 * Standalone host for the self-evolution workers (Distiller + Curator).
 *
 * Thin wrapper over the canonical assembly in runtime/evolution-service.ts
 * (createEvolutionServiceFromEnv): manual curator lane every tick, scheduled
 * curator lane behind the idle-gated scheduler with its dedicated scheduler
 * credential. The single deployment-specific choice here is the model wire:
 * this host builds the conversational runtime model from SYNTHIA_MODEL_*
 * (anthropic-messages for GLM) instead of the factory default ModelClient,
 * because the GLM endpoint this stack pays for is Anthropic-protocol.
 *
 * Env (beyond the factory contract):
 *   SYNTHIA_MODEL_*                       conversational model env, same
 *                                         contract as runtime/server.ts
 *   SYNTHIA_EVOLUTION_MODEL_NAME          evolution model id (default
 *                                         SYNTHIA_MODEL_NAME)
 *
 * Usage: bun run scripts/run-evolution-workers.ts
 */
import { createRuntimeModelFromEnv } from "../runtime/pi-responses-model.ts";
import { EvolutionModelAdapter } from "../runtime/evolution-model-adapter.ts";
import {
  createEvolutionServiceFromEnv,
  startEvolutionServiceMain,
} from "../runtime/evolution-service.ts";

const modelId = process.env.SYNTHIA_EVOLUTION_MODEL_NAME
  ?? process.env.SYNTHIA_MODEL_NAME
  ?? "evolution-json";
const model = new EvolutionModelAdapter(
  createRuntimeModelFromEnv({
    ...process.env,
    ...(process.env.SYNTHIA_EVOLUTION_MODEL_NAME !== undefined
      ? { SYNTHIA_MODEL_NAME: process.env.SYNTHIA_EVOLUTION_MODEL_NAME }
      : {}),
    ...(process.env.SYNTHIA_EVOLUTION_MODEL_API !== undefined
      ? { SYNTHIA_MODEL_API: process.env.SYNTHIA_EVOLUTION_MODEL_API }
      : {}),
  }),
  modelId,
);

await startEvolutionServiceMain({
  createService: () => createEvolutionServiceFromEnv(process.env, { model }),
});
